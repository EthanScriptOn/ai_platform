from pathlib import Path
import os

from tiktok_res_app import services


ROOT = Path(__file__).resolve().parents[1]
services.configure_runtime(
    Path(os.getenv("CONTENT_ASSET_CONFIG_PATH", str(ROOT / "config.local.yml")))
)

from tiktok_res_app.app import app  # noqa: E402,F401
