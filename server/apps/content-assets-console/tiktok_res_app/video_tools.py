from __future__ import annotations

import asyncio
import re
import shutil
from pathlib import Path
from typing import List, Optional

ROOT = Path(__file__).resolve().parents[1]
FFMPEG_TIME_RE = re.compile(r"time=(\d+):(\d+):(\d+(?:\.\d+)?)")


def resolve_binary(name: str) -> str:
    system_path = shutil.which(name)
    if system_path:
        return system_path
    for base in ("/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"):
        candidate = Path(base) / name
        if candidate.exists() and candidate.is_file():
            return str(candidate)
    bundled = ROOT / "tools" / "bin" / name
    if bundled.exists() and bundled.is_file():
        return str(bundled)
    return name


async def run_process(args: List[str]) -> None:
    command = [resolve_binary(args[0]), *args[1:]]
    try:
        process = await asyncio.create_subprocess_exec(
            *command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError as exc:
        raise RuntimeError(f"服务器缺少 {args[0]}，请先安装后再试") from exc
    stdout, stderr = await process.communicate()
    if process.returncode != 0:
        detail = (stderr or stdout or b"").decode("utf-8", errors="ignore").strip()
        raise RuntimeError(detail or f"命令执行失败: {' '.join(command)}")


async def probe_duration(path: Path) -> Optional[float]:
    try:
        process = await asyncio.create_subprocess_exec(
            resolve_binary("ffprobe"),
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError:
        return None
    stdout, _ = await process.communicate()
    if process.returncode != 0:
        return await probe_duration_via_ffmpeg(path)
    try:
        value = float(stdout.decode("utf-8", errors="ignore").strip())
        if value > 0:
            if _duration_requires_ffmpeg_fallback(path, value):
                fallback = await probe_duration_via_ffmpeg(path)
                if fallback and fallback > 0:
                    return fallback
            return value
    except Exception:
        pass
    return await probe_duration_via_ffmpeg(path)


def _duration_requires_ffmpeg_fallback(path: Path, seconds: float) -> bool:
    if seconds <= 0:
        return True
    try:
        size_bytes = path.stat().st_size
    except OSError:
        return False
    if size_bytes <= 0:
        return False

    # Some live-recorded FLV files carry wildly inflated container durations
    # in ffprobe output. When that happens, the implied average bitrate drops
    # to an implausibly low value for a video file; use ffmpeg's stream scan
    # instead.
    avg_bitrate_bps = (size_bytes * 8.0) / seconds
    if path.suffix.lower() == ".flv" and avg_bitrate_bps < 24_000:
        return True
    return False


def extract_last_ffmpeg_time_seconds(text: str) -> Optional[float]:
    matches = FFMPEG_TIME_RE.findall(text or "")
    if not matches:
        return None
    hours, minutes, seconds = matches[-1]
    try:
        return int(hours) * 3600 + int(minutes) * 60 + float(seconds)
    except Exception:
        return None


async def probe_duration_via_ffmpeg(path: Path) -> Optional[float]:
    try:
        process = await asyncio.create_subprocess_exec(
            resolve_binary("ffmpeg"),
            "-i",
            str(path),
            "-map",
            "0:v:0?",
            "-f",
            "null",
            "-",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError:
        return None
    _, stderr = await process.communicate()
    return extract_last_ffmpeg_time_seconds(stderr.decode("utf-8", errors="ignore"))


async def prepare_video_preview(path: str) -> Dict[str, Any]:
    source = resolve_output_path(path)
    if source.suffix.lower() not in VIDEO_FILE_SUFFIXES:
        raise RuntimeError("只能预览视频文件")
    preview = source.with_name(f"{source.stem}_preview.mp4")
    if not preview.exists() or preview.stat().st_mtime < source.stat().st_mtime:
        await run_process(
            [
                "ffmpeg",
                "-y",
                "-i",
                str(source),
                "-c",
                "copy",
                "-movflags",
                "+faststart",
                str(preview),
            ]
        )
    return {
        "source_path": str(source),
        "preview_path": str(preview.resolve()),
        "duration_seconds": await probe_duration(preview) or await probe_duration(source),
    }


async def clip_video(path: str, *, start_seconds: float, end_seconds: float) -> Dict[str, Any]:
    source = resolve_output_path(path)
    if source.suffix.lower() not in VIDEO_FILE_SUFFIXES:
        raise RuntimeError("只能剪辑视频文件")
    start = max(0.0, float(start_seconds))
    end = max(0.0, float(end_seconds))
    if end <= start:
        raise RuntimeError("结束时间必须大于开始时间")
    clips_dir = source.parent / "clips"
    clips_dir.mkdir(parents=True, exist_ok=True)
    output = clips_dir / f"{source.stem}_clip_{int(start * 1000)}_{int(end * 1000)}.mp4"
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
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            str(output),
        ]
    )
    return {
        "source_path": str(source),
        "clip_path": str(output.resolve()),
        "start_seconds": start,
        "end_seconds": end,
        "duration_seconds": round(end - start, 3),
        "size_bytes": output.stat().st_size if output.exists() else None,
    }
