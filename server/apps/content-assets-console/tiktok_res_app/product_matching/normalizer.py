from __future__ import annotations

import re
from typing import Any, Dict, Optional

from .schemas import NormalizedProduct


def _clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _first_price(product: Dict[str, Any]) -> Optional[float]:
    for key in ("show_price_yuan", "min_price_yuan", "price_yuan"):
        value = product.get(key)
        if value in (None, ""):
            continue
        try:
            return float(value)
        except (TypeError, ValueError):
            continue
    return None


def normalize_douyin_product(product: Dict[str, Any]) -> NormalizedProduct:
    raw = product if isinstance(product, dict) else {}
    return NormalizedProduct(
        source="douyin",
        source_product_id=_clean_text(raw.get("product_id")),
        promotion_id=_clean_text(raw.get("promotion_id")),
        title=_clean_text(raw.get("title")),
        category=raw.get("category"),
        cover=_clean_text(raw.get("cover")),
        detail_url=_clean_text(raw.get("detail_url")),
        price_yuan=_first_price(raw),
        raw=raw,
    )

