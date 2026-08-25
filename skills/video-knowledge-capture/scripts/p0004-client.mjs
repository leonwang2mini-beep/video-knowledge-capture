import { stdin as input, stdout as output } from "node:process";
import { pathToFileURL } from "node:url";


const DEFAULT_BASE_URL = "http://127.0.0.1:43127";
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_INPUT_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;

class ClientError extends Error {
  constructor(message, code, { retryable = false, state = "failed" } = {}) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.state = state;
  }
}

function validateBaseUrl(value) {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "http:"
    || parsed.hostname !== "127.0.0.1"
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    throw new Error("P0004 base URL must be an uncredentialed http://127.0.0.1 origin.");
  }
  return parsed.origin;
}

function validateUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) {
    throw new ClientError("请提供一条完整的公开视频链接。", "INVALID_VIDEO_URL");
  }
  if ([...value].some((character) => character.codePointAt(0) < 32)) {
    throw new ClientError("视频链接包含无效控制字符。", "INVALID_VIDEO_URL");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ClientError("视频链接格式无效。", "INVALID_VIDEO_URL");
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new ClientError("只接受 http 或 https 公公开视频链接。", "INVALID_VIDEO_URL");
  }
  if (parsed.username || parsed.password) {
    throw new ClientError("链接不得包含用户名或密码。", "URL_CREDENTIALS_REJECTED");
  }
  return value;
}

function validateJobId(value) {
  if (typeof value !== "string" || !JOB_ID_PATTERN.test(value.trim())) {
    throw new ClientError("任务编号格式无效。", "INVALID_JOB_ID");
  }
  return value.trim().toLowerCase();
}

function validateWaitSeconds(value = 90) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 120) {
    throw new ClientError("等待秒数必须是 0 到 120 的数字。", "INVALID_WAIT_SECONDS");
  }
  return value;
}

function nextAction(code, retryable) {
  const actions = {
    CONFIG_REQUIRED: "在本机打开视频知识捕手，先配置并验证 Obsidian Inbox。",
    INVALID_JOB_ID: "使用首次回执中的完整 job_id 查询。",
    INVALID_VIDEO_URL: "重新提供一条完整的 http 或 https 公公开视频链接。",
    INVALID_WAIT_SECONDS: "将 wait_seconds 设置为 0 到 120。",
    P0004_UNAVAILABLE: "确认电脑已开机并启动视频知识捕手，然后重新提交链接。",
    URL_CREDENTIALS_REJECTED: "删除链接中的用户名或密码后重新提交公开链接。",
    WECHAT_ADVANCED_MODE_DISABLED: "在本机视频知识捕手设置中启用微信高级模式。",
    WECHAT_SETUP_REQUIRED: "在本机视频知识捕手设置中完成微信高级模式授权。",
    YUANBAO_LOGIN_REQUIRED: "在本机视频知识捕手中重新完成腾讯元宝隔离登录。",
  };
  if (actions[code]) return actions[code];
  return retryable
    ? "处理条件恢复后可重新提交原链接，或再次查询同一 job_id。"
    : "检查链接和本机设置后再提交；不要把当前结果视为已入库。";
}

function failure(error) {
  const code = String(error?.code || "P0004_CLIENT_FAILED").slice(0, 100);
  const retryable = error?.retryable === true;
  return {
    code,
    message: String(error?.message || "本地视频知识捕手调用失败。").slice(0, 500),
    next_action: nextAction(code, retryable),
    retryable,
    state: error?.state || "failed",
  };
}

async function readBoundedJson(response) {
  if (!response.body) throw new ClientError("本机服务没有返回内容。", "P0004_INVALID_RESPONSE", { retryable: true });
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new ClientError("本机服务返回内容过大。", "P0004_RESPONSE_TOO_LARGE", { retryable: true });
    }
    chunks.push(value);
  }
  const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  let parsed;
  try {
    parsed = JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new ClientError("本机服务返回了无效 JSON。", "P0004_INVALID_RESPONSE", { retryable: true });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ClientError("本机服务返回结构无效。", "P0004_INVALID_RESPONSE", { retryable: true });
  }
  return parsed;
}

export class P0004Client {
  constructor({ baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch, pollIntervalMs = 1000 } = {}) {
    this.baseUrl = validateBaseUrl(baseUrl);
    this.fetchImpl = fetchImpl;
    this.pollIntervalMs = Math.max(20, Number(pollIntervalMs) || 1000);
  }

  async request(method, route, payload = null) {
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${route}`, {
        body: payload ? JSON.stringify(payload) : undefined,
        headers: payload
          ? { Accept: "application/json", "Content-Type": "application/json" }
          : { Accept: "application/json" },
        method,
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ClientError(
        "本机视频知识捕手当前不可连接。",
        "P0004_UNAVAILABLE",
        { retryable: true, state: "unavailable" },
      );
    }
    const body = await readBoundedJson(response);
    if (!response.ok) {
      const apiError = body.error && typeof body.error === "object" ? body.error : {};
      const code = String(apiError.code || `P0004_HTTP_${response.status}`).slice(0, 100);
      throw new ClientError(
        String(apiError.message || "视频知识捕手拒绝了请求。").slice(0, 500),
        code,
        {
          retryable: response.status >= 500 || [
            "CONFIG_REQUIRED",
            "WECHAT_ADVANCED_MODE_DISABLED",
            "WECHAT_SETUP_REQUIRED",
            "YUANBAO_LOGIN_REQUIRED",
          ].includes(code),
        },
      );
    }
    return body;
  }

  summarizeJob(job, platform = null) {
    if (!job || typeof job !== "object") {
      throw new ClientError("本机服务没有返回有效任务。", "P0004_INVALID_RESPONSE", { retryable: true });
    }
    const jobId = validateJobId(job.jobId);
    if (job.status === "completed") {
      const result = job.result && typeof job.result === "object" ? job.result : {};
      const state = result.captureStatus === "duplicate" ? "duplicate" : "completed";
      const retainedMediaPath = typeof (result.retainedMediaPath || job.retainedMediaPath) === "string"
        ? String(result.retainedMediaPath || job.retainedMediaPath).slice(0, 4096)
        : null;
      return {
        capture_id: result.captureId,
        capture_status: result.captureStatus,
        job_id: jobId,
        kind: "media-job",
        message: state === "duplicate" ? "视频已经存在于知识库。" : "视频已下载、转写并写入知识库。",
        note_path: typeof result.notePath === "string" ? result.notePath.slice(0, 4096) : null,
        platform,
        retained_media_path: retainedMediaPath,
        segment_count: result.segmentCount,
        source_type: job.sourceType,
        state,
        transcript_char_count: result.transcriptCharCount,
      };
    }
    if (job.status === "failed") {
      const jobError = job.error && typeof job.error === "object" ? job.error : {};
      const error = new ClientError(
        String(jobError.message || "本机视频任务失败。").slice(0, 500),
        String(jobError.code || "MEDIA_JOB_FAILED").slice(0, 100),
        { retryable: job.retryable === true || jobError.retryable === true },
      );
      const result = failure(error);
      result.job_id = jobId;
      result.kind = "media-job";
      result.source_type = job.sourceType;
      result.stage = job.stage;
      const details = jobError.details && typeof jobError.details === "object" ? jobError.details : {};
      if (typeof details.failureCategory === "string") result.failure_category = details.failureCategory.slice(0, 100);
      if (typeof details.profile === "string") result.download_profile = details.profile.slice(0, 100);
      return result;
    }
    if (!["queued", "waiting-for-upload", "running", "processing"].includes(job.status)) {
      throw new ClientError("本机服务返回了未知任务状态。", "P0004_INVALID_RESPONSE", { retryable: true });
    }
    return {
      job_id: jobId,
      kind: "media-job",
      message: "任务已由本机接收，正在下载或转写。",
      platform,
      source_type: job.sourceType,
      stage: job.stage,
      state: "processing",
    };
  }

  async capture(inputPayload) {
    try {
      const url = validateUrl(inputPayload?.url);
      const waitSeconds = validateWaitSeconds(inputPayload?.wait_seconds ?? 90);
      const response = await this.request("POST", "/api/intakes", { keepMedia: true, url });
      const intake = response.intake && typeof response.intake === "object" ? response.intake : {};
      const platform = typeof intake.platform?.id === "string" ? intake.platform.id : null;
      if (intake.kind === "link-note") {
        const capture = response.capture && typeof response.capture === "object" ? response.capture : {};
        if (!["created", "duplicate"].includes(capture.status)) {
          throw new ClientError("本机服务没有返回有效笔记状态。", "P0004_INVALID_RESPONSE", { retryable: true });
        }
        return {
          capture_id: capture.captureId,
          capture_status: capture.status,
          kind: "link-note",
          message: capture.status === "duplicate" ? "链接笔记已经存在。" : "链接笔记已写入知识库。",
          note_path: capture.notePath,
          platform,
          retained_media_path: null,
          state: capture.status === "duplicate" ? "duplicate" : "completed",
        };
      }
      if (intake.kind !== "media-job") {
        throw new ClientError("本机服务没有返回有效采集类型。", "P0004_INVALID_RESPONSE", { retryable: true });
      }
      let summary = this.summarizeJob(response.job, platform);
      if (summary.state !== "processing" || waitSeconds === 0) return summary;
      const deadline = Date.now() + waitSeconds * 1000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(this.pollIntervalMs, deadline - Date.now())));
        const status = await this.request("GET", `/api/media/jobs/${summary.job_id}`);
        summary = this.summarizeJob(status.job, platform);
        if (summary.state !== "processing") return summary;
      }
      summary.next_action = "稍后使用同一 job_id 查询任务状态。";
      return summary;
    } catch (error) {
      return failure(error);
    }
  }

  async status(inputPayload) {
    try {
      const jobId = validateJobId(inputPayload?.job_id);
      const response = await this.request("GET", `/api/media/jobs/${jobId}`);
      return this.summarizeJob(response.job);
    } catch (error) {
      return failure(error);
    }
  }
}

async function readInputJson(stream = input) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) throw new ClientError("输入 JSON 过大。", "INVALID_INPUT");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new ClientError("标准输入必须是一个 JSON 对象。", "INVALID_INPUT");
  }
}

async function main(argv = process.argv.slice(2)) {
  const action = argv[0];
  if (!["capture", "status"].includes(action) || argv.length !== 1) {
    output.write(`${JSON.stringify(failure(new ClientError(
      "用法：node p0004-client.mjs <capture|status>，并通过标准输入传入 JSON。",
      "INVALID_ACTION",
    )))}\n`);
    process.exitCode = 2;
    return;
  }
  let payload;
  try {
    payload = await readInputJson();
  } catch (error) {
    output.write(`${JSON.stringify(failure(error))}\n`);
    process.exitCode = 2;
    return;
  }
  const client = new P0004Client();
  const result = action === "capture" ? await client.capture(payload) : await client.status(payload);
  output.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
