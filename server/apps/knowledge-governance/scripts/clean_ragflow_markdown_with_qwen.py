#!/usr/bin/env python3
import argparse
import json
import os
import re
import ssl
import time
from pathlib import Path
from urllib import error, request


API_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
DEFAULT_MODEL = "qwen-plus"

SYSTEM_PROMPT = """你是公司知识库文档整理员。
你的任务是把已经审核过、但带有审核字段的 Markdown，改写成适合进入 RAGFlow 检索的干净 Markdown。

必须遵守：
1. 只基于原文整理，不要编造新事实。
2. 删除审核过程字段，例如：最终入库内容、原文证据、置信度、可见性、审核备注、来源路径、来源链接、飞书地址、source、review、confidence、visibility。
3. 保留真正能回答问题的业务内容。
4. 每个知识点都尽量整理成下面这个结构：
   ## 知识标题
   ### 常见问法
   - 用户可能怎么问
   ### 答案
   直接给可回复用户的答案或处理步骤
   ### 关键词
   - 产品名、别名、故障词、业务词
5. 如果原文里有多个知识点，按多个二级标题拆开。
6. “答案”里只能放最终可回答用户的话，不要出现“最终入库内容：”“原文证据：”“用户可能问：”这类字段名。
7. 如果原文只是目录、代码片段、流水日志、无明确业务结论，可以压缩成很短的摘要；不要硬编 FAQ。
8. 输出必须是 Markdown，不要输出解释，不要用代码块包起来。
"""

USER_PROMPT = """请整理下面这份 Markdown。

文件名：{name}

原文：
{content}
"""

BAD_PATTERNS = [
    "最终入库内容",
    "原文证据",
    "置信度",
    "可见性",
    "审核备注",
    "来源路径",
    "来源链接",
    "飞书地址",
    "用户可能问",
    "来源类型",
    "来源文档",
    "适用范围",
]


def compact(text, limit):
    text = re.sub(r"\n{3,}", "\n\n", text.strip())
    if len(text) <= limit:
        return text
    head = text[: int(limit * 0.65)]
    tail = text[-int(limit * 0.25) :]
    return f"{head}\n\n...[中间内容过长，已截断，请只整理可见部分]...\n\n{tail}"


def strip_code_fence(text):
    text = text.strip()
    match = re.fullmatch(r"```(?:markdown|md)?\s*(.*?)```", text, flags=re.S | re.I)
    return match.group(1).strip() if match else text


def call_qwen(api_key, model, name, content, timeout, retries, ssl_context=None):
    payload = {
        "model": model,
        "temperature": 0.1,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": USER_PROMPT.format(name=name, content=content)},
        ],
    }
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = request.Request(
        API_URL,
        data=body,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST",
    )
    last_error = None
    for attempt in range(retries + 1):
        try:
            with request.urlopen(req, timeout=timeout, context=ssl_context) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            return strip_code_fence(data["choices"][0]["message"]["content"])
        except (error.HTTPError, error.URLError, TimeoutError, KeyError, json.JSONDecodeError) as exc:
            last_error = exc
            if attempt < retries:
                time.sleep(2 + attempt * 3)
    raise RuntimeError(f"千问整理失败：{last_error}")


def has_bad_words(text):
    return [word for word in BAD_PATTERNS if word in text]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-dir", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--model", default=os.getenv("QWEN_MODEL", DEFAULT_MODEL))
    parser.add_argument("--limit", type=int, default=0, help="只处理前 N 个文件，0 表示全部")
    parser.add_argument("--only", action="append", default=[], help="只处理指定文件名，可重复传")
    parser.add_argument("--max-chars", type=int, default=24000)
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--retries", type=int, default=2)
    parser.add_argument("--insecure-skip-ssl-verify", action="store_true")
    args = parser.parse_args()

    api_key = os.getenv("QWEN_API_KEY") or os.getenv("DASHSCOPE_API_KEY")
    if not api_key:
        raise SystemExit("缺少 QWEN_API_KEY 或 DASHSCOPE_API_KEY")

    input_dir = Path(args.input_dir)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    files = sorted(input_dir.glob("*.md"))
    if args.only:
        wanted = set(args.only)
        files = [path for path in files if path.name in wanted]
    if args.limit > 0:
        files = files[: args.limit]

    ssl_context = ssl._create_unverified_context() if args.insecure_skip_ssl_verify else None
    results = []
    for idx, path in enumerate(files, 1):
        raw = path.read_text(encoding="utf-8", errors="replace")
        cleaned = call_qwen(
            api_key=api_key,
            model=args.model,
            name=path.name,
            content=compact(raw, args.max_chars),
            timeout=args.timeout,
            retries=args.retries,
            ssl_context=ssl_context,
        )
        if not cleaned.startswith("#"):
            cleaned = f"# {path.stem}\n\n{cleaned.strip()}\n"
        out_path = out_dir / path.name
        out_path.write_text(cleaned.strip() + "\n", encoding="utf-8")
        bad_words = has_bad_words(cleaned)
        results.append({"file": path.name, "bad_words": bad_words, "chars": len(cleaned)})
        print(json.dumps({"done": idx, "total": len(files), **results[-1]}, ensure_ascii=False), flush=True)

    summary = {
        "ok": True,
        "model": args.model,
        "input_dir": str(input_dir),
        "out_dir": str(out_dir),
        "files": len(results),
        "files_with_bad_words": [item for item in results if item["bad_words"]],
    }
    (out_dir / "_clean_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
