from __future__ import annotations

import asyncio
import json
import socket
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Optional

from config import ConfigLoader


def load_agent_settings(config_path: Optional[str]) -> Optional[Dict[str, Any]]:
    cfg = ConfigLoader(config_path).get("platform", {}) if config_path else {}
    if not isinstance(cfg, dict):
        cfg = {}
    enabled = bool(cfg.get("enabled") or cfg.get("base_url"))
    base_url = str(cfg.get("base_url") or "").strip().rstrip("/")
    token = str(cfg.get("token") or "").strip()
    client_id = str(cfg.get("client_id") or socket.gethostname()).strip() or socket.gethostname()
    timeout_seconds = float(cfg.get("timeout_seconds") or 20)
    local_base_url = str(cfg.get("local_base_url") or "http://127.0.0.1:8767").strip().rstrip("/")

    if not enabled:
        return None
    if not base_url:
        return None
    return {
        "base_url": base_url,
        "token": token,
        "client_id": client_id,
        "timeout_seconds": timeout_seconds,
        "local_base_url": local_base_url,
    }


class PlatformAgent:
    def __init__(self, settings: Dict[str, Any]) -> None:
        self.base_url = settings["base_url"].rstrip("/")
        self.token = settings.get("token") or ""
        self.client_id = settings.get("client_id") or socket.gethostname()
        self.timeout = float(settings.get("timeout_seconds") or 20)
        self.local_base_url = settings.get("local_base_url") or "http://127.0.0.1:8767"

    def _headers(self) -> Dict[str, str]:
        headers = {
            "Accept": "application/json",
            "X-Yuebai-Collector-Client": self.client_id,
        }
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        return headers

    def _request(
        self,
        method: str,
        url: str,
        payload: Optional[Dict[str, Any]] = None,
        *,
        headers: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        body = None
        request_headers = {**(headers or {})}
        if payload is not None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            request_headers["Content-Type"] = "application/json; charset=utf-8"
        request = urllib.request.Request(url, data=body, headers=request_headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                raw = response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            try:
                parsed = json.loads(raw)
                message = parsed.get("error") or parsed.get("message") or parsed.get("detail") or raw
            except Exception:
                message = raw
            raise RuntimeError(message) from exc
        return json.loads(raw) if raw else {}

    def _platform_request(
        self,
        method: str,
        api_path: str,
        payload: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        return self._request(method, f"{self.base_url}{api_path}", payload, headers=self._headers())

    def _local_request(self, method: str, api_path: str, command_options: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        options = command_options or {}
        body = options.get("body")
        payload = None
        if body:
            try:
                payload = json.loads(body)
            except Exception:
                payload = {"raw": body}
        headers = options.get("headers") if isinstance(options.get("headers"), dict) else {}
        return self._request(method, f"{self.local_base_url}{api_path}", payload, headers=headers)

    def collect_status(self) -> Dict[str, Any]:
        status: Dict[str, Any] = {"ok": True, "connected": True, "installed": True}
        try:
            health = self._local_request("GET", "/api/health")
            status["message"] = health.get("video_product_mapping_message") or "抖音本地执行端已连接。"
            status["data"] = {"health": health}
        except Exception as exc:
            status.update({"ok": False, "message": f"本地健康检查失败：{exc}"})

        try:
            auth = self._local_request("GET", "/api/auth/status")
            status["likely_logged_in"] = bool(auth.get("likely_logged_in"))
            status["has_cookie"] = bool(auth.get("has_cookie"))
            status.setdefault("data", {})["auth"] = auth
        except Exception:
            pass

        try:
            jobs = self._local_request("GET", "/api/jobs").get("jobs") or []
            status["job_count"] = len(jobs)
            status["running_count"] = len([job for job in jobs if job.get("status") in {"queued", "running"}])
            if jobs:
                latest = max(jobs, key=lambda job: float(job.get("updated_at") or job.get("created_at") or 0))
                status["last_job_at"] = str(latest.get("updated_at") or latest.get("created_at") or "")
        except Exception:
            pass
        return status

    def report_status(self) -> None:
        self._platform_request(
            "POST",
            "/api/content-assets/agent/status",
            {"clientId": self.client_id, "status": self.collect_status()},
        )

    def poll_command(self) -> Dict[str, Any]:
        return self._platform_request(
            "GET",
            f"/api/content-assets/agent/command?clientId={urllib.parse.quote(self.client_id)}",
        ).get("command") or {"noop": True}

    def report_command_result(self, command_id: str, payload: Dict[str, Any]) -> None:
        self._platform_request(
            "POST",
            "/api/content-assets/agent/command-result",
            {"clientId": self.client_id, "commandId": command_id, "payload": payload},
        )

    def run_command(self, command: Dict[str, Any]) -> Dict[str, Any]:
        command_id = command.get("id") or ""
        if not command_id or command.get("noop"):
            return {}
        path = str(command.get("path") or "")
        if not path.startswith("/api/"):
            return {"ok": False, "error": "invalid command path"}
        options = command.get("options") if isinstance(command.get("options"), dict) else {}
        method = str(options.get("method") or "GET").upper()
        try:
            payload = self._local_request(method, path, options)
        except Exception as exc:
            payload = {"ok": False, "error": str(exc)}
        self.report_command_result(command_id, payload)
        return payload


async def run_platform_agent(config_path: Optional[str]) -> None:
    settings = load_agent_settings(config_path)
    if not settings:
        return
    agent = PlatformAgent(settings)
    while True:
        try:
            await asyncio.to_thread(agent.report_status)
            command = await asyncio.to_thread(agent.poll_command)
            if command and not command.get("noop"):
                await asyncio.to_thread(agent.run_command, command)
        except Exception:
            pass
        await asyncio.sleep(3)
