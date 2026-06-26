from __future__ import annotations

import json
import os
import socket
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional

from config import ConfigLoader


def _env_flag(name: str) -> Optional[bool]:
    raw = os.getenv(name)
    if raw is None:
        return None
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def load_platform_settings(config_path: Optional[str]) -> Optional[Dict[str, Any]]:
    cfg = ConfigLoader(config_path).get("platform", {}) if config_path else {}
    if not isinstance(cfg, dict):
        cfg = {}

    enabled = _env_flag("YUEBAI_PLATFORM_JOB_SYNC")
    if enabled is None:
        enabled = bool(cfg.get("enabled") or cfg.get("base_url"))
    base_url = str(os.getenv("YUEBAI_AI_PLATFORM_URL") or cfg.get("base_url") or "").strip().rstrip("/")
    token = str(os.getenv("YUEBAI_AI_PLATFORM_TOKEN") or cfg.get("token") or "").strip()
    client_id = str(os.getenv("YUEBAI_COLLECTOR_CLIENT_ID") or cfg.get("client_id") or socket.gethostname()).strip()
    timeout_seconds = float(os.getenv("YUEBAI_AI_PLATFORM_TIMEOUT") or cfg.get("timeout_seconds") or 20)

    if not enabled:
        return None
    if not base_url:
        raise RuntimeError("平台任务同步已启用但缺少 platform.base_url")
    return {
        "base_url": base_url,
        "token": token,
        "client_id": client_id or socket.gethostname(),
        "timeout_seconds": timeout_seconds,
    }


class RemoteJobBackend:
    def __init__(self, settings: Dict[str, Any]):
        self._base_url = settings["base_url"].rstrip("/")
        self._token = settings.get("token") or ""
        self._client_id = settings.get("client_id") or socket.gethostname()
        self._timeout = float(settings.get("timeout_seconds") or 20)

    def _request(self, method: str, api_path: str, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        body = None
        headers = {
            "Accept": "application/json",
            "X-Yuebai-Collector-Client": self._client_id,
        }
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        if payload is not None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json; charset=utf-8"
        request = urllib.request.Request(
            f"{self._base_url}{api_path}",
            data=body,
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:
                raw = response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            try:
                parsed = json.loads(raw)
                message = parsed.get("error") or parsed.get("message") or raw
            except Exception:
                message = raw
            raise RuntimeError(f"平台任务接口请求失败：{message}") from exc
        parsed = json.loads(raw) if raw else {}
        if parsed.get("ok") is False:
            raise RuntimeError(str(parsed.get("error") or parsed.get("message") or "平台任务接口返回失败"))
        return parsed

    def ping(self) -> None:
        self._request("GET", "/api/content-assets/remote/jobs/health")

    def fail_inflight_jobs(self, reason: str) -> int:
        return 0

    def create_job(self, job_dict: Dict[str, Any]) -> None:
        self._request("POST", "/api/content-assets/remote/jobs", {"job": job_dict})

    def update_job(
        self,
        job_dict: Dict[str, Any],
        *,
        status: Optional[str] = None,
        result: Optional[Dict[str, Any]] = None,
        error: Optional[str] = None,
    ) -> None:
        payload = {
            "job": job_dict,
            "status": status,
            "result": result,
            "error": error,
        }
        self._request("POST", f"/api/content-assets/remote/jobs/{job_dict['id']}/update", payload)

    def get_job(self, job_id: str) -> Optional[Dict[str, Any]]:
        data = self._request("GET", f"/api/content-assets/remote/jobs/{job_id}")
        return data.get("job")

    def list_jobs(self) -> List[Dict[str, Any]]:
        data = self._request("GET", "/api/content-assets/remote/jobs")
        jobs = data.get("jobs")
        return jobs if isinstance(jobs, list) else []

    def delete_job(self, job_id: str) -> Optional[Dict[str, Any]]:
        data = self._request("POST", f"/api/content-assets/remote/jobs/{job_id}/delete")
        return data.get("job")


def build_remote_job_backend(config_path: Optional[str]) -> Optional[RemoteJobBackend]:
    settings = load_platform_settings(config_path)
    if not settings:
        return None
    backend = RemoteJobBackend(settings)
    backend.ping()
    return backend
