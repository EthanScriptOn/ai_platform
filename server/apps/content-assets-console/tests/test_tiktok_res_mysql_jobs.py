from __future__ import annotations

from typing import Any, Dict, List, Optional

import pytest

from tiktok_res_app import mysql_jobs, services


class FakeBackend:
    def __init__(self) -> None:
        self.jobs: Dict[str, Dict[str, Any]] = {}
        self.created: List[str] = []
        self.updated: List[str] = []
        self.deleted: List[str] = []
        self.recovered: List[str] = []

    def create_job(self, job_dict: Dict[str, Any]) -> None:
        self.created.append(job_dict["id"])
        self.jobs[job_dict["id"]] = job_dict

    def update_job(
        self,
        job_dict: Dict[str, Any],
        *,
        status: Optional[str] = None,
        result: Optional[Dict[str, Any]] = None,
        error: Optional[str] = None,
    ) -> None:
        self.updated.append(job_dict["id"])
        self.jobs[job_dict["id"]] = job_dict

    def get_job(self, job_id: str) -> Optional[Dict[str, Any]]:
        job = self.jobs.get(job_id)
        if not job:
            return None
        return {
            "id": job["id"],
            "type": job["type"],
            "status": job["status"],
            "created_at": job["created_at"],
            "updated_at": job["updated_at"],
            "input": job["input"],
            "result": job.get("result"),
            "error": job.get("error"),
        }

    def list_jobs(self) -> List[Dict[str, Any]]:
        return [self.get_job(job_id) for job_id in self.jobs]

    def delete_job(self, job_id: str) -> Optional[Dict[str, Any]]:
        self.deleted.append(job_id)
        return self.get_job(job_id)

    def fail_inflight_jobs(self, reason: str) -> int:
        self.recovered.append(reason)
        return 0


def test_load_mysql_settings_from_env(monkeypatch):
    monkeypatch.setenv("TIKTOK_RES_MYSQL_ENABLED", "1")
    monkeypatch.setenv("TIKTOK_RES_MYSQL_HOST", "127.0.0.1")
    monkeypatch.setenv("TIKTOK_RES_MYSQL_PORT", "3306")
    monkeypatch.setenv("TIKTOK_RES_MYSQL_USER", "tester")
    monkeypatch.setenv("TIKTOK_RES_MYSQL_PASSWORD", "secret")
    monkeypatch.setenv("TIKTOK_RES_MYSQL_DATABASE", "tiktok_res")

    settings = mysql_jobs.load_mysql_settings(None)

    assert settings == {
        "host": "127.0.0.1",
        "port": 3306,
        "user": "tester",
        "password": "secret",
        "database": "tiktok_res",
    }


def test_load_mysql_settings_raises_on_partial_config(tmp_path):
    config_path = tmp_path / "config.yml"
    config_path.write_text(
        """
mysql:
  enabled: true
  host: 127.0.0.1
  user: tester
""".strip(),
        encoding="utf-8",
    )

    with pytest.raises(RuntimeError, match="配置不完整"):
        mysql_jobs.load_mysql_settings(str(config_path))


@pytest.mark.asyncio
async def test_job_store_uses_backend_when_available(monkeypatch):
    backend = FakeBackend()
    monkeypatch.setattr(services, "build_job_backend", lambda config_path: backend)
    store = services.JobStore(config_path="config.yml")

    job = await store.create("video_download", {"url": "https://example.com"})
    await store.update(job.id, status="completed", result={"ok": True})

    fetched = await store.get(job.id)
    listed = await store.list()
    deleted = await store.delete(job.id)

    assert backend.created == [job.id]
    assert backend.updated == [job.id]
    assert fetched is not None and fetched["id"] == job.id
    assert listed and listed[0]["id"] == job.id
    assert deleted is not None and deleted["id"] == job.id
    assert backend.deleted == [job.id]


def test_job_store_recovers_inflight_backend_jobs_on_init(monkeypatch):
    backend = FakeBackend()
    monkeypatch.setattr(services, "build_job_backend", lambda config_path: backend)

    services.JobStore(config_path="config.yml")

    assert backend.recovered == ["服务启动时发现任务已中断，已自动标记为失败，请重新提交。"]
