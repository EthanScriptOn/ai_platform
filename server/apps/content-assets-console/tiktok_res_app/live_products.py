from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

AUTH_ISSUE_UNCHANGED = object()


def extract_web_rid(url: str, *, extract_url: Callable[[str], str] = lambda value: value) -> str:
    url = extract_url(url)
    match = re.search(r"live\.douyin\.com/(\d+)", url)
    if match:
        return match.group(1)
    match = re.search(r"/live/(\d+)", url)
    if match:
        return match.group(1)
    raise RuntimeError("无法从直播链接中解析直播间号")


def normalize_cookie_for_playwright(raw: Dict[str, str]) -> List[Dict[str, str]]:
    cookies = []
    for name, value in raw.items():
        if value:
            cookies.append({"name": str(name), "value": str(value), "domain": ".douyin.com", "path": "/"})
    return cookies


def find_anchor_id(room: Dict[str, Any]) -> str:
    for key in ("owner", "anchor", "user"):
        value = room.get(key)
        if isinstance(value, dict):
            anchor_id = value.get("id_str") or value.get("id") or value.get("uid")
            if anchor_id:
                return str(anchor_id)
    for key in ("owner_user_id_str", "owner_user_id", "anchor_id", "user_id"):
        if room.get(key):
            return str(room[key])
    raise RuntimeError("无法从直播间信息中解析 author_id")


async def fetch_live_products_impl(
    url: str,
    *,
    offset: int = 0,
    limit: int = 20,
    all_products: bool = False,
    cookies: Dict[str, str],
    output_dir: Path,
    extract_url: Callable[[str], str],
) -> tuple[Dict[str, Any], object]:
    try:
        from playwright.async_api import async_playwright
    except ImportError as exc:
        raise RuntimeError("缺少 playwright，请先运行: .venv/bin/python -m playwright install chromium") from exc

    web_rid = extract_web_rid(url, extract_url=extract_url)
    cookies = normalize_cookie_for_playwright(cookies)
    live_url = f"https://live.douyin.com/{web_rid}"
    room_info: Dict[str, Any] = {}

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True)
        context = await browser.new_context(locale="zh-CN", viewport={"width": 1440, "height": 1000})
        await context.add_cookies(cookies)
        page = await context.new_page()

        async def on_response(response: Any) -> None:
            nonlocal room_info
            if "/webcast/room/web/enter/" not in response.url or room_info:
                return
            try:
                payload = await response.json()
            except Exception:
                return
            data = payload.get("data") if isinstance(payload, dict) else None
            rooms = data.get("data") if isinstance(data, dict) else None
            if isinstance(rooms, list) and rooms:
                room_info = rooms[0] if isinstance(rooms[0], dict) else {}

        page.on("response", on_response)
        await page.goto(live_url, wait_until="domcontentloaded", timeout=60_000)
        await page.wait_for_timeout(8_000)

        if not room_info:
            raise RuntimeError("没有捕获到直播间 enter 接口，可能页面未加载完成或登录态失效")

        room_id = str(room_info.get("id_str") or room_info.get("room_id_str") or room_info.get("id") or "")
        status = int(room_info.get("status") or 0)
        author_id = find_anchor_id(room_info)
        if not room_id:
            raise RuntimeError("无法从直播间信息中解析 room_id")
        if status != 2:
            raise RuntimeError(f"直播未处于开播状态: status={status}")

        async def fetch_page(page_offset: int, page_limit: int) -> Dict[str, Any]:
            api_path = (
                f"/live/promotions/page/?room_id={room_id}&author_id={author_id}"
                f"&offset={int(page_offset)}&limit={int(page_limit)}"
                "&aid=6383&app_name=douyin_web&live_id=1&device_platform=webapp"
                "&channel=channel_pc_web&version_code=320100&version_name=32.1.0"
            )
            response = await page.evaluate(
                """async (path) => {
                const res = await fetch(path, {
                    credentials: 'include',
                    headers: { accept: 'application/json, text/plain, */*' }
                });
                const text = await res.text();
                return { status: res.status, contentType: res.headers.get('content-type'), body: text };
            }""",
                api_path,
            )
            body = (response.get("body") or "").strip()
            if not body:
                raise RuntimeError("商品接口返回空响应")
            return json.loads(body)

        if all_products:
            data = await fetch_page(int(offset), 100)
            combined = dict(data)
            combined["promotions"] = list(data.get("promotions") or [])
            seen = {
                str(item.get("promotion_id") or item.get("product_id") or index)
                for index, item in enumerate(combined["promotions"])
                if isinstance(item, dict)
            }
            next_offset = data.get("next_offset")
            pages = 1
            while next_offset not in (None, "", 0, "0") and pages < 50:
                page_data = await fetch_page(int(next_offset), 100)
                page_items = page_data.get("promotions") or []
                if not page_items:
                    break
                added = 0
                for item in page_items:
                    if not isinstance(item, dict):
                        continue
                    key = str(item.get("promotion_id") or item.get("product_id") or "")
                    if key and key in seen:
                        continue
                    if key:
                        seen.add(key)
                    combined["promotions"].append(item)
                    added += 1
                pages += 1
                new_offset = page_data.get("next_offset")
                if added == 0 or new_offset == next_offset:
                    break
                next_offset = new_offset
            combined["next_offset"] = next_offset
            combined["fetched_pages"] = pages
            data = combined
        else:
            data = await fetch_page(int(offset), int(limit))
        await browser.close()

    raw_path = output_dir / f"live_products_{web_rid}_raw.json"
    raw_path.parent.mkdir(parents=True, exist_ok=True)
    raw_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    summary = summarize_products(data, web_rid=web_rid, room_id=room_id, author_id=author_id)
    auth_issue_update = AUTH_ISSUE_UNCHANGED
    if summary.get("needs_login"):
        auth_issue_update = str(summary.get("api_message") or "抖音接口提示需要重新登录")
    elif summary.get("product_count", 0) > 0:
        auth_issue_update = None
    summary_path = output_dir / f"live_products_{web_rid}_summary.json"
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    summary["raw_path"] = str(raw_path)
    summary["summary_path"] = str(summary_path)
    return summary, auth_issue_update


def yuan_from_cents(value: Any) -> Optional[float]:
    try:
        if value in (None, ""):
            return None
        return round(int(value) / 100, 2)
    except Exception:
        return None


def summarize_products(data: Dict[str, Any], *, web_rid: str, room_id: str, author_id: str) -> Dict[str, Any]:
    products = []
    for item in data.get("promotions") or []:
        price_info = {}
        try:
            price_info = json.loads((item.get("event_param") or {}).get("price_info") or "{}")
        except Exception:
            price_info = {}
        products.append(
            {
                "promotion_id": item.get("promotion_id"),
                "product_id": item.get("product_id"),
                "title": item.get("title") or item.get("elastic_title") or item.get("name") or "",
                "button_label": item.get("button_label"),
                "can_add_cart": item.get("can_add_cart"),
                "can_sold": item.get("can_sold"),
                "show_price_yuan": yuan_from_cents(price_info.get("show_price")),
                "min_price_yuan": yuan_from_cents(price_info.get("min_price") or item.get("min_price") or item.get("price")),
                "max_price_yuan": yuan_from_cents(price_info.get("max_price") or item.get("max_price")),
                "cover": item.get("cover"),
                "detail_url": item.get("detail_url"),
                "category": item.get("category"),
            }
        )
    api_message = data.get("msg") or data.get("message") or ""
    api_code = data.get("code")
    return {
        "web_rid": web_rid,
        "room_id": room_id,
        "author_id": author_id,
        "api_code": api_code,
        "api_message": api_message,
        "needs_login": "登录" in str(api_message),
        "next_offset": data.get("next_offset"),
        "fetched_pages": data.get("fetched_pages"),
        "categories": ((data.get("page_category") or {}).get("categories") or []),
        "product_count": len(products),
        "products": products,
    }
