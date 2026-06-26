from __future__ import annotations

from copy import deepcopy
from typing import Any

from archive_constants import CATEGORY_LABELS, CASE_STATUS_LABELS, MESSAGE_ROLE_LABELS, THREAD_TYPE_LABELS


def render_thread_markdown(thread: dict[str, Any]) -> str:
    lines = [
        f"# {thread['thread_id']}",
        "",
        "## 线程信息",
        f"- 类别：{CATEGORY_LABELS.get(thread['category'], thread['category'])}",
        f"- 状态：{thread['status']}",
        f"- 线程类型：{THREAD_TYPE_LABELS.get(str(thread.get('thread_type') or ''), str(thread.get('thread_type') or 'n/a'))}",
        f"- 最新消息角色：{MESSAGE_ROLE_LABELS.get(str(thread.get('latest_message_role') or ''), str(thread.get('latest_message_role') or 'n/a'))}",
        f"- 最新动作：{thread.get('latest_batch_action') or 'n/a'}",
        f"- 群聊：{thread['chat_name']} ({thread['chat_id']})",
        f"- 首位反馈人：{thread['reporter']}",
        f"- 参与人：{', '.join(thread.get('participants') or [thread['reporter']])}",
        f"- 首次消息时间：{thread['first_message_time']}",
        f"- 最新消息时间：{thread['last_message_time']}",
        f"- 消息数：{len(thread['messages'])}",
        f"- 置信度：{thread['confidence'] if thread['confidence'] is not None else 'n/a'}",
        f"- 已关联 Case：{thread.get('case_id') or '未提升'}",
        "",
        "## 摘要",
        thread["summary"],
        "",
        "## 关键词",
        ", ".join(thread["keywords"]) if thread["keywords"] else "n/a",
        "",
        "## 原始消息",
    ]
    for index, item in enumerate(thread["messages"], start=1):
        media_suffix = ""
        role_suffix = ""
        if item.get("media_local_url") or item.get("media_local_path"):
            media_bits = []
            if item.get("media_kind"):
                media_bits.append(f"kind={item['media_kind']}")
            if item.get("media_local_url"):
                media_bits.append(f"url={item['media_local_url']}")
            if item.get("media_local_path"):
                media_bits.append(f"path={item['media_local_path']}")
            media_suffix = f" [media: {'; '.join(media_bits)}]"
        if item.get("message_role"):
            role_suffix = f" [role: {MESSAGE_ROLE_LABELS.get(str(item.get('message_role') or ''), str(item.get('message_role') or ''))}]"
        lines.append(
            f"{index}. [{item['time']}] {item['sender']} ({item['type']}): {item['content']}{role_suffix}{media_suffix}"
        )
    lines.extend(
        [
            "",
            "## 归档信息",
            f"- 创建时间：{thread['created_at']}",
            f"- 更新时间：{thread['updated_at']}",
            f"- 提升时间：{thread.get('promoted_at') or 'n/a'}",
            "",
        ]
    )
    return "\n".join(lines)


def render_case_markdown(case: dict[str, Any]) -> str:
    lines = [
        f"# {case['case_id']}",
        "",
        "## 基本信息",
        f"- 类别：{CATEGORY_LABELS.get(case['category'], case['category'])}",
        f"- 状态：{CASE_STATUS_LABELS.get(case['status'], case['status'])}",
        f"- 优先级：{case['priority']}",
        f"- 群聊：{case['chat_name']} ({case['chat_id']})",
        f"- 关联线程：{case.get('source_thread_id') or 'n/a'}",
        f"- 首位反馈人：{case['reporter']}",
        f"- 参与反馈人：{', '.join(case.get('reporters') or [case['reporter']])}",
        f"- 全部参与人：{', '.join(case.get('participants') or [case['reporter']])}",
        f"- 首次消息时间：{case['first_message_time']}",
        f"- 最新消息时间：{case['last_message_time']}",
        f"- 置信度：{case['confidence'] if case['confidence'] is not None else 'n/a'}",
        "",
        "## 问题摘要",
        case["summary"],
        "",
        "## 关键词",
        ", ".join(case["keywords"]) if case["keywords"] else "n/a",
        "",
        "## Case 活动",
    ]
    activities = case.get("activities") or []
    if activities:
        for index, item in enumerate(activities, start=1):
            lines.append(
                f"{index}. [{item.get('time')}] {MESSAGE_ROLE_LABELS.get(str(item.get('message_role') or ''), str(item.get('message_role') or ''))} / {item.get('sender') or 'unknown'} / {item.get('summary') or ''}"
            )
    else:
        lines.append("暂无活动记录")
    lines.extend([
        "",
        "## 原始消息",
    ])
    for index, item in enumerate(case["messages"], start=1):
        media_suffix = ""
        role_suffix = ""
        if item.get("media_local_url") or item.get("media_local_path"):
            media_bits = []
            if item.get("media_kind"):
                media_bits.append(f"kind={item['media_kind']}")
            if item.get("media_local_url"):
                media_bits.append(f"url={item['media_local_url']}")
            if item.get("media_local_path"):
                media_bits.append(f"path={item['media_local_path']}")
            media_suffix = f" [media: {'; '.join(media_bits)}]"
        if item.get("message_role"):
            role_suffix = f" [role: {MESSAGE_ROLE_LABELS.get(str(item.get('message_role') or ''), str(item.get('message_role') or ''))}]"
        lines.append(
            f"{index}. [{item['time']}] {item['sender']} ({item['type']}): {item['content']}{role_suffix}{media_suffix}"
        )
    lines.extend(
        [
            "",
            "## 归档信息",
            f"- 消息数：{len(case['messages'])}",
            f"- 创建时间：{case['created_at']}",
            f"- 更新时间：{case['updated_at']}",
            "",
        ]
    )
    return "\n".join(lines)


def render_conversation_markdown(conversation: dict[str, Any]) -> str:
    lines = [
        f"# {conversation['source_id']} 会话全程记录",
        "",
        "## 说明",
        "- 本文件保留当前接入链路收到的原始文本内容，不做翻译或改写。",
        "- 若某些消息来自图片理解或语音转写，则这里保存的是链路收到的文本结果。",
        "",
        "## 会话信息",
        f"- 来源：{conversation['source_kind']}",
        f"- 类别：{CATEGORY_LABELS.get(conversation['category'], conversation['category'])}",
        f"- 群聊：{conversation['chat_name']} ({conversation['chat_id']})",
        f"- 参与人：{', '.join(conversation.get('participants') or ['unknown'])}",
        f"- 开始时间：{conversation['started_at']}",
        f"- 结束时间：{conversation['ended_at']}",
        f"- 消息数：{conversation['message_count']}",
        "",
        "## 活动时间线",
    ]
    activities = conversation.get("activities") or []
    if activities:
        for index, item in enumerate(activities, start=1):
            lines.append(
                f"{index}. [{item.get('time')}] {MESSAGE_ROLE_LABELS.get(str(item.get('message_role') or ''), str(item.get('message_role') or ''))} / {item.get('sender') or 'unknown'} / {item.get('summary') or ''}"
            )
    else:
        lines.append("暂无活动记录")
    lines.extend([
        "",
        "## 全量对话",
    ])
    for index, item in enumerate(conversation["timeline"], start=1):
        media_suffix = ""
        role_suffix = ""
        if item.get("media_local_url") or item.get("media_local_path"):
            media_bits = []
            if item.get("media_kind"):
                media_bits.append(f"kind={item['media_kind']}")
            if item.get("media_local_url"):
                media_bits.append(f"url={item['media_local_url']}")
            if item.get("media_local_path"):
                media_bits.append(f"path={item['media_local_path']}")
            media_suffix = f" [media: {'; '.join(media_bits)}]"
        if item.get("message_role"):
            role_suffix = f" [role: {MESSAGE_ROLE_LABELS.get(str(item.get('message_role') or ''), str(item.get('message_role') or ''))}]"
        lines.append(
            f"{index}. [{item['time']}] {item['sender']} ({item['type']}): {item['content']}{role_suffix}{media_suffix}"
        )
    lines.append("")
    return "\n".join(lines)


def build_thread_snapshot(thread: dict[str, Any], paths: dict[str, str]) -> dict[str, Any]:
    return {
        "thread_id": thread["thread_id"],
        "chat_id": thread["chat_id"],
        "chat_name": thread["chat_name"],
        "category": thread["category"],
        "status": thread["status"],
        "thread_type": thread.get("thread_type"),
        "latest_message_role": thread.get("latest_message_role"),
        "latest_batch_action": thread.get("latest_batch_action"),
        "priority": thread["priority"],
        "summary": thread["summary"],
        "reporter": thread["reporter"],
        "participants": thread.get("participants") or [thread["reporter"]],
        "first_message_time": thread["first_message_time"],
        "last_message_time": thread["last_message_time"],
        "updated_at": thread["updated_at"],
        "keywords": thread["keywords"],
        "message_count": len(thread["messages"]),
        "case_id": thread.get("case_id"),
        "paths": paths,
    }


def build_case_snapshot(case: dict[str, Any], paths: dict[str, str]) -> dict[str, Any]:
    return {
        "case_id": case["case_id"],
        "chat_id": case["chat_id"],
        "chat_name": case["chat_name"],
        "category": case["category"],
        "priority": case["priority"],
        "summary": case["summary"],
        "status": case["status"],
        "status_label": CASE_STATUS_LABELS.get(case["status"], case["status"]),
        "reporters": case.get("reporters") or [case["reporter"]],
        "participants": case.get("participants") or [case["reporter"]],
        "first_message_time": case["first_message_time"],
        "last_message_time": case["last_message_time"],
        "updated_at": case["updated_at"],
        "keywords": case["keywords"],
        "message_count": len(case["messages"]),
        "activity_count": len(case.get("activities") or []),
        "latest_message_role": case.get("latest_message_role"),
        "source_thread_id": case.get("source_thread_id"),
        "paths": paths,
    }


def build_case_payload_from_thread(thread: dict[str, Any]) -> dict[str, Any]:
    return {
        "chat_id": thread["chat_id"],
        "chat_name": thread["chat_name"],
        "sender": thread["latest_sender"],
        "message_time": thread["last_message_time"],
        "first_message_time": thread["first_message_time"],
        "last_message_time": thread["last_message_time"],
        "category": thread["category"],
        "priority": thread["priority"],
        "summary": thread["summary"],
        "keywords": thread["keywords"],
        "confidence": thread["confidence"],
        "messages": deepcopy(thread["messages"]),
        "thread_type": str(thread.get("thread_type") or "").strip(),
        "message_role": str(thread.get("latest_message_role") or "").strip(),
        "batch_action": str(thread.get("latest_batch_action") or "").strip(),
        "force_case_id": str(thread.get("force_case_id") or "").strip(),
        "disable_case_matching": bool(thread.get("disable_case_matching")),
        "force_promote_case": True,
    }
