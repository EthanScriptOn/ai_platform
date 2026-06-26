from __future__ import annotations

import email.utils
import hashlib
import hmac
import mimetypes
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict

from config import ConfigLoader


class OssUploader:
    def __init__(self, config: ConfigLoader) -> None:
        self.config = config

    def _cfg(self) -> Dict[str, Any]:
        return self.config.get("oss", {}) or {}

    def resolve_settings(self) -> Dict[str, str]:
        cfg = self._cfg()
        access_key_id = str(cfg.get("access_key_id") or "").strip()
        access_key_secret = str(cfg.get("access_key_secret") or "").strip()
        bucket = str(cfg.get("bucket") or "").strip()
        endpoint = str(cfg.get("endpoint") or "").strip()
        public_host = str(cfg.get("public_host") or "").strip()
        key_prefix = str(cfg.get("key_prefix") or "tiktok_res/video_product_mapping").strip().strip("/")

        if not (access_key_id and access_key_secret and bucket and endpoint):
            raise RuntimeError(
                "未配置完整的 OSS 信息，请检查项目配置文件中的 "
                "oss.access_key_id / oss.access_key_secret / oss.bucket / oss.endpoint"
            )

        if not public_host:
            public_host = f"{bucket}.{endpoint}"

        return {
            "access_key_id": access_key_id,
            "access_key_secret": access_key_secret,
            "bucket": bucket,
            "endpoint": endpoint,
            "public_host": public_host,
            "key_prefix": key_prefix,
        }

    def upload_file(self, path: Path, *, purpose: str) -> str:
        file_path = Path(path).expanduser().resolve()
        if not file_path.exists() or not file_path.is_file():
            raise RuntimeError(f"待上传文件不存在: {file_path}")

        settings = self.resolve_settings()
        file_bytes = file_path.read_bytes()
        digest = hashlib.md5(file_bytes).hexdigest()[:12]
        date_part = time.strftime("%Y%m%d")
        object_key = (
            f"{settings['key_prefix']}/{purpose}/{date_part}/"
            f"{file_path.stem}_{digest}{file_path.suffix.lower()}"
        )
        mime_type = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
        date = email.utils.formatdate(usegmt=True)
        canonical_resource = f"/{settings['bucket']}/{object_key}"
        string_to_sign = f"PUT\n\n{mime_type}\n{date}\n{canonical_resource}"
        signature = base64_hmac_sha1(settings["access_key_secret"], string_to_sign)
        upload_url = f"https://{settings['bucket']}.{settings['endpoint']}/{urllib.parse.quote(object_key)}"
        request = urllib.request.Request(
            upload_url,
            data=file_bytes,
            method="PUT",
            headers={
                "Date": date,
                "Content-Type": mime_type,
                "Authorization": f"OSS {settings['access_key_id']}:{signature}",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                response.read()
        except Exception as exc:
            raise RuntimeError(f"上传 OSS 失败: {exc}") from exc
        return f"https://{settings['public_host']}/{object_key}"


def base64_hmac_sha1(secret: str, text: str) -> str:
    digest = hmac.new(secret.encode("utf-8"), text.encode("utf-8"), hashlib.sha1).digest()
    return __import__("base64").b64encode(digest).decode("ascii")
