from __future__ import annotations

import re
from difflib import SequenceMatcher
from typing import Any, Dict, List, Optional

from .agent_domain_rules import ProductMatchDomainRulesMixin
from .schemas import CandidateProduct, MatchConditions


class ProductMatchScoringMixin(ProductMatchDomainRulesMixin):
    def _score_candidate(
        self,
        source_product: Dict[str, Any],
        item: Dict[str, Any],
        conditions: MatchConditions,
    ) -> float:
        source_title = str(source_product.get("title") or "")
        candidate_title = str(item.get("title") or item.get("name") or "")
        title_score = self._title_similarity(source_title, candidate_title)

        source_price = self._as_float(source_product.get("price_yuan"))
        candidate_price = self._as_float(item.get("price_yuan") or item.get("price"))
        use_price = conditions.price_float_percent is not None
        price_score = self._price_similarity(source_price, candidate_price, conditions.price_float_percent)

        review_score = self._review_score(item)
        popularity_score = self._popularity_score(item)

        if conditions.best_reviewed:
            if use_price:
                score = title_score * 0.48 + price_score * 0.12 + review_score * 0.3 + popularity_score * 0.1
            else:
                score = title_score * 0.6 + review_score * 0.3 + popularity_score * 0.1
        else:
            if use_price:
                score = title_score * 0.6 + price_score * 0.18 + review_score * 0.12 + popularity_score * 0.1
            else:
                score = title_score * 0.82 + review_score * 0.1 + popularity_score * 0.08

        if conditions.same_product and title_score >= 0.9:
            score += 0.06

        brand_score = self._brand_score(source_product, item)
        if brand_score is not None:
            score += brand_score * 0.22

        model_score = self._model_score(source_product, item)
        if model_score is not None:
            score += model_score * 0.1

        category_score = self._category_score(source_product, item)
        if conditions.same_category or self._extract_category_keywords(str(source_product.get("title") or "")):
            score += category_score * 0.08

        spec_score = self._spec_score(source_product, item)
        if spec_score is not None:
            score += spec_score
        fishing_score = self._fishing_score(source_product, item)
        if fishing_score is not None:
            score += fishing_score

        external_score = self._external_score(item)
        if external_score is not None:
            score = max(score, external_score)

        score = max(0.0, min(score, 0.999))
        ceiling_penalty = self._score_ceiling_penalty(source_product, item, score)
        if ceiling_penalty > 0:
            score = max(0.0, score - ceiling_penalty)
        return round(score, 4)

    @staticmethod
    def _candidate_identity(item: Dict[str, Any]) -> str:
        return str(
            item.get("product_id")
            or item.get("item_id")
            or item.get("sku_id")
            or item.get("id")
            or item.get("title")
            or ""
        ).strip()

    @staticmethod
    def _extract_brand(source_title: str) -> str:
        title = str(source_title or "").strip()
        if not title:
            return ""
        bracket = re.search(r"【([^】]+)】", title)
        if bracket:
            return bracket.group(1).strip()
        leading = re.match(r"([A-Za-z][A-Za-z0-9\\-]{2,})", title)
        if leading:
            return leading.group(1).strip()
        paper_brand = ProductMatchScoringMixin._extract_paper_brand(title)
        if paper_brand:
            return paper_brand
        return ""

    @staticmethod
    def _extract_model_tokens(source_title: str) -> List[str]:
        title = str(source_title or "").strip()
        if not title:
            return []
        tokens = set()
        for token in re.findall(r"[A-Za-z]+\\d+(?:\\.\\d+)?|\\d+\\.\\d+|[A-Za-z]{1,3}\\d{1,3}", title):
            token = token.strip().lower()
            if len(token) >= 2:
                tokens.add(token)
        return sorted(tokens)

    @staticmethod
    def _extract_category_keywords(source_title: str) -> List[str]:
        title = str(source_title or "").strip()
        if not title:
            return []
        keywords = []
        for word in (
            "跑步鞋",
            "慢跑鞋",
            "运动鞋",
            "休闲鞋",
            "徒步鞋",
            "户外",
            "卷纸",
            "抽纸",
            "纸巾",
            "卫生纸",
            "厕纸",
            "面巾纸",
            "厨房纸",
            "手帕纸",
            "湿巾",
            "钓鱼",
            "垂钓",
            "鱼饵",
            "饵料",
            "窝料",
            "打窝",
            "野钓",
            "黑坑",
        ):
            if word in title:
                keywords.append(word)
        return keywords

    def _build_query_keyword_variants(self, source_product: Dict[str, Any]) -> List[str]:
        title = str(source_product.get("title") or "").strip()
        if not title:
            return []
        brand = self._extract_brand(title)
        model_tokens = self._extract_model_tokens(title)
        category_keywords = self._extract_category_keywords(title)
        paper_spec = self._extract_paper_specs(title)
        is_shoe_query = any(
            keyword in category_keywords
            for keyword in ("跑步鞋", "慢跑鞋", "运动鞋", "休闲鞋", "徒步鞋", "户外")
        )
        primary_category = (
            "跑步鞋"
            if "跑步鞋" in category_keywords
            else ("运动鞋" if "运动鞋" in category_keywords else (category_keywords[0] if category_keywords else "鞋"))
        )

        variants = [title]
        if brand:
            variants.append(f"{brand} {primary_category}")
            if is_shoe_query:
                variants.append(f"{brand} 运动鞋")
                variants.append(f"{brand} 慢跑鞋")
            if model_tokens and is_shoe_query:
                variants.append(f"{brand} {model_tokens[0]} {primary_category}")
        if model_tokens and is_shoe_query:
            variants.append(f"{model_tokens[0]} {primary_category}")
        if paper_spec:
            paper_category = next(
                (keyword for keyword in category_keywords if keyword in self._PAPER_CATEGORY_KEYWORDS),
                "卷纸",
            )
            if brand:
                variants.append(f"{brand} {paper_category}")
                if paper_spec.get("pack_count") and paper_spec.get("pack_unit"):
                    pack_text = f"{paper_spec['pack_count']}{paper_spec['pack_unit']}"
                    variants.append(f"{brand} {pack_text} {paper_category}")
                    variants.append(f"{brand} {paper_category} {pack_text}")
                    weight_value = paper_spec.get("weight_g")
                    if weight_value:
                        weight_text = int(weight_value) if float(weight_value).is_integer() else weight_value
                        variants.append(f"{brand} {weight_text}克 {pack_text} {paper_category}")
                if paper_spec.get("is_case"):
                    variants.append(f"{brand} 整箱 {paper_category}")
        fishing_variants = self._build_fishing_query_variants(title)
        variants.extend(fishing_variants)

        deduped: List[str] = []
        seen = set()
        for value in variants:
            clean = re.sub(r"\\s+", " ", str(value or "")).strip()
            if clean and clean not in seen:
                seen.add(clean)
                deduped.append(clean)
        return deduped

    def _brand_score(self, source_product: Dict[str, Any], item: Dict[str, Any]) -> Optional[float]:
        brand = self._extract_brand(str(source_product.get("title") or "")).lower()
        if not brand:
            return None
        candidate_text = self._candidate_context_text(item).lower()
        candidate_brand = str(item.get("brand_name") or "").strip().lower()
        if brand in candidate_text or (candidate_brand and brand == candidate_brand):
            return 1.0
        if candidate_brand and candidate_brand not in {"未知", "unknown"}:
            return -0.6
        return -0.25

    def _model_score(self, source_product: Dict[str, Any], item: Dict[str, Any]) -> Optional[float]:
        models = self._extract_model_tokens(str(source_product.get("title") or ""))
        if not models:
            return None
        candidate_text = self._candidate_context_text(item).lower()
        matched = sum(1 for model in models if model in candidate_text)
        if matched == 0:
            return -0.2
        return matched / len(models)

    def _candidate_context_text(self, item: Dict[str, Any]) -> str:
        parts = [
            str(item.get("title") or ""),
            str(item.get("name") or ""),
            str(item.get("brand_name") or ""),
            str(item.get("shop_name") or ""),
        ]
        raw = item.get("raw") if isinstance(item.get("raw"), dict) else {}
        category_info = raw.get("categoryInfo") if isinstance(raw.get("categoryInfo"), dict) else {}
        if isinstance(category_info, dict):
            parts.extend(
                [
                    str(category_info.get("cid1Name") or ""),
                    str(category_info.get("cid2Name") or ""),
                    str(category_info.get("cid3Name") or ""),
                ]
            )
        parts.append(str(raw.get("category_name") or ""))
        spec_info = raw.get("specInfo") if isinstance(raw.get("specInfo"), dict) else {}
        if isinstance(spec_info, dict):
            parts.extend(str(value or "") for value in spec_info.values() if value not in (None, ""))
        item_basic_info = raw.get("item_basic_info") if isinstance(raw.get("item_basic_info"), dict) else {}
        if isinstance(item_basic_info, dict):
            parts.extend(
                [
                    str(item_basic_info.get("title") or ""),
                    str(item_basic_info.get("short_title") or ""),
                ]
            )
        return " ".join(part for part in parts if part).strip()

    @staticmethod
    def _as_float(value: Any) -> Optional[float]:
        try:
            if value in (None, ""):
                return None
            return float(value)
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _match_type(score: float) -> str:
        if score >= 0.88:
            return "疑似同款"
        if score >= 0.62:
            return "相似商品"
        return "候选商品"

    @staticmethod
    def _confidence_label(score: float) -> str:
        if score >= 0.8:
            return "高可信"
        if score >= 0.5:
            return "中可信"
        return "低可信"

    def _reason_for(
        self,
        source_product: Dict[str, Any],
        item: Dict[str, Any],
        score: float,
        conditions: MatchConditions,
    ) -> str:
        reasons: List[str] = []
        title_score = self._title_similarity(
            str(source_product.get("title") or ""),
            str(item.get("title") or item.get("name") or ""),
        )
        if title_score >= 0.9:
            reasons.append("标题高度接近")
        elif title_score >= 0.72:
            reasons.append("标题相似度较高")

        spec_reason = self._spec_reason(source_product, item)
        if spec_reason:
            reasons.append(spec_reason)

        source_price = self._as_float(source_product.get("price_yuan"))
        candidate_price = self._as_float(item.get("price_yuan") or item.get("price"))
        if source_price and candidate_price:
            diff_ratio = abs(candidate_price - source_price) / max(source_price, 1.0)
            if diff_ratio <= 0.08:
                reasons.append("价格非常接近")
            elif diff_ratio <= 0.2:
                reasons.append("价格区间接近")

        review_share = self._as_float(item.get("good_comments_share"))
        if conditions.best_reviewed and review_share is not None:
            reasons.append(f"好评率 {review_share:g}%")

        order_count = self._as_float(item.get("in_order_count_30_days_sku"))
        if order_count:
            reasons.append(f"近30天引单 {int(order_count)}")

        if not reasons:
            if score >= 0.88 and conditions.same_product:
                return "标题、价格等信息高度接近。"
            if conditions.best_reviewed:
                return "综合相似度与好评表现排序。"
            return "按标题和价格接近程度排序。"
        return "，".join(reasons[:3]) + "。"

    @staticmethod
    def _title_similarity(source_title: str, candidate_title: str) -> float:
        source = re.sub(r"[^\w\u4e00-\u9fff]+", "", str(source_title or "").lower())
        candidate = re.sub(r"[^\w\u4e00-\u9fff]+", "", str(candidate_title or "").lower())
        if not source or not candidate:
            return 0.0
        if source == candidate:
            return 1.0

        ratio = SequenceMatcher(None, source, candidate).ratio()
        if len(source) >= 4 and source in candidate:
            ratio = max(ratio, 0.9)
        elif len(candidate) >= 4 and candidate in source:
            ratio = max(ratio, 0.9)

        source_bigrams = {source[index : index + 2] for index in range(max(len(source) - 1, 1))}
        candidate_bigrams = {
            candidate[index : index + 2] for index in range(max(len(candidate) - 1, 1))
        }
        if source_bigrams and candidate_bigrams:
            overlap = len(source_bigrams & candidate_bigrams) / len(source_bigrams)
            ratio = max(ratio, overlap)

        return ratio

    @staticmethod
    def _price_similarity(
        source_price: Optional[float],
        candidate_price: Optional[float],
        tolerance_percent: Optional[float],
    ) -> float:
        if tolerance_percent is None:
            return 0.5
        if source_price is None or candidate_price is None:
            return 0.5
        tolerance = max((tolerance_percent or 30.0) / 100.0, 0.05)
        diff_ratio = abs(candidate_price - source_price) / max(source_price, 1.0)
        return max(0.0, 1.0 - diff_ratio / tolerance)

    @staticmethod
    def _review_score(item: Dict[str, Any]) -> float:
        share = item.get("good_comments_share")
        share_value = ProductMatchScoringMixin._as_float(share)
        if share_value is None:
            return 0.5
        if share_value > 1:
            return max(0.0, min(share_value / 100.0, 1.0))
        return max(0.0, min(share_value, 1.0))

    @staticmethod
    def _popularity_score(item: Dict[str, Any]) -> float:
        count = ProductMatchScoringMixin._as_float(item.get("in_order_count_30_days_sku"))
        if count is None or count <= 0:
            return 0.0
        return min(count / 1000.0, 1.0)

    @staticmethod
    def _external_score(item: Dict[str, Any]) -> Optional[float]:
        for key in ("score", "similarity", "match_score"):
            value = ProductMatchScoringMixin._as_float(item.get(key))
            if value is None:
                continue
            return max(0.0, min(value if value <= 1 else value / 100.0, 1.0))
        return None

    @staticmethod
    def _category_score(source_product: Dict[str, Any], item: Dict[str, Any]) -> float:
        title_keywords = ProductMatchScoringMixin._extract_category_keywords(str(source_product.get("title") or ""))
        category_text = str(source_product.get("category") or "").strip()
        raw = item.get("raw") if isinstance(item.get("raw"), dict) else {}
        category_info = raw.get("categoryInfo") if isinstance(raw.get("categoryInfo"), dict) else {}
        candidate_text = " ".join(
            [
                str(category_info.get("cid1Name") or ""),
                str(category_info.get("cid2Name") or ""),
                str(category_info.get("cid3Name") or ""),
                str(raw.get("category_name") or ""),
                str(item.get("title") or ""),
            ]
        ).strip()
        if title_keywords:
            matched = sum(1 for keyword in title_keywords if keyword in candidate_text)
            if matched:
                return min(1.0, matched / max(1, len(title_keywords)))
            if any(word in candidate_text for word in ("跑步鞋", "运动鞋", "休闲鞋", "男士休闲鞋")):
                return 0.35
            return -0.35
        if category_text and candidate_text:
            if category_text in candidate_text or candidate_text in category_text:
                return 1.0
        return 0.0

    def _min_candidate_score(
        self,
        source_product: Dict[str, Any],
        conditions: MatchConditions,
    ) -> float:
        brand = self._extract_brand(str(source_product.get("title") or ""))
        if brand:
            return 0.45
        if conditions.same_product:
            return 0.4
        return 0.35

    def _platform_label(self, platform: str, client: Optional[ProductCatalogClient] = None) -> str:
        value = str(getattr(client, "platform_label", "") or "").strip()
        if value:
            return value
        mapping = {
            "douyin": "抖音",
            "jd": "京东",
            "taobao": "淘宝",
            "meituan": "美团",
        }
        return mapping.get(platform, platform.upper())

    @staticmethod
    def _candidate_category_name(item: Dict[str, Any]) -> str:
        direct = str(item.get("category_name") or "").strip()
        if direct:
            return direct
        raw = item.get("raw") if isinstance(item.get("raw"), dict) else {}
        category_info = raw.get("categoryInfo") if isinstance(raw.get("categoryInfo"), dict) else {}
        parts = [
            str(category_info.get("cid1Name") or "").strip(),
            str(category_info.get("cid2Name") or "").strip(),
            str(category_info.get("cid3Name") or "").strip(),
        ]
        parts = [part for part in parts if part]
        if parts:
            return " / ".join(parts)
        return str(raw.get("category_name") or "").strip()

    @staticmethod
    def _sales_label(platform: str) -> str:
        if platform == "jd":
            return "近30天引单"
        return "销量"
