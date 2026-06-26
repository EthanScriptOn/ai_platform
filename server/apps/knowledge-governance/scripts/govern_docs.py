#!/usr/bin/env python3
import argparse
import json
import os
import re
import signal
import ssl
import time
from pathlib import Path
from urllib import request, error


API_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"


SYSTEM_PROMPT = """你是公司内部知识库治理专家。
你的任务不是简单摘要，而是把碎片化飞书文档治理成可审核、可检索、可问答的结构化知识。

必须遵守：
1. 只能基于原文和元数据，不要编造。
2. 允许把原文中的碎片条目补齐成结构化表达，例如把“问题标题 + 一句判断点”整理成问题、适用范围、处理动作、证据。
3. 如果原文只有链接或服务器清单，不要硬凑 FAQ；要提炼成“资源索引/系统资料/环境信息”，并说明适用场景。
4. 如果原文是表格或近似表格，必须理解行列关系，不要把单元格拆散。
5. 把“客服可直接发群里的话术”和“内部排查信息”分开。
6. 对账号、密码、token、服务器 IP 这类敏感信息标记为 internal_only，不要放入客服话术。
7. 每条知识都要有 source_evidence，引用原文中的短句或标题作为证据。
8. 没有明确解决方案时，不要把背景信息伪装成解决方案。
9. 客服可回复话术必须是纯文本，不要使用 emoji，不要使用 Markdown 加粗、标题或引用格式。
10. 不要根据链接路径、文件名、图片名猜测事实；只能使用原文明说的信息。
11. 不要根据域名、公司名相似、接口名相似推断厂商归属；原文未明确时留空或写“未明确”。

请只输出合法 JSON，不要输出 Markdown，不要输出解释。
"""


USER_PROMPT_TEMPLATE = """请治理下面这篇公司文档。

元数据：
{metadata}

原文：
{content}

输出 JSON Schema：
{{
  "document": {{
    "title": "文档标题",
    "doc_type": "problem_solution|procedure|resource_index|api_doc|meeting_review|technical_note|mixed|empty",
    "products": ["相关产品"],
    "vendors": ["相关上游/厂商"],
    "feishu_url": "飞书地址",
    "source_path": "原文路径",
    "summary": "一句话说明这篇文档治理后主要用于什么"
  }},
  "knowledge_units": [
    {{
      "unit_type": "faq|solution|procedure|resource|fact|risk|meeting_action",
      "title": "知识标题",
      "user_questions": ["用户可能怎么问"],
      "scope": "适用范围",
      "answer_for_customer": "可直接发给客服群/客户群的回答；没有明确方案则为空字符串",
      "internal_notes": "仅内部使用的信息，例如账号密码/IP/研发排查/上游群升级路径",
      "steps": ["处理步骤或操作流程"],
      "entities": {{
        "products": [],
        "vendors": [],
        "systems": [],
        "links": [],
        "servers": []
      }},
      "source_evidence": ["来自原文的短证据"],
      "confidence": 0.0,
      "visibility": "public_reply|internal_only|needs_review",
      "needs_human_review": true,
      "review_reason": "为什么需要/不需要人工审核"
    }}
  ],
  "quality": {{
    "is_useful_for_kb": true,
    "missing_context": ["缺失但影响问答的上下文"],
    "risks": ["敏感信息、歧义、过期风险等"],
    "suggested_followups": ["建议人工补充的问题"]
  }}
}}
"""


def load_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def safe_slug(text):
    text = re.sub(r"[\\/:*?\"<>|]+", "-", text)
    text = re.sub(r"\s+", "-", text).strip("-")
    return text[:120] or "untitled"


def compact_content(text, limit=18000):
    text = re.sub(r"\n{3,}", "\n\n", text.strip())
    if len(text) <= limit:
        return text
    head = text[:12000]
    tail = text[-5000:]
    return head + "\n\n...[中间内容过长，已截断]...\n\n" + tail


def find_manifest(export_root, source_path):
    source = str(Path(source_path))
    for manifest in Path(export_root).glob("*/manifest.json"):
        data = load_json(manifest)
        if isinstance(data, dict):
            for key in ("documents", "items", "records", "nodes"):
                if isinstance(data.get(key), list):
                    data = data[key]
                    break
        if not isinstance(data, list):
            continue
        for item in data:
            if not isinstance(item, dict):
                continue
            if item.get("content_path") == source:
                raw = item.get("raw") or {}
                token = raw.get("origin_node_token") or item.get("node_token") or raw.get("node_token")
                url = f"https://newstar.feishu.cn/wiki/{token}" if token else ""
                return {
                    "title": item.get("title") or Path(source).stem,
                    "space_id": raw.get("space_id") or raw.get("origin_space_id") or "",
                    "node_token": token or "",
                    "document_token": item.get("document_token") or "",
                    "feishu_url": url,
                    "source_path": source,
                }
    return {
        "title": Path(source).stem,
        "space_id": "",
        "node_token": "",
        "document_token": "",
        "feishu_url": "",
        "source_path": source,
    }


def call_qwen(api_key, model, metadata, content, temperature=0.1, ssl_context=None, http_timeout=120):
    payload = {
        "model": model,
        "temperature": temperature,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": USER_PROMPT_TEMPLATE.format(
                    metadata=json.dumps(metadata, ensure_ascii=False, indent=2),
                    content=compact_content(content),
                ),
            },
        ],
    }
    req = request.Request(
        API_URL,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with request.urlopen(req, timeout=http_timeout, context=ssl_context) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Qwen API HTTP {exc.code}: {body}") from exc

    text = data["choices"][0]["message"]["content"]
    return json.loads(text)


def render_markdown(result):
    doc = result.get("document") or {}
    units = result.get("knowledge_units") or []
    lines = [
        f"# {doc.get('title', '未命名文档')}",
        "",
        f"- 知识类型：{doc.get('doc_type', '')}",
        f"- 产品：{'、'.join(doc.get('products') or [])}",
        f"- 上游/厂商：{'、'.join(doc.get('vendors') or [])}",
        f"- 飞书地址：{doc.get('feishu_url', '')}",
        f"- 原始路径：{doc.get('source_path', '')}",
        "",
        "## 治理摘要",
        doc.get("summary", ""),
        "",
        "## 结构化知识",
    ]
    for idx, unit in enumerate(units, 1):
        lines.extend([
            "",
            f"### {idx}. {unit.get('title', '未命名知识')}",
            "",
            f"- 类型：{unit.get('unit_type', '')}",
            f"- 适用范围：{unit.get('scope', '')}",
            f"- 可见性：{unit.get('visibility', '')}",
            f"- 置信度：{unit.get('confidence', '')}",
        ])
        questions = unit.get("user_questions") or []
        if questions:
            lines.extend(["", "用户可能问："])
            lines.extend([f"- {q}" for q in questions])
        answer = unit.get("answer_for_customer") or ""
        if answer:
            lines.extend(["", "客服可回复：", answer])
        steps = unit.get("steps") or []
        if steps:
            lines.extend(["", "处理步骤："])
            lines.extend([f"{i}. {step}" for i, step in enumerate(steps, 1)])
        notes = unit.get("internal_notes") or ""
        if notes:
            lines.extend(["", "内部说明：", notes])
        evidence = unit.get("source_evidence") or []
        if evidence:
            lines.extend(["", "原文证据："])
            lines.extend([f"- {item}" for item in evidence])
    quality = result.get("quality") or {}
    if quality:
        lines.extend(["", "## 质量与审核"])
        for key in ["missing_context", "risks", "suggested_followups"]:
            values = quality.get(key) or []
            if values:
                lines.append("")
                lines.append(key + "：")
                lines.extend([f"- {item}" for item in values])
    return "\n".join(lines).strip() + "\n"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--model", default=os.getenv("QWEN_MODEL", "qwen3.7-max"))
    parser.add_argument("--insecure-skip-ssl-verify", action="store_true")
    parser.add_argument("--per-doc-timeout", type=int, default=120)
    args = parser.parse_args()

    api_key = os.getenv("QWEN_API_KEY") or os.getenv("DASHSCOPE_API_KEY")
    if not api_key:
        raise SystemExit("Missing QWEN_API_KEY or DASHSCOPE_API_KEY")

    config = load_json(args.config)
    export_root = config["export_root"]
    out = Path(args.out)
    md_out = out / "ragflow_markdown"
    out.mkdir(parents=True, exist_ok=True)
    md_out.mkdir(parents=True, exist_ok=True)

    governed_path = out / "governed_units.jsonl"
    review_path = out / "review_queue.jsonl"
    summary = []
    ssl_context = ssl._create_unverified_context() if args.insecure_skip_ssl_verify else None

    def on_timeout(signum, frame):
        raise TimeoutError("per document governance timeout")

    signal.signal(signal.SIGALRM, on_timeout)

    with governed_path.open("w", encoding="utf-8", buffering=1) as governed, review_path.open("w", encoding="utf-8", buffering=1) as review:
        for doc_path in config["docs"]:
            metadata = find_manifest(export_root, doc_path)
            content = Path(doc_path).read_text(encoding="utf-8", errors="replace")
            print(f"[govern] start: {metadata['title']}", flush=True)
            try:
                signal.alarm(args.per_doc_timeout)
                result = call_qwen(
                    api_key,
                    args.model,
                    metadata,
                    content,
                    ssl_context=ssl_context,
                    http_timeout=args.per_doc_timeout,
                )
                signal.alarm(0)
            except Exception as exc:
                signal.alarm(0)
                print(f"[govern] failed: {metadata['title']} - {exc}", flush=True)
                summary.append({
                    "title": metadata["title"],
                    "doc_type": "failed",
                    "units": 0,
                    "review_units": 0,
                    "useful": False,
                })
                continue
            result.setdefault("document", {}).update({
                "title": result.get("document", {}).get("title") or metadata["title"],
                "feishu_url": metadata["feishu_url"],
                "source_path": metadata["source_path"],
            })

            governed.write(json.dumps(result, ensure_ascii=False) + "\n")
            for unit in result.get("knowledge_units") or []:
                if unit.get("needs_human_review", True) or unit.get("visibility") != "public_reply":
                    review.write(json.dumps({
                        "document_title": result["document"].get("title"),
                        "feishu_url": metadata["feishu_url"],
                        "source_path": metadata["source_path"],
                        "unit": unit,
                    }, ensure_ascii=False) + "\n")

            slug = safe_slug(result["document"].get("title") or metadata["title"])
            (md_out / f"{slug}.md").write_text(render_markdown(result), encoding="utf-8")
            governed.flush()
            review.flush()
            summary.append({
                "title": result["document"].get("title"),
                "doc_type": result["document"].get("doc_type"),
                "units": len(result.get("knowledge_units") or []),
                "review_units": sum(1 for u in (result.get("knowledge_units") or []) if u.get("needs_human_review", True)),
                "useful": (result.get("quality") or {}).get("is_useful_for_kb"),
            })
            print(f"[govern] done: {metadata['title']} ({len(result.get('knowledge_units') or [])} units)", flush=True)
            time.sleep(0.2)

    lines = ["# 文档治理样本运行结果", ""]
    for item in summary:
        lines.append(f"- {item['title']}：{item['doc_type']}，知识单元 {item['units']}，待审核 {item['review_units']}，可用性 {item['useful']}")
    (out / "summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
