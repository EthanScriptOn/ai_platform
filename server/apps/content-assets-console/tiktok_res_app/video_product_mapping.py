from __future__ import annotations

import asyncio
import base64
import json
import re
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, Optional

from config import ConfigLoader
from tiktok_res_app.oss_uploader import OssUploader
from tiktok_res_app.video_product_mapping_progress import VideoProductMappingProgressMixin
from tiktok_res_app.services import (
    OUTPUT_DIR,
    VIDEO_FILE_SUFFIXES,
    probe_duration,
    resolve_output_path,
    run_process,
    source_identity_from_path,
)
from utils.asyncio_compat import to_thread


ProgressCallback = Callable[[Dict[str, Any]], Awaitable[None]]


class VideoProductMapper(VideoProductMappingProgressMixin):
    def __init__(
        self,
        config: ConfigLoader,
        *,
        progress_callback: Optional[ProgressCallback] = None,
    ) -> None:
        self.config = config
        self._progress_callback = progress_callback
        self._progress_lock = asyncio.Lock()
        self._progress_state: Optional[Dict[str, Any]] = None
        self._prepared_clips: Dict[str, Dict[str, Any]] = {}

    def _cfg(self) -> Dict[str, Any]:
        return self.config.get("video_product_mapping", {}) or {}

    def _model(self) -> str:
        return str(self._cfg().get("model", "qwen3.7-plus")).strip() or "qwen3.7-plus"

    def _api_url(self) -> str:
        value = str(
            self._cfg().get(
                "api_url",
                "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
            )
        ).strip()
        return value or "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"

    def _resolve_api_key(self) -> str:
        return str(self._cfg().get("api_key", "")).strip()

    def _chunk_seconds(self) -> int:
        value = int(self._cfg().get("chunk_seconds", 15) or 15)
        return max(5, value)

    def _overlap_seconds(self) -> int:
        value = int(self._cfg().get("overlap_seconds", 3) or 3)
        return max(0, value)

    def _max_chunks(self) -> int:
        value = int(self._cfg().get("max_chunks", 0) or 0)
        return max(0, value)

    def _max_candidates(self) -> int:
        value = int(self._cfg().get("max_candidates", 400) or 400)
        return max(20, value)

    def _scale_width(self) -> int:
        value = int(self._cfg().get("scale_width", 640) or 640)
        return max(320, value)

    def _crf(self) -> int:
        value = int(self._cfg().get("crf", 31) or 31)
        return min(max(value, 18), 40)

    def _timeout_seconds(self) -> int:
        value = int(self._cfg().get("timeout_seconds", 900) or 900)
        return max(60, value)

    def _input_mode(self) -> str:
        value = str(self._cfg().get("input_mode", "oss_url") or "oss_url").strip().lower()
        return value or "oss_url"

    def _validate_mode(self) -> str:
        mode = self._input_mode()
        if mode not in {"oss_url", "base64"}:
            raise RuntimeError("video_product_mapping.input_mode 仅支持 oss_url 或 base64")
        return mode

    def _ensure_ready(self) -> None:
        if not self._resolve_api_key():
            raise RuntimeError(
                "未配置视频商品识别 API Key，请检查项目配置文件中的 "
                "video_product_mapping.api_key"
            )
        if self._validate_mode() == "oss_url":
            OssUploader(self.config).resolve_settings()

    def _summary_path(self, products_path: Path) -> Path:
        if re.match(r"live_products_\d+_raw\.json$", products_path.name):
            summary = products_path.with_name(products_path.name.replace("_raw.json", "_summary.json"))
            if summary.exists():
                return summary
        return products_path

    def _load_products(self, products_path: Path) -> List[Dict[str, Any]]:
        payload = json.loads(products_path.read_text(encoding="utf-8"))
        if isinstance(payload.get("products"), list):
            return [item for item in payload["products"] if isinstance(item, dict)]
        nested = payload.get("products")
        if isinstance(nested, dict) and isinstance(nested.get("products"), list):
            return [item for item in nested["products"] if isinstance(item, dict)]
        raise RuntimeError("商品文件里没有可用的商品列表")

    @staticmethod
    def _mapping_output_path(video_path: Path) -> Path:
        return video_path.with_name(f"{video_path.stem}_product_map.json")

    @staticmethod
    def _build_windows(duration: float, chunk_seconds: int, overlap_seconds: int) -> List[Dict[str, float]]:
        if duration <= 0:
            raise RuntimeError("视频时长无效，无法识别商品")
        step = max(1, chunk_seconds - overlap_seconds)
        windows: List[Dict[str, float]] = []
        start = 0.0
        while start < duration:
            end = min(duration, start + chunk_seconds)
            windows.append({"start": round(start, 3), "end": round(end, 3)})
            if end >= duration:
                break
            start += step
        return windows

    async def _probe_duration(self, video_path: Path) -> float:
        duration = await probe_duration(video_path)
        if duration is None:
            raise RuntimeError("无法读取视频时长，请确认 ffprobe 可用")
        return duration

    async def _compress_clip(self, source: Path, output: Path, start: float, end: float) -> None:
        output.parent.mkdir(parents=True, exist_ok=True)
        await run_process(
            [
                "ffmpeg",
                "-y",
                "-ss",
                f"{start:.3f}",
                "-to",
                f"{end:.3f}",
                "-i",
                str(source),
                "-vf",
                f"scale={self._scale_width()}:-2,fps=24,format=yuv420p",
                "-c:v",
                "libx264",
                "-profile:v",
                "main",
                "-level",
                "4.1",
                "-preset",
                "veryfast",
                "-crf",
                str(self._crf()),
                "-c:a",
                "aac",
                "-b:a",
                "64k",
                "-movflags",
                "+faststart",
                str(output),
            ]
        )

    async def _prepare_chunk(
        self,
        *,
        source_video: Path,
        clips_dir: Path,
        chunk_index: int,
        window: Dict[str, float],
    ) -> Path:
        clip_path = clips_dir / (
            f"chunk_{chunk_index:03d}_{int(window['start'] * 1000)}_{int(window['end'] * 1000)}.mp4"
        )
        input_mode = self._validate_mode()
        clip_bytes = 0
        await self._update_progress(chunk_index=chunk_index, status="cutting", error=None)
        try:
            await self._compress_clip(source_video, clip_path, window["start"], window["end"])
            clip_bytes = clip_path.stat().st_size if clip_path.exists() else 0
            prepared = {
                "clip_bytes": clip_bytes,
                "input_mode": input_mode,
                "clip_reference": "",
            }
            if input_mode == "oss_url":
                await self._update_progress(
                    chunk_index=chunk_index,
                    status="uploading",
                    clip_bytes=clip_bytes,
                    input_mode=input_mode,
                )
                prepared["clip_reference"] = await to_thread(
                    OssUploader(self.config).upload_file,
                    clip_path,
                    purpose="video-product-mapping-clips",
                )
            self._prepared_clips[str(clip_path)] = prepared
            await self._update_progress(
                chunk_index=chunk_index,
                status="ready",
                clip_bytes=clip_bytes,
                input_mode=input_mode,
                clip_reference=str(prepared["clip_reference"] or ""),
                error=None,
            )
            return clip_path
        except Exception as exc:
            await self._update_progress(
                chunk_index=chunk_index,
                status="failed",
                clip_bytes=clip_bytes,
                input_mode=input_mode,
                error=str(exc),
            )
            raise

    async def _call_model(
        self,
        *,
        clip_path: Path,
        products: List[Dict[str, Any]],
        previous: Optional[Dict[str, Any]],
        start: float,
        end: float,
    ) -> Dict[str, Any]:
        titles = [str(item.get("title") or "").strip() for item in products if str(item.get("title") or "").strip()]
        prepared = self._prepared_clips.get(str(clip_path), {})
        input_mode = str(prepared.get("input_mode") or self._validate_mode())
        clip_reference = str(prepared.get("clip_reference") or "")
        clip_size = int(prepared.get("clip_bytes") or 0)
        video_payload: Dict[str, Any]
        if input_mode == "oss_url":
            if clip_size <= 0 and clip_path.exists():
                clip_size = clip_path.stat().st_size
            if not clip_reference:
                clip_reference = await to_thread(
                    OssUploader(self.config).upload_file,
                    clip_path,
                    purpose="video-product-mapping-clips",
                )
                prepared["clip_reference"] = clip_reference
                self._prepared_clips[str(clip_path)] = prepared
            video_payload = {
                "type": "video_url",
                "video_url": {"url": clip_reference},
            }
        else:
            clip_bytes = clip_path.read_bytes()
            clip_size = len(clip_bytes)
            prepared["clip_bytes"] = clip_size
            prepared["input_mode"] = input_mode
            self._prepared_clips[str(clip_path)] = prepared
            video_b64 = base64.b64encode(clip_bytes).decode("utf-8")
            clip_reference = "data:video/mp4;base64"
            video_payload = {
                "type": "video_url",
                "video_url": {"url": "data:video/mp4;base64," + video_b64},
            }
        previous_block = "上一片段没有可靠商品结果。"
        if previous and previous.get("resolved_match"):
            previous_block = f"上一片段识别结果是：{previous['resolved_match']['title']}。如果当前片段明显还在讲同一个商品，请直接返回这个商品。"
        candidate_lines = [f"{idx + 1}. {title}" for idx, title in enumerate(titles)]
        prompt = (
            f"你正在分析一段抖音视频的连续片段，当前片段是 {start:.1f}-{end:.1f} 秒。"
            "请结合视频画面和声音，判断当前片段主要在讲哪个商品。"
            "你只能从候选商品列表中选择，不能编造列表外商品。"
            "如果看不清，也请尽量返回最可能的一个候选商品。"
            '请只返回严格 JSON，不要 markdown。格式：{"match_index":1,"match_title":"候选标题","confidence":0.93,"summary":"一句中文总结"}\n\n'
            f"{previous_block}\n\n"
            "候选商品标题如下：\n"
            + "\n".join(candidate_lines)
        )
        payload = {
            "model": self._model(),
            "messages": [
                {
                    "role": "system",
                    "content": "你是一个严谨的直播商品识别助手。必须只从候选商品列表中选择。",
                },
                {
                    "role": "user",
                    "content": [
                        video_payload,
                        {"type": "text", "text": prompt},
                    ],
                },
            ],
            "modalities": ["text"],
            "stream": False,
            "temperature": 0.1,
            "max_tokens": 1000,
        }

        def _request() -> Dict[str, Any]:
            request = urllib.request.Request(
                self._api_url(),
                data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                headers={
                    "Authorization": "Bearer " + self._resolve_api_key(),
                    "Content-Type": "application/json",
                },
                method="POST",
            )
            try:
                with urllib.request.urlopen(request, timeout=self._timeout_seconds()) as response:
                    return json.loads(response.read().decode("utf-8"))
            except urllib.error.HTTPError as exc:
                body = exc.read().decode("utf-8", errors="ignore")
                raise RuntimeError(
                    f"视频商品识别请求失败: status={exc.code}, body={body}"
                ) from exc

        outer = await to_thread(_request)
        content = self._normalize_content_text(outer["choices"][0]["message"]["content"])
        parsed = self._coerce_json_object(content)
        return {
            "parsed": parsed,
            "clip_bytes": clip_size,
            "raw_text": content,
            "input_mode": input_mode,
            "clip_reference": clip_reference,
        }

    async def run(self, video_path: str, products_path: str) -> Dict[str, Any]:
        self._ensure_ready()
        self._prepared_clips = {}

        source_video = resolve_output_path(video_path)
        if source_video.suffix.lower() not in VIDEO_FILE_SUFFIXES:
            raise RuntimeError("只能识别视频文件")

        source_products = self._summary_path(resolve_output_path(products_path))
        products = self._load_products(source_products)
        if not products:
            raise RuntimeError("商品文件里没有可识别的商品")

        candidate_products = products[: self._max_candidates()]
        duration = await self._probe_duration(source_video)
        windows = self._build_windows(
            duration,
            self._chunk_seconds(),
            self._overlap_seconds(),
        )
        if self._max_chunks() > 0:
            windows = windows[: self._max_chunks()]

        output_path = self._mapping_output_path(source_video)
        source_identity = source_identity_from_path(source_video, "video")
        await self._set_progress_state(
            {
                "source_identity": source_identity,
                "video_path": str(source_video),
                "products_path": str(source_products),
                "model": self._model(),
                "input_mode": self._validate_mode(),
                "chunk_seconds": self._chunk_seconds(),
                "overlap_seconds": self._overlap_seconds(),
                "duration_seconds": round(duration, 3),
                "product_count": len(products),
                "candidate_count": len(candidate_products),
                "chunk_count": len(windows),
                "completed_chunk_count": 0,
                "prepared_chunk_count": 0,
                "analyzing_chunk_count": 0,
                "failed_chunk_count": 0,
                "successful_chunk_count": 0,
                "matched_products": [],
                "chunks": [
                    self._initial_chunk_state(index, window)
                    for index, window in enumerate(windows, start=1)
                ],
                "mapping_path": str(output_path),
                "pipeline": {},
            }
        )
        previous: Optional[Dict[str, Any]] = None

        with tempfile.TemporaryDirectory(prefix="tiktok_res_product_map_") as tmp_dir:
            clips_dir = Path(tmp_dir)
            next_prepare_task: Optional[asyncio.Task[Path]] = None
            if windows:
                next_prepare_task = asyncio.create_task(
                    self._prepare_chunk(
                        source_video=source_video,
                        clips_dir=clips_dir,
                        chunk_index=1,
                        window=windows[0],
                    )
                )
            for index, window in enumerate(windows, start=1):
                clip_path: Optional[Path] = None
                try:
                    if next_prepare_task is not None:
                        clip_path = await next_prepare_task
                except Exception:
                    clip_path = None

                if index < len(windows):
                    next_window = windows[index]
                    next_prepare_task = asyncio.create_task(
                        self._prepare_chunk(
                            source_video=source_video,
                            clips_dir=clips_dir,
                            chunk_index=index + 1,
                            window=next_window,
                        )
                    )
                else:
                    next_prepare_task = None

                if clip_path is None:
                    continue

                await self._update_progress(chunk_index=index, status="analyzing")
                try:
                    model_result = await self._call_model(
                        clip_path=clip_path,
                        products=candidate_products,
                        previous=previous,
                        start=window["start"],
                        end=window["end"],
                    )
                    parsed = model_result["parsed"]
                    summary_text = ""
                    evidence = []
                    top_matches = []
                    decision = None
                    if isinstance(parsed, dict):
                        summary_text = str(
                            parsed.get("summary") or parsed.get("说明") or parsed.get("理由") or ""
                        ).strip()
                        evidence = parsed.get("evidence") or []
                        top_matches = parsed.get("top_matches") or []
                        decision = parsed.get("decision")
                    resolved_match = self._resolve_primary_match(parsed, candidate_products, previous)
                    await self._update_progress(
                        chunk_index=index,
                        status="completed",
                        decision=decision,
                        summary=summary_text or str(model_result.get("raw_text") or ""),
                        evidence=evidence,
                        top_matches=top_matches,
                        clip_bytes=int(model_result.get("clip_bytes") or 0),
                        input_mode=str(model_result.get("input_mode") or self._validate_mode()),
                        clip_reference=str(model_result.get("clip_reference") or ""),
                        resolved_match=resolved_match,
                        error=None,
                    )
                    if resolved_match:
                        previous = {"resolved_match": resolved_match}
                except Exception as exc:
                    prepared = self._prepared_clips.get(str(clip_path), {})
                    await self._update_progress(
                        chunk_index=index,
                        status="failed",
                        decision=None,
                        summary="",
                        evidence=[],
                        top_matches=[],
                        clip_bytes=int(
                            prepared.get("clip_bytes")
                            or (clip_path.stat().st_size if clip_path.exists() else 0)
                        ),
                        input_mode=str(prepared.get("input_mode") or self._validate_mode()),
                        clip_reference=str(prepared.get("clip_reference") or ""),
                        resolved_match=None,
                        error=str(exc),
                    )

        progress_result = await self._snapshot_progress()
        chunk_results = list(progress_result.get("chunks") or [])
        matched_products = self._aggregate_matches(chunk_results)
        successful_chunks = sum(1 for item in chunk_results if item.get("resolved_match"))
        failed_chunks = sum(1 for item in chunk_results if item.get("error"))
        if successful_chunks == 0:
            first_error = next((item.get("error") for item in chunk_results if item.get("error")), "")
            raise RuntimeError(first_error or "所有视频片段都未能识别出商品")
        result = dict(progress_result)
        result["matched_products"] = matched_products
        result["successful_chunk_count"] = successful_chunks
        result["failed_chunk_count"] = failed_chunks
        output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        result["files"] = [
            {
                "path": str(output_path.resolve()),
                "name": output_path.name,
                "size_bytes": output_path.stat().st_size,
                "type": "video_product_map",
            }
        ]
        await self._update_progress(files=result["files"])
        result = await self._snapshot_progress()
        return result


def video_product_mapping_status(config: ConfigLoader) -> Dict[str, Any]:
    mapper = VideoProductMapper(config)
    try:
        mapper._ensure_ready()
    except Exception as exc:
        return {
            "ready": False,
            "message": str(exc),
            "input_mode": mapper._input_mode(),
        }
    return {
        "ready": True,
        "message": "",
        "input_mode": mapper._input_mode(),
    }
