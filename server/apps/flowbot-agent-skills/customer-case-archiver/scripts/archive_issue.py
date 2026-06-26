#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

from archive_issue_common import load_payload
from archive_issue_payload import normalize_payload
from archive_issue_persistence import run_pipeline

def default_root() -> Path:
    return Path(__file__).resolve().parents[3] / "customer-bot-data"

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Ingest customer-service issue records into raw logs, candidate threads, and local cases."
    )
    parser.add_argument(
        "--root",
        default=str(default_root()),
        help="Archive root directory. Defaults to customer-bot-data beside the skill bundle.",
    )
    parser.add_argument(
        "--input-file",
        help="Optional JSON file path. If omitted, the script reads JSON from stdin.",
    )
    return parser.parse_args()

def main() -> int:
    args = parse_args()
    payload = normalize_payload(load_payload(args))
    result = run_pipeline(Path(args.root).expanduser().resolve(), payload)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
