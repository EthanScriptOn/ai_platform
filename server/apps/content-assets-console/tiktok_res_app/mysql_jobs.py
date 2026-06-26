from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import asdict
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from config import ConfigLoader


logger = logging.getLogger("tiktok_res.mysql_jobs")
LOCAL_DOWNLOADED_ROOT = (Path(__file__).resolve().parents[1] / "Downloaded").resolve()


def _env_flag(name: str) -> Optional[bool]:
    raw = os.getenv(name)
    if raw is None:
        return None
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _job_source_type(job_type: str) -> str:
    if job_type.startswith("live_"):
        return "live"
    if job_type in {"product_match", "video_product_map"}:
        return "product_match"
    return "video"


def _source_identity_from_url(url: str) -> Optional[str]:
    if not url:
        return None
    patterns = (
        r"live\.douyin\.com/(\d+)",
        r"/(?:follow/)?live/(\d+)",
        r"/video/(\d+)",
        r"/note/(\d+)",
    )
    for pattern in patterns:
        match = re.search(pattern, url)
        if match:
            return match.group(1)
    return None


def _source_identity_from_result(result: Optional[Dict[str, Any]]) -> Optional[str]:
    if not isinstance(result, dict):
        return None
    value = str(result.get("source_identity") or "").strip()
    if value:
        return value
    parsed = result.get("parsed")
    if isinstance(parsed, dict):
        for key in ("room_id", "aweme_id", "note_id", "mix_id", "music_id"):
            value = str(parsed.get(key) or "").strip()
            if value:
                return value
    recording = result.get("recording")
    if isinstance(recording, dict):
        nested = _source_identity_from_result(recording)
        if nested:
            return nested
    products = result.get("products")
    if isinstance(products, dict):
        value = str(products.get("web_rid") or products.get("room_id") or "").strip()
        if value:
            return value
    value = str(result.get("web_rid") or result.get("room_id") or "").strip()
    return value or None


def _remap_downloaded_path(value: str) -> str:
    normalized = str(value or "").replace("\\", "/")
    marker = "/Downloaded"
    index = normalized.find(marker)
    if index < 0:
        return value
    suffix = normalized[index + len(marker):].lstrip("/")
    if not suffix:
        return str(LOCAL_DOWNLOADED_ROOT)
    return str((LOCAL_DOWNLOADED_ROOT / suffix).resolve())


def _rewrite_downloaded_paths(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _rewrite_downloaded_paths(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_rewrite_downloaded_paths(item) for item in value]
    if isinstance(value, str) and "/Downloaded" in value.replace("\\", "/"):
        return _remap_downloaded_path(value)
    return value


def load_mysql_settings(config_path: Optional[str]) -> Optional[Dict[str, Any]]:
    env_enabled = _env_flag("TIKTOK_RES_MYSQL_ENABLED")
    env_host = os.getenv("TIKTOK_RES_MYSQL_HOST")
    env_user = os.getenv("TIKTOK_RES_MYSQL_USER")
    env_password = os.getenv("TIKTOK_RES_MYSQL_PASSWORD")
    env_database = os.getenv("TIKTOK_RES_MYSQL_DATABASE")
    env_port = os.getenv("TIKTOK_RES_MYSQL_PORT")

    cfg = ConfigLoader(config_path).get("mysql", {}) if config_path else {}
    if not isinstance(cfg, dict):
        cfg = {}

    enabled = env_enabled if env_enabled is not None else bool(cfg.get("enabled"))
    host = env_host or str(cfg.get("host") or "").strip()
    user = env_user or str(cfg.get("user") or "").strip()
    password = env_password or str(cfg.get("password") or "").strip()
    database = env_database or str(cfg.get("database") or "").strip()
    try:
        port = int(env_port or cfg.get("port") or 3306)
    except (TypeError, ValueError):
        port = 3306

    has_any_mysql_config = bool(
        env_enabled is not None
        or env_port
        or host
        or user
        or password
        or database
        or cfg.get("enabled")
    )

    if not has_any_mysql_config:
        return None
    if not (host and user and password and database):
        raise RuntimeError("MySQL 已启用但配置不完整，请检查 host/user/password/database")

    return {
        "host": host,
        "port": port,
        "user": user,
        "password": password,
        "database": database,
    }


class MySQLJobBackend:
    def __init__(self, settings: Dict[str, Any]):
        try:
            import pymysql
            from pymysql.cursors import DictCursor
        except ImportError as exc:  # pragma: no cover - exercised in deployment
            raise RuntimeError("缺少 pymysql，请先安装 MySQL 依赖") from exc

        self._pymysql = pymysql
        self._dict_cursor = DictCursor
        self._settings = settings

    def _connect(self):
        return self._pymysql.connect(
            host=self._settings["host"],
            port=int(self._settings["port"]),
            user=self._settings["user"],
            password=self._settings["password"],
            database=self._settings["database"],
            charset="utf8mb4",
            autocommit=True,
            cursorclass=self._dict_cursor,
        )

    @staticmethod
    def _dt_from_epoch(value: float) -> datetime:
        return datetime.fromtimestamp(float(value))

    @staticmethod
    def _epoch_from_dt(value: Optional[datetime]) -> float:
        if value is None:
            return 0.0
        return value.timestamp()

    def _row_to_job(self, row: Dict[str, Any]) -> Dict[str, Any]:
        result_raw = row.get("result_json")
        input_raw = row.get("input_json")
        return {
            "id": row["job_uid"],
            "type": row["job_type"],
            "status": row["status"],
            "created_at": self._epoch_from_dt(row.get("created_at")),
            "updated_at": self._epoch_from_dt(row.get("updated_at")),
            "input": result_or_default(input_raw, {}),
            "result": _rewrite_downloaded_paths(result_or_default(result_raw, None)),
            "error": row.get("error_text"),
        }

    def ping(self) -> None:
        with self._connect() as conn:
            with conn.cursor() as cursor:
                cursor.execute("SELECT 1")

    def fail_inflight_jobs(self, reason: str) -> int:
        now = datetime.now()
        with self._connect() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    UPDATE asset_jobs
                    SET status = 'failed',
                        error_text = %s,
                        finished_at = COALESCE(finished_at, %s),
                        updated_at = %s
                    WHERE deleted_at IS NULL
                      AND status IN ('queued', 'running')
                    """,
                    (reason, now, now),
                )
                return int(cursor.rowcount or 0)

    def create_job(self, job_dict: Dict[str, Any]) -> None:
        payload = job_dict.get("input") or {}
        source_url = str(payload.get("url") or "")
        source_identity = _source_identity_from_url(source_url)
        with self._connect() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO asset_jobs
                    (job_uid, job_type, status, source_url, source_type, source_identity, input_json,
                     created_at, updated_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON DUPLICATE KEY UPDATE
                      job_type = VALUES(job_type),
                      status = VALUES(status),
                      source_url = VALUES(source_url),
                      source_type = VALUES(source_type),
                      source_identity = COALESCE(asset_jobs.source_identity, VALUES(source_identity)),
                      input_json = VALUES(input_json),
                      updated_at = VALUES(updated_at),
                      deleted_at = NULL
                    """,
                    (
                        job_dict["id"],
                        job_dict["type"],
                        job_dict["status"],
                        source_url or None,
                        _job_source_type(job_dict["type"]),
                        source_identity,
                        json.dumps(payload, ensure_ascii=False),
                        self._dt_from_epoch(job_dict["created_at"]),
                        self._dt_from_epoch(job_dict["updated_at"]),
                    ),
                )

    def update_job(
        self,
        job_dict: Dict[str, Any],
        *,
        status: Optional[str] = None,
        result: Optional[Dict[str, Any]] = None,
        error: Optional[str] = None,
    ) -> None:
        next_status = status or job_dict["status"]
        result_json = job_dict.get("result") if result is None else result
        error_text = job_dict.get("error") if error is None else error
        source_identity = _source_identity_from_result(result_json) or _source_identity_from_url(
            str((job_dict.get("input") or {}).get("url") or "")
        )
        started_at = self._dt_from_epoch(job_dict["updated_at"]) if next_status == "running" else None
        finished_at = (
            self._dt_from_epoch(job_dict["updated_at"])
            if next_status in {"completed", "failed", "cancelled", "deleted"}
            else None
        )
        with self._connect() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    UPDATE asset_jobs
                    SET status = %s,
                        source_identity = COALESCE(%s, source_identity),
                        result_json = %s,
                        error_text = %s,
                        started_at = CASE
                            WHEN %s IS NOT NULL AND started_at IS NULL THEN %s
                            ELSE started_at
                        END,
                        finished_at = CASE
                            WHEN %s IS NOT NULL THEN %s
                            ELSE finished_at
                        END,
                        updated_at = %s
                    WHERE job_uid = %s AND deleted_at IS NULL
                    """,
                    (
                        next_status,
                        source_identity,
                        json.dumps(result_json, ensure_ascii=False) if result_json is not None else None,
                        error_text,
                        started_at,
                        started_at,
                        finished_at,
                        finished_at,
                        self._dt_from_epoch(job_dict["updated_at"]),
                        job_dict["id"],
                    ),
                )

    def get_job(self, job_id: str) -> Optional[Dict[str, Any]]:
        with self._connect() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT job_uid, job_type, status, input_json, result_json, error_text,
                           created_at, updated_at
                    FROM asset_jobs
                    WHERE job_uid = %s AND deleted_at IS NULL
                    LIMIT 1
                    """,
                    (job_id,),
                )
                row = cursor.fetchone()
        return self._row_to_job(row) if row else None

    def list_jobs(self) -> List[Dict[str, Any]]:
        with self._connect() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT job_uid, job_type, status, input_json, result_json, error_text,
                           created_at, updated_at
                    FROM asset_jobs
                    WHERE deleted_at IS NULL
                    ORDER BY id DESC
                    """
                )
                rows = cursor.fetchall() or []
        return [self._row_to_job(row) for row in rows]

    def delete_job(self, job_id: str) -> Optional[Dict[str, Any]]:
        existing = self.get_job(job_id)
        if not existing:
            return None
        now = datetime.now()
        with self._connect() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    UPDATE asset_jobs
                    SET status = 'deleted', deleted_at = %s, updated_at = %s, finished_at = COALESCE(finished_at, %s)
                    WHERE job_uid = %s AND deleted_at IS NULL
                    """,
                    (now, now, now, job_id),
                )
        return existing


def build_job_backend(config_path: Optional[str]) -> Optional[MySQLJobBackend]:
    settings = load_mysql_settings(config_path)
    if not settings:
        return None
    backend = MySQLJobBackend(settings)
    backend.ping()
    logger.info(
        "MySQL job backend enabled: %s:%s/%s",
        settings["host"],
        settings["port"],
        settings["database"],
    )
    return backend


def result_or_default(raw: Any, default: Any) -> Any:
    if raw is None:
        return default
    if isinstance(raw, (dict, list)):
        return raw
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except Exception:
            return default
    return default
