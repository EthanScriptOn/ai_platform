# LLM 文档治理样板流水线

这个目录用于验证“治理后入库”是否明显优于“原文直接入库”。

核心原则：

- 规则只做文件读取、去重、元数据补齐、流程调度。
- 大模型负责语义治理：理解表格、流程、链接、碎片化条目，并抽取成结构化知识。
- 人工审核负责最终确认，审核前的内容只算草稿。
- 输出同时保留 JSON 和 Markdown，JSON 方便审核/入图谱，Markdown 方便进入 RAGFlow。

运行方式：

```bash
export QWEN_API_KEY='你的千问 key'
python3 knowledge-governance-pilot/scripts/govern_docs.py \
  --config knowledge-governance-pilot/config/sample_docs.json \
  --out data/knowledge-governance/review-runs/current
```

输出：

- `governed_units.jsonl`：结构化知识草稿。
- `review_queue.jsonl`：待人工审核项。
- `ragflow_markdown/*.md`：治理后可入库文本。
- `summary.md`：本次治理统计。
