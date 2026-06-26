from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from tiktok_res_app import services
from tiktok_res_app.video_product_mapping import VideoProductMapper, video_product_mapping_status


class _FakeConfig:
    def __init__(self, data):
        self._data = data

    def get(self, key, default=None):
        return self._data.get(key, default)


class _FakeMapper(VideoProductMapper):
    async def _probe_duration(self, video_path: Path) -> float:
        return 33.0

    async def _compress_clip(self, source: Path, output: Path, start: float, end: float) -> None:
        output.write_bytes(b"clip")

    async def _call_model(self, *, clip_path: Path, products, previous, start: float, end: float):
        if start < 12:
            parsed = {
                "decision": "anchor",
                "primary_match": {"index": 1, "title": products[0]["title"], "confidence": 0.95},
                "summary": "命中特仑苏",
                "evidence": ["主播口播特仑苏"],
                "top_matches": [{"index": 1, "title": products[0]["title"], "confidence": 0.95}],
            }
        elif start < 24:
            parsed = {
                "decision": "continue",
                "primary_match": {"index": 1, "title": products[0]["title"], "confidence": 0.92},
                "summary": "继续讲特仑苏",
                "evidence": ["画面延续上一段"],
                "top_matches": [{"index": 1, "title": products[0]["title"], "confidence": 0.92}],
            }
        else:
            parsed = {
                "decision": "switch",
                "primary_match": {"index": 2, "title": products[1]["title"], "confidence": 0.97},
                "summary": "切到蒙牛",
                "evidence": ["画面出现蒙牛字样"],
                "top_matches": [{"index": 2, "title": products[1]["title"], "confidence": 0.97}],
            }
        return {"parsed": parsed, "clip_bytes": clip_path.stat().st_size}


class _ProgressMapper(_FakeMapper):
    async def _call_model(self, *, clip_path: Path, products, previous, start: float, end: float):
        await asyncio.sleep(0.02)
        return await super()._call_model(
            clip_path=clip_path,
            products=products,
            previous=previous,
            start=start,
            end=end,
        )


@pytest.mark.asyncio
async def test_video_product_mapper_aggregates_matches_and_writes_json(tmp_path, monkeypatch):
    output = tmp_path / "Downloaded"
    live_dir = output / "东方甄选" / "live" / "2026-05-20_1108_东方甄选_80017709309"
    live_dir.mkdir(parents=True)
    video = live_dir / "2026-05-20_1108_东方甄选_80017709309.flv"
    video.write_bytes(b"video")
    raw = output / "live_products_80017709309_raw.json"
    summary = output / "live_products_80017709309_summary.json"
    raw.write_text("{}", encoding="utf-8")
    summary.write_text(
        json.dumps(
            {
                "products": [
                    {"product_id": "1", "title": "特仑苏纯牛奶", "show_price_yuan": 89},
                    {"product_id": "2", "title": "蒙牛纯牛奶", "show_price_yuan": 79},
                ]
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(services, "OUTPUT_DIR", output)
    mapper = _FakeMapper(
        _FakeConfig(
            {
                "video_product_mapping": {
                    "api_key": "test-key",
                    "input_mode": "base64",
                    "chunk_seconds": 15,
                    "overlap_seconds": 3,
                    "max_chunks": 0,
                    "max_candidates": 20,
                }
            }
        )
    )

    result = await mapper.run(str(video), str(raw))

    assert result["source_identity"] == "80017709309"
    assert result["chunk_count"] == 3
    assert result["matched_products"][0]["title"] == "特仑苏纯牛奶"
    assert result["matched_products"][0]["hit_count"] == 2
    assert result["matched_products"][1]["title"] == "蒙牛纯牛奶"
    assert Path(result["mapping_path"]).exists()


@pytest.mark.asyncio
async def test_video_product_mapper_emits_pipeline_progress(tmp_path, monkeypatch):
    output = tmp_path / "Downloaded"
    live_dir = output / "东方甄选" / "live" / "2026-05-20_1108_东方甄选_80017709309"
    live_dir.mkdir(parents=True)
    video = live_dir / "2026-05-20_1108_东方甄选_80017709309.flv"
    video.write_bytes(b"video")
    raw = output / "live_products_80017709309_raw.json"
    summary = output / "live_products_80017709309_summary.json"
    raw.write_text("{}", encoding="utf-8")
    summary.write_text(
        json.dumps(
            {
                "products": [
                    {"product_id": "1", "title": "特仑苏纯牛奶", "show_price_yuan": 89},
                    {"product_id": "2", "title": "蒙牛纯牛奶", "show_price_yuan": 79},
                ]
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(services, "OUTPUT_DIR", output)
    progress_events = []

    async def on_progress(payload):
        progress_events.append(payload)

    mapper = _ProgressMapper(
        _FakeConfig(
            {
                "video_product_mapping": {
                    "api_key": "test-key",
                    "input_mode": "base64",
                    "chunk_seconds": 15,
                    "overlap_seconds": 3,
                    "max_chunks": 0,
                    "max_candidates": 20,
                }
            }
        ),
        progress_callback=on_progress,
    )

    result = await mapper.run(str(video), str(raw))

    assert progress_events
    assert any(event["pipeline"]["counts"]["analyzing"] >= 1 for event in progress_events)
    assert any(
        event["pipeline"]["counts"]["analyzing"] >= 1 and event["pipeline"]["counts"]["ready"] >= 1
        for event in progress_events
    )
    assert result["pipeline"]["depends_on_previous_chunk"] is True
    assert result["pipeline"]["mode"] == "serial_analysis_with_background_prepare"
    assert all(chunk["status"] in {"completed", "failed"} for chunk in result["chunks"])
    assert all(chunk.get("status_label") for chunk in result["chunks"])
    assert all(chunk.get("step_history") for chunk in result["chunks"])
    assert all(chunk["step_history"][-1]["status"] in {"completed", "failed"} for chunk in result["chunks"])


@pytest.mark.asyncio
async def test_video_product_mapper_requires_api_key(tmp_path, monkeypatch):
    output = tmp_path / "Downloaded"
    output.mkdir()
    video = output / "video_7637862013976202534.mp4"
    products = output / "live_products_7637862013976202534_summary.json"
    video.write_bytes(b"video")
    products.write_text(json.dumps({"products": [{"title": "测试商品"}]}, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(services, "OUTPUT_DIR", output)
    mapper = VideoProductMapper(_FakeConfig({"video_product_mapping": {"api_key": "", "input_mode": "base64"}}))

    with pytest.raises(RuntimeError, match="API Key"):
        await mapper.run(str(video), str(products))


def test_video_product_mapping_status_requires_oss_config_for_oss_mode():
    status = video_product_mapping_status(
        _FakeConfig(
            {
                "video_product_mapping": {"api_key": "test-key", "input_mode": "oss_url"},
                "oss": {},
            }
        )
    )

    assert status["ready"] is False
    assert "OSS" in status["message"]


def test_video_product_mapping_status_accepts_base64_without_oss():
    status = video_product_mapping_status(
        _FakeConfig(
            {
                "video_product_mapping": {"api_key": "test-key", "input_mode": "base64"},
                "oss": {},
            }
        )
    )

    assert status["ready"] is True
    assert status["message"] == ""
