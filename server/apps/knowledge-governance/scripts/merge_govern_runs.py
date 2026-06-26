#!/usr/bin/env python3
import argparse
from pathlib import Path


def concat_files(inputs, output):
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8") as out:
        for path in inputs:
            if not path.exists():
                continue
            text = path.read_text(encoding="utf-8")
            if text and not text.endswith("\n"):
                text += "\n"
            out.write(text)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True, help="包含多个 shard-* 目录的根目录")
    parser.add_argument("--out", required=True, help="合并后的输出目录")
    args = parser.parse_args()

    root = Path(args.root)
    out = Path(args.out)
    shards = sorted([p for p in root.iterdir() if p.is_dir() and p.name.startswith("shard-")])

    concat_files(
        [shard / "out" / "governed_units.jsonl" for shard in shards],
        out / "governed_units.jsonl",
    )
    concat_files(
        [shard / "out" / "review_queue.jsonl" for shard in shards],
        out / "review_queue.jsonl",
    )
    concat_files(
        [shard / "out" / "summary.md" for shard in shards],
        out / "summary.md",
    )

    md_out = out / "ragflow_markdown"
    md_out.mkdir(parents=True, exist_ok=True)
    copied = 0
    for shard in shards:
        for md in sorted((shard / "out" / "ragflow_markdown").glob("*.md")):
            target = md_out / f"{shard.name}-{md.name}"
            target.write_text(md.read_text(encoding="utf-8"), encoding="utf-8")
            copied += 1

    print(
        f"merged shards={len(shards)} governed={out / 'governed_units.jsonl'} "
        f"review={out / 'review_queue.jsonl'} markdown_files={copied}"
    )


if __name__ == "__main__":
    main()
