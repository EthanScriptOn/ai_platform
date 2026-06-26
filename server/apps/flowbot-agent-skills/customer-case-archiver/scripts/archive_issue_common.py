from __future__ import annotations

import json
from copy import deepcopy
from datetime import datetime
from pathlib import Path
from typing import Any


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def load_payload(args: argparse.Namespace) -> dict[str, Any]:
    if args.input_file:
        raw = Path(args.input_file).read_text(encoding="utf-8")
    else:
        import sys

        raw = sys.stdin.read()
    if not raw.strip():
        raise ValueError("No JSON payload provided.")
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("Payload must be a JSON object.")
    return data


def parse_time(value: str | None) -> datetime:
    if not value:
        return datetime.now()
    text = str(value).strip()
    for fmt in (
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%dT%H:%M:%S.%f",
        "%Y-%m-%d",
    ):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError as exc:
        raise ValueError(f"Unsupported time format: {text}") from exc


def format_time(value: datetime) -> str:
    return value.strftime("%Y-%m-%d %H:%M:%S")


def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return deepcopy(default)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return deepcopy(default)
    return data if isinstance(data, type(default)) else deepcopy(default)


def write_json(path: Path, data: Any) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def append_jsonl(path: Path, data: Any) -> None:
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(data, ensure_ascii=False) + "\n")


def message_key(chat_id: str, item: dict[str, Any]) -> str:
    msg_id = str(item.get("msg_id") or "").strip()
    if msg_id:
        return f"{chat_id}::{msg_id}"
    return f"{chat_id}::{item.get('time')}::{item.get('sender')}::{item.get('type')}::{item.get('content')}"
