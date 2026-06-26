#!/usr/bin/env python3
import argparse
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
    import hashlib

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


def load_decisions(path):
    if not Path(path).exists():
        return {}
    return json.loads(Path(path).read_text(encoding="utf-8"))


def lines(value):
    if isinstance(value, list):
      return [str(item).strip() for item in value if str(item).strip()]
    if value:
      return [str(value).strip()]
    return []


def render_unit(item, unit):
    output = [
        f"### {unit.get('title', '')}",
        "",
    ]
    questions = lines(unit.get("user_questions"))
    if questions:
        output.append("#### 常见问法")
        output.extend([f"- {question}" for question in questions])
        output.append("")

    final_content = (unit.get("final_content") or "").strip()
    if final_content:
        output.extend(["#### 答案", final_content, ""])
    else:
        answer = (unit.get("answer_for_customer") or "").strip()
        if answer:
            output.extend(["#### 答案", answer, ""])
        steps = lines(unit.get("steps"))
        if steps:
            output.append("#### 处理步骤")
            output.extend([f"{idx}. {step}" for idx, step in enumerate(steps, 1)])
            output.append("")
        internal_notes = (unit.get("internal_notes") or "").strip()
        if internal_notes:
            output.extend(["#### 内部说明", internal_notes, ""])

    keywords = []
    for value in [unit.get("title"), unit.get("scope"), *lines(unit.get("tags"))]:
        text = str(value or "").strip()
        if text and text not in keywords:
            keywords.append(text)
    if keywords:
        output.append("#### 关键词")
        output.extend([f"- {keyword}" for keyword in keywords[:20]])
        output.append("")
    return output


def build_export(run_dir):
    run_dir = Path(run_dir)
    docs = read_jsonl(run_dir / "governed_units.jsonl")
    decisions = load_decisions(run_dir / "review_decisions.json")

    lines_out = ["# 已审核知识库", ""]
    approved_units = 0
    docs_used = 0

    for doc_result in docs:
        quality = doc_result.get("quality") or {}
        if quality.get("is_useful_for_kb") is False:
            continue
        doc = doc_result.get("document") or {}
        rendered = []
        for unit in doc_result.get("knowledge_units") or []:
            item_id = stable_id(doc.get("title", ""), unit)
            decision = decisions.get(item_id)
            if decision:
                if decision.get("status") != "approved":
                    continue
                working_unit = decision.get("unit") or unit
            else:
                working_unit = unit

            final_content = (
                (working_unit.get("final_content") or "").strip()
                or (working_unit.get("answer_for_customer") or "").strip()
                or (working_unit.get("internal_notes") or "").strip()
                or bool(lines(working_unit.get("steps")))
            )
            if not final_content:
                continue
            approved_units += 1
            rendered.extend(
                render_unit(
                    {
                        "feishu_url": doc.get("feishu_url", ""),
                    },
                    working_unit,
                )
            )
        if rendered:
            docs_used += 1
            lines_out.extend([f"## {doc.get('title', '')}", ""])
            lines_out.extend(rendered)

    return "\n".join(lines_out).strip() + "\n", {"docs_used": docs_used, "approved_units": approved_units}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    text, stats = build_export(args.run_dir)
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(text, encoding="utf-8")
    print(json.dumps({"ok": True, "path": str(out_path), **stats}, ensure_ascii=False))


if __name__ == "__main__":
    main()
