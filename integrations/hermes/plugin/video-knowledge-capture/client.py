"""Safe loopback client for the P0004 video knowledge capture service."""

from __future__ import annotations

import json
import re
import socket
import time
from typing import Any
from urllib import error, parse, request


P0004_BASE_URL = "http://127.0.0.1:43127"
MAX_RESPONSE_BYTES = 1024 * 1024
JOB_ID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


class ClientInputError(ValueError):
    """Raised when Hermes supplies an invalid structured argument."""

    def __init__(self, message: str, code: str):
        super().__init__(message)
        self.code = code


class P0004HttpError(RuntimeError):
    """A bounded, sanitized error returned by the local P0004 service."""

    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code


def _validate_video_url(value: Any) -> str:
    if not isinstance(value, str):
        raise ClientInputError("请发送一条公开视频链接。", "INVALID_VIDEO_URL")
    normalized = value.strip()
    if not normalized or len(normalized) > 4096:
        raise ClientInputError("视频链接为空或过长。", "INVALID_VIDEO_URL")
    if any(ord(character) < 32 for character in normalized):
        raise ClientInputError("视频链接包含无效控制字符。", "INVALID_VIDEO_URL")
    try:
        parsed = parse.urlsplit(normalized)
        hostname = parsed.hostname
    except ValueError as exc:
        raise ClientInputError("视频链接格式无效。", "INVALID_VIDEO_URL") from exc
    if parsed.scheme.lower() not in {"http", "https"} or not hostname:
        raise ClientInputError("只接受 http 或 https 公公开视频链接。", "INVALID_VIDEO_URL")
    if parsed.username is not None or parsed.password is not None:
        raise ClientInputError("链接不得包含用户名或密码。", "URL_CREDENTIALS_REJECTED")
    return normalized


def _validate_job_id(value: Any) -> str:
    if not isinstance(value, str) or not JOB_ID_PATTERN.fullmatch(value.strip()):
        raise ClientInputError("任务编号格式无效。", "INVALID_JOB_ID")
    return value.strip().lower()


def _validate_wait_seconds(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ClientInputError("等待秒数必须是 0 到 120 的数字。", "INVALID_WAIT_SECONDS")
    wait_seconds = float(value)
    if wait_seconds < 0 or wait_seconds > 120:
        raise ClientInputError("等待秒数必须在 0 到 120 之间。", "INVALID_WAIT_SECONDS")
    return wait_seconds


def _next_action(code: str, *, retryable: bool = True) -> str:
    actions = {
        "CONFIG_REQUIRED": "在家庭电脑打开视频知识捕手，先配置并验证 Obsidian Inbox。",
        "WECHAT_SETUP_REQUIRED": "在家庭电脑打开视频知识捕手设置，启用微信高级模式并完成本地授权。",
        "WECHAT_ADVANCED_MODE_DISABLED": "在家庭电脑打开视频知识捕手设置，启用微信高级模式。",
        "YUANBAO_LOGIN_REQUIRED": "在家庭电脑的视频知识捕手中重新完成腾讯元宝隔离登录。",
        "P0004_UNAVAILABLE": "确认家庭电脑已开机，并启动 start-video-capture.cmd 后重新发送链接。",
        "INVALID_VIDEO_URL": "重新发送一条完整的 http 或 https 公公开视频链接。",
        "URL_CREDENTIALS_REJECTED": "删除链接中的用户名或密码后重新发送公开链接。",
        "INVALID_JOB_ID": "使用首次回执中的完整 job_id 查询。",
        "INVALID_WAIT_SECONDS": "将 wait_seconds 设置为 0 到 120。",
    }
    if code in actions:
        return actions[code]
    if retryable:
        return "保留该任务编号；处理条件恢复后可重新发送原链接，或再次查询任务状态。"
    return "检查链接和本机设置后再提交；不要把当前结果视为已入库。"


def _failure(
    code: str,
    message: str,
    *,
    retryable: bool,
    state: str = "failed",
    http_status: int | None = None,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "state": state,
        "code": code,
        "message": message,
        "retryable": retryable,
        "next_action": _next_action(code, retryable=retryable),
    }
    if http_status is not None:
        result["http_status"] = http_status
    return result


class P0004Client:
    """Submit and query P0004 jobs without invoking a shell."""

    def __init__(
        self,
        base_url: str = P0004_BASE_URL,
        *,
        request_timeout: float = 10.0,
        poll_interval: float = 1.0,
    ) -> None:
        parsed = parse.urlsplit(base_url)
        if parsed.scheme != "http" or parsed.hostname != "127.0.0.1":
            raise ValueError("P0004 base URL must use http://127.0.0.1.")
        if parsed.username is not None or parsed.password is not None:
            raise ValueError("P0004 base URL must not contain credentials.")
        self.base_url = base_url.rstrip("/")
        self.request_timeout = max(0.1, float(request_timeout))
        self.poll_interval = max(0.02, float(poll_interval))

    def _request_json(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        body = None
        headers = {"Accept": "application/json"}
        if payload is not None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        http_request = request.Request(
            f"{self.base_url}{path}",
            data=body,
            headers=headers,
            method=method,
        )
        try:
            with request.urlopen(http_request, timeout=self.request_timeout) as response:
                raw = response.read(MAX_RESPONSE_BYTES + 1)
        except error.HTTPError as exc:
            raw = exc.read(MAX_RESPONSE_BYTES + 1)
            code = f"P0004_HTTP_{exc.code}"
            message = "视频知识捕手拒绝了请求。"
            if len(raw) <= MAX_RESPONSE_BYTES:
                try:
                    parsed_error = json.loads(raw.decode("utf-8"))
                    error_payload = parsed_error.get("error") or {}
                    code = str(error_payload.get("code") or code)[:100]
                    message = str(error_payload.get("message") or message)[:500]
                except (UnicodeDecodeError, json.JSONDecodeError, AttributeError):
                    pass
            raise P0004HttpError(exc.code, code, message) from exc
        except (error.URLError, socket.timeout, TimeoutError, ConnectionError) as exc:
            raise ConnectionError("无法连接本机视频知识捕手。") from exc

        if len(raw) > MAX_RESPONSE_BYTES:
            raise P0004HttpError(502, "P0004_RESPONSE_TOO_LARGE", "本机服务返回内容过大。")
        try:
            parsed_response = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise P0004HttpError(502, "P0004_INVALID_RESPONSE", "本机服务返回了无效响应。") from exc
        if not isinstance(parsed_response, dict):
            raise P0004HttpError(502, "P0004_INVALID_RESPONSE", "本机服务返回结构无效。")
        return parsed_response

    def _safe_call(self, operation):
        try:
            return operation()
        except ClientInputError as exc:
            return _failure(exc.code, str(exc), retryable=False)
        except P0004HttpError as exc:
            retryable = exc.status >= 500 or exc.code in {
                "CONFIG_REQUIRED",
                "WECHAT_SETUP_REQUIRED",
                "WECHAT_ADVANCED_MODE_DISABLED",
                "YUANBAO_LOGIN_REQUIRED",
            }
            return _failure(
                exc.code,
                str(exc),
                retryable=retryable,
                http_status=exc.status,
            )
        except ConnectionError:
            return _failure(
                "P0004_UNAVAILABLE",
                "家庭电脑上的视频知识捕手当前不可连接。",
                retryable=True,
                state="unavailable",
            )
        except Exception:
            return _failure(
                "P0004_BRIDGE_FAILED",
                "Hermes 与本机视频知识捕手之间的调用失败。",
                retryable=True,
            )

    def capture(self, video_url: Any, wait_seconds: Any = 90) -> dict[str, Any]:
        def operation() -> dict[str, Any]:
            normalized_url = _validate_video_url(video_url)
            bounded_wait = _validate_wait_seconds(wait_seconds)
            response = self._request_json(
                "POST",
                "/api/intakes",
                {"keepMedia": True, "url": normalized_url},
            )
            intake = response.get("intake") or {}
            platform = intake.get("platform") or {}
            platform_id = platform.get("id") if isinstance(platform, dict) else None

            if intake.get("kind") == "link-note":
                capture = response.get("capture") or {}
                capture_status = capture.get("status")
                if capture_status not in {"created", "duplicate"}:
                    raise P0004HttpError(
                        502,
                        "P0004_INVALID_RESPONSE",
                        "本机服务没有返回有效的链接笔记状态。",
                    )
                return {
                    "state": "duplicate" if capture_status == "duplicate" else "completed",
                    "kind": "link-note",
                    "capture_status": capture_status,
                    "capture_id": capture.get("captureId"),
                    "platform": platform_id,
                    "note_path": capture.get("notePath"),
                    "retained_media_path": None,
                    "message": "链接笔记已存在。" if capture_status == "duplicate" else "链接笔记已写入知识库。",
                }

            if intake.get("kind") != "media-job":
                raise P0004HttpError(
                    502,
                    "P0004_INVALID_RESPONSE",
                    "本机服务没有返回有效的采集类型。",
                )
            job = response.get("job") or {}
            job_id = _validate_job_id(job.get("jobId"))
            return self._wait_for_job(job_id, bounded_wait, platform_id, initial_job=job)

        return self._safe_call(operation)

    def status(self, job_id: Any) -> dict[str, Any]:
        def operation() -> dict[str, Any]:
            normalized_job_id = _validate_job_id(job_id)
            response = self._request_json("GET", f"/api/media/jobs/{normalized_job_id}")
            return self._summarize_job(response.get("job"), platform_id=None)

        return self._safe_call(operation)

    def _wait_for_job(
        self,
        job_id: str,
        wait_seconds: float,
        platform_id: str | None,
        *,
        initial_job: Any,
    ) -> dict[str, Any]:
        summary = self._summarize_job(initial_job, platform_id=platform_id)
        if summary["state"] != "processing" or wait_seconds == 0:
            return summary

        deadline = time.monotonic() + wait_seconds
        while time.monotonic() < deadline:
            time.sleep(min(self.poll_interval, max(0.0, deadline - time.monotonic())))
            response = self._request_json("GET", f"/api/media/jobs/{job_id}")
            summary = self._summarize_job(response.get("job"), platform_id=platform_id)
            if summary["state"] != "processing":
                return summary
        summary["message"] = "任务仍在本机处理中，可稍后用 job_id 查询。"
        summary["next_action"] = "稍后调用 video_knowledge_status 查询同一 job_id。"
        return summary

    def _summarize_job(self, job: Any, platform_id: str | None) -> dict[str, Any]:
        if not isinstance(job, dict):
            raise P0004HttpError(502, "P0004_INVALID_RESPONSE", "本机服务没有返回任务。")
        job_id = _validate_job_id(job.get("jobId"))
        status = job.get("status")
        source_type = job.get("sourceType")
        if status == "completed":
            result = job.get("result") or {}
            capture_status = result.get("captureStatus")
            state = "duplicate" if capture_status == "duplicate" else "completed"
            retained_media_path = result.get("retainedMediaPath") or job.get("retainedMediaPath")
            if isinstance(retained_media_path, str):
                retained_media_path = retained_media_path[:4096] or None
            else:
                retained_media_path = None
            message = "视频已存在于知识库。" if state == "duplicate" else "视频已下载、转写并写入知识库。"
            message += (
                f" 视频保留位置：{retained_media_path}"
                if retained_media_path
                else " 本次任务未返回保留视频路径，请在家庭电脑查看任务详情。"
            )
            return {
                "state": state,
                "kind": "media-job",
                "job_id": job_id,
                "capture_status": capture_status,
                "capture_id": result.get("captureId"),
                "platform": platform_id,
                "source_type": source_type,
                "note_path": result.get("notePath"),
                "retained_media_path": retained_media_path,
                "segment_count": result.get("segmentCount"),
                "transcript_char_count": result.get("transcriptCharCount"),
                "message": message,
            }
        if status == "failed":
            job_error = job.get("error") or {}
            code = str(job_error.get("code") or "MEDIA_JOB_FAILED")[:100]
            retryable = bool(job.get("retryable") or job_error.get("retryable"))
            details = job_error.get("details")
            if not isinstance(details, dict):
                details = {}
            result = _failure(
                code,
                str(job_error.get("message") or "本机视频任务失败。")[:500],
                retryable=retryable,
            )
            result.update({
                "kind": "media-job",
                "job_id": job_id,
                "source_type": source_type,
                "stage": job.get("stage"),
            })
            failure_category = details.get("failureCategory")
            if isinstance(failure_category, str) and failure_category:
                result["failure_category"] = failure_category[:100]
            download_profile = details.get("profile")
            if isinstance(download_profile, str) and download_profile:
                result["download_profile"] = download_profile[:100]
            format_id = details.get("formatId")
            if isinstance(format_id, str) and format_id:
                result["download_format_id"] = format_id[:100]
            resolution = details.get("resolution")
            if isinstance(resolution, str) and resolution:
                result["download_resolution"] = resolution[:100]
            for source_key, result_key in (
                ("attempt", "download_attempt"),
                ("attempts", "download_attempts"),
                ("estimatedSize", "estimated_size"),
                ("exitCode", "downloader_exit_code"),
            ):
                value = details.get(source_key)
                if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0:
                    result[result_key] = value
            if code == "PUBLIC_MEDIA_DOWNLOAD_FAILED":
                if failure_category == "transfer-failed":
                    result["next_action"] = "稍后重新发送原链接；P0004 会再次使用较小的兼容媒体格式。"
                elif failure_category == "login-required":
                    result["next_action"] = "该链接要求登录或人机验证；请改发无需登录即可播放的公开链接。"
                elif failure_category in {"access-restricted", "content-unavailable"}:
                    result["next_action"] = "检查视频是否仍公开可播放；P0004 不会读取 Cookie 或绕过访问限制。"
            return result
        if status not in {"queued", "waiting-for-upload", "running", "processing"}:
            raise P0004HttpError(502, "P0004_INVALID_RESPONSE", "本机服务返回了未知任务状态。")
        return {
            "state": "processing",
            "kind": "media-job",
            "job_id": job_id,
            "platform": platform_id,
            "source_type": source_type,
            "stage": job.get("stage"),
            "message": "任务已由家庭电脑接收，正在下载或转写。",
        }
