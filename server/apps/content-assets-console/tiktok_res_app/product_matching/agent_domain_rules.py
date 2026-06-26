from __future__ import annotations

import re
from typing import Any, Dict, List, Optional


class ProductMatchDomainRulesMixin:
    @classmethod
    def _strip_promotion_phrases(cls, text: str) -> str:
        value = str(text or "").strip()
        if not value:
            return ""
        for phrase in cls._PROMOTION_PHRASES:
            value = value.replace(phrase, " ")
        value = re.sub(r"\b(?:拍\d+发\d+)\b", " ", value)
        value = re.sub(r"\s+", " ", value).strip()
        return value

    @classmethod
    def _is_fishing_bait_product(cls, text: str) -> bool:
        value = str(text or "").strip()
        if not value:
            return False
        matched = sum(1 for keyword in cls._FISHING_BAIT_KEYWORDS if keyword in value)
        return matched >= 2 or ("钓鱼" in value and ("鲫" in value or "鲤" in value or "草" in value))

    @classmethod
    def _fishing_species_tags(cls, text: str) -> List[str]:
        value = str(text or "")
        tags = set()
        for word, tag in cls._FISHING_SPECIES_WORDS.items():
            if word in value:
                tags.add(tag)
        for cluster in re.findall(r"[鲫鲤草鳊青]{2,}", value):
            tags.update(cluster)
        return sorted(tags)

    def _build_fishing_query_variants(self, title: str) -> List[str]:
        if not self._is_fishing_bait_product(title):
            return []

        cleaned = self._strip_promotion_phrases(title)
        tokens = [item for item in re.split(r"\s+", cleaned) if item]
        if len(tokens) >= 2 and len(tokens[0]) <= 2:
            cleaned = " ".join(tokens[1:]).strip()

        variants = [cleaned] if cleaned and cleaned != title else []
        variants.extend(["钓鱼打窝饵料", "钓鱼窝料"])

        species = self._fishing_species_tags(cleaned or title)
        if species:
            species_text = "".join(species)
            variants.append(f"{species_text} 饵料")
            variants.append(f"打窝饵料 {species_text}")

        if "四季" in title:
            variants.append("四季钓鱼打窝饵料")

        return [value for value in variants if value]

    @classmethod
    def _looks_like_paper_product(cls, text: str) -> bool:
        value = str(text or "").strip()
        if not value:
            return False
        return any(keyword in value for keyword in cls._PAPER_CATEGORY_KEYWORDS)

    @classmethod
    def _extract_paper_brand(cls, text: str) -> str:
        content = str(text or "").strip()
        if not cls._looks_like_paper_product(content):
            return ""
        match = re.match(
            r"([\u4e00-\u9fff]{2,6}?)(?:原木|有芯|无芯|本色|金装|卷纸|抽纸|纸巾|卫生纸|厕纸|面巾纸|厨房纸|手帕纸|湿巾)",
            content,
        )
        if not match:
            return ""
        value = match.group(1).strip()
        if 2 <= len(value) <= 6:
            return value
        return ""

    @classmethod
    def _extract_paper_specs(cls, text: str) -> Dict[str, Any]:
        content = str(text or "")
        if not cls._looks_like_paper_product(content):
            return {}

        normalized = content.lower().replace("×", "*")
        counts: List[Dict[str, Any]] = []
        for match in re.finditer(r"(\d+)\s*(卷|抽|包|张|片)", normalized):
            try:
                value = int(match.group(1))
            except ValueError:
                continue
            counts.append(
                {
                    "value": value,
                    "unit": match.group(2),
                    "start": match.start(),
                }
            )

        weights: List[float] = []
        for match in re.finditer(r"(\d+(?:\.\d+)?)\s*(?:g|克)", normalized):
            try:
                weights.append(float(match.group(1)))
            except ValueError:
                continue

        layers: List[int] = []
        for match in re.finditer(r"(\d+)\s*层", normalized):
            try:
                layers.append(int(match.group(1)))
            except ValueError:
                continue

        pack_count = None
        pack_unit = ""
        if counts:
            preferred = sorted(
                counts,
                key=lambda item: (
                    cls._PAPER_PACK_UNITS.index(item["unit"])
                    if item["unit"] in cls._PAPER_PACK_UNITS
                    else len(cls._PAPER_PACK_UNITS),
                    -item["value"],
                    item["start"],
                ),
            )
            pack_count = int(preferred[0]["value"])
            pack_unit = str(preferred[0]["unit"])

        return {
            "pack_count": pack_count,
            "pack_unit": pack_unit,
            "weight_g": max(weights) if weights else None,
            "layer_count": max(layers) if layers else None,
            "is_case": any(word in normalized for word in ("整箱", "箱装", "整件", "整提", "家庭装")),
        }

    def _spec_score(self, source_product: Dict[str, Any], item: Dict[str, Any]) -> Optional[float]:
        source_text = str(source_product.get("title") or "")
        candidate_text = self._candidate_context_text(item)
        source_spec = self._extract_paper_specs(source_text)
        if not source_spec:
            return None

        candidate_spec = self._extract_paper_specs(candidate_text)
        if not candidate_spec:
            return -0.08 if self._looks_like_paper_product(candidate_text) else -0.18

        score = 0.0
        compared = 0

        source_count = source_spec.get("pack_count")
        candidate_count = candidate_spec.get("pack_count")
        source_unit = source_spec.get("pack_unit")
        candidate_unit = candidate_spec.get("pack_unit")
        if source_count and candidate_count:
            compared += 1
            if source_unit and candidate_unit and source_unit != candidate_unit:
                score -= 0.45
            else:
                ratio = candidate_count / max(source_count, 1)
                if candidate_count == source_count:
                    score += 0.42
                elif 0.85 <= ratio <= 1.18:
                    score -= 0.14
                elif ratio <= 0.35 or ratio >= 2.8:
                    score -= 0.7
                elif ratio <= 0.55 or ratio >= 2.0:
                    score -= 0.42
                else:
                    score -= 0.24
            if source_spec.get("is_case") and candidate_count < source_count:
                score -= 0.12
            if source_spec.get("is_case") and candidate_spec.get("is_case") and candidate_count == source_count:
                score += 0.06

        source_layers = source_spec.get("layer_count")
        candidate_layers = candidate_spec.get("layer_count")
        if source_layers and candidate_layers:
            compared += 1
            score += 0.08 if source_layers == candidate_layers else -0.12

        source_weight = source_spec.get("weight_g")
        candidate_weight = candidate_spec.get("weight_g")
        if source_weight and candidate_weight:
            compared += 1
            diff_ratio = abs(candidate_weight - source_weight) / max(source_weight, 1.0)
            if diff_ratio <= 0.08:
                score += 0.08
            elif diff_ratio <= 0.2:
                score += 0.03
            else:
                score -= 0.18

        if compared == 0:
            return -0.06
        return score

    def _has_strong_spec_conflict(self, source_product: Dict[str, Any], item: Dict[str, Any]) -> bool:
        source_spec = self._extract_paper_specs(str(source_product.get("title") or ""))
        if not source_spec:
            return False

        candidate_spec = self._extract_paper_specs(self._candidate_context_text(item))
        if not candidate_spec:
            return False

        source_count = source_spec.get("pack_count")
        candidate_count = candidate_spec.get("pack_count")
        source_unit = source_spec.get("pack_unit")
        candidate_unit = candidate_spec.get("pack_unit")

        if source_count and candidate_count:
            if source_unit and candidate_unit and source_unit != candidate_unit:
                return True
            ratio = candidate_count / max(source_count, 1)
            if source_spec.get("is_case") and candidate_count < source_count * 0.75:
                return True
            if source_count >= 8 and ratio <= 0.35:
                return True
            if ratio >= 3.5:
                return True

        return False

    def _score_ceiling_penalty(
        self,
        source_product: Dict[str, Any],
        item: Dict[str, Any],
        current_score: float,
    ) -> float:
        if current_score < 0.95:
            return 0.0

        source_spec = self._extract_paper_specs(str(source_product.get("title") or ""))
        if not source_spec:
            return 0.0

        candidate_spec = self._extract_paper_specs(self._candidate_context_text(item))
        if not candidate_spec:
            return 0.0

        penalty = 0.0

        source_count = source_spec.get("pack_count")
        candidate_count = candidate_spec.get("pack_count")
        if source_count and candidate_count and source_count != candidate_count:
            ratio = abs(candidate_count - source_count) / max(source_count, 1)
            penalty += 0.06 if ratio > 0.2 else 0.03

        source_weight = source_spec.get("weight_g")
        candidate_weight = candidate_spec.get("weight_g")
        if source_weight and candidate_weight:
            diff_ratio = abs(candidate_weight - source_weight) / max(source_weight, 1.0)
            if diff_ratio > 0.2:
                penalty += 0.05
            elif diff_ratio > 0.08:
                penalty += 0.03

        source_layers = source_spec.get("layer_count")
        candidate_layers = candidate_spec.get("layer_count")
        if source_layers and candidate_layers and source_layers != candidate_layers:
            penalty += 0.02

        return min(penalty, 0.12)

    def _fishing_score(self, source_product: Dict[str, Any], item: Dict[str, Any]) -> Optional[float]:
        source_text = str(source_product.get("title") or "")
        candidate_text = self._candidate_context_text(item)
        if not self._is_fishing_bait_product(source_text):
            return None

        source_clean = self._strip_promotion_phrases(source_text)
        candidate_clean = self._strip_promotion_phrases(candidate_text)
        source_keywords = {word for word in self._FISHING_BAIT_KEYWORDS if word in source_clean}
        candidate_keywords = {word for word in self._FISHING_BAIT_KEYWORDS if word in candidate_clean}
        source_species = set(self._fishing_species_tags(source_clean))
        candidate_species = set(self._fishing_species_tags(candidate_clean))

        score = 0.0
        if source_keywords:
            overlap = len(source_keywords & candidate_keywords) / max(len(source_keywords), 1)
            score += overlap * 0.12
        if source_species:
            overlap = len(source_species & candidate_species) / max(len(source_species), 1)
            score += overlap * 0.16
        if {"钓鱼", "饵料"} & source_keywords and {"钓鱼", "饵料"} & candidate_keywords:
            score += 0.04
        if ("打窝" in source_keywords or "窝料" in source_keywords) and (
            "打窝" in candidate_keywords or "窝料" in candidate_keywords
        ):
            score += 0.04
        return score if score > 0 else None


    def _spec_reason(self, source_product: Dict[str, Any], item: Dict[str, Any]) -> str:
        source_spec = self._extract_paper_specs(str(source_product.get("title") or ""))
        if not source_spec:
            return ""

        candidate_spec = self._extract_paper_specs(self._candidate_context_text(item))
        if not candidate_spec:
            return ""

        bits: List[str] = []
        source_count = source_spec.get("pack_count")
        candidate_count = candidate_spec.get("pack_count")
        if source_count and candidate_count and source_count == candidate_count:
            bits.append(f"{candidate_count}{candidate_spec.get('pack_unit') or ''}")

        source_layers = source_spec.get("layer_count")
        candidate_layers = candidate_spec.get("layer_count")
        if source_layers and candidate_layers and source_layers == candidate_layers:
            bits.append(f"{candidate_layers}层")

        source_weight = source_spec.get("weight_g")
        candidate_weight = candidate_spec.get("weight_g")
        if source_weight and candidate_weight:
            diff_ratio = abs(candidate_weight - source_weight) / max(source_weight, 1.0)
            if diff_ratio <= 0.08:
                weight_text = int(candidate_weight) if float(candidate_weight).is_integer() else candidate_weight
                bits.append(f"{weight_text}g")

        if not bits:
            return ""
        return f"规格接近（{'/'.join(str(bit) for bit in bits[:3])}）"


