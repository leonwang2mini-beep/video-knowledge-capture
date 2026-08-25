const elements = {
  configForm: document.querySelector("#config-form"),
  configHint: document.querySelector("#config-hint"),
  configSubmit: document.querySelector("#config-submit"),
  connectionLabel: document.querySelector("#connection-label"),
  connectionStatus: document.querySelector("#connection-status"),
  destinationPath: document.querySelector("#destination-path"),
  failureList: document.querySelector("#failure-list"),
  inboxPath: document.querySelector("#inbox-path"),
  inboxSeal: document.querySelector("#inbox-seal"),
  intakeForm: document.querySelector("#intake-form"),
  intakeResult: document.querySelector("#intake-result"),
  intakeSubmit: document.querySelector("#intake-submit"),
  intakeUrl: document.querySelector("#intake-url"),
  keepMediaDefault: document.querySelector("#keep-media-default"),
  localMediaFile: document.querySelector("#local-media-file"),
  localMediaForm: document.querySelector("#local-media-form"),
  localMediaSubmit: document.querySelector("#local-media-submit"),
  localMediaUrl: document.querySelector("#local-media-url"),
  mediaJobCount: document.querySelector("#media-job-count"),
  mediaJobList: document.querySelector("#media-job-list"),
  queueCount: document.querySelector("#queue-count"),
  retainedMediaOpen: document.querySelector("#retained-media-open"),
  retainedMediaPath: document.querySelector("#retained-media-path"),
  resultIcon: document.querySelector("#result-icon"),
  resultMessage: document.querySelector("#result-message"),
  resultPath: document.querySelector("#result-path"),
  resultTitle: document.querySelector("#result-title"),
  runtimeComponents: document.querySelector("#runtime-components"),
  runtimeInstall: document.querySelector("#runtime-install"),
  runtimeSeal: document.querySelector("#runtime-seal"),
  settingsPanel: document.querySelector("#settings-panel"),
  settingsSummary: document.querySelector("#settings-summary"),
  toastRegion: document.querySelector("#toast-region"),
  wechatCertInstall: document.querySelector("#wechat-cert-install"),
  wechatCertUninstall: document.querySelector("#wechat-cert-uninstall"),
  wechatStart: document.querySelector("#wechat-start"),
  wechatStatus: document.querySelector("#wechat-status"),
  wechatStop: document.querySelector("#wechat-stop"),
  yuanbaoCancel: document.querySelector("#yuanbao-cancel"),
  yuanbaoForget: document.querySelector("#yuanbao-forget"),
  yuanbaoLogin: document.querySelector("#yuanbao-login"),
  yuanbaoSeal: document.querySelector("#yuanbao-seal"),
  yuanbaoStatus: document.querySelector("#yuanbao-status"),
};

const appState = {
  configuration: null,
  failures: [],
  jobs: [],
  lastSubmittedJobId: null,
  runtime: null,
  wechat: null,
  yuanbao: null,
};

const componentLabels = {
  ffmpeg: "FFmpeg",
  whisper: "whisper.cpp",
  whisperModel: "中文语音模型",
  wxChannel: "微信下载组件",
  ytDlp: "公开视频下载器",
};

async function apiRequest(url, { method = "GET", body } = {}) {
  const response = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok) {
    const error = new Error(payload.error?.message || "本地服务返回了未知错误。");
    error.code = payload.error?.code || "REQUEST_FAILED";
    error.retryable = payload.error?.retryable === true;
    throw error;
  }
  return payload;
}

async function binaryRequest(url, file) {
  const response = await fetch(url, {
    body: file,
    headers: { "Content-Type": "application/octet-stream" },
    method: "PUT",
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok) {
    const error = new Error(payload.error?.message || "本机文件上传失败。");
    error.code = payload.error?.code || "UPLOAD_FAILED";
    throw error;
  }
  return payload;
}

function createTextElement(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

function setButtonLoading(button, loading, label) {
  const target = button.querySelector?.(".button-label") ?? button;
  if (!button.dataset.defaultLabel) button.dataset.defaultLabel = target.textContent;
  button.disabled = loading;
  button.dataset.loading = loading ? "true" : "false";
  target.textContent = loading ? label : button.dataset.defaultLabel;
}

function showToast(message, state = "success") {
  const toast = createTextElement("div", "toast", message);
  toast.dataset.state = state;
  elements.toastRegion.append(toast);
  window.setTimeout(() => toast.remove(), 4200);
}

function showResult(state, { icon, message, path = "", title }) {
  elements.intakeResult.hidden = false;
  elements.intakeResult.dataset.state = state;
  elements.resultIcon.textContent = icon;
  elements.resultTitle.textContent = title;
  elements.resultMessage.textContent = message;
  elements.resultPath.textContent = path;
  elements.resultPath.title = path;
}

function setConnection(state, label) {
  elements.connectionStatus.dataset.state = state;
  elements.connectionLabel.textContent = label;
}

function openSettingsAndFocus(target = elements.inboxPath) {
  elements.settingsPanel.open = true;
  elements.settingsPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  window.setTimeout(() => target?.focus(), 280);
}

function renderConfiguration(configuration) {
  appState.configuration = configuration;
  const ready = configuration.inboxStatus === "ready";
  elements.inboxSeal.dataset.state = ready ? "ready" : "error";
  elements.inboxSeal.textContent = ready ? "已就绪" : "待设置";
  elements.destinationPath.textContent = configuration.inboxDir || "尚未配置 Obsidian Inbox";
  elements.destinationPath.title = configuration.inboxDir || "";
  elements.inboxPath.value = configuration.inboxDir || "";
  elements.retainedMediaPath.value = configuration.retainedMediaDir || "";
  elements.configHint.textContent = configuration.message;
  elements.settingsSummary.textContent = ready
    ? `Inbox 已就绪${appState.failures.some((item) => item.resolution === "pending") ? " · 有任务待处理" : ""}`
    : "首次使用只需设置一次 Inbox";
}

function renderRuntime(runtime) {
  appState.runtime = runtime;
  const entries = Object.entries(runtime.components || {});
  elements.runtimeComponents.replaceChildren();
  for (const [name, component] of entries) {
    const item = createTextElement(
      "li",
      "",
      `${componentLabels[name] || name} · ${component.ready ? "已就绪" : "缺少"}`,
    );
    item.dataset.ready = component.ready ? "true" : "false";
    elements.runtimeComponents.append(item);
  }
  const ready = entries.length > 0 && entries.every(([, component]) => component.ready);
  elements.runtimeSeal.dataset.state = ready ? "ready" : "idle";
  elements.runtimeSeal.textContent = ready ? "已就绪" : "首次自动准备";
}

function renderYuanbao(yuanbao) {
  appState.yuanbao = yuanbao;
  const waiting = yuanbao.state === "waiting-for-login";
  elements.yuanbaoLogin.disabled = waiting;
  elements.yuanbaoCancel.disabled = !waiting;
  elements.yuanbaoForget.disabled = waiting || !yuanbao.configured;
  if (waiting) {
    elements.yuanbaoSeal.dataset.state = "idle";
    elements.yuanbaoSeal.textContent = "等待扫码";
    elements.yuanbaoStatus.textContent = "隔离窗口已打开，请完成微信扫码登录；完成后回到这里再次粘贴链接。";
    return;
  }
  if (yuanbao.configured) {
    elements.yuanbaoSeal.dataset.state = "ready";
    elements.yuanbaoSeal.textContent = "已连接";
    elements.yuanbaoStatus.textContent = "视频号解析已就绪；登录态只以 Windows 加密记录保存。";
    return;
  }
  elements.yuanbaoSeal.dataset.state = yuanbao.error ? "error" : "idle";
  elements.yuanbaoSeal.textContent = yuanbao.error ? "需重连" : "首次登录";
  elements.yuanbaoStatus.textContent = yuanbao.error?.message || "首次收录视频号时会自动打开隔离登录窗口。";
}

function renderWechat(wechat) {
  appState.wechat = wechat;
  if (!wechat.advancedEnabled) {
    elements.wechatStatus.textContent = "备用模式尚未启用；日常视频号收录优先使用腾讯元宝。";
    return;
  }
  if (!wechat.runtimeReady) {
    elements.wechatStatus.textContent = "缺少微信备用下载组件。";
    return;
  }
  elements.wechatStatus.textContent = wechat.serviceReady
    ? (wechat.clientReady ? "桌面微信备用捕获已连接。" : "组件已运行，等待桌面微信视频页面。")
    : "备用组件未启动。";
}

function platformFromUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (host === "weixin.qq.com" && /^\/sph(?:\/|$)/i.test(url.pathname)) return "wechat-channels";
    if (host.endsWith("youtube.com") || host === "youtu.be") return "youtube";
    if (host.endsWith("bilibili.com") || host === "b23.tv") return "bilibili";
    if (host.endsWith("douyin.com") || host.endsWith("iesdouyin.com")) return "douyin";
    if (host.endsWith("kuaishou.com") || host.endsWith("gifshow.com")) return "kuaishou";
    if (host.endsWith("xiaohongshu.com") || host.endsWith("xhslink.com")) return "xiaohongshu";
    if (host.endsWith("tiktok.com")) return "tiktok";
    if (host.endsWith("v.qq.com")) return "tencent-video";
    if (host.endsWith("weixin.qq.com")) return "wechat";
    return "web";
  } catch {
    return "invalid";
  }
}

function platformLabel(url) {
  const labels = {
    bilibili: "Bilibili",
    douyin: "抖音",
    kuaishou: "快手",
    "tencent-video": "腾讯视频",
    tiktok: "TikTok",
    wechat: "微信公众号",
    "wechat-channels": "微信视频号",
    web: "公开网页",
    xiaohongshu: "小红书",
    youtube: "YouTube",
  };
  return labels[platformFromUrl(url)] || "视频链接";
}

function mediaStageLabel(job) {
  if (job.status === "completed") return "已进入知识库";
  if (job.status === "failed") return "需要处理";
  if (job.status === "cleaned") return "已清理";
  const stages = {
    "awaiting-upload": "等待本机文件",
    cleanup: "整理收尾",
    completed: "已完成",
    "download-public": "正在下载公开视频",
    "download-wechat": "正在下载视频号",
    "extract-audio": "正在提取声音",
    interrupted: "等待安全重试",
    "prepare-media": "正在准备",
    queued: "已排队",
    "resolve-yuanbao": "正在解析视频号",
    "retain-media": "正在保存原视频",
    "upload-media": "正在接收本机文件",
    "write-note": "正在整理知识笔记",
  };
  return stages[job.stage] || "处理中";
}

function readableTime(value) {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      month: "numeric",
      day: "numeric",
    }).format(new Date(value));
  } catch {
    return "刚刚";
  }
}

function renderMediaJobs(jobs) {
  appState.jobs = jobs;
  const activeCount = jobs.filter((job) => ["queued", "running", "uploading"].includes(job.status)).length;
  elements.mediaJobCount.textContent = activeCount ? `${activeCount} 个处理中` : `${jobs.length} 个任务`;
  elements.mediaJobList.replaceChildren();

  if (jobs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "quiet-empty";
    empty.append(createTextElement("span", "", "✓"), createTextElement("p", "", "准备好了，粘贴第一条链接吧。"));
    elements.mediaJobList.append(empty);
    return;
  }

  for (const job of jobs.slice(0, 8)) {
    const item = document.createElement("article");
    item.className = "media-job-item";

    const source = document.createElement("p");
    source.className = "media-job-source";
    source.append(
      createTextElement("b", "", platformLabel(job.sourceUrl)),
      createTextElement("small", "", job.sourceUrl),
    );

    const detail = document.createElement("div");
    detail.className = "job-detail";
    const state = createTextElement("span", "job-state", mediaStageLabel(job));
    state.dataset.state = job.status;
    const message = job.status === "completed"
      ? `${job.result?.segmentCount || 0} 段字幕${job.keepMedia ? " · 已保留视频" : ""}`
      : job.status === "failed"
        ? job.error?.message || "任务失败，可安全重试。"
        : job.progress?.percentage
          ? `下载进度 ${Math.round(job.progress.percentage)}%`
          : "自动处理中，你可以关闭页面，任务会留在本机。";
    const path = job.result?.notePath || job.result?.retainedMediaPath || readableTime(job.updatedAt);
    detail.append(state, createTextElement("p", "", message), createTextElement("small", "", path));

    const actions = document.createElement("div");
    actions.className = "job-actions";
    if (job.status === "failed" && job.retryable) {
      const retry = createTextElement("button", "secondary-action", "重试");
      retry.type = "button";
      retry.addEventListener("click", () => retryMediaJob(job, retry));
      actions.append(retry);
    }
    if (job.status === "failed" && job.workRetained) {
      const cleanup = createTextElement("button", "text-action danger-action", "清理临时文件");
      cleanup.type = "button";
      cleanup.addEventListener("click", () => cleanupMediaJob(job, cleanup));
      actions.append(cleanup);
    }
    item.append(source, detail, actions);
    elements.mediaJobList.append(item);

    if (job.jobId === appState.lastSubmittedJobId && job.status === "completed") {
      showResult("success", {
        icon: "✓",
        message: `${job.result?.segmentCount || 0} 段字幕已整理完成${job.keepMedia ? "，原视频已保留" : ""}。`,
        path: job.result?.notePath || "",
        title: "已收进知识库",
      });
      appState.lastSubmittedJobId = null;
    } else if (job.jobId === appState.lastSubmittedJobId && job.status === "failed") {
      showResult("error", {
        icon: "!",
        message: job.error?.message || "任务未完成，已留下可安全重试的记录。",
        title: "这次没有完成",
      });
      openSettingsAndFocus(null);
      appState.lastSubmittedJobId = null;
    }
  }
}

function renderFailures(failures, pendingCount) {
  appState.failures = failures;
  elements.queueCount.textContent = `${pendingCount} 条`;
  elements.queueCount.dataset.state = pendingCount ? "error" : "ready";
  elements.failureList.replaceChildren();
  if (failures.length === 0) {
    const empty = document.createElement("div");
    empty.className = "quiet-empty";
    empty.append(createTextElement("span", "", "✓"), createTextElement("p", "", "没有待处理记录。"));
    elements.failureList.append(empty);
    return;
  }
  for (const failure of failures.slice(0, 10)) {
    const item = document.createElement("article");
    item.className = "failure-item";
    const source = document.createElement("p");
    source.className = "failure-source";
    source.append(
      createTextElement("b", "", platformLabel(failure.sourceUrl)),
      createTextElement("small", "", failure.sourceUrl || "未记录链接"),
    );
    const detail = document.createElement("div");
    detail.className = "failure-detail";
    detail.append(
      createTextElement("p", "", failure.message),
      createTextElement("small", "", `${failure.errorCode} · ${readableTime(failure.failedAt)}`),
    );
    const actions = document.createElement("div");
    actions.className = "failure-actions";
    if (failure.resolution === "pending" && failure.retryable) {
      const retry = createTextElement("button", "secondary-action", "重试");
      retry.type = "button";
      retry.addEventListener("click", () => retryCapture(failure, retry));
      actions.append(retry);
    } else {
      actions.append(createTextElement("span", "job-state", failure.resolution === "resolved" ? "已处理" : "需检查"));
    }
    item.append(source, detail, actions);
    elements.failureList.append(item);
  }
}

async function loadStatus() {
  const payload = await apiRequest("/api/status");
  renderConfiguration(payload.configuration);
  setConnection("ready", "本地服务已连接");
}

async function loadRuntime() {
  const payload = await apiRequest("/api/runtime");
  renderRuntime(payload.runtime);
  return payload.runtime;
}

async function loadYuanbao() {
  const payload = await apiRequest("/api/yuanbao/status");
  renderYuanbao(payload.yuanbao);
  return payload.yuanbao;
}

async function loadWechat() {
  const payload = await apiRequest("/api/wechat/status");
  renderWechat(payload.wechat);
}

async function loadMediaJobs() {
  const payload = await apiRequest("/api/media/jobs");
  renderMediaJobs(payload.jobs);
}

async function loadFailures() {
  const payload = await apiRequest("/api/failures");
  renderFailures(payload.failures, payload.pendingCount);
}

async function refreshAll() {
  try {
    await Promise.all([
      loadStatus(),
      loadRuntime(),
      loadYuanbao(),
      loadWechat(),
      loadMediaJobs(),
      loadFailures(),
    ]);
  } catch (error) {
    setConnection("error", "本地服务连接失败");
    showToast(error.message, "error");
  }
}

async function installRuntimeComponents(components = null, button = elements.runtimeInstall) {
  const label = components?.length === 1 ? `正在安装 ${componentLabels[components[0]] || "组件"}…` : "正在准备本地引擎…";
  setButtonLoading(button, true, label);
  try {
    const payload = await apiRequest("/api/runtime/install", {
      body: components ? { components } : {},
      method: "POST",
    });
    renderRuntime(payload.runtime);
    showToast("本地内容引擎已准备完成。", "success");
    return payload.runtime;
  } catch (error) {
    showToast(`本地引擎准备失败：${error.message}`, "error");
    throw error;
  } finally {
    setButtonLoading(button, false, label);
  }
}

async function ensureRuntime(platformId) {
  if (platformId === "web") return true;
  const required = platformId === "wechat-channels"
    ? ["ffmpeg", "whisper", "whisperModel", "wxChannel"]
    : ["ytDlp", "ffmpeg", "whisper", "whisperModel"];
  const runtime = appState.runtime || await loadRuntime();
  const missing = required.filter((name) => !runtime.components?.[name]?.ready);
  if (missing.length === 0) return true;
  showResult("working", {
    icon: "…",
    message: "首次使用正在下载并校验本地组件，只需要准备一次。",
    title: "正在准备本地引擎",
  });
  await installRuntimeComponents(missing, elements.intakeSubmit);
  return true;
}

async function ensureAdvancedMode() {
  if (appState.configuration?.wechatAdvancedEnabled) return;
  const payload = await apiRequest("/api/config", {
    body: { wechatAdvancedEnabled: true },
    method: "PUT",
  });
  renderConfiguration(payload.configuration);
}

async function ensureWechatAccess() {
  await ensureAdvancedMode();
  const yuanbao = await loadYuanbao();
  if (yuanbao.configured) return true;
  openSettingsAndFocus(elements.yuanbaoLogin);
  if (yuanbao.state !== "waiting-for-login") {
    const payload = await apiRequest("/api/yuanbao/login/start", { body: {}, method: "POST" });
    renderYuanbao(payload.yuanbao);
  }
  showResult("working", {
    icon: "1",
    message: "请在刚打开的隔离窗口完成微信扫码。完成后回到这里，再次粘贴同一链接即可。",
    title: "首次使用：登录一次",
  });
  return false;
}

async function submitIntake(event) {
  event.preventDefault();
  if (appState.configuration?.inboxStatus !== "ready") {
    showResult("error", {
      icon: "1",
      message: "先设置一次 Obsidian Inbox，以后无需再确认。",
      title: "还差一个落点",
    });
    openSettingsAndFocus();
    return;
  }

  const url = elements.intakeUrl.value.trim();
  const platformId = platformFromUrl(url);
  if (!url || platformId === "invalid") {
    elements.intakeUrl.setAttribute("aria-invalid", "true");
    elements.intakeUrl.focus();
    showResult("error", { icon: "!", message: "请粘贴一条完整的 http/https 视频链接。", title: "没有识别到链接" });
    return;
  }

  elements.intakeUrl.removeAttribute("aria-invalid");
  setButtonLoading(elements.intakeSubmit, true, "自动处理中…");
  try {
    if (platformId === "wechat-channels" && !(await ensureWechatAccess())) return;
    await ensureRuntime(platformId);
    showResult("working", {
      icon: "…",
      message: `${platformLabel(url)}链接已识别，正在下载并交给本机字幕引擎。`,
      title: "已经接住了",
    });
    const payload = await apiRequest("/api/intakes", {
      body: {
        keepMedia: elements.keepMediaDefault.checked,
        url,
      },
      method: "POST",
    });
    if (payload.intake.kind === "link-note") {
      showResult("success", {
        icon: payload.capture.status === "duplicate" ? "＝" : "✓",
        message: payload.capture.status === "duplicate"
          ? "这条链接已经在 Inbox 中，没有重复创建。"
          : "该页面暂不支持自动下载，已先保存公开信息和链接。",
        path: payload.capture.notePath,
        title: payload.capture.status === "duplicate" ? "已经收录过" : "已保存公开页面",
      });
    } else {
      appState.lastSubmittedJobId = payload.job.jobId;
      showResult("working", {
        icon: "…",
        message: "可以继续做其他事。下载、字幕和知识库写入会在本机自动完成。",
        title: "正在自动整理",
      });
      await loadMediaJobs();
    }
    elements.intakeForm.reset();
    elements.intakeUrl.focus();
  } catch (error) {
    if (["WECHAT_SETUP_REQUIRED", "YUANBAO_LOGIN_REQUIRED"].includes(error.code)) {
      await ensureWechatAccess();
    } else {
      showResult("error", {
        icon: "!",
        message: error.message,
        title: "这次没有开始",
      });
      showToast(error.message, "error");
    }
  } finally {
    setButtonLoading(elements.intakeSubmit, false, "自动处理中…");
  }
}

async function saveConfiguration(event) {
  event.preventDefault();
  const inboxDir = elements.inboxPath.value.trim();
  const retainedMediaDir = elements.retainedMediaPath.value.trim();
  if (!inboxDir) {
    elements.inboxPath.setAttribute("aria-invalid", "true");
    elements.inboxPath.focus();
    return;
  }
  setButtonLoading(elements.configSubmit, true, "验证中…");
  try {
    const payload = await apiRequest("/api/config", {
      body: { inboxDir, retainedMediaDir },
      method: "PUT",
    });
    renderConfiguration(payload.configuration);
    elements.inboxPath.removeAttribute("aria-invalid");
    showToast("Inbox 已保存，以后粘贴链接即可。", "success");
    elements.intakeUrl.focus();
  } catch (error) {
    elements.inboxPath.setAttribute("aria-invalid", "true");
    elements.configHint.textContent = error.message;
    showToast(error.message, "error");
  } finally {
    setButtonLoading(elements.configSubmit, false, "验证中…");
  }
}

async function openRetainedMediaDirectory() {
  setButtonLoading(elements.retainedMediaOpen, true, "正在打开…");
  try {
    const payload = await apiRequest("/api/retained-media/open", { method: "POST" });
    showToast("已打开视频保存目录。", "success");
    elements.retainedMediaPath.value = payload.retainedMediaDir || elements.retainedMediaPath.value;
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    setButtonLoading(elements.retainedMediaOpen, false, "正在打开…");
  }
}

async function changeYuanbaoSession(action, button) {
  if (action === "forget" && !window.confirm("清除本应用保存的元宝加密登录态？下次需要重新扫码。")) return;
  const loading = action === "start" ? "正在打开…" : action === "forget" ? "正在清除…" : "正在取消…";
  setButtonLoading(button, true, loading);
  try {
    if (action === "start") await ensureAdvancedMode();
    const endpoint = action === "forget" ? "/api/yuanbao/session/forget" : `/api/yuanbao/login/${action}`;
    const payload = await apiRequest(endpoint, { body: {}, method: "POST" });
    renderYuanbao(payload.yuanbao);
    showToast(action === "start" ? "隔离登录窗口已打开。" : "登录状态已更新。", "success");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    setButtonLoading(button, false, loading);
  }
}

async function changeWechatSidecar(action, button) {
  const label = action === "start" ? "正在启动…" : "正在停止…";
  setButtonLoading(button, true, label);
  try {
    await ensureAdvancedMode();
    await apiRequest(`/api/wechat/${action}`, { body: {}, method: "POST" });
    await loadWechat();
    showToast(action === "start" ? "备用捕获已启动。" : "备用捕获已停止。", "success");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    setButtonLoading(button, false, label);
  }
}

async function changeWechatCertificate(action, button) {
  const confirmed = window.confirm(
    action === "install"
      ? "备用桌面捕获需要管理员授权安装本机 HTTPS 根证书。继续吗？"
      : "将停止备用捕获并卸载其 HTTPS 根证书。继续吗？",
  );
  if (!confirmed) return;
  const label = action === "install" ? "安装中…" : "卸载中…";
  setButtonLoading(button, true, label);
  try {
    await ensureAdvancedMode();
    await apiRequest(`/api/wechat/certificate/${action}`, { body: {}, method: "POST" });
    showToast(action === "install" ? "证书已安装。" : "证书已卸载。", "success");
    await loadWechat();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    setButtonLoading(button, false, label);
  }
}

async function submitLocalMedia(event) {
  event.preventDefault();
  const file = elements.localMediaFile.files?.[0];
  const url = elements.localMediaUrl.value.trim();
  if (!file || !url) {
    showToast("请填写原始链接并选择本机媒体。", "error");
    return;
  }
  setButtonLoading(elements.localMediaSubmit, true, "正在接收…");
  try {
    await ensureRuntime("youtube");
    const payload = await apiRequest("/api/media/jobs", {
      body: {
        fileName: file.name,
        keepMedia: elements.keepMediaDefault.checked,
        sourceType: "local-upload",
        url,
      },
      method: "POST",
    });
    await binaryRequest(`/api/media/jobs/${payload.job.jobId}/source`, file);
    appState.lastSubmittedJobId = payload.job.jobId;
    elements.localMediaForm.reset();
    showToast("本机文件已进入离线转写队列。", "success");
    await loadMediaJobs();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    setButtonLoading(elements.localMediaSubmit, false, "正在接收…");
  }
}

async function retryMediaJob(job, button) {
  setButtonLoading(button, true, "重试中…");
  try {
    await apiRequest(`/api/media/jobs/${job.jobId}/retry`, { body: {}, method: "POST" });
    appState.lastSubmittedJobId = job.jobId;
    showToast("任务已重新进入队列。", "success");
    await loadMediaJobs();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    if (button.isConnected) setButtonLoading(button, false, "重试中…");
  }
}

async function cleanupMediaJob(job, button) {
  setButtonLoading(button, true, "清理中…");
  try {
    await apiRequest(`/api/media/jobs/${job.jobId}/cleanup`, { body: {}, method: "POST" });
    showToast("失败任务的临时文件已清理。", "success");
    await loadMediaJobs();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    if (button.isConnected) setButtonLoading(button, false, "清理中…");
  }
}

async function retryCapture(failure, button) {
  setButtonLoading(button, true, "重试中…");
  try {
    const payload = await apiRequest(`/api/failures/${failure.failureId}/retry`, { body: {}, method: "POST" });
    showResult("success", {
      icon: "✓",
      message: "失败记录已安全恢复，没有创建重复笔记。",
      path: payload.capture.notePath,
      title: "重试成功",
    });
    await loadFailures();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    if (button.isConnected) setButtonLoading(button, false, "重试中…");
  }
}

function restorePreference() {
  try {
    const stored = window.localStorage.getItem("vkc.keepMedia");
    elements.keepMediaDefault.checked = stored === null ? true : stored === "true";
  } catch {
    elements.keepMediaDefault.checked = true;
  }
}

elements.intakeForm.addEventListener("submit", submitIntake);
elements.configForm.addEventListener("submit", saveConfiguration);
elements.localMediaForm.addEventListener("submit", submitLocalMedia);
elements.retainedMediaOpen.addEventListener("click", openRetainedMediaDirectory);
elements.runtimeInstall.addEventListener("click", () => installRuntimeComponents());
elements.yuanbaoLogin.addEventListener("click", () => changeYuanbaoSession("start", elements.yuanbaoLogin));
elements.yuanbaoCancel.addEventListener("click", () => changeYuanbaoSession("cancel", elements.yuanbaoCancel));
elements.yuanbaoForget.addEventListener("click", () => changeYuanbaoSession("forget", elements.yuanbaoForget));
elements.wechatStart.addEventListener("click", () => changeWechatSidecar("start", elements.wechatStart));
elements.wechatStop.addEventListener("click", () => changeWechatSidecar("stop", elements.wechatStop));
elements.wechatCertInstall.addEventListener("click", () => changeWechatCertificate("install", elements.wechatCertInstall));
elements.wechatCertUninstall.addEventListener("click", () => changeWechatCertificate("uninstall", elements.wechatCertUninstall));
elements.keepMediaDefault.addEventListener("change", () => {
  try {
    window.localStorage.setItem("vkc.keepMedia", String(elements.keepMediaDefault.checked));
  } catch {
    // A blocked preference store does not prevent capture.
  }
});

elements.intakeUrl.addEventListener("paste", (event) => {
  const text = event.clipboardData?.getData("text")?.trim();
  if (!text || platformFromUrl(text) === "invalid") return;
  event.preventDefault();
  elements.intakeUrl.value = text;
  window.setTimeout(() => elements.intakeForm.requestSubmit(), 80);
});

document.body.addEventListener("dragover", (event) => {
  if (event.dataTransfer?.types?.includes("text/uri-list")) event.preventDefault();
});
document.body.addEventListener("drop", (event) => {
  const text = event.dataTransfer?.getData("text/uri-list")?.trim();
  if (!text || platformFromUrl(text) === "invalid") return;
  event.preventDefault();
  elements.intakeUrl.value = text;
  elements.intakeForm.requestSubmit();
});

restorePreference();
refreshAll().then(() => elements.intakeUrl.focus());
window.setInterval(() => {
  const active = appState.jobs.some((job) => ["queued", "running", "uploading"].includes(job.status));
  if (active || appState.yuanbao?.state === "waiting-for-login") {
    Promise.all([loadMediaJobs(), loadYuanbao()]).catch(() => {});
  }
}, 2500);
