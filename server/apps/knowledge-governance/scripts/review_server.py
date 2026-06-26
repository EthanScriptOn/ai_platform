#!/usr/bin/env python3
import argparse
import json
import os
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from review_ragflow import import_approved_to_ragflow
from review_repository import (
    load_decisions,
    load_governed_items,
    render_approved_markdown,
    save_decisions,
)
from review_ui import load_root_html


ROOT_HTML = load_root_html()


class ReviewHandler(BaseHTTPRequestHandler):
    server_version = "KnowledgeReview/0.1"

    def log_message(self, fmt, *args):
        print(f"[review] {self.address_string()} {fmt % args}")

    def send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_body_json(self):
        size = int(self.headers.get("Content-Length") or "0")
        if not size:
            return {}
        return json.loads(self.rfile.read(size).decode("utf-8"))

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/":
            body = ROOT_HTML.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if parsed.path == "/api/items":
            items = load_governed_items(self.server.run_dir)
            decisions = load_decisions(self.server.state_path)
            for item in items:
                item["decision"] = decisions.get(item["id"])
            self.send_json({"items": items})
            return
        self.send_json({"error": "not found"}, status=404)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/decision":
            payload = self.read_body_json()
            item_id = payload.get("id")
            if not item_id:
                self.send_json({"error": "missing id"}, status=400)
                return
            decisions = load_decisions(self.server.state_path)
            decisions[item_id] = {
                "status": payload.get("status") or "pending",
                "note": payload.get("note") or "",
                "unit": payload.get("unit") or {},
                "updated_at": datetime.now().isoformat(timespec="seconds"),
            }
            save_decisions(self.server.state_path, decisions)
            self.send_json({"ok": True})
            return
        if parsed.path == "/api/export":
            items = load_governed_items(self.server.run_dir)
            decisions = load_decisions(self.server.state_path)
            text, count = render_approved_markdown(items, decisions)
            export_dir = Path(self.server.run_dir) / "approved_ragflow_markdown"
            export_dir.mkdir(parents=True, exist_ok=True)
            out_path = export_dir / "approved_knowledge.md"
            out_path.write_text(text, encoding="utf-8")
            self.send_json({"ok": True, "count": count, "path": str(out_path)})
            return
        if parsed.path == "/api/import-ragflow":
            try:
                result = import_approved_to_ragflow(self.server)
            except Exception as exc:
                self.send_json({"ok": False, "error": str(exc)}, status=500)
                return
            self.send_json(result, status=200 if result.get("ok") else 400)
            return
        self.send_json({"error": "not found"}, status=404)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-dir", default="data/knowledge-governance/review-runs/current")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8777)
    parser.add_argument("--ragflow-base-url", default=os.getenv("RAGFLOW_BASE_URL", "http://47.104.81.250:8080"))
    parser.add_argument("--ragflow-token-file", default=os.getenv("RAGFLOW_TOKEN_FILE", "/tmp/ragflow_yfd_api_token.txt"))
    parser.add_argument("--ragflow-dataset-id", default=os.getenv("RAGFLOW_DATASET_ID", ""))
    parser.add_argument("--ragflow-state-file", default=os.getenv("RAGFLOW_STATE_FILE", "/tmp/ragflow_yfd_clean_state.json"))
    args = parser.parse_args()

    run_dir = Path(args.run_dir).resolve()
    state_path = run_dir / "review_decisions.json"
    token = ""
    if args.ragflow_token_file and Path(args.ragflow_token_file).exists():
        token = Path(args.ragflow_token_file).read_text(encoding="utf-8").strip()
    dataset_id = args.ragflow_dataset_id
    if not dataset_id and args.ragflow_state_file and Path(args.ragflow_state_file).exists():
        dataset_id = (json.loads(Path(args.ragflow_state_file).read_text(encoding="utf-8"))).get("dataset_id", "")
    server = ThreadingHTTPServer((args.host, args.port), ReviewHandler)
    server.run_dir = str(run_dir)
    server.state_path = str(state_path)
    server.ragflow_base_url = args.ragflow_base_url
    server.ragflow_token = token
    server.ragflow_dataset_id = dataset_id
    print(f"Knowledge review server: http://{args.host}:{args.port}/")
    print(f"Run dir: {run_dir}")
    print(f"RAGFlow: {args.ragflow_base_url} dataset={dataset_id or '-'}")
    server.serve_forever()


if __name__ == "__main__":
    main()
