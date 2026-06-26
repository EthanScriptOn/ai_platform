from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional


OUTPUT_FILE_SUFFIXES = {".mp4", ".flv", ".m3u8", ".json", ".jpg", ".jpeg", ".png", ".webp", ".mp3"}
VIDEO_FILE_SUFFIXES = {".mp4", ".flv", ".m3u8"}
PARTIAL_VIDEO_SUFFIXES = (".mp4.tmp", ".flv.tmp", ".m3u8.tmp")


def create_output_file_helpers(get_output_dir: Callable[[], Path]) -> Dict[str, Callable[..., Any]]:
    def list_output_files(output_dir: Path) -> Dict[str, float]:
        if not output_dir.exists():
            return {}
        files: Dict[str, float] = {}
        for path in output_dir.rglob("*"):
            if path.is_file() and path.suffix.lower() in OUTPUT_FILE_SUFFIXES:
                try:
                    files[str(path.resolve())] = path.stat().st_mtime
                except OSError:
                    continue
        return files

    def resolve_output_path(path: str) -> Path:
        candidate = Path(path).expanduser().resolve()
        root = get_output_dir()
        try:
            candidate.relative_to(root)
        except ValueError as exc:
            raise RuntimeError("只能访问 Downloaded 目录里的文件") from exc
        if not candidate.exists() or not candidate.is_file():
            raise RuntimeError("文件不存在")
        return candidate

    def cleanup_empty_output_dirs(start: Path) -> None:
        root = get_output_dir()
        current = start.resolve()
        while current != root and root in current.parents:
            try:
                current.rmdir()
            except OSError:
                break
            current = current.parent

    def associated_output_paths(path: Path) -> List[Path]:
        paths = [path]
        suffix = path.suffix.lower()
        if suffix in VIDEO_FILE_SUFFIXES:
            preview = path.with_name(f"{path.stem}_preview.mp4")
            paths.append(preview)
            clips_dir = path.parent / "clips"
            if clips_dir.exists():
                paths.extend(
                    item
                    for item in clips_dir.glob(f"{path.stem}*")
                    if item.is_file()
                )
        return paths

    def delete_output_file(path: str, *, include_associated: bool = True) -> Dict[str, Any]:
        target = resolve_output_path(path)
        deleted = []
        candidates = associated_output_paths(target) if include_associated else [target]
        for candidate in candidates:
            try:
                resolved = resolve_output_path(str(candidate))
            except Exception:
                continue
            try:
                resolved.unlink()
            except FileNotFoundError:
                continue
            deleted.append(str(resolved))
            cleanup_empty_output_dirs(resolved.parent)
        return {"deleted": deleted}

    def read_json_output_file(path: str) -> Dict[str, Any]:
        target = resolve_output_path(path)
        if target.suffix.lower() != ".json":
            raise RuntimeError("只能预览 JSON 数据文件")
        data = json.loads(target.read_text(encoding="utf-8"))
        summary_data = None
        if re.match(r"live_products_\d+_raw\.json$", target.name):
            summary = target.with_name(target.name.replace("_raw.json", "_summary.json"))
            if summary.exists():
                try:
                    summary_data = json.loads(summary.read_text(encoding="utf-8"))
                except Exception:
                    summary_data = None
        return {
            "path": str(target),
            "name": target.name,
            "size_bytes": target.stat().st_size,
            "updated_at": target.stat().st_mtime,
            "data": data,
            "summary_data": summary_data,
        }

    def collect_output_paths(value: Any) -> List[str]:
        paths: List[str] = []
        if isinstance(value, dict):
            for item in value.values():
                paths.extend(collect_output_paths(item))
        elif isinstance(value, list):
            for item in value:
                paths.extend(collect_output_paths(item))
        elif isinstance(value, str):
            try:
                candidate = Path(value).expanduser().resolve()
                candidate.relative_to(get_output_dir())
            except Exception:
                return paths
            if candidate.exists() and candidate.is_file():
                paths.append(str(candidate))
        return paths

    def delete_job_output_files(job: Dict[str, Any]) -> Dict[str, Any]:
        seen = set()
        deleted = []
        for path in collect_output_paths(job.get("result")):
            if path in seen:
                continue
            seen.add(path)
            result = delete_output_file(path, include_associated=False)
            deleted.extend(item for item in result["deleted"] if item not in deleted)
        return {"deleted": deleted}

    def source_identity_from_path(path: Path, item_type: str) -> str:
        text = str(path)
        if item_type == "products":
            match = re.search(r"live_products_(\d+)_", path.name)
            if match:
                return match.group(1)
        if item_type == "room":
            match = re.search(r"_(\d+)_room\.json$", path.name)
            if match:
                return match.group(1)
        if "/live/" in text:
            matches = re.findall(r"_(\d{6,})", text)
            if matches:
                return matches[-1]
        matches = re.findall(r"(\d{12,})", path.stem)
        if matches:
            return matches[-1]
        return ""

    def is_generated_preview_file(path: Path) -> bool:
        return path.suffix.lower() == ".mp4" and path.stem.endswith("_preview")

    def is_partial_video_file(path: Path) -> bool:
        return path.name.lower().endswith(PARTIAL_VIDEO_SUFFIXES)

    def is_shadow_product_summary(path: Path) -> bool:
        if not re.match(r"live_products_\d+_summary\.json$", path.name):
            return False
        return path.with_name(path.name.replace("_summary.json", "_raw.json")).exists()

    def is_video_product_map_file(path: Path) -> bool:
        return path.suffix.lower() == ".json" and path.name.endswith("_product_map.json")

    def product_count_from_payload(payload: Dict[str, Any]) -> int:
        value = payload.get("product_count")
        try:
            if value is not None:
                return max(0, int(value))
        except (TypeError, ValueError):
            pass
        products = payload.get("products")
        if isinstance(products, list):
            return len(products)
        promotions = payload.get("promotions")
        if isinstance(promotions, list):
            return len(promotions)
        return 0

    def output_identity_tokens(parsed: Dict[str, Any]) -> List[str]:
        tokens: List[str] = []
        for key in ("aweme_id", "room_id", "note_id", "mix_id", "music_id"):
            value = str(parsed.get(key) or "").strip()
            if value:
                tokens.append(value)
        return tokens

    def path_matches_output_identity(path: str, tokens: List[str]) -> bool:
        if not tokens:
            return True
        return any(token in path for token in tokens)

    def describe_file_path(path: Path) -> Optional[Dict[str, Any]]:
        if not path.exists() or not path.is_file():
            return None
        try:
            size = path.stat().st_size
        except OSError:
            size = None
        suffix = path.suffix.lower()
        return {
            "path": str(path.resolve()),
            "name": path.name,
            "size_bytes": size,
            "type": "video" if suffix in VIDEO_FILE_SUFFIXES else "metadata",
        }

    def describe_manifest_files(output_dir: Path, *, parsed: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        manifest_path = output_dir / "download_manifest.jsonl"
        if not manifest_path.exists():
            return []
        identity = str((parsed or {}).get("aweme_id") or "").strip()
        if not identity:
            return []
        records: List[Dict[str, Any]] = []
        try:
            lines = manifest_path.read_text(encoding="utf-8").splitlines()
        except OSError:
            return []
        for line in reversed(lines):
            try:
                record = json.loads(line)
            except Exception:
                continue
            if identity and str(record.get("aweme_id") or "") != identity:
                continue
            records.append(record)
            break
        if not records:
            return []
        files: List[Dict[str, Any]] = []
        for rel_path in records[0].get("file_paths") or []:
            candidate = (output_dir / str(rel_path)).resolve()
            try:
                candidate.relative_to(output_dir.resolve())
            except ValueError:
                continue
            item = describe_file_path(candidate)
            if item:
                files.append(item)
        return files

    def describe_output_files(
        output_dir: Path,
        before: Dict[str, float],
        started_at: float,
        *,
        parsed: Optional[Dict[str, Any]] = None,
    ) -> List[Dict[str, Any]]:
        manifest_files = describe_manifest_files(output_dir, parsed=parsed)
        if manifest_files:
            return manifest_files
        after = list_output_files(output_dir)
        identity_tokens = output_identity_tokens(parsed or {})
        paths = [
            path
            for path, mtime in after.items()
            if (
                path not in before
                or mtime > before.get(path, 0)
                or mtime >= started_at - 1
            )
            and path_matches_output_identity(path, identity_tokens)
        ]
        files = []
        for path in sorted(paths, key=lambda item: after.get(item, 0), reverse=True):
            item = describe_file_path(Path(path))
            if item:
                files.append(item)
        return files

    def scan_library(limit: int = 100) -> List[Dict[str, Any]]:
        output_dir = get_output_dir()
        if not output_dir.exists():
            return []
        items = []
        for path in output_dir.rglob("*"):
            if not path.is_file():
                continue
            suffix = path.suffix.lower()
            if suffix not in {".mp4", ".flv", ".m3u8", ".json"}:
                continue
            if is_generated_preview_file(path):
                continue
            if is_shadow_product_summary(path):
                continue
            if path.name.endswith("_room.json"):
                continue
            if is_video_product_map_file(path):
                item_type = "video_product_map"
            elif "live_products_" in path.name:
                item_type = "products"
            elif path.parent.name == "clips":
                item_type = "clip"
            elif suffix in VIDEO_FILE_SUFFIXES:
                item_type = "video"
            else:
                continue
            try:
                stat = path.stat()
            except OSError:
                continue
            item = {
                "type": item_type,
                "name": path.name,
                "path": str(path.resolve()),
                "size_bytes": stat.st_size,
                "updated_at": stat.st_mtime,
                "source_identity": source_identity_from_path(path, item_type),
            }
            if item_type == "products":
                payload_path = path
                summary_path = path.with_name(path.name.replace("_raw.json", "_summary.json"))
                if summary_path.exists():
                    payload_path = summary_path
                try:
                    payload = json.loads(payload_path.read_text(encoding="utf-8"))
                except Exception:
                    payload = {}
                item["product_count"] = product_count_from_payload(payload)
            items.append(item)
        return sorted(items, key=lambda item: item["updated_at"], reverse=True)[:limit]

    return {
        "associated_output_paths": associated_output_paths,
        "cleanup_empty_output_dirs": cleanup_empty_output_dirs,
        "collect_output_paths": collect_output_paths,
        "delete_job_output_files": delete_job_output_files,
        "delete_output_file": delete_output_file,
        "describe_file_path": describe_file_path,
        "describe_manifest_files": describe_manifest_files,
        "describe_output_files": describe_output_files,
        "is_generated_preview_file": is_generated_preview_file,
        "is_partial_video_file": is_partial_video_file,
        "is_shadow_product_summary": is_shadow_product_summary,
        "is_video_product_map_file": is_video_product_map_file,
        "list_output_files": list_output_files,
        "output_identity_tokens": output_identity_tokens,
        "path_matches_output_identity": path_matches_output_identity,
        "product_count_from_payload": product_count_from_payload,
        "read_json_output_file": read_json_output_file,
        "resolve_output_path": resolve_output_path,
        "scan_library": scan_library,
        "source_identity_from_path": source_identity_from_path,
    }
