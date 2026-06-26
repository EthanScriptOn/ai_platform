#!/usr/bin/env python3
import json
import os
import sys


def fail(message: str, code: int = 1) -> int:
    print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
    return code


def main() -> int:
    if len(sys.argv) < 2:
        return fail("missing_audio_path")
    audio_path = sys.argv[1]
    if not os.path.exists(audio_path):
        return fail("audio_not_found")

    model_name = os.environ.get("FLOWBOT_TRANSCRIBE_MODEL", "base").strip() or "base"
    language = os.environ.get("FLOWBOT_TRANSCRIBE_LANGUAGE", "zh").strip() or None
    device = os.environ.get("FLOWBOT_TRANSCRIBE_DEVICE", "cpu").strip() or "cpu"
    compute_type = os.environ.get("FLOWBOT_TRANSCRIBE_COMPUTE_TYPE", "int8").strip() or "int8"

    try:
        from faster_whisper import WhisperModel
    except Exception as exc:
        return fail(f"missing_dependency:{exc}", 2)

    try:
        model = WhisperModel(model_name, device=device, compute_type=compute_type)
        segments, info = model.transcribe(
            audio_path,
            language=language,
            vad_filter=True,
            condition_on_previous_text=False,
            beam_size=5,
        )
        text = "".join((segment.text or "") for segment in segments).strip()
        payload = {
            "ok": True,
            "text": text,
            "language": getattr(info, "language", "") or "",
            "duration_seconds": float(getattr(info, "duration", 0.0) or 0.0),
            "model": model_name,
            "device": device,
            "compute_type": compute_type,
        }
        print(json.dumps(payload, ensure_ascii=False))
        return 0
    except Exception as exc:
        return fail(f"transcribe_runtime_error:{exc}")


if __name__ == "__main__":
    sys.exit(main())
