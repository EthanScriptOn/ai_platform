from typing import Any, Dict, List, Optional


def normalize_paged_response(
    raw_data: Any,
    *,
    item_keys: Optional[List[str]] = None,
    source: str = "api",
) -> Dict[str, Any]:
    raw = raw_data if isinstance(raw_data, dict) else {}
    keys = item_keys or []
    keys = ["items", *keys, "aweme_list", "mix_list", "music_list"]

    items: List[Dict[str, Any]] = []
    for key in keys:
        value = raw.get(key)
        if isinstance(value, list):
            items = value
            break

    has_more_value = raw.get("has_more", False)
    try:
        has_more = bool(int(has_more_value))
    except (TypeError, ValueError):
        has_more = bool(has_more_value)

    max_cursor_value = raw.get("max_cursor")
    if max_cursor_value is None:
        max_cursor_value = raw.get("cursor", 0)
    try:
        max_cursor = int(max_cursor_value or 0)
    except (TypeError, ValueError):
        max_cursor = 0

    status_code_value = raw.get("status_code", 0)
    try:
        status_code = int(status_code_value or 0)
    except (TypeError, ValueError):
        status_code = 0

    risk_flags = {
        "login_tip": bool(
            ((raw.get("not_login_module") or {}).get("guide_login_tip_exist"))
            if isinstance(raw.get("not_login_module"), dict)
            else False
        ),
        "verify_page": bool(raw.get("verify_ticket")),
    }

    normalized = {
        "items": items,
        "aweme_list": items,
        "has_more": has_more,
        "max_cursor": max_cursor,
        "status_code": status_code,
        "source": source,
        "risk_flags": risk_flags,
        "raw": raw,
    }
    for key, value in raw.items():
        if key not in normalized:
            normalized[key] = value
    return normalized
