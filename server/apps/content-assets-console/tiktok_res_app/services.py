from __future__ import annotations

import asyncio
import json
import re
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, urlparse
import os

import yaml

from auth import CookieManager
from config import ConfigLoader
from control import QueueManager, RateLimiter, RetryHandler
from core import DouyinAPIClient, DownloaderFactory, URLParser
from storage import FileManager
from tiktok_res_app.job_store import JobStore
from tiktok_res_app.live_products import AUTH_ISSUE_UNCHANGED, fetch_live_products_impl, normalize_cookie_for_playwright
from tiktok_res_app.output_files import VIDEO_FILE_SUFFIXES, create_output_file_helpers
from tiktok_res_app.video_tools import clip_video, prepare_video_preview, probe_duration, run_process
from utils.asyncio_compat import to_thread
from utils.cookie_utils import parse_cookie_header, sanitize_cookies
from utils.validators import is_short_url, normalize_short_url


ROOT = Path(__file__).resolve().parents[1]
APP_CONFIG_PATH = ROOT / "config.yml"
CONFIG_PATH = APP_CONFIG_PATH
CONFIG_OVERRIDE_PATH: Optional[Path] = None
COOKIE_PATH = ROOT / "config" / "cookies.json"
LOGIN_PROFILE_DIR = ROOT / "config" / "douyin_login_profile"
OUTPUT_DIR = ROOT / "Downloaded"
DEFAULT_LOGIN_URL = "https://www.douyin.com/"
REQUIRED_COOKIE_KEYS = {"msToken", "ttwid", "odin_tt", "passport_csrf_token"}
LOGIN_COOKIE_KEYS = {"sessionid", "sessionid_ss", "sid_guard", "sid_tt", "uid_tt", "uid_tt_ss"}

def get_output_dir(config: Optional[ConfigLoader] = None) -> Path:
    cfg = config or load_config()
    raw_path = str(cfg.get("path") or "./Downloaded/").strip()
    path = Path(raw_path).expanduser()
    if not path.is_absolute():
        path = ROOT / path
    return path.resolve()


_output_file_helpers = create_output_file_helpers(get_output_dir)
associated_output_paths = _output_file_helpers["associated_output_paths"]
cleanup_empty_output_dirs = _output_file_helpers["cleanup_empty_output_dirs"]
collect_output_paths = _output_file_helpers["collect_output_paths"]
delete_job_output_files = _output_file_helpers["delete_job_output_files"]
delete_output_file = _output_file_helpers["delete_output_file"]
describe_file_path = _output_file_helpers["describe_file_path"]
describe_manifest_files = _output_file_helpers["describe_manifest_files"]
describe_output_files = _output_file_helpers["describe_output_files"]
is_generated_preview_file = _output_file_helpers["is_generated_preview_file"]
is_partial_video_file = _output_file_helpers["is_partial_video_file"]
is_shadow_product_summary = _output_file_helpers["is_shadow_product_summary"]
is_video_product_map_file = _output_file_helpers["is_video_product_map_file"]
list_output_files = _output_file_helpers["list_output_files"]
output_identity_tokens = _output_file_helpers["output_identity_tokens"]
path_matches_output_identity = _output_file_helpers["path_matches_output_identity"]
product_count_from_payload = _output_file_helpers["product_count_from_payload"]
read_json_output_file = _output_file_helpers["read_json_output_file"]
resolve_output_path = _output_file_helpers["resolve_output_path"]
scan_library = _output_file_helpers["scan_library"]
source_identity_from_path = _output_file_helpers["source_identity_from_path"]


@dataclass
class LoginBrowserSession:
    playwright: Any
    browser: Any
    context: Any
    page: Any
    url: str
    started_at: float
    observed_cookie_headers: List[str] = field(default_factory=list)
    observed_mstokens: List[str] = field(default_factory=list)




_login_session: Optional[LoginBrowserSession] = None
_login_lock = asyncio.Lock()
_auth_issue: Optional[str] = None


def configure_runtime(config_path: Path) -> None:
    global CONFIG_PATH, CONFIG_OVERRIDE_PATH
    CONFIG_OVERRIDE_PATH = config_path.resolve()
    CONFIG_PATH = CONFIG_OVERRIDE_PATH


def _read_yaml_config(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {}
    loaded = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    return loaded if isinstance(loaded, dict) else {}


def _merge_config_dict(base: Dict[str, Any], override: Dict[str, Any]) -> Dict[str, Any]:
    merged = dict(base)
    for key, value in override.items():
        if isinstance(merged.get(key), dict) and isinstance(value, dict):
            merged[key] = _merge_config_dict(merged[key], value)
        else:
            merged[key] = value
    return merged


def load_config() -> ConfigLoader:
    base_path = APP_CONFIG_PATH.resolve()
    runtime_path = (CONFIG_OVERRIDE_PATH or CONFIG_PATH).resolve()
    primary_path = base_path if base_path.exists() else runtime_path
    loader = ConfigLoader(str(primary_path))
    if runtime_path != primary_path and runtime_path.exists():
        loader.config = _merge_config_dict(loader.config, _read_yaml_config(runtime_path))
    loader.config_path = str(primary_path)
    return loader


def load_cookies() -> Dict[str, str]:
    config = load_config()
    cookies = config.get_cookies()
    if cookies:
        return cookies
    if COOKIE_PATH.exists():
        raw = json.loads(COOKIE_PATH.read_text(encoding="utf-8"))
        return {str(key): str(value) for key, value in raw.items() if value}
    return {}


def load_latest_backup_cookies() -> Dict[str, str]:
    backup_files = sorted(
        COOKIE_PATH.parent.glob(f"{COOKIE_PATH.stem}_*.bak{COOKIE_PATH.suffix}"),
        key=lambda item: item.stat().st_mtime if item.exists() else 0,
        reverse=True,
    )
    for path in backup_files:
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        cookies = {str(key): str(value) for key, value in raw.items() if value}
        if has_login_markers(cookies):
            return sanitize_cookies(cookies)
    return {}


def list_cookie_backup_files() -> List[Path]:
    return sorted(
        COOKIE_PATH.parent.glob(f"{COOKIE_PATH.stem}_*.bak{COOKIE_PATH.suffix}"),
        key=lambda item: item.stat().st_mtime if item.exists() else 0,
        reverse=True,
    )


def extract_douyin_url(text: str) -> str:
    raw = (text or "").strip()
    match = re.search(r"https?://[^\s，,。]+", raw)
    if match:
        return match.group(0).rstrip("。，,.!！?？")
    match = re.search(r"(?:v\.)?(?:ies)?douyin\.com/[^\s，,。]+", raw, flags=re.IGNORECASE)
    if match:
        return f"https://{match.group(0).rstrip('。，,.!！?？')}"
    return raw


def looks_like_live_url(text: str) -> bool:
    url = extract_douyin_url(text)
    return bool(re.search(r"(?:live\.douyin\.com|douyin\.com/(?:follow/)?live/)", url, flags=re.IGNORECASE))



def latest_persisted_auth_issue() -> Optional[str]:
    output_dir = get_output_dir()
    if not output_dir.exists():
        return None
    try:
        cookie_mtime = COOKIE_PATH.stat().st_mtime if COOKIE_PATH.exists() else 0
    except OSError:
        cookie_mtime = 0
    candidates = sorted(
        output_dir.glob("live_products_*_raw.json"),
        key=lambda item: item.stat().st_mtime if item.exists() else 0,
        reverse=True,
    )
    for path in candidates[:5]:
        try:
            if path.stat().st_mtime < cookie_mtime - 2:
                continue
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        message = str(data.get("msg") or data.get("message") or "")
        if "登录" in message:
            return message
    return None


def update_cookie_config(cookies: Dict[str, str]) -> None:
    existing: Dict[str, Any] = {}
    target_path = APP_CONFIG_PATH
    if target_path.exists():
        existing = yaml.safe_load(target_path.read_text(encoding="utf-8")) or {}
    existing["cookies"] = cookies
    target_path.write_text(
        yaml.safe_dump(existing, allow_unicode=True, sort_keys=False),
        encoding="utf-8",
    )


def cookie_status() -> Dict[str, Any]:
    cookies = load_cookies()
    keys = sorted(cookies.keys())
    missing_required = sorted(key for key in REQUIRED_COOKIE_KEYS if not cookies.get(key))
    login_markers = sorted(key for key in LOGIN_COOKIE_KEYS if cookies.get(key))
    auth_issue = _auth_issue or latest_persisted_auth_issue()
    cookie_file = COOKIE_PATH.exists()
    updated_at = None
    if cookie_file:
        updated_at = datetime.fromtimestamp(COOKIE_PATH.stat().st_mtime).isoformat(timespec="seconds")
    return {
        "has_cookie": bool(cookies),
        "likely_logged_in": bool(login_markers) and not auth_issue,
        "auth_issue": auth_issue,
        "cookie_count": len(cookies),
        "cookie_file": str(COOKIE_PATH),
        "cookie_file_exists": cookie_file,
        "updated_at": updated_at,
        "keys": keys,
        "login_markers": login_markers,
        "missing_required": missing_required,
        "login_session_active": _login_session is not None,
        "login_session_url": _login_session.url if _login_session else None,
    }


def extract_ms_token_from_text(text: str) -> Optional[str]:
    for pattern in (
        r"[?&]msToken=([^&#\s]+)",
        r'"msToken"\s*:\s*"([^"]+)"',
        r"'msToken'\s*:\s*'([^']+)'",
        r"msToken=([^;\s]+)",
    ):
        match = re.search(pattern, text or "")
        if match and match.group(1):
            return match.group(1).strip()
    return None


def collect_cookies_from_storage(storage: Dict[str, Any]) -> Dict[str, str]:
    cookies = {
        cookie["name"]: cookie["value"]
        for cookie in storage.get("cookies", [])
        if str(cookie.get("domain", "")).endswith("douyin.com") and cookie.get("name") and cookie.get("value")
    }
    return sanitize_cookies(cookies)


def has_login_markers(cookies: Dict[str, str]) -> bool:
    return any(cookies.get(key) for key in LOGIN_COOKIE_KEYS)


async def close_login_session() -> None:
    global _login_session
    if not _login_session:
        return
    session = _login_session
    _login_session = None
    for target in (session.context, session.browser):
        if not target:
            continue
        try:
            await target.close()
        except Exception:
            pass
    try:
        await session.playwright.stop()
    except Exception:
        pass


async def collect_session_cookies(session: LoginBrowserSession, *, include_page_cookie: bool) -> Dict[str, str]:
    storage = await session.context.storage_state()
    cookies = collect_cookies_from_storage(storage)
    if include_page_cookie:
        try:
            document_cookie = await session.page.evaluate("() => document.cookie || ''")
            cookies.update(parse_cookie_header(document_cookie))
            token = extract_ms_token_from_text(document_cookie)
            if token and not cookies.get("msToken"):
                cookies["msToken"] = token
        except Exception:
            pass
    for header in reversed(session.observed_cookie_headers):
        cookies.update(parse_cookie_header(header))
        token = extract_ms_token_from_text(header)
        if token and not cookies.get("msToken"):
            cookies["msToken"] = token
    for token in reversed(session.observed_mstokens):
        if token and not cookies.get("msToken"):
            cookies["msToken"] = token
            break
    return sanitize_cookies(cookies)


async def persist_login_cookies(cookies: Dict[str, str]) -> None:
    global _auth_issue
    COOKIE_PATH.parent.mkdir(parents=True, exist_ok=True)
    COOKIE_PATH.write_text(json.dumps(cookies, ensure_ascii=False, indent=2), encoding="utf-8")
    update_cookie_config(cookies)
    _auth_issue = None


def has_graphical_display() -> bool:
    if os.name == "nt" or os.uname().sysname == "Darwin":
        return True
    return bool(str(os.getenv("DISPLAY") or "").strip() or str(os.getenv("WAYLAND_DISPLAY") or "").strip())


async def import_cookies_from_login_profile() -> Dict[str, str]:
    try:
        from playwright.async_api import async_playwright
    except ImportError as exc:
        raise RuntimeError("缺少 playwright，请先运行: .venv/bin/python -m playwright install chromium") from exc

    if not LOGIN_PROFILE_DIR.exists():
        return {}

    playwright = await async_playwright().start()
    context = None
    try:
        context = await playwright.chromium.launch_persistent_context(
            user_data_dir=str(LOGIN_PROFILE_DIR),
            headless=True,
            locale="zh-CN",
            viewport={"width": 1440, "height": 1000},
            args=[
                "--disable-blink-features=AutomationControlled",
                "--disable-dev-shm-usage",
                "--no-sandbox",
            ],
        )
        storage = await context.storage_state()
        cookies = collect_cookies_from_storage(storage)
        return sanitize_cookies(cookies)
    finally:
        if context:
            try:
                await context.close()
            except Exception:
                pass
        try:
            await playwright.stop()
        except Exception:
            pass


async def start_login_session(url: str = DEFAULT_LOGIN_URL, *, fresh: bool = False) -> Dict[str, Any]:
    global _login_session
    try:
        from playwright.async_api import async_playwright
    except ImportError as exc:
        raise RuntimeError("缺少 playwright，请先运行: .venv/bin/python -m playwright install chromium") from exc

    async with _login_lock:
        if not fresh and not has_graphical_display():
            restored = load_latest_backup_cookies()
            if restored:
                await persist_login_cookies(restored)
                return {
                    "started": False,
                    "imported": True,
                    "restored_backup": True,
                    "reused": False,
                    "fresh": False,
                    "url": url or DEFAULT_LOGIN_URL,
                    "status": cookie_status(),
                }
            imported = await import_cookies_from_login_profile()
            if imported and has_login_markers(imported):
                await persist_login_cookies(imported)
                return {
                    "started": False,
                    "imported": True,
                    "reused": False,
                    "fresh": False,
                    "url": url or DEFAULT_LOGIN_URL,
                    "status": cookie_status(),
                }
            raise RuntimeError("当前服务器没有图形界面，无法弹出抖音登录窗口；且历史登录资料不可直接复用。")

        if _login_session:
            session = _login_session
            if fresh:
                await session.context.clear_cookies()
                try:
                    await session.page.evaluate("() => { localStorage.clear(); sessionStorage.clear(); }")
                except Exception:
                    pass
                session.observed_cookie_headers.clear()
                session.observed_mstokens.clear()
            session.url = url or DEFAULT_LOGIN_URL
            try:
                await session.page.bring_to_front()
            except Exception:
                pass
            try:
                await session.page.goto(session.url, wait_until="domcontentloaded", timeout=15_000)
            except Exception:
                pass
            return {"started": True, "reused": True, "fresh": fresh, "url": session.url, "status": cookie_status()}

        if fresh and LOGIN_PROFILE_DIR.exists():
            shutil.rmtree(LOGIN_PROFILE_DIR, ignore_errors=True)
        LOGIN_PROFILE_DIR.parent.mkdir(parents=True, exist_ok=True)
        playwright = await async_playwright().start()
        context = await playwright.chromium.launch_persistent_context(
            user_data_dir=str(LOGIN_PROFILE_DIR),
            headless=False,
            locale="zh-CN",
            viewport={"width": 1440, "height": 1000},
            args=[
                "--disable-blink-features=AutomationControlled",
                "--disable-dev-shm-usage",
                "--no-sandbox",
            ],
        )
        existing = [] if fresh else normalize_cookie_for_playwright(load_cookies())
        if existing:
            await context.add_cookies(existing)
        page = context.pages[0] if context.pages else await context.new_page()
        session = LoginBrowserSession(
            playwright=playwright,
            browser=None,
            context=context,
            page=page,
            url=url or DEFAULT_LOGIN_URL,
            started_at=time.time(),
        )

        def on_request(request: Any) -> None:
            try:
                headers = request.headers or {}
                cookie_header = headers.get("cookie")
                if cookie_header:
                    session.observed_cookie_headers.append(cookie_header)
                query = parse_qs(urlparse(request.url or "").query)
                if query.get("msToken"):
                    session.observed_mstokens.append((query["msToken"][0] or "").strip())
                token = extract_ms_token_from_text(request.url or "")
                if token:
                    session.observed_mstokens.append(token)
            except Exception:
                return

        page.on("request", on_request)
        _login_session = session
        try:
            await page.goto(session.url, wait_until="domcontentloaded", timeout=15_000)
        except Exception:
            pass
        return {"started": True, "reused": False, "fresh": fresh, "url": session.url, "status": cookie_status()}


async def save_login_session() -> Dict[str, Any]:
    if not _login_session:
        raise RuntimeError("没有正在打开的登录窗口，请先点击打开抖音登录")

    async with _login_lock:
        if not _login_session:
            raise RuntimeError("没有正在打开的登录窗口，请先点击打开抖音登录")
        global _auth_issue
        session = _login_session
        cookies = await collect_session_cookies(session, include_page_cookie=True)
        await persist_login_cookies(cookies)
        return {"saved": True, "cookie_count": len(cookies), "status": cookie_status()}


async def autosave_login_session() -> Dict[str, Any]:
    if not _login_session:
        return {"saved": False, "waiting": False, "message": "没有正在打开的登录窗口", "status": cookie_status()}

    async with _login_lock:
        if not _login_session:
            return {"saved": False, "waiting": False, "message": "没有正在打开的登录窗口", "status": cookie_status()}
        global _auth_issue
        session = _login_session
        cookies = await collect_session_cookies(session, include_page_cookie=True)
        if not has_login_markers(cookies):
            return {
                "saved": False,
                "waiting": True,
                "cookie_count": len(cookies),
                "message": "等待抖音登录完成",
                "status": cookie_status(),
            }

        await persist_login_cookies(cookies)
        return {"saved": True, "waiting": False, "cookie_count": len(cookies), "status": cookie_status()}


async def sync_login_session_once() -> Dict[str, Any]:
    if not _login_session:
        return cookie_status()
    async with _login_lock:
        if not _login_session:
            return cookie_status()
        cookies = await collect_session_cookies(_login_session, include_page_cookie=True)
        if has_login_markers(cookies):
            await persist_login_cookies(cookies)
    return cookie_status()


async def cancel_login_session() -> Dict[str, Any]:
    async with _login_lock:
        await close_login_session()
    return {"cancelled": True, "status": cookie_status()}


async def logout_saved_cookies() -> Dict[str, Any]:
    global _auth_issue
    async with _login_lock:
        await close_login_session()
        backup_path = None
        if COOKIE_PATH.exists():
            stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            backup_path = COOKIE_PATH.with_name(f"{COOKIE_PATH.stem}_{stamp}.bak{COOKIE_PATH.suffix}")
            COOKIE_PATH.replace(backup_path)
        COOKIE_PATH.parent.mkdir(parents=True, exist_ok=True)
        COOKIE_PATH.write_text("{}", encoding="utf-8")
        deleted_backups: List[str] = []
        for backup in list_cookie_backup_files():
            try:
                backup.unlink()
                deleted_backups.append(str(backup))
            except FileNotFoundError:
                continue
        shutil.rmtree(LOGIN_PROFILE_DIR, ignore_errors=True)
        update_cookie_config({})
        _auth_issue = None
    return {
        "logged_out": True,
        "backup_path": str(backup_path) if backup_path else None,
        "deleted_backups": deleted_backups,
        "cleared_login_profile": True,
        "status": cookie_status(),
    }


async def resolve_url(api_client: DouyinAPIClient, url: str) -> str:
    url = extract_douyin_url(url)
    if is_short_url(url):
        resolved = await api_client.resolve_short_url(normalize_short_url(url))
        if not resolved:
            raise RuntimeError(f"短链接解析失败: {url}")
        return resolved
    return url


async def run_downloader(url: str, *, live_duration_seconds: Optional[int] = None) -> Dict[str, Any]:
    input_url = url
    url = extract_douyin_url(url)
    config = load_config()
    if live_duration_seconds is not None:
        live_cfg = dict(config.get("live") or {})
        live_cfg["max_duration_seconds"] = max(0, int(live_duration_seconds))
        config.update(live=live_cfg)

    cookies = load_cookies()
    cookie_manager = CookieManager(cookie_file=str(COOKIE_PATH))
    cookie_manager.set_cookies(cookies)
    output_dir = get_output_dir(config)
    started_at = time.time()
    before_files = list_output_files(output_dir)

    async with DouyinAPIClient(cookies, proxy=config.get("proxy")) as api_client:
        final_url = await resolve_url(api_client, url)
        parsed = URLParser.parse(final_url)
        if not parsed:
            raise RuntimeError(f"不支持的链接: {url}")

        file_manager = FileManager(config.get("path"))
        downloader = DownloaderFactory.create(
            parsed["type"],
            config,
            api_client,
            file_manager,
            cookie_manager,
            None,
            RateLimiter(max_per_second=float(config.get("rate_limit", 2) or 2)),
            RetryHandler(max_retries=int(config.get("retry_times", 3) or 3)),
            QueueManager(max_workers=int(config.get("thread", 5) or 5)),
            progress_reporter=None,
        )
        if downloader is None:
            raise RuntimeError(f"没有可用下载器: {parsed['type']}")

        result = await downloader.download(parsed)
        files = describe_output_files(output_dir, before_files, started_at, parsed=parsed)
        if result.success > 0 and not files:
            files = describe_output_files(output_dir, {}, 0, parsed=parsed)
        video_files = [file for file in files if file["type"] == "video"]
        if result.success <= 0:
            raise RuntimeError(
                f"下载失败：总数 {result.total}，成功 {result.success}，失败 {result.failed}。"
                "可能是该视频无可播放地址、登录态失效、或抖音限制了当前链接。"
            )
        if parsed["type"] == "video" and not video_files:
            raise RuntimeError(
                f"下载器返回成功，但没有在输出目录找到视频文件：{output_dir}"
            )
        return {
            "url": input_url,
            "extracted_url": url,
            "resolved_url": final_url,
            "type": parsed["type"],
            "parsed": parsed,
            "total": result.total,
            "success": result.success,
            "failed": result.failed,
            "skipped": result.skipped,
            "output_dir": str(output_dir),
            "files": files,
            "video_files": video_files,
        }


async def fetch_live_products(
    url: str,
    *,
    offset: int = 0,
    limit: int = 20,
    all_products: bool = False,
) -> Dict[str, Any]:
    global _auth_issue
    summary, auth_issue_update = await fetch_live_products_impl(
        url,
        offset=offset,
        limit=limit,
        all_products=all_products,
        cookies=load_cookies(),
        output_dir=get_output_dir(),
        extract_url=extract_douyin_url,
    )
    if auth_issue_update is not AUTH_ISSUE_UNCHANGED:
        _auth_issue = auth_issue_update  # type: ignore[assignment]
    return summary
