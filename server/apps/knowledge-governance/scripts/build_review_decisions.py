#!/usr/bin/env python3
import argparse
import json
from datetime import datetime, timezone
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
    import hashlib

    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def join_steps(steps):
    steps = [str(step).strip() for step in (steps or []) if str(step).strip()]
    if not steps:
        return ""
    return "\n".join(f"{idx}. {step}" for idx, step in enumerate(steps, 1))


def choose_final_content(unit):
    visibility = unit.get("visibility") or "needs_review"
    answer = (unit.get("answer_for_customer") or "").strip()
    internal = (unit.get("internal_notes") or "").strip()
    steps_text = join_steps(unit.get("steps") or [])
    if visibility == "public_reply":
        return answer or steps_text or internal
    return internal or answer or steps_text


def should_approve(doc_result, unit, min_confidence):
    quality = doc_result.get("quality") or {}
    if quality.get("is_useful_for_kb") is False:
        return False, "文档整体被模型判定为不适合入库"

    final_content = choose_final_content(unit)
    if not final_content:
        return False, "缺少可入库的最终内容"

    confidence = unit.get("confidence")
    try:
        confidence = float(confidence)
    except (TypeError, ValueError):
        confidence = 0.0
    if confidence < min_confidence:
        return False, f"置信度低于阈值 {min_confidence}"

    title = (unit.get("title") or "").strip()
    if not title:
        return False, "缺少知识标题"

    return True, "批量审核自动通过"


def build_decisions(run_dir, min_confidence):
    items = read_jsonl(Path(run_dir) / "governed_units.jsonl")
    decisions = {}
    stats = {
        "documents": 0,
        "units": 0,
        "approved": 0,
        "changes_requested": 0,
        "rejected": 0,
    }
    for doc_result in items:
        stats["documents"] += 1
        doc = doc_result.get("document") or {}
        for unit in doc_result.get("knowledge_units") or []:
            stats["units"] += 1
            unit = json.loads(json.dumps(unit, ensure_ascii=False))
            final_content = choose_final_content(unit)
            if final_content:
                unit["final_content"] = final_content

            approved, note = should_approve(doc_result, unit, min_confidence)
            status = "approved" if approved else "changes_requested"
            stats[status] += 1
            item_id = stable_id(doc.get("title"), unit)
            decisions[item_id] = {
                "status": status,
                "note": note,
                "unit": unit,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
    return decisions, stats


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--out", default="")
    parser.add_argument("--min-confidence", type=float, default=0.7)
    args = parser.parse_args()

    run_dir = Path(args.run_dir)
    out_path = Path(args.out) if args.out else (run_dir / "review_decisions.json")
    decisions, stats = build_decisions(run_dir, args.min_confidence)
    out_path.write_text(json.dumps(decisions, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        json.dumps(
            {
                "ok": True,
                "path": str(out_path),
                "stats": stats,
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
