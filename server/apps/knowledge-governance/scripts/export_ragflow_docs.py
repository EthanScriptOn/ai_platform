#!/usr/bin/env python3
import argparse
import json
import re
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


def load_decisions(path):
    if not Path(path).exists():
        return {}
    return json.loads(Path(path).read_text(encoding="utf-8"))


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


def safe_slug(text):
    text = re.sub(r"[\\/:*?\"<>|]+", "-", text)
    text = re.sub(r"\s+", "-", text).strip("-")
    return text[:120] or "untitled"


def listify(value):
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if value:
        return [str(value).strip()]
    return []


def pick_final_content(unit):
    return (
        (unit.get("final_content") or "").strip()
        or (unit.get("answer_for_customer") or "").strip()
        or (unit.get("internal_notes") or "").strip()
        or ("\n".join(f"{idx}. {step}" for idx, step in enumerate(listify(unit.get("steps")), 1)))
    )


def render_clean_unit_content(unit):
    output = []
    questions = listify(unit.get("user_questions"))
    if questions:
        output.append("### 常见问法")
        output.extend([f"- {question}" for question in questions])
        output.append("")

    final_content = pick_final_content(unit)
    if final_content:
        output.extend(["### 答案", final_content, ""])

    steps = listify(unit.get("steps"))
    if steps:
        output.append("### 处理步骤")
        output.extend([f"{idx}. {step}" for idx, step in enumerate(steps, 1)])
        output.append("")

    tags = listify(unit.get("tags"))
    products = listify((unit.get("entities") or {}).get("products"))
    systems = listify((unit.get("entities") or {}).get("systems"))
    keywords = []
    for item in [unit.get("title"), unit.get("scope"), *tags, *products, *systems]:
        text = str(item or "").strip()
        if text and text not in keywords:
            keywords.append(text)
    if keywords:
        output.append("### 关键词")
        output.extend([f"- {keyword}" for keyword in keywords[:20]])
        output.append("")
    return output


def render_doc(doc, units):
    lines = [
        f"# {doc.get('title', '未命名文档')}",
        "",
    ]
    summary = (doc.get("summary") or "").strip()
    if summary:
        lines.extend([summary, ""])
    for idx, unit in enumerate(units, 1):
        lines.extend(
            [
                f"## {idx}. {unit.get('title', '')}",
                "",
            ]
        )
        lines.extend(render_clean_unit_content(unit))
    return "\n".join(lines).strip() + "\n"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--out-dir", required=True)
    args = parser.parse_args()

    run_dir = Path(args.run_dir)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    decisions = load_decisions(run_dir / "review_decisions.json")
    docs = read_jsonl(run_dir / "governed_units.jsonl")

    written = 0
    units_written = 0
    used_names = {}
    for doc_result in docs:
        quality = doc_result.get("quality") or {}
        if quality.get("is_useful_for_kb") is False:
            continue
        doc = doc_result.get("document") or {}
        selected_units = []
        for unit in doc_result.get("knowledge_units") or []:
            item_id = stable_id(doc.get("title", ""), unit)
            decision = decisions.get(item_id)
            if decision:
                if decision.get("status") != "approved":
                    continue
                working_unit = decision.get("unit") or unit
            else:
                working_unit = unit
            if not pick_final_content(working_unit):
                continue
            selected_units.append(working_unit)
        if not selected_units:
            continue
        slug = safe_slug(doc.get("title") or "untitled")
        used_names[slug] = used_names.get(slug, 0) + 1
        suffix = "" if used_names[slug] == 1 else f"-{used_names[slug]}"
        (out_dir / f"{slug}{suffix}.md").write_text(render_doc(doc, selected_units), encoding="utf-8")
        written += 1
        units_written += len(selected_units)

    print(json.dumps({"ok": True, "docs_written": written, "units_written": units_written, "out_dir": str(out_dir)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
