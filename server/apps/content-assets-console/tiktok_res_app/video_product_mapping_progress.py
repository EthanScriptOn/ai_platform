from __future__ import annotations

import json
import re
import time
from typing import Any, Dict, List, Optional


def strip_code_fence(text: str) -> str:
    candidate = str(text or "").strip()
    if candidate.startswith("```"):
        candidate = re.sub(r"^```(?:json)?\s*", "", candidate)
        candidate = re.sub(r"\s*```$", "", candidate)
    return candidate.strip()


class VideoProductMappingProgressMixin:
    @staticmethod
    def _normalize_content_text(content: Any) -> str:
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts = []
            for item in content:
                if isinstance(item, dict) and item.get("type") == "text":
                    parts.append(str(item.get("text") or ""))
            return "\n".join(part for part in parts if part)
        return str(content or "")

    @staticmethod
    def _coerce_json_object(content: str) -> Any:
        cleaned = strip_code_fence(content)
        try:
            return json.loads(cleaned)
        except Exception:
            return cleaned

    @classmethod
    def _resolve_primary_match(
        cls,
        parsed: Any,
        products: List[Dict[str, Any]],
        previous: Optional[Dict[str, Any]],
    ) -> Optional[Dict[str, Any]]:
        index_value: Any = None
        title_value = ""
        confidence_value: Any = None
        raw_text = ""

        if isinstance(parsed, dict):
            raw_text = json.dumps(parsed, ensure_ascii=False)
            index_value = (
                parsed.get("match_index")
                or parsed.get("index")
                or parsed.get("product_index")
                or parsed.get("商品ID")
                or parsed.get("商品序号")
            )
            title_value = str(
                parsed.get("match_title")
                or parsed.get("title")
                or parsed.get("商品名称")
                or parsed.get("商品标题")
                or ""
            ).strip()
            confidence_value = parsed.get("confidence") or parsed.get("置信度")
        elif isinstance(parsed, list):
            raw_text = json.dumps(parsed, ensure_ascii=False)
            if parsed:
                title_value = str(parsed[0]).strip()
        else:
            raw_text = str(parsed or "").strip()

        resolved_index: Optional[int] = None
        try:
            if index_value not in (None, ""):
                candidate_index = int(index_value)
                if 1 <= candidate_index <= len(products):
                    resolved_index = candidate_index
        except (TypeError, ValueError):
            resolved_index = None

        if resolved_index is None and title_value:
            for candidate_index, product in enumerate(products, start=1):
                title = str(product.get("title") or "").strip()
                if title and title == title_value:
                    resolved_index = candidate_index
                    break

        if resolved_index is None and raw_text:
            best_index = None
            best_title = ""
            for candidate_index, product in enumerate(products, start=1):
                title = str(product.get("title") or "").strip()
                if title and title in raw_text and len(title) > len(best_title):
                    best_index = candidate_index
                    best_title = title
            resolved_index = best_index

        if resolved_index is None and previous and previous.get("resolved_match") and raw_text:
            if any(marker in raw_text for marker in ("同一", "继续", "延续", "还是", "仍在")):
                return previous["resolved_match"]

        if resolved_index is None:
            return None

        source_product = products[resolved_index - 1]
        try:
            confidence = float(confidence_value or 0)
        except (TypeError, ValueError):
            confidence = 0.0
        return {
            "index": resolved_index,
            "title": str(source_product.get("title") or title_value or "").strip(),
            "confidence": confidence,
            "source_product": source_product,
        }

    @staticmethod
    def _aggregate_matches(chunks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        buckets: Dict[int, Dict[str, Any]] = {}
        for chunk in chunks:
            resolved = chunk.get("resolved_match")
            if not isinstance(resolved, dict):
                continue
            index = int(resolved.get("index") or 0)
            if index <= 0:
                continue
            bucket = buckets.setdefault(
                index,
                {
                    "product_index": index,
                    "title": resolved.get("title") or "",
                    "source_product": resolved.get("source_product") or {},
                    "hit_count": 0,
                    "confidence_sum": 0.0,
                    "max_confidence": 0.0,
                    "chunk_indices": [],
                    "sample_summaries": [],
                },
            )
            confidence = float(resolved.get("confidence") or 0)
            bucket["hit_count"] += 1
            bucket["confidence_sum"] += confidence
            bucket["max_confidence"] = max(bucket["max_confidence"], confidence)
            bucket["chunk_indices"].append(int(chunk.get("chunk_index") or 0))
            summary = str(chunk.get("summary") or "").strip()
            if summary and summary not in bucket["sample_summaries"] and len(bucket["sample_summaries"]) < 3:
                bucket["sample_summaries"].append(summary)

        items = []
        for bucket in buckets.values():
            hit_count = int(bucket["hit_count"] or 0)
            bucket["avg_confidence"] = round(
                (bucket["confidence_sum"] / hit_count) if hit_count else 0.0,
                4,
            )
            bucket["max_confidence"] = round(float(bucket["max_confidence"] or 0), 4)
            bucket.pop("confidence_sum", None)
            items.append(bucket)
        items.sort(key=lambda item: (-item["hit_count"], -item["avg_confidence"], item["product_index"]))
        return items

    @staticmethod
    def _chunk_status_label(status: str) -> str:
        labels = {
            "queued": "待开始",
            "cutting": "正在切片",
            "uploading": "正在上传 OSS",
            "ready": "已就绪，等待分析",
            "analyzing": "模型分析中",
            "completed": "识别完成",
            "failed": "处理失败",
        }
        return labels.get(status, status)

    @classmethod
    def _initial_chunk_state(cls, index: int, window: Dict[str, float]) -> Dict[str, Any]:
        return {
            "chunk_index": index,
            "start_seconds": window["start"],
            "end_seconds": window["end"],
            "status": "queued",
            "status_label": cls._chunk_status_label("queued"),
            "step_history": [],
            "decision": None,
            "summary": "",
            "evidence": [],
            "top_matches": [],
            "clip_bytes": 0,
            "input_mode": "",
            "clip_reference": "",
            "resolved_match": None,
            "error": None,
        }

    @staticmethod
    def _pipeline_summary(counts: Dict[str, int], total: int) -> str:
        if total <= 0:
            return "暂无分段"
        parts = [f"共 {total} 段", f"完成 {counts.get('completed', 0)} 段"]
        if counts.get("analyzing", 0):
            parts.append(f"分析中 {counts['analyzing']} 段")
        if counts.get("ready", 0):
            parts.append(f"待分析 {counts['ready']} 段")
        if counts.get("uploading", 0):
            parts.append(f"上传中 {counts['uploading']} 段")
        if counts.get("cutting", 0):
            parts.append(f"切片中 {counts['cutting']} 段")
        if counts.get("failed", 0):
            parts.append(f"失败 {counts['failed']} 段")
        return "，".join(parts)

    def _refresh_progress_locked(self) -> None:
        if self._progress_state is None:
            return
        chunks = self._progress_state.get("chunks") or []
        counts = {
            "queued": 0,
            "cutting": 0,
            "uploading": 0,
            "ready": 0,
            "analyzing": 0,
            "completed": 0,
            "failed": 0,
        }
        for chunk in chunks:
            status = str(chunk.get("status") or "queued")
            if status not in counts:
                counts[status] = 0
            counts[status] += 1

        total = len(chunks)
        current_chunk_index = next(
            (
                int(chunk.get("chunk_index") or 0)
                for chunk in chunks
                if str(chunk.get("status") or "") == "analyzing"
            ),
            0,
        ) or None
        if total and counts["completed"] + counts["failed"] >= total:
            pipeline_status = "completed" if counts["failed"] == 0 else "partial"
        elif any(counts[key] for key in ("cutting", "uploading", "ready", "analyzing")):
            pipeline_status = "running"
        else:
            pipeline_status = "queued"

        self._progress_state["completed_chunk_count"] = counts["completed"]
        self._progress_state["prepared_chunk_count"] = (
            counts["ready"] + counts["analyzing"] + counts["completed"] + counts["failed"]
        )
        self._progress_state["analyzing_chunk_count"] = counts["analyzing"]
        self._progress_state["failed_chunk_count"] = counts["failed"]
        self._progress_state["successful_chunk_count"] = sum(
            1 for chunk in chunks if chunk.get("resolved_match")
        )
        self._progress_state["matched_products"] = self._aggregate_matches(chunks)
        self._progress_state["pipeline"] = {
            "mode": "serial_analysis_with_background_prepare",
            "depends_on_previous_chunk": True,
            "status": pipeline_status,
            "current_chunk_index": current_chunk_index,
            "counts": counts,
            "summary": self._pipeline_summary(counts, total),
        }

    def _snapshot_progress_locked(self) -> Dict[str, Any]:
        if self._progress_state is None:
            return {}
        return json.loads(json.dumps(self._progress_state, ensure_ascii=False))

    async def _publish_progress(self) -> None:
        if not self._progress_callback:
            return
        async with self._progress_lock:
            snapshot = self._snapshot_progress_locked()
        await self._progress_callback(snapshot)

    async def _set_progress_state(self, state: Dict[str, Any]) -> None:
        async with self._progress_lock:
            self._progress_state = state
            self._refresh_progress_locked()
            snapshot = self._snapshot_progress_locked() if self._progress_callback else None
        if snapshot is not None:
            await self._progress_callback(snapshot)

    async def _update_progress(self, *, chunk_index: Optional[int] = None, **fields: Any) -> None:
        async with self._progress_lock:
            if self._progress_state is None:
                return
            if chunk_index is None:
                self._progress_state.update(fields)
            else:
                chunks = self._progress_state.get("chunks") or []
                if 1 <= chunk_index <= len(chunks):
                    chunk = chunks[chunk_index - 1]
                    previous_status = str(chunk.get("status") or "queued")
                    chunk.update(fields)
                    next_status = str(chunk.get("status") or "queued")
                    chunk["status_label"] = self._chunk_status_label(next_status)
                    if next_status and next_status != previous_status:
                        history = list(chunk.get("step_history") or [])
                        history.append(
                            {
                                "status": next_status,
                                "label": self._chunk_status_label(next_status),
                                "at": time.time(),
                            }
                        )
                        chunk["step_history"] = history
            self._refresh_progress_locked()
            snapshot = self._snapshot_progress_locked() if self._progress_callback else None
        if snapshot is not None:
            await self._progress_callback(snapshot)

    async def _snapshot_progress(self) -> Dict[str, Any]:
        async with self._progress_lock:
            return self._snapshot_progress_locked()


