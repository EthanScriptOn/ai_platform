from __future__ import annotations

import json
from copy import deepcopy
from datetime import datetime
from pathlib import Path
from typing import Any

from archive_constants import (
    CASE_STATUS_LABELS,
    MESSAGE_ROLE_LABELS,
    PRIORITY_ORDER,
    THREAD_TYPE_LABELS,
)
from archive_issue_common import (
    append_jsonl,
    ensure_dir,
    format_time,
    load_json,
    message_key,
    write_json,
)
from archive_issue_matching import build_case_id, build_thread_id, choose_case, choose_thread
from archive_issue_payload import (
    collect_people,
    message_time_bounds,
    normalize_keywords,
    normalize_priority,
)
from archive_renderers import (
    build_case_payload_from_thread,
    build_case_snapshot,
    build_thread_snapshot,
    render_case_markdown,
    render_conversation_markdown,
    render_thread_markdown,
)


def merge_messages(existing: list[dict[str, Any]], incoming: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged = deepcopy(existing)
    seen: set[str] = set()
    for item in merged:
        seen.add(message_key("_", item))
    for item in incoming:
        key = message_key("_", item)
        if key in seen:
            continue
        seen.add(key)
        merged.append(item)
    merged.sort(key=lambda item: item["time"])
    return merged


def choose_summary(existing: str, incoming: str) -> str:
    if not existing:
        return incoming
    if incoming in existing:
        return existing
    if len(incoming) > len(existing):
        return incoming
    return existing


def should_refresh_case_summary(batch_action: str, message_role: str) -> bool:
    if batch_action != "new_case":
        return False
    return message_role in {"problem_report", "feature_request", "evidence", "user_reply"}


def derive_case_status(category: str, batch_action: str, message_role: str, previous_status: str) -> str:
    status = str(previous_status or "").strip() or "open"
    if category == "feature_request":
        if message_role == "resolution":
            return "resolved"
        return status if status in CASE_STATUS_LABELS else "open"

    if message_role in {"resolution"}:
        return "resolved"
    if message_role in {"waiting_upstream"}:
        return "waiting_upstream"
    if message_role in {"developer_question", "waiting_user"}:
        return "waiting_user"
    if message_role in {"diagnosis", "workaround"}:
        return "diagnosed"
    if message_role in {"troubleshooting_update"}:
        return "investigating"
    if message_role in {"problem_report", "evidence", "user_reply"}:
        return "investigating" if batch_action in {"new_case", "append_case", "append_case_activity"} else status
    return status if status in CASE_STATUS_LABELS else "open"


def build_activity_entry(thread: dict[str, Any], now: datetime) -> dict[str, Any]:
    timeline = deepcopy(thread.get("messages") or [])
    return {
        "activity_id": f"ACT-{now.strftime('%Y%m%d-%H%M%S')}-{abs(hash(thread.get('thread_id') or thread.get('summary') or '')) % 10000:04d}",
        "time": format_time(now),
        "thread_id": thread.get("thread_id"),
        "thread_type": str(thread.get("thread_type") or ""),
        "thread_type_label": THREAD_TYPE_LABELS.get(str(thread.get("thread_type") or ""), str(thread.get("thread_type") or "")),
        "message_role": str(thread.get("latest_message_role") or ""),
        "message_role_label": MESSAGE_ROLE_LABELS.get(str(thread.get("latest_message_role") or ""), str(thread.get("latest_message_role") or "")),
        "batch_action": str(thread.get("latest_batch_action") or ""),
        "summary": str(thread.get("summary") or ""),
        "sender": str(thread.get("latest_sender") or thread.get("reporter") or ""),
        "message_count": len(timeline),
        "messages": timeline,
    }


def build_conversation_record(source: dict[str, Any], source_kind: str) -> dict[str, Any]:
    timeline = deepcopy(source["messages"])
    return {
        "source_kind": source_kind,
        "source_id": source[f"{source_kind}_id"],
        "chat_id": source["chat_id"],
        "chat_name": source["chat_name"],
        "category": source["category"],
        "preserve_original_text": True,
        "source_policy": "store-as-received",
        "participants": collect_people(timeline),
        "started_at": source["first_message_time"],
        "ended_at": source["last_message_time"],
        "message_count": len(timeline),
        "timeline": timeline,
        "activities": deepcopy(source.get("activities") or []),
    }




def persist_raw_messages(root: Path, payload: dict[str, Any], now: datetime) -> dict[str, Any]:
    raw_path = root / "raw-messages.jsonl"
    count = 0
    keys: list[str] = []
    for item in payload["messages"]:
        key = message_key(payload["chat_id"], item)
        event = {
            "event_time": format_time(now),
            "chat_id": payload["chat_id"],
            "chat_name": payload["chat_name"],
            "category_hint": payload["category"],
            "dedupe_key": key,
            "message": item,
        }
        append_jsonl(raw_path, event)
        count += 1
        keys.append(key)
    return {
        "path": str(raw_path),
        "count": count,
        "message_keys": keys,
    }


def write_thread(root: Path, thread: dict[str, Any]) -> dict[str, str]:
    threads_dir = root / "threads"
    ensure_dir(threads_dir)
    thread_json_path = threads_dir / f"{thread['thread_id']}.json"
    thread_md_path = threads_dir / f"{thread['thread_id']}.md"
    write_json(thread_json_path, thread)
    thread_md_path.write_text(render_thread_markdown(thread), encoding="utf-8")
    return {
        "json": str(thread_json_path),
        "markdown": str(thread_md_path),
    }


def update_thread_index(root: Path, thread: dict[str, Any], paths: dict[str, str]) -> dict[str, Any]:
    index_path = root / "thread_index.json"
    index_data = load_json(index_path, {"version": 1, "threads": []})
    snapshot = build_thread_snapshot(thread, paths)
    replaced = False
    next_threads: list[dict[str, Any]] = []
    for item in index_data["threads"]:
        if isinstance(item, dict) and item.get("thread_id") == thread["thread_id"]:
            next_threads.append(snapshot)
            replaced = True
        else:
            next_threads.append(item)
    if not replaced:
        next_threads.append(snapshot)
    next_threads.sort(key=lambda item: item.get("updated_at", ""), reverse=True)
    index_data["threads"] = next_threads
    write_json(index_path, index_data)
    return snapshot


def append_thread_event(root: Path, action: str, thread_snapshot: dict[str, Any], now: datetime) -> None:
    append_jsonl(
        root / "thread-events.jsonl",
        {
            "event_time": format_time(now),
            "action": action,
            "thread": thread_snapshot,
        },
    )


def should_promote_thread(thread: dict[str, Any]) -> tuple[bool, str]:
    message_count = len(thread["messages"])
    participant_count = len(thread.get("participants") or [])
    has_media = any(str(item.get("type") or "text") != "text" for item in thread["messages"])
    confidence = thread.get("confidence")
    high_confidence = isinstance(confidence, (int, float)) and float(confidence) >= 0.85
    if thread.get("case_id"):
        return True, "already-linked"
    if participant_count >= 2:
        return True, "multi-party-discussion"
    if message_count >= 2:
        return True, "multi-message-thread"
    if has_media:
        return True, "media-evidence"
    if thread["priority"] in {"P0", "P1"} and high_confidence:
        return True, "high-priority-confidence"
    return False, "insufficient-evidence"


def upsert_thread(root: Path, payload: dict[str, Any], now: datetime) -> dict[str, Any]:
    matched = None
    if payload.get("force_thread_id"):
        thread_id = str(payload["force_thread_id"])
        matched = {"thread_id": thread_id}
    elif not payload.get("disable_thread_matching"):
        matched = choose_thread(load_json(root / "thread_index.json", {"version": 1, "threads": []})["threads"], payload)
    if matched:
        thread_id = str(matched["thread_id"])
        thread_path = root / "threads" / f"{thread_id}.json"
        if thread_path.exists():
            thread = json.loads(thread_path.read_text(encoding="utf-8"))
        else:
            thread = deepcopy(matched)
        action = "update"
    else:
        thread_id = build_thread_id(now, payload)
        thread = {
            "thread_id": thread_id,
            "status": "candidate",
            "created_at": format_time(now),
            "promoted_at": None,
            "case_id": None,
            "promotion_reason": None,
        }
        action = "create"

    thread["chat_id"] = payload["chat_id"]
    thread["chat_name"] = payload["chat_name"]
    thread["category"] = payload["category"]
    thread["priority"] = max(
        [normalize_priority(thread.get("priority", "P3"), "P3"), payload["priority"]],
        key=lambda item: PRIORITY_ORDER.get(str(item), 0),
    )
    thread["reporter"] = thread.get("reporter") or payload["sender"]
    thread["first_message_time"] = thread.get("first_message_time") or payload["first_message_time"]
    thread["last_message_time"] = payload["last_message_time"]
    thread["summary"] = choose_summary(str(thread.get("summary") or ""), payload["summary"])
    thread["keywords"] = normalize_keywords(
        list(thread.get("keywords") or []) + list(payload["keywords"]),
        thread["summary"],
        payload["messages"],
    )
    thread["confidence"] = payload["confidence"]
    thread["messages"] = merge_messages(thread.get("messages") or [], payload["messages"])
    thread["first_message_time"], thread["last_message_time"] = message_time_bounds(thread["messages"])
    thread["participants"] = collect_people(thread["messages"])
    thread["reporters"] = collect_people(thread["messages"])
    thread["latest_sender"] = payload["sender"]
    thread["updated_at"] = format_time(now)
    thread["raw_message_keys"] = [message_key(payload["chat_id"], item) for item in thread["messages"]]
    thread["force_case_id"] = str(payload.get("force_case_id") or "").strip()
    thread["disable_case_matching"] = bool(payload.get("disable_case_matching"))
    thread["thread_type"] = payload["thread_type"]
    thread["latest_message_role"] = payload["message_role"]
    thread["latest_batch_action"] = payload["batch_action"]
    for item in thread["messages"]:
        item.setdefault("thread_type", payload["thread_type"])
        item.setdefault("message_role", payload["message_role"])
        item.setdefault("batch_action", payload["batch_action"])
    promote, reason = should_promote_thread(thread)
    if thread.get("case_id"):
        thread["status"] = "promoted"
    else:
        thread["status"] = "ready" if promote else "candidate"
    thread["promotion_reason"] = reason

    paths = write_thread(root, thread)
    snapshot = update_thread_index(root, thread, paths)
    append_thread_event(root, action, snapshot, now)
    return {
        "thread": thread,
        "action": action,
        "paths": paths,
        "snapshot": snapshot,
    }


def link_thread_case(root: Path, thread: dict[str, Any], case_id: str, reason: str, now: datetime) -> dict[str, Any]:
    thread["case_id"] = case_id
    thread["status"] = "promoted"
    thread["promoted_at"] = thread.get("promoted_at") or format_time(now)
    thread["promotion_reason"] = reason
    thread["updated_at"] = format_time(now)
    paths = write_thread(root, thread)
    snapshot = update_thread_index(root, thread, paths)
    append_thread_event(root, "promote", snapshot, now)
    return {
        "thread": thread,
        "paths": paths,
        "snapshot": snapshot,
    }


def persist_case(root: Path, thread: dict[str, Any], now: datetime, promotion_reason: str) -> dict[str, Any]:
    cases_dir = root / "cases"
    conversations_dir = root / "conversations"
    ensure_dir(cases_dir)
    ensure_dir(conversations_dir)
    index_path = root / "index.json"
    issues_path = root / "issues.jsonl"

    case_payload = build_case_payload_from_thread(thread)
    index_data = load_json(index_path, {"version": 1, "cases": []})
    index_cases = index_data["cases"]

    if thread.get("case_id"):
        case_id = str(thread["case_id"])
        matched = {"case_id": case_id}
    elif case_payload.get("force_case_id"):
        case_id = str(case_payload["force_case_id"])
        matched = {"case_id": case_id}
    else:
        matched = None if case_payload.get("disable_case_matching") else choose_case(index_cases, case_payload)
        case_id = str(matched["case_id"]) if matched else build_case_id(now, case_payload)

    case_json_path = cases_dir / f"{case_id}.json"
    if case_json_path.exists():
        case = json.loads(case_json_path.read_text(encoding="utf-8"))
        action = "update"
    elif matched:
        case = deepcopy(matched)
        action = "update"
    else:
        case = {
            "case_id": case_id,
            "status": "open",
            "created_at": format_time(now),
        }
        action = "create"
    case.setdefault("status", "open")
    case.setdefault("created_at", format_time(now))
    case.setdefault("activities", [])

    case["chat_id"] = thread["chat_id"]
    case["chat_name"] = thread["chat_name"]
    case["category"] = thread["category"]
    case["priority"] = thread["priority"]
    case["reporter"] = case.get("reporter") or thread["reporter"]
    if should_refresh_case_summary(str(thread.get("latest_batch_action") or ""), str(thread.get("latest_message_role") or "")):
        case["summary"] = choose_summary(str(case.get("summary") or ""), thread["summary"])
    else:
        case["summary"] = str(case.get("summary") or thread["summary"])
    case["keywords"] = normalize_keywords(
        list(case.get("keywords") or []) + list(thread["keywords"]),
        case["summary"],
        thread["messages"],
    )
    case["confidence"] = thread["confidence"]
    case["messages"] = merge_messages(case.get("messages") or [], thread["messages"])
    case["first_message_time"], case["last_message_time"] = message_time_bounds(case["messages"])
    case["reporters"] = collect_people(case["messages"])
    case["participants"] = collect_people(case["messages"])
    case["latest_sender"] = thread["latest_sender"]
    case["updated_at"] = format_time(now)
    case["source_thread_id"] = thread["thread_id"]
    case["promotion_reason"] = promotion_reason
    case["latest_message_role"] = thread.get("latest_message_role")
    case["latest_batch_action"] = thread.get("latest_batch_action")
    case["thread_type"] = thread.get("thread_type")
    case["status"] = derive_case_status(
        case["category"],
        str(thread.get("latest_batch_action") or ""),
        str(thread.get("latest_message_role") or ""),
        str(case.get("status") or "open"),
    )
    case["activities"] = list(case.get("activities") or [])
    case["activities"].append(build_activity_entry(thread, now))
    case["conversation"] = build_conversation_record(case, "case")

    case_md_path = cases_dir / f"{case_id}.md"
    conversation_json_path = conversations_dir / f"{case_id}.json"
    conversation_md_path = conversations_dir / f"{case_id}.md"
    write_json(case_json_path, case)
    case_md_path.write_text(render_case_markdown(case), encoding="utf-8")
    write_json(conversation_json_path, case["conversation"])
    conversation_md_path.write_text(
        render_conversation_markdown(case["conversation"]),
        encoding="utf-8",
    )

    paths = {
        "json": str(case_json_path),
        "markdown": str(case_md_path),
        "conversation_json": str(conversation_json_path),
        "conversation_markdown": str(conversation_md_path),
    }
    snapshot = build_case_snapshot(case, paths)

    replaced = False
    next_cases: list[dict[str, Any]] = []
    for item in index_cases:
        if isinstance(item, dict) and item.get("case_id") == case_id:
            next_cases.append(snapshot)
            replaced = True
        else:
            next_cases.append(item)
    if not replaced:
        next_cases.append(snapshot)
    next_cases.sort(key=lambda item: item.get("updated_at", ""), reverse=True)
    index_data["cases"] = next_cases
    write_json(index_path, index_data)

    append_jsonl(
        issues_path,
        {
            "event_time": format_time(now),
            "action": action,
            "case": snapshot,
        },
    )

    return {
        "case": case,
        "action": action,
        "paths": paths,
        "snapshot": snapshot,
    }


def run_pipeline(root: Path, payload: dict[str, Any]) -> dict[str, Any]:
    ensure_dir(root)
    now = datetime.now()
    raw_result = persist_raw_messages(root, payload, now)
    thread_result = upsert_thread(root, payload, now)
    thread = thread_result["thread"]
    promote, reason = should_promote_thread(thread)
    if payload.get("force_promote_case") or payload.get("force_case_id") or payload.get("batch_action") in {"new_case", "append_case", "append_case_activity"}:
        promote = True
        reason = "forced-case-link"

    case_result: dict[str, Any] | None = None
    if promote:
        case_result = persist_case(root, thread, now, reason)
        thread_result = link_thread_case(root, thread, case_result["case"]["case_id"], reason, now)

    return {
        "ok": True,
        "root": str(root),
        "raw": raw_result,
        "thread": {
            "action": "promote" if case_result else thread_result["action"],
            "thread_id": thread_result["thread"]["thread_id"],
            "status": thread_result["thread"]["status"],
            "reason": thread_result["thread"]["promotion_reason"],
            "json_path": thread_result["paths"]["json"],
            "markdown_path": thread_result["paths"]["markdown"],
        },
        "case": None
        if not case_result
        else {
            "action": case_result["action"],
            "case_id": case_result["case"]["case_id"],
            "json_path": case_result["paths"]["json"],
            "markdown_path": case_result["paths"]["markdown"],
            "conversation_json_path": case_result["paths"]["conversation_json"],
            "conversation_markdown_path": case_result["paths"]["conversation_markdown"],
            "issues_path": str(root / "issues.jsonl"),
        },
        "indexes": {
            "thread_index": str(root / "thread_index.json"),
            "case_index": str(root / "index.json"),
        },
    }
