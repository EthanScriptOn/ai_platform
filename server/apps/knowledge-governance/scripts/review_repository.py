import hashlib
import json
from pathlib import Path


def read_jsonl(path):
    rows = []
    if not Path(path).exists():
        return rows
    with Path(path).open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def stable_id(document_title, unit):
    raw = json.dumps(
        {
            "document_title": document_title,
            "title": unit.get("title"),
            "evidence": unit.get("source_evidence", []),
        },
        ensure_ascii=False,
        sort_keys=True,
    )
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def load_governed_items(run_dir):
    items = []
    governed_path = Path(run_dir) / "governed_units.jsonl"
    for doc_result in read_jsonl(governed_path):
        doc = doc_result.get("document") or {}
        for unit in doc_result.get("knowledge_units") or []:
            needs_review = unit.get("needs_human_review", True) or unit.get("visibility") != "public_reply"
            if not needs_review:
                continue
            items.append(
                {
                    "id": stable_id(doc.get("title"), unit),
                    "document_title": doc.get("title") or "",
                    "feishu_url": doc.get("feishu_url") or "",
                    "source_path": doc.get("source_path") or "",
                    "unit": unit,
                }
            )
    return items


def load_decisions(state_path):
    if not Path(state_path).exists():
        return {}
    return json.loads(Path(state_path).read_text(encoding="utf-8"))


def save_decisions(state_path, decisions):
    Path(state_path).parent.mkdir(parents=True, exist_ok=True)
    Path(state_path).write_text(json.dumps(decisions, ensure_ascii=False, indent=2), encoding="utf-8")


def render_approved_markdown(items, decisions):
    lines = ["# 已审核知识库", ""]
    approved = []
    for item in items:
        decision = decisions.get(item["id"])
        if not decision or decision.get("status") != "approved":
            continue
        unit = decision.get("unit") or item["unit"]
        approved.append((item, unit))

    by_doc = {}
    for item, unit in approved:
        by_doc.setdefault(item["document_title"], []).append((item, unit))

    for doc_title, pairs in by_doc.items():
        lines.extend([f"## {doc_title}", ""])
        for item, unit in pairs:
            lines.extend(
                [
                    f"### {unit.get('title', '')}",
                    "",
                ]
            )
            questions = unit.get("user_questions") or []
            if questions:
                lines.append("#### 常见问法")
                lines.extend([f"- {q}" for q in questions])
                lines.append("")
            final_content = unit.get("final_content") or ""
            if final_content:
                lines.extend(["#### 答案", final_content, ""])
            else:
                if unit.get("answer_for_customer"):
                    lines.extend(["#### 答案", unit["answer_for_customer"], ""])
                steps = unit.get("steps") or []
                if steps:
                    lines.append("#### 处理步骤")
                    lines.extend([f"{idx}. {step}" for idx, step in enumerate(steps, 1)])
                    lines.append("")
                if unit.get("internal_notes"):
                    lines.extend(["#### 内部说明", unit["internal_notes"], ""])
            keywords = []
            for value in [unit.get("title"), unit.get("scope"), *(unit.get("tags") or [])]:
                text = str(value or "").strip()
                if text and text not in keywords:
                    keywords.append(text)
            if keywords:
                lines.append("#### 关键词")
                lines.extend([f"- {x}" for x in keywords[:20]])
                lines.append("")
    return "\n".join(lines).strip() + "\n", len(approved)
