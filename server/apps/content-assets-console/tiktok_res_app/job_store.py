from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import asdict, dataclass
from typing import Any, Dict, List, Optional

from tiktok_res_app.mysql_jobs import build_job_backend
from tiktok_res_app.remote_jobs import build_remote_job_backend
from utils.asyncio_compat import to_thread


@dataclass
class Job:
    id: str
    type: str
    status: str
    created_at: float
    updated_at: float
    input: Dict[str, Any]
    result: Optional[Dict[str, Any]] = None
    error: Optional[str] = None


class JobStore:
    def __init__(self, *, config_path: Optional[str] = None) -> None:
        self._jobs: Dict[str, Job] = {}
        self._lock = asyncio.Lock()
        self._backend = build_remote_job_backend(config_path) or build_job_backend(config_path)
        if self._backend and hasattr(self._backend, "fail_inflight_jobs"):
            self._backend.fail_inflight_jobs(
                "服务启动时发现任务已中断，已自动标记为失败，请重新提交。"
            )

    async def create(self, job_type: str, payload: Dict[str, Any]) -> Job:
        now = time.time()
        job = Job(
            id=uuid.uuid4().hex,
            type=job_type,
            status="queued",
            created_at=now,
            updated_at=now,
            input=payload,
        )
        async with self._lock:
            self._jobs[job.id] = job
        if self._backend:
            await to_thread(self._backend.create_job, asdict(job))
        return job

    async def update(
        self,
        job_id: str,
        *,
        status: Optional[str] = None,
        result: Optional[Dict[str, Any]] = None,
        error: Optional[str] = None,
    ) -> None:
        snapshot: Optional[Dict[str, Any]] = None
        async with self._lock:
            job = self._jobs.get(job_id)
            if job is not None:
                if status is not None:
                    job.status = status
                if result is not None:
                    job.result = result
                if error is not None:
                    job.error = error
                job.updated_at = time.time()
                snapshot = asdict(job)
        if snapshot is None:
            if not self._backend:
                return
            snapshot = await to_thread(self._backend.get_job, job_id)
            if not snapshot:
                return
            if status is not None:
                snapshot["status"] = status
            if result is not None:
                snapshot["result"] = result
            if error is not None:
                snapshot["error"] = error
            snapshot["updated_at"] = time.time()
        if self._backend:
            await to_thread(
                self._backend.update_job,
                snapshot,
                status=status,
                result=result,
                error=error,
            )

    async def get(self, job_id: str) -> Optional[Dict[str, Any]]:
        if self._backend:
            job = await to_thread(self._backend.get_job, job_id)
            if job:
                return job
        async with self._lock:
            job = self._jobs.get(job_id)
            return asdict(job) if job else None

    async def delete(self, job_id: str) -> Optional[Dict[str, Any]]:
        deleted = None
        if self._backend:
            deleted = await to_thread(self._backend.delete_job, job_id)
        async with self._lock:
            job = self._jobs.pop(job_id, None)
            if job:
                return asdict(job)
        return deleted

    async def list(self) -> List[Dict[str, Any]]:
        if self._backend:
            return await to_thread(self._backend.list_jobs)
        async with self._lock:
            return [asdict(job) for job in sorted(self._jobs.values(), key=lambda item: item.created_at, reverse=True)]
