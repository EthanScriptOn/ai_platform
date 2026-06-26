from __future__ import annotations

import re
from datetime import datetime
from typing import Any

from archive_constants import (
    CATEGORY_LABELS,
    MESSAGE_ROLE_LABELS,
    PRIORITY_ALIASES,
    PRIORITY_ORDER,
    THREAD_TYPE_LABELS,
)
from archive_issue_common import format_time, parse_time


def normalize_messages(messages: Any, fallback_sender: str, fallback_time: datetime) -> list[dict[str, Any]]:
    if not isinstance(messages, list) or not messages:
        raise ValueError("messages must be a non-empty array.")
    normalized: list[dict[str, Any]] = []
    seen_keys: set[str] = set()
    for index, item in enumerate(messages):
        if not isinstance(item, dict):
            continue
        time_value = parse_time(item.get("time")) if item.get("time") else fallback_time
        content = str(item.get("content") or "").strip()
        sender = str(item.get("sender") or fallback_sender).strip() or fallback_sender
        msg_id = str(item.get("msg_id") or "").strip()
        msg_type = str(item.get("type") or "text").strip() or "text"
        if not content:
            continue
        dedupe_key = msg_id or f"{format_time(time_value)}::{sender}::{msg_type}::{content}"
        if dedupe_key in seen_keys:
            continue
        seen_keys.add(dedupe_key)
        normalized.append(
            {
                "msg_id": msg_id or None,
                "time": format_time(time_value),
                "sender": sender,
                "type": msg_type,
                "content": content,
                "thread_type": str(item.get("thread_type") or "").strip(),
                "message_role": str(item.get("message_role") or "").strip(),
                "batch_action": str(item.get("batch_action") or item.get("action") or "").strip(),
                "media_kind": str(item.get("media_kind") or "").strip(),
                "media_file_type": item.get("media_file_type"),
                "media_download_status": str(item.get("media_download_status") or "").strip(),
                "media_local_path": str(item.get("media_local_path") or "").strip(),
                "media_local_url": str(item.get("media_local_url") or "").strip(),
                "media_remote_url": str(item.get("media_remote_url") or "").strip(),
                "media_mime_type": str(item.get("media_mime_type") or "").strip(),
                "media_size_bytes": item.get("media_size_bytes"),
                "media_width": item.get("media_width"),
                "media_height": item.get("media_height"),
                "_seq": index,
            }
        )
    if not normalized:
        raise ValueError("messages must contain at least one non-empty content item.")
    normalized.sort(key=lambda item: (item["time"], item["_seq"]))
    for item in normalized:
        item.pop("_seq", None)
    return normalized


def collect_people(messages: list[dict[str, Any]]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for item in messages:
        sender = str(item.get("sender") or "").strip()
        if not sender or sender in seen:
            continue
        seen.add(sender)
        result.append(sender)
    return result


def extract_tokens(text: str) -> set[str]:
    parts = re.findall(r"[\u4e00-\u9fff]{2,}|[A-Za-z0-9_]{3,}", text.lower())
    tokens: set[str] = set()
    for part in parts:
        clean = part.strip()
        if not clean:
            continue
        tokens.add(clean)
        if re.fullmatch(r"[\u4e00-\u9fff]{3,}", clean):
            for index in range(len(clean) - 1):
                tokens.add(clean[index : index + 2])
    return tokens


def normalize_keywords(keywords: Any, summary: str, messages: list[dict[str, Any]]) -> list[str]:
    values: list[str] = []
    if isinstance(keywords, list):
        for item in keywords:
            token = str(item or "").strip()
            if token:
                values.append(token)
    if not values:
        source = " ".join([summary] + [item["content"] for item in messages])
        values.extend(sorted(extract_tokens(source))[:6])
    seen: set[str] = set()
    result: list[str] = []
    for item in values:
        if item in seen:
            continue
        seen.add(item)
        result.append(item)
    return result[:6]


def message_time_bounds(messages: list[dict[str, Any]]) -> tuple[str, str]:
    if not messages:
        now_text = format_time(datetime.now())
        return now_text, now_text
    return messages[0]["time"], messages[-1]["time"]


def normalize_priority(value: Any, default: str = "P2") -> str:
    raw = str(value or "").strip()
    if not raw:
        return default
    return PRIORITY_ALIASES.get(raw.lower(), raw.upper())


def normalize_payload(payload: dict[str, Any]) -> dict[str, Any]:
    category = str(payload.get("category") or "").strip()
    if category not in CATEGORY_LABELS:
        raise ValueError(f"category must be one of: {', '.join(CATEGORY_LABELS)}")

    priority = normalize_priority(payload.get("priority") or "P2", "P2")
    if priority not in PRIORITY_ORDER:
        raise ValueError(f"priority must be one of: {', '.join(PRIORITY_ORDER)}")

    chat_id = str(payload.get("chat_id") or "").strip()
    if not chat_id:
        raise ValueError("chat_id is required.")

    chat_name = str(payload.get("chat_name") or chat_id).strip() or chat_id
    sender = str(payload.get("sender") or "unknown").strip() or "unknown"
    message_time = parse_time(payload.get("message_time"))
    summary = str(payload.get("summary") or "").strip()
    if not summary:
        raise ValueError("summary is required.")

    messages = normalize_messages(payload.get("messages"), sender, message_time)
    first_message_time, last_message_time = message_time_bounds(messages)
    keywords = normalize_keywords(payload.get("keywords"), summary, messages)
    confidence = payload.get("confidence")
    try:
        confidence_value = round(float(confidence), 4) if confidence is not None else None
    except (TypeError, ValueError) as exc:
        raise ValueError("confidence must be numeric.") from exc

    thread_type = str(payload.get("thread_type") or "").strip() or "case_feedback"
    if thread_type not in THREAD_TYPE_LABELS:
        raise ValueError(f"thread_type must be one of: {', '.join(THREAD_TYPE_LABELS)}")

    message_role = str(payload.get("message_role") or "").strip() or "problem_report"
    if message_role not in MESSAGE_ROLE_LABELS:
        raise ValueError(f"message_role must be one of: {', '.join(MESSAGE_ROLE_LABELS)}")

    batch_action = str(payload.get("batch_action") or payload.get("action") or "").strip()
    if not batch_action:
        batch_action = "new_case" if not str(payload.get("force_case_id") or "").strip() else "append_case"

    return {
        "chat_id": chat_id,
        "chat_name": chat_name,
        "sender": sender,
        "message_time": last_message_time,
        "first_message_time": first_message_time,
        "last_message_time": last_message_time,
        "category": category,
        "priority": priority,
        "summary": summary,
        "keywords": keywords,
        "confidence": confidence_value,
        "messages": messages,
        "thread_type": thread_type,
        "message_role": message_role,
        "batch_action": batch_action,
        "force_case_id": str(payload.get("force_case_id") or "").strip(),
        "force_thread_id": str(payload.get("force_thread_id") or "").strip(),
        "disable_thread_matching": bool(payload.get("disable_thread_matching")),
        "disable_case_matching": bool(payload.get("disable_case_matching")),
        "force_promote_case": bool(payload.get("force_promote_case")),
    }
