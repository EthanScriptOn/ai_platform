from __future__ import annotations

import json
import time

from tiktok_res_app.services import describe_output_files
from tiktok_res_app import services


def test_describe_output_files_filters_by_live_room_id(tmp_path):
    output = tmp_path / "Downloaded"
    current_dir = output / "会跳舞鹦鹉" / "live" / "2026-05-19_1637_会跳舞鹦鹉_578021558731"
    old_dir = output / "野兽中文配音" / "clips"
    current_dir.mkdir(parents=True)
    old_dir.mkdir(parents=True)
    current_file = current_dir / "2026-05-19_1637_会跳舞鹦鹉_578021558731.flv"
    old_preview = old_dir / "100个孩子PK世界上最强壮的大力士_7637862013976202534_preview.mp4"
    current_file.write_bytes(b"live")
    old_preview.write_bytes(b"old")
    started_at = time.time()
    before = {}

    files = describe_output_files(
        output,
        before,
        started_at,
        parsed={"type": "live", "room_id": "578021558731"},
    )

    paths = [item["path"] for item in files]
    assert str(current_file.resolve()) in paths
    assert str(old_preview.resolve()) not in paths


def test_describe_output_files_keeps_all_without_identity(tmp_path):
    output = tmp_path / "Downloaded"
    output.mkdir()
    file_path = output / "unknown.mp4"
    file_path.write_bytes(b"video")

    files = describe_output_files(output, {}, time.time(), parsed={})

    assert [item["path"] for item in files] == [str(file_path.resolve())]


def test_delete_output_file_removes_associated_preview_and_clips(tmp_path, monkeypatch):
    output = tmp_path / "Downloaded"
    source_dir = output / "author" / "video_123"
    clips_dir = source_dir / "clips"
    clips_dir.mkdir(parents=True)
    source = source_dir / "video_123.mp4"
    preview = source_dir / "video_123_preview.mp4"
    clip = clips_dir / "video_123_clip_0_1000.mp4"
    unrelated = clips_dir / "other_clip.mp4"
    for path in (source, preview, clip, unrelated):
        path.write_bytes(b"data")
    monkeypatch.setattr(services, "OUTPUT_DIR", output)

    result = services.delete_output_file(str(source), include_associated=True)

    assert str(source.resolve()) in result["deleted"]
    assert str(preview.resolve()) in result["deleted"]
    assert str(clip.resolve()) in result["deleted"]
    assert not source.exists()
    assert not preview.exists()
    assert not clip.exists()
    assert unrelated.exists()


def test_delete_output_file_can_delete_only_one_asset(tmp_path, monkeypatch):
    output = tmp_path / "Downloaded"
    source_dir = output / "author" / "video_123"
    clips_dir = source_dir / "clips"
    clips_dir.mkdir(parents=True)
    source = source_dir / "video_123.mp4"
    preview = source_dir / "video_123_preview.mp4"
    clip = clips_dir / "video_123_clip_0_1000.mp4"
    for path in (source, preview, clip):
        path.write_bytes(b"data")
    monkeypatch.setattr(services, "OUTPUT_DIR", output)

    result = services.delete_output_file(str(source), include_associated=False)

    assert result["deleted"] == [str(source.resolve())]
    assert not source.exists()
    assert preview.exists()
    assert clip.exists()


def test_delete_output_file_rejects_outside_downloaded(tmp_path, monkeypatch):
    output = tmp_path / "Downloaded"
    output.mkdir()
    outside = tmp_path / "outside.mp4"
    outside.write_bytes(b"data")
    monkeypatch.setattr(services, "OUTPUT_DIR", output)

    try:
        services.delete_output_file(str(outside))
    except RuntimeError as exc:
        assert "Downloaded" in str(exc)
    else:
        raise AssertionError("outside file should be rejected")


def test_source_identity_matches_live_products_and_live_video():
    product_path = services.OUTPUT_DIR / "live_products_578021558731_raw.json"
    video_path = (
        services.OUTPUT_DIR
        / "会跳舞鹦鹉"
        / "live"
        / "2026-05-19_1637_会跳舞鹦鹉_578021558731"
        / "2026-05-19_1637_会跳舞鹦鹉_578021558731.flv"
    )

    assert services.source_identity_from_path(product_path, "products") == "578021558731"
    assert services.source_identity_from_path(video_path, "video") == "578021558731"


def test_looks_like_live_url_detects_live_links():
    assert services.looks_like_live_url("https://live.douyin.com/578021558731?foo=bar")
    assert services.looks_like_live_url("https://www.douyin.com/follow/live/578021558731")
    assert not services.looks_like_live_url("https://v.douyin.com/8K7wsKVkeoA/")


def test_read_json_output_file_uses_product_summary_for_raw_preview(tmp_path, monkeypatch):
    output = tmp_path / "Downloaded"
    output.mkdir()
    raw = output / "live_products_578021558731_raw.json"
    summary = output / "live_products_578021558731_summary.json"
    raw.write_text(json.dumps({"promotions": [{"title": "raw"}]}), encoding="utf-8")
    summary.write_text(
        json.dumps({"web_rid": "578021558731", "products": [{"title": "summary"}]}),
        encoding="utf-8",
    )
    monkeypatch.setattr(services, "OUTPUT_DIR", output)

    result = services.read_json_output_file(str(raw))

    assert result["data"]["promotions"][0]["title"] == "raw"
    assert result["summary_data"]["products"][0]["title"] == "summary"


def test_scan_library_hides_generated_previews_and_duplicate_product_summary(tmp_path, monkeypatch):
    output = tmp_path / "Downloaded"
    video_dir = output / "author" / "video_123456789012"
    video_dir.mkdir(parents=True)
    source = video_dir / "video_123456789012.mp4"
    preview = video_dir / "video_123456789012_preview.mp4"
    raw = output / "live_products_578021558731_raw.json"
    summary = output / "live_products_578021558731_summary.json"
    for path in (source, preview):
        path.write_bytes(b"video")
    for path in (raw, summary):
        path.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(services, "OUTPUT_DIR", output)

    items = services.scan_library()
    names = {item["name"] for item in items}

    assert source.name in names
    assert preview.name not in names
    assert raw.name in names
    assert summary.name not in names


def test_scan_library_hides_partial_live_recordings(tmp_path, monkeypatch):
    output = tmp_path / "Downloaded"
    live_dir = output / "author" / "live" / "2026-05-19_1801_author_578021558731"
    live_dir.mkdir(parents=True)
    partial = live_dir / "2026-05-19_1801_author_578021558731.flv.tmp"
    room = live_dir / "2026-05-19_1801_author_578021558731_room.json"
    partial.write_bytes(b"partial")
    room.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(services, "OUTPUT_DIR", output)

    items = services.scan_library()

    assert items == []
