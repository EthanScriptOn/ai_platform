#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import requests


DEFAULT_BASE_URL = "http://47.104.81.250:8080"
DEFAULT_USERNAME = "admin"
DEFAULT_PASSWORD = ""
DEFAULT_WORKSPACE_ID = "default"
DEFAULT_OUTPUT_DIR = Path("exports/maxkb-governance")
REQUEST_TIMEOUT = 60


@dataclass
class MaxkbConfig:
    base_url: str
    username: str
    password: str
    workspace_id: str


class MaxkbClient:
    def __init__(self, config: MaxkbConfig):
        self.config = config
        self.session = requests.Session()
        self.session.headers.update({"Content-Type": "application/json"})
        self.token = self.login()
        self.session.headers.update({"Authorization": f"Bearer {self.token}"})

    def url(self, path: str) -> str:
        return f"{self.config.base_url.rstrip('/')}{path}"

    def request(self, method: str, path: str, **kwargs: Any) -> Any:
        response = self.session.request(method, self.url(path), timeout=REQUEST_TIMEOUT, **kwargs)
        response.raise_for_status()
        data = response.json()
        if data.get("code") != 200:
            raise RuntimeError(f"MaxKB API failed: {method} {path} {data}")
        return data.get("data")

    def login(self) -> str:
        response = self.session.post(
            self.url("/admin/api/user/login"),
            json={"username": self.config.username, "password": self.config.password},
            timeout=REQUEST_TIMEOUT,
        )
        response.raise_for_status()
        data = response.json()
        if data.get("code") != 200:
            raise RuntimeError(f"MaxKB login failed: {data}")
        token = str((data.get("data") or {}).get("token") or "").strip()
        if not token:
            raise RuntimeError(f"MaxKB login returned no token: {data}")
        return token

    def list_knowledges(self) -> list[dict[str, Any]]:
        data = self.request(
            "GET",
            f"/admin/api/workspace/{self.config.workspace_id}/knowledge",
            params={"folder_id": self.config.workspace_id},
        )
        return data or []

    def list_documents(self, knowledge_id: str, page_size: int = 1000) -> list[dict[str, Any]]:
        data = self.request(
            "GET",
            f"/admin/api/workspace/{self.config.workspace_id}/knowledge/{knowledge_id}/document/1/{page_size}",
        )
        if isinstance(data, list):
            return data
        return (data or {}).get("records") or []

    def list_paragraphs(self, knowledge_id: str, document_id: str, page_size: int = 1000) -> list[dict[str, Any]]:
        data = self.request(
            "GET",
            f"/admin/api/workspace/{self.config.workspace_id}/knowledge/{knowledge_id}/document/{document_id}/paragraph/1/{page_size}",
        )
        if isinstance(data, list):
            return data
        return (data or {}).get("records") or []


def safe_name(value: str) -> str:
    cleaned = re.sub(r"[\\/:*?\"<>|\r\n\t]+", " ", str(value or "").strip())
    cleaned = re.sub(r"\s+", "-", cleaned).strip("-")
    return cleaned[:120] or "untitled"


def normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", str(value or "").replace("\r\n", "\n").replace("\r", "\n")).strip()


def split_qa_pairs(text: str) -> list[dict[str, str]]:
    raw = str(text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not raw:
        return []
    pattern = re.compile(
        r"(?:^|\n)\s*(?:Q|问题|问)[:：]\s*(?P<q>.*?)(?:\n\s*(?:A|答案|答|处理办法|解决办法)[:：]\s*(?P<a>.*?))(?=(?:\n\s*(?:Q|问题|问)[:：])|\Z)",
        re.S,
    )
    pairs: list[dict[str, str]] = []
    for match in pattern.finditer(raw):
        q = normalize_text(match.group("q"))
        a = normalize_text(match.group("a"))
        if q and a:
            pairs.append({"question": q, "answer": a})
    return pairs


def extract_keywords(text: str, limit: int = 8) -> list[str]:
    words = re.findall(r"[\u4e00-\u9fff]{2,}|[A-Za-z0-9_]{3,}", text)
    seen: set[str] = set()
    result: list[str] = []
    for word in words:
        item = word.strip()
        if not item or item in seen:
            continue
        seen.add(item)
        result.append(item)
        if len(result) >= limit:
            break
    return result


def assess_document(doc: dict[str, Any], paragraphs: list[dict[str, Any]]) -> dict[str, Any]:
    content = "\n\n".join(str(item.get("content") or "") for item in paragraphs)
    qa_pairs = split_qa_pairs(content)
    char_length = len(content)
    line_count = len([line for line in content.splitlines() if line.strip()])
    risks: list[str] = []
    if char_length < 80:
        risks.append("too_short")
    if len(qa_pairs) >= 3:
        risks.append("many_qa_in_one_doc")
    if len(paragraphs) == 1 and char_length > 2500:
        risks.append("large_single_paragraph")
    if line_count >= 20 and len(qa_pairs) == 0:
        risks.append("mixed_notes_no_qa_structure")
    return {
        "documentId": doc.get("id"),
        "documentName": doc.get("name"),
        "charLength": char_length,
        "paragraphCount": len(paragraphs),
        "qaPairCount": len(qa_pairs),
        "lineCount": line_count,
        "risks": risks,
        "keywords": extract_keywords(content),
    }


def render_curated_markdown(knowledge: dict[str, Any], doc: dict[str, Any], paragraphs: list[dict[str, Any]]) -> str:
    content = "\n\n".join(str(item.get("content") or "").strip() for item in paragraphs if str(item.get("content") or "").strip())
    qa_pairs = split_qa_pairs(content)
    title = str(doc.get("name") or "未命名文档").strip()
    lines = [
        f"# {title}",
        "",
        f"来源知识库：{knowledge.get('name') or ''}",
        f"来源文档ID：{doc.get('id') or ''}",
        "",
    ]
    if qa_pairs:
        lines.extend(["## 标准问答", ""])
        for index, pair in enumerate(qa_pairs, start=1):
            lines.extend([
                f"### {index}. {pair['question']}",
                "",
                pair["answer"],
                "",
            ])
    else:
        lines.extend([
            "## 原始整理",
            "",
            content or "[空内容]",
            "",
        ])
    return "\n".join(lines).strip() + "\n"


def split_heading_sections(text: str) -> list[dict[str, str]]:
    raw = str(text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not raw:
        return []
    lines = raw.splitlines()
    sections: list[dict[str, str]] = []
    current_title = ""
    current_lines: list[str] = []
    heading_pattern = re.compile(r"^\s{0,3}(#{1,4}\s+.+|[一二三四五六七八九十]+[、.．]\s*.+|\d+(?:\.\d+)*[、.．]\s*.+)$")

    def flush() -> None:
        nonlocal current_title, current_lines
        content = "\n".join(current_lines).strip()
        if content:
            sections.append({
                "title": normalize_text(current_title or content.splitlines()[0][:60]),
                "content": content,
            })
        current_title = ""
        current_lines = []

    for line in lines:
        if heading_pattern.match(line) and current_lines:
            flush()
            current_title = re.sub(r"^\s{0,3}#{1,4}\s+", "", line).strip()
            current_lines = [line]
        else:
            if not current_title and heading_pattern.match(line):
                current_title = re.sub(r"^\s{0,3}#{1,4}\s+", "", line).strip()
            current_lines.append(line)
    flush()
    return sections


def chunk_long_text(title: str, content: str, max_chars: int = 2800) -> list[dict[str, str]]:
    normalized = str(content or "").strip()
    if len(normalized) <= max_chars:
        return [{"title": title, "content": normalized}] if normalized else []
    chunks: list[dict[str, str]] = []
    paragraphs = re.split(r"\n{2,}", normalized)
    current: list[str] = []
    current_len = 0
    for paragraph in paragraphs:
        part = paragraph.strip()
        if not part:
            continue
        if current and current_len + len(part) + 2 > max_chars:
            chunks.append({
                "title": f"{title}（{len(chunks) + 1}）",
                "content": "\n\n".join(current).strip(),
            })
            current = []
            current_len = 0
        if len(part) > max_chars:
            for index in range(0, len(part), max_chars):
                chunks.append({
                    "title": f"{title}（{len(chunks) + 1}）",
                    "content": part[index:index + max_chars].strip(),
                })
            continue
        current.append(part)
        current_len += len(part) + 2
    if current:
        chunks.append({
            "title": f"{title}（{len(chunks) + 1}）" if chunks else title,
            "content": "\n\n".join(current).strip(),
        })
    return chunks


def build_knowledge_units(knowledge: dict[str, Any], doc: dict[str, Any], paragraphs: list[dict[str, Any]]) -> list[dict[str, str]]:
    content = "\n\n".join(str(item.get("content") or "").strip() for item in paragraphs if str(item.get("content") or "").strip())
    doc_title = str(doc.get("name") or "未命名文档").strip()
    qa_pairs = split_qa_pairs(content)
    units: list[dict[str, str]] = []
    if qa_pairs:
        for index, pair in enumerate(qa_pairs, start=1):
            title = pair["question"][:80] or f"{doc_title}-问答-{index}"
            body = "\n".join([
                f"# {title}",
                "",
                f"来源知识库：{knowledge.get('name') or ''}",
                f"来源文档：{doc_title}",
                f"来源文档ID：{doc.get('id') or ''}",
                "",
                "## 问题",
                "",
                pair["question"],
                "",
                "## 标准答复",
                "",
                pair["answer"],
                "",
            ])
            units.append({"title": title, "content": body})
        return units

    sections = split_heading_sections(content)
    if not sections:
        sections = [{"title": doc_title, "content": content}]
    for section in sections:
        section_title = section["title"][:90] or doc_title
        for chunk in chunk_long_text(section_title, section["content"]):
            title = chunk["title"][:100] or doc_title
            body = "\n".join([
                f"# {title}",
                "",
                f"来源知识库：{knowledge.get('name') or ''}",
                f"来源文档：{doc_title}",
                f"来源文档ID：{doc.get('id') or ''}",
                "",
                "## 内容",
                "",
                chunk["content"],
                "",
            ])
            units.append({"title": title, "content": body})
    return units


def export_all(client: MaxkbClient, output_dir: Path) -> dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)
    raw_dir = output_dir / "raw"
    curated_dir = output_dir / "curated-drafts"
    units_dir = output_dir / "curated-units"
    raw_dir.mkdir(parents=True, exist_ok=True)
    curated_dir.mkdir(parents=True, exist_ok=True)
    units_dir.mkdir(parents=True, exist_ok=True)

    knowledges = client.list_knowledges()
    manifest: dict[str, Any] = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "knowledgeCount": len(knowledges),
        "documentCount": 0,
        "paragraphCount": 0,
        "knowledges": [],
    }
    assessments: list[dict[str, Any]] = []

    for knowledge in knowledges:
        knowledge_id = str(knowledge.get("id") or "").strip()
        knowledge_name = str(knowledge.get("name") or knowledge_id).strip()
        knowledge_slug = safe_name(f"{knowledge_name}-{knowledge_id[:8]}")
        knowledge_raw_dir = raw_dir / knowledge_slug
        knowledge_curated_dir = curated_dir / knowledge_slug
        knowledge_units_dir = units_dir / knowledge_slug
        knowledge_raw_dir.mkdir(parents=True, exist_ok=True)
        knowledge_curated_dir.mkdir(parents=True, exist_ok=True)
        knowledge_units_dir.mkdir(parents=True, exist_ok=True)

        documents = client.list_documents(knowledge_id)
        knowledge_item = {
            "id": knowledge_id,
            "name": knowledge_name,
            "documentCount": len(documents),
            "charLength": knowledge.get("char_length"),
            "documents": [],
        }
        for doc in documents:
            document_id = str(doc.get("id") or "").strip()
            document_name = str(doc.get("name") or document_id).strip()
            paragraphs = client.list_paragraphs(knowledge_id, document_id)
            assessment = assess_document(doc, paragraphs)
            assessment.update({
                "knowledgeId": knowledge_id,
                "knowledgeName": knowledge_name,
            })
            assessments.append(assessment)

            raw_payload = {
                "knowledge": knowledge,
                "document": doc,
                "paragraphs": paragraphs,
                "assessment": assessment,
            }
            raw_path = knowledge_raw_dir / f"{safe_name(document_name)}-{document_id[:8]}.json"
            raw_path.write_text(json.dumps(raw_payload, ensure_ascii=False, indent=2), encoding="utf-8")

            curated_path = knowledge_curated_dir / f"{safe_name(document_name)}.md"
            curated_path.write_text(render_curated_markdown(knowledge, doc, paragraphs), encoding="utf-8")
            doc_units_dir = knowledge_units_dir / safe_name(document_name)
            doc_units_dir.mkdir(parents=True, exist_ok=True)
            units = build_knowledge_units(knowledge, doc, paragraphs)
            unit_paths: list[str] = []
            for unit_index, unit in enumerate(units, start=1):
                unit_path = doc_units_dir / f"{unit_index:03d}-{safe_name(unit['title'])}.md"
                unit_path.write_text(unit["content"], encoding="utf-8")
                unit_paths.append(str(unit_path.relative_to(output_dir)))

            knowledge_item["documents"].append({
                "id": document_id,
                "name": document_name,
                "paragraphCount": len(paragraphs),
                "rawPath": str(raw_path.relative_to(output_dir)),
                "curatedDraftPath": str(curated_path.relative_to(output_dir)),
                "curatedUnitCount": len(units),
                "curatedUnitPaths": unit_paths,
                "assessment": assessment,
            })
            manifest["documentCount"] += 1
            manifest["paragraphCount"] += len(paragraphs)
        manifest["knowledges"].append(knowledge_item)

    risk_counts: dict[str, int] = {}
    for item in assessments:
        for risk in item["risks"]:
            risk_counts[risk] = risk_counts.get(risk, 0) + 1
    report = {
        "generatedAt": manifest["generatedAt"],
        "knowledgeCount": manifest["knowledgeCount"],
        "documentCount": manifest["documentCount"],
        "paragraphCount": manifest["paragraphCount"],
        "curatedUnitCount": sum(
            doc.get("curatedUnitCount", 0)
            for knowledge in manifest["knowledges"]
            for doc in knowledge["documents"]
        ),
        "riskCounts": dict(sorted(risk_counts.items())),
        "topFragmentedDocuments": sorted(
            assessments,
            key=lambda item: (len(item["risks"]), item["qaPairCount"], item["charLength"]),
            reverse=True,
        )[:30],
    }

    (output_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    (output_dir / "fragmentation-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    (output_dir / "fragmentation-report.md").write_text(render_report_markdown(report), encoding="utf-8")
    return report


def render_report_markdown(report: dict[str, Any]) -> str:
    lines = [
        "# MaxKB 知识库碎片化体检报告",
        "",
        f"- 生成时间：{report['generatedAt']}",
        f"- 知识库数：{report['knowledgeCount']}",
        f"- 文档数：{report['documentCount']}",
        f"- 段落数：{report['paragraphCount']}",
        f"- 整理后知识单元数：{report.get('curatedUnitCount', 0)}",
        "",
        "## 风险计数",
        "",
    ]
    for key, count in report.get("riskCounts", {}).items():
        lines.append(f"- {key}: {count}")
    lines.extend(["", "## 优先治理文档", ""])
    for item in report.get("topFragmentedDocuments", []):
        risks = ", ".join(item.get("risks") or []) or "none"
        lines.extend([
            f"### {item.get('knowledgeName')} / {item.get('documentName')}",
            "",
            f"- 字符数：{item.get('charLength')}",
            f"- 段落数：{item.get('paragraphCount')}",
            f"- Q/A 数：{item.get('qaPairCount')}",
            f"- 风险：{risks}",
            f"- 关键词：{', '.join(item.get('keywords') or [])}",
            "",
        ])
    return "\n".join(lines).strip() + "\n"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export and diagnose MaxKB knowledge fragmentation.")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--username", default=DEFAULT_USERNAME)
    parser.add_argument("--password", default=DEFAULT_PASSWORD)
    parser.add_argument("--workspace-id", default=DEFAULT_WORKSPACE_ID)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    client = MaxkbClient(MaxkbConfig(
        base_url=args.base_url,
        username=args.username,
        password=args.password,
        workspace_id=args.workspace_id,
    ))
    report = export_all(client, args.output_dir)
    print(json.dumps({
        "ok": True,
        "outputDir": str(args.output_dir),
        "knowledgeCount": report["knowledgeCount"],
        "documentCount": report["documentCount"],
        "paragraphCount": report["paragraphCount"],
        "curatedUnitCount": report.get("curatedUnitCount", 0),
        "riskCounts": report["riskCounts"],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
