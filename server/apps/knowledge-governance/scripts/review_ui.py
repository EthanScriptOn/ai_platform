from pathlib import Path


def load_root_html():
    return Path(__file__).with_name("review_ui.html").read_text(encoding="utf-8")
