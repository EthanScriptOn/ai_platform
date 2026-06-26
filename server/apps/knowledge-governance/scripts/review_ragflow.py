import hashlib
import json
import mimetypes
from datetime import datetime
from pathlib import Path
from urllib import error, parse, request

from review_repository import load_decisions, load_governed_items, render_approved_markdown


def ragflow_request_json(base_url, token, method, path, data=None, timeout=60):
    body = None
    headers = {"Authorization": f"Bearer {token}"}
    if data is not None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = request.Request(
        base_url.rstrip("/") + path,
        data=body,
        headers=headers,
        method=method,
    )
    try:
        with request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
    except error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"RAGFlow HTTP {exc.code}: {raw}") from exc
    if not raw:
        return {}
    parsed = json.loads(raw)
    if parsed.get("code") not in (None, 0):
        raise RuntimeError(parsed.get("message") or json.dumps(parsed, ensure_ascii=False))
    return parsed


def ragflow_upload_file(base_url, token, dataset_id, file_path, timeout=120):
    boundary = "----codexragflow" + hashlib.sha1(str(datetime.now()).encode()).hexdigest()
    path = Path(file_path)
    content_type = mimetypes.guess_type(path.name)[0] or "text/markdown"
    content = path.read_bytes()
    parts = [
        f"--{boundary}\r\n".encode(),
        (
            f'Content-Disposition: form-data; name="file"; filename="{path.name}"\r\n'
            f"Content-Type: {content_type}\r\n\r\n"
        ).encode(),
        content,
        b"\r\n",
        f"--{boundary}--\r\n".encode(),
    ]
    body = b"".join(parts)
    req = request.Request(
        f"{base_url.rstrip('/')}/api/v1/datasets/{dataset_id}/documents",
        data=body,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Content-Length": str(len(body)),
        },
        method="POST",
    )
    try:
        with request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
    except error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"RAGFlow upload HTTP {exc.code}: {raw}") from exc
    parsed = json.loads(raw)
    if parsed.get("code") != 0:
        raise RuntimeError(parsed.get("message") or raw)
    return parsed


def import_approved_to_ragflow(server):
    items = load_governed_items(server.run_dir)
    decisions = load_decisions(server.state_path)
    text, count = render_approved_markdown(items, decisions)
    if count <= 0:
        return {"ok": False, "error": "还没有已通过的知识，请先审核并通过至少一条。"}

    export_dir = Path(server.run_dir) / "approved_ragflow_markdown"
    export_dir.mkdir(parents=True, exist_ok=True)
    out_path = export_dir / "approved_knowledge.md"
    out_path.write_text(text, encoding="utf-8")

    token = server.ragflow_token
    if not token:
        return {"ok": False, "error": "缺少 RAGFlow API token。"}
    dataset_id = server.ragflow_dataset_id
    if not dataset_id:
        return {"ok": False, "error": "缺少 RAGFlow dataset_id。"}

    base = server.ragflow_base_url
    encoded_name = parse.quote(out_path.name)
    docs = ragflow_request_json(
        base,
        token,
        "GET",
        f"/api/v1/datasets/{dataset_id}/documents?keywords={encoded_name}&page=1&page_size=100",
    )
    existing = [
        doc["id"]
        for doc in (docs.get("data", {}).get("docs") or [])
        if doc.get("name") == out_path.name or doc.get("location") == out_path.name
    ]
    if existing:
        ragflow_request_json(
            base,
            token,
            "DELETE",
            f"/api/v1/datasets/{dataset_id}/documents",
            {"ids": existing},
        )

    uploaded = ragflow_upload_file(base, token, dataset_id, out_path)
    uploaded_docs = uploaded.get("data") or []
    document_ids = [doc["id"] for doc in uploaded_docs if doc.get("id")]
    if not document_ids:
        raise RuntimeError("RAGFlow 上传成功但没有返回 document id。")

    ragflow_request_json(
        base,
        token,
        "POST",
        f"/api/v1/datasets/{dataset_id}/chunks",
        {"document_ids": document_ids},
    )

    state_path = Path(server.run_dir) / "ragflow_import_state.json"
    state = {
        "imported_at": datetime.now().isoformat(timespec="seconds"),
        "base_url": base,
        "dataset_id": dataset_id,
        "document_name": out_path.name,
        "document_ids": document_ids,
        "approved_count": count,
        "path": str(out_path),
        "replaced_document_ids": existing,
    }
    state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    return {
        "ok": True,
        "count": count,
        "path": str(out_path),
        "document_name": out_path.name,
        "document_ids": document_ids,
        "replaced_document_ids": existing,
        "state_path": str(state_path),
    }
