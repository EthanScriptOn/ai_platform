from __future__ import annotations

from typing import Any, Dict, List, Optional, Protocol

from .douyin_buyin import build_douyin_buyin_client
from .jd_union import build_jd_union_client
from .normalizer import normalize_douyin_product
from .agent_scoring import ProductMatchScoringMixin
from .schemas import CandidateProduct, MatchConditions, MatchRequest, ProductMatchResult
from .taobao_union import build_taobao_union_client


class ProductCatalogClient(Protocol):
    async def search_products(
        self,
        product: Dict[str, Any],
        conditions: MatchConditions,
    ) -> List[Dict[str, Any]]:
        ...


class ProductMatchAgent(ProductMatchScoringMixin):
    platform_result_limit = 3
    _PROMOTION_PHRASES = (
        "拍一发二",
        "拍1发2",
        "拍二发四",
        "拍2发4",
        "拍一发三",
        "拍1发3",
        "直播间",
        "专拍",
        "必备",
        "福利款",
        "福利",
        "同款",
        "轻松钓",
        "四季可用",
    )
    _PAPER_CATEGORY_KEYWORDS = (
        "卷纸",
        "抽纸",
        "纸巾",
        "卫生纸",
        "厕纸",
        "面巾纸",
        "厨房纸",
        "手帕纸",
        "湿巾",
    )
    _PAPER_PACK_UNITS = ("卷", "抽", "包", "张", "片")
    _FISHING_BAIT_KEYWORDS = (
        "钓鱼",
        "垂钓",
        "鱼饵",
        "饵料",
        "窝料",
        "打窝",
        "酒米",
        "野钓",
        "黑坑",
    )
    _FISHING_SPECIES_WORDS = {
        "鲫鱼": "鲫",
        "鲤鱼": "鲤",
        "草鱼": "草",
        "鳊鱼": "鳊",
        "青鱼": "青",
        "罗非": "罗非",
        "翘嘴": "翘嘴",
    }

    def __init__(
        self,
        config: Optional[Any] = None,
        catalog_client: Optional[ProductCatalogClient] = None,
        catalog_clients: Optional[Dict[str, ProductCatalogClient]] = None,
    ) -> None:
        self.config = getattr(config, "config", config) or {}
        if catalog_clients:
            self.catalog_clients = {
                self._normalize_platform_name(name): client
                for name, client in catalog_clients.items()
            }
        elif catalog_client is not None:
            provider_name = self._normalize_platform_name(
                str(getattr(catalog_client, "provider_name", "jd") or "jd").strip()
            )
            self.catalog_clients = {provider_name: catalog_client}
        else:
            self.catalog_clients = self._build_catalog_clients(self.config)
        self.available_platforms = list(dict.fromkeys(self.catalog_clients.keys()))

    async def run(self, request: MatchRequest) -> Dict[str, Any]:
        selected_platforms = self._normalize_selected_platforms(request.platforms)
        normalized_products = [
            normalize_douyin_product(item)
            for item in request.products
            if isinstance(item, dict) and (item.get("title") or item.get("product_id"))
        ]

        results: List[ProductMatchResult] = []
        for product in normalized_products:
            source_product = product.model_dump()
            all_candidates: List[CandidateProduct] = []
            tool_calls: List[Dict[str, Any]] = []
            queried_platforms: List[str] = []
            unsupported_platforms: List[str] = []
            platform_errors: List[str] = []
            total_raw_count = 0

            for platform in selected_platforms:
                client = self.catalog_clients.get(platform)
                if client is None:
                    unsupported_platforms.append(platform)
                    continue

                platform_label = self._platform_label(platform, client)
                try:
                    platform_search = await self._search_platform_candidates(
                        client=client,
                        source_product=source_product,
                        conditions=request.conditions,
                    )
                    raw_candidates = platform_search["items"]
                except Exception as exc:
                    error_message = str(exc)
                    platform_errors.append(f"{platform_label}：{error_message}")
                    tool_calls.append(
                        {
                            "name": getattr(client, "tool_name", "product_catalog.search_products"),
                            "platform": platform,
                            "platform_label": platform_label,
                            "args": {
                                "source_product": source_product,
                                "conditions": request.conditions.model_dump(),
                            },
                            "result_count": 0,
                            "query_variants": self._build_query_keyword_variants(source_product),
                            "error": error_message,
                        }
                    )
                    continue

                total_raw_count += len(raw_candidates)
                queried_platforms.append(platform)
                all_candidates.extend(
                    self._rank_candidates(
                        raw_candidates,
                        source_product,
                        request.conditions,
                        platform,
                        platform_label,
                    )
                )
                tool_calls.append(
                    {
                        "name": getattr(client, "tool_name", "product_catalog.search_products"),
                        "platform": platform,
                        "platform_label": platform_label,
                        "args": {
                            "source_product": source_product,
                            "conditions": request.conditions.model_dump(),
                        },
                        "result_count": len(raw_candidates),
                        "query_variants": platform_search["query_variants"],
                        "query_details": platform_search["query_details"],
                    }
                )

            if not queried_platforms:
                if platform_errors:
                    raise RuntimeError(f"所选平台当前都查询失败：{'；'.join(platform_errors)}")
                unsupported = "、".join(self._platform_label(name) for name in unsupported_platforms)
                raise RuntimeError(f"所选平台暂未接入：{unsupported or '未知平台'}")

            candidates = sorted(all_candidates, key=lambda item: item.score, reverse=True)
            min_score = self._min_candidate_score(source_product, request.conditions)
            candidates = [item for item in candidates if item.score >= min_score][: request.conditions.limit_per_product]
            notes = self._build_notes(
                request.conditions,
                total_raw_count,
                queried_platforms,
                unsupported_platforms,
                platform_errors,
                bool(candidates),
            )
            results.append(
                ProductMatchResult(
                    source_product=product,
                    status="matched" if candidates else "no_match",
                    queried_platforms=queried_platforms,
                    unsupported_platforms=unsupported_platforms,
                    candidates=candidates,
                    agent_notes=notes,
                    tool_calls=tool_calls,
                )
            )

        return {
            "source": request.source,
            "platforms_requested": selected_platforms,
            "platforms_queried": [
                self._platform_label(name) for name in selected_platforms if name in self.catalog_clients
            ],
            "conditions": request.conditions.model_dump(),
            "product_count": len(normalized_products),
            "matched_count": sum(1 for item in results if item.candidates),
            "status": "completed",
            "results": [item.model_dump() for item in results],
            "agent": {
                "name": "跨平台商品匹配智能体",
                "mode": "multi_platform_router",
                "catalog_api": "ready",
                "available_platforms": self.available_platforms,
            },
        }

    async def _search_platform_candidates(
        self,
        *,
        client: ProductCatalogClient,
        source_product: Dict[str, Any],
        conditions: MatchConditions,
    ) -> Dict[str, Any]:
        query_variants = self._build_query_keyword_variants(source_product)
        seen: Dict[str, Dict[str, Any]] = {}
        query_details: List[Dict[str, Any]] = []
        errors: List[str] = []

        for keyword in query_variants:
            query_product = dict(source_product)
            query_product["title"] = keyword
            try:
                items = await client.search_products(query_product, conditions)
            except Exception as exc:
                errors.append(f"{keyword}: {exc}")
                query_details.append(
                    {
                        "keyword": keyword,
                        "result_count": 0,
                        "error": str(exc),
                    }
                )
                continue

            query_details.append({"keyword": keyword, "result_count": len(items)})
            for item in items:
                key = self._candidate_identity(item)
                if key not in seen:
                    seen[key] = item

        if not seen and errors:
            raise RuntimeError("；".join(errors))

        return {
            "items": list(seen.values()),
            "query_variants": query_variants,
            "query_details": query_details,
        }

    def _build_catalog_clients(self, config: Dict[str, Any]) -> Dict[str, ProductCatalogClient]:
        provider = str((config.get("product_matching") or {}).get("provider") or "").strip().lower()
        if provider in {"", "auto", "multi_platform", "multi", "all"}:
            clients: Dict[str, ProductCatalogClient] = {}
            douyin_config = config.get("douyin_buyin") or {}
            jd_config = config.get("jd_union") or {}
            taobao_config = config.get("taobao_union") or {}
            if self._has_required_values(douyin_config, ("app_key", "app_secret", "access_token")):
                clients["douyin"] = build_douyin_buyin_client(config)
            if self._has_required_values(jd_config, ("app_key", "app_secret")):
                clients["jd"] = build_jd_union_client(config)
            if self._has_required_values(taobao_config, ("app_key", "app_secret")) and (
                self._has_value((taobao_config.get("pid")))
                or self._has_value((taobao_config.get("adzone_id")))
            ):
                clients["taobao"] = build_taobao_union_client(config)
            if clients:
                return clients
            raise RuntimeError(
                "未找到可用的商品匹配平台配置，请检查 douyin_buyin、jd_union 或 taobao_union 配置项"
            )
        if provider in {"douyin_buyin", "douyin"}:
            return {"douyin": build_douyin_buyin_client(config)}
        if provider in {"jd_union", "jd"}:
            return {"jd": build_jd_union_client(config)}
        if provider in {"taobao_union", "taobao"}:
            return {"taobao": build_taobao_union_client(config)}
        if not provider:
            raise RuntimeError("未配置商品匹配 provider，请在 config.yml 中设置 product_matching.provider")
        raise RuntimeError(f"暂不支持的商品匹配 provider：{provider}")

    @staticmethod
    def _has_required_values(config: Dict[str, Any], fields: tuple[str, ...]) -> bool:
        return all(ProductMatchAgent._has_value(config.get(field)) for field in fields)

    @staticmethod
    def _has_value(value: Any) -> bool:
        return str(value or "").strip() != ""

    def _normalize_selected_platforms(self, platforms: List[str]) -> List[str]:
        values = [self._normalize_platform_name(str(item or "").strip().lower()) for item in (platforms or [])]
        normalized = [item for item in values if item]
        if not normalized:
            normalized = list(self.available_platforms)
        deduped = list(dict.fromkeys(normalized))
        if not deduped:
            raise RuntimeError("至少选择一个匹配平台")
        return deduped

    @staticmethod
    def _normalize_platform_name(value: str) -> str:
        mapping = {
            "douyin_buyin": "douyin",
            "douyin": "douyin",
            "jd_union": "jd",
            "jd": "jd",
            "taobao_union": "taobao",
            "taobao": "taobao",
            "meituan_union": "meituan",
            "meituan": "meituan",
        }
        return mapping.get(str(value or "").strip().lower(), str(value or "").strip().lower())

    def _rank_candidates(
        self,
        raw_candidates: List[Dict[str, Any]],
        source_product: Dict[str, Any],
        conditions: MatchConditions,
        platform: str,
        platform_label: str,
    ) -> List[CandidateProduct]:
        candidates: List[CandidateProduct] = []
        for item in raw_candidates:
            if not isinstance(item, dict):
                continue
            if self._has_strong_spec_conflict(source_product, item):
                continue
            score = self._score_candidate(source_product, item, conditions)
            raw = item.get("raw") if isinstance(item.get("raw"), dict) else item
            candidates.append(
                CandidateProduct(
                    product_id=str(item.get("product_id") or item.get("id") or ""),
                    title=str(item.get("title") or item.get("name") or ""),
                    platform=str(item.get("platform") or platform),
                    platform_label=str(item.get("platform_label") or platform_label),
                    price_yuan=self._as_float(item.get("price_yuan") or item.get("price")),
                    image=str(item.get("image") or item.get("cover") or ""),
                    brand_name=str(item.get("brand_name") or ""),
                    category_name=self._candidate_category_name(item),
                    comments_count=self._as_float(item.get("comments_count") or item.get("comments")),
                    good_comments_share=self._as_float(item.get("good_comments_share")),
                    sales_count=self._as_float(
                        item.get("sales_count") or item.get("in_order_count_30_days_sku")
                    ),
                    sales_label=str(item.get("sales_label") or self._sales_label(platform)),
                    score=score,
                    confidence=score,
                    confidence_label=self._confidence_label(score),
                    match_type=self._match_type(score),
                    match_reason=str(
                        item.get("match_reason")
                        or self._reason_for(source_product, item, score, conditions)
                    ),
                    detail_url=str(item.get("detail_url") or ""),
                    shop_name=str(item.get("shop_name") or ""),
                    raw=raw,
                )
            )
        candidates.sort(key=lambda item: item.score, reverse=True)
        return candidates[: self.platform_result_limit]

    def _build_notes(
        self,
        conditions: MatchConditions,
        total_raw_count: int,
        queried_platforms: List[str],
        unsupported_platforms: List[str],
        platform_errors: List[str],
        has_candidates: bool,
    ) -> List[str]:
        notes = []
        platform_labels = "、".join(self._platform_label(name) for name in queried_platforms)
        if platform_labels:
            notes.append(f"第一版按商品名向 {platform_labels} 查询。")
        if conditions.same_product:
            notes.append("优先查找同一个商品。")
        if conditions.similar_product:
            notes.append("同时保留相似商品候选。")
        if conditions.same_category:
            notes.append("限定或优先同类型商品。")
        if conditions.price_float_percent is not None:
            notes.append(f"价格浮动控制在正负 {conditions.price_float_percent:g}% 附近。")
        if conditions.best_reviewed:
            notes.append("候选结果优先考虑好评表现。")
        if unsupported_platforms:
            notes.append(
                f"暂未接入平台：{'、'.join(self._platform_label(name) for name in unsupported_platforms)}。"
            )
        if platform_errors:
            notes.append(f"查询失败平台：{'；'.join(platform_errors)}。")
        if total_raw_count and has_candidates:
            notes.append(f"每个平台最终只展示前 {self.platform_result_limit} 个候选，当前共重排了 {total_raw_count} 个结果。")
            if conditions.price_float_percent is None:
                notes.append("这次没有填写价格浮动，所以价格不参与过滤和排序。")
        else:
            notes.append("当前选中平台没有返回符合条件的商品候选。")
        return notes
