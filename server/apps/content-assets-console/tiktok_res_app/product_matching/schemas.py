from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class MatchConditions(BaseModel):
    same_product: bool = True
    similar_product: bool = True
    same_category: bool = False
    price_float_percent: Optional[float] = Field(None, ge=0, le=100)
    best_reviewed: bool = False
    limit_per_product: int = Field(3, ge=1, le=3)


class MatchRequest(BaseModel):
    products: List[Dict[str, Any]] = Field(default_factory=list)
    platforms: List[str] = Field(default_factory=lambda: ["jd"])
    conditions: MatchConditions = Field(default_factory=MatchConditions)
    source: str = "douyin_live"


class NormalizedProduct(BaseModel):
    source: str = "douyin"
    source_product_id: str = ""
    promotion_id: str = ""
    title: str = ""
    category: Any = None
    cover: str = ""
    detail_url: str = ""
    price_yuan: Optional[float] = None
    raw: Dict[str, Any] = Field(default_factory=dict)


class CandidateProduct(BaseModel):
    product_id: str = ""
    title: str = ""
    platform: str = ""
    platform_label: str = ""
    price_yuan: Optional[float] = None
    image: str = ""
    brand_name: str = ""
    category_name: str = ""
    comments_count: Optional[float] = None
    good_comments_share: Optional[float] = None
    sales_count: Optional[float] = None
    sales_label: str = ""
    score: float = 0
    confidence: float = 0
    confidence_label: str = ""
    match_type: str = "候选"
    match_reason: str = ""
    detail_url: str = ""
    shop_name: str = ""
    raw: Dict[str, Any] = Field(default_factory=dict)


class ProductMatchResult(BaseModel):
    source_product: NormalizedProduct
    status: str
    queried_platforms: List[str] = Field(default_factory=list)
    unsupported_platforms: List[str] = Field(default_factory=list)
    candidates: List[CandidateProduct] = Field(default_factory=list)
    agent_notes: List[str] = Field(default_factory=list)
    tool_calls: List[Dict[str, Any]] = Field(default_factory=list)
