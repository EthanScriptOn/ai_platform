from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime
from typing import Any, Dict, List, Optional

import aiohttp

from .schemas import MatchConditions


def _clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _as_float(value: Any) -> Optional[float]:
    try:
        if value in (None, ""):
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _ensure_list(value: Any) -> List[Any]:
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        for key in ("urlInfo", "image", "coupon", "couponList"):
            nested = value.get(key)
            if isinstance(nested, list):
                return nested
            if isinstance(nested, dict):
                return [nested]
    if value in (None, ""):
        return []
    return [value]


def _as_bool(value: Any, default: bool = True) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


class JdUnionCatalogClient:
    provider_name = "jd"
    platform_label = "京东"
    tool_name = "jd.union.open.goods.query"
    result_limit = 3

    def __init__(
        self,
        *,
        app_key: str,
        app_secret: str,
        access_token: str = "",
        server_url: str = "https://api.jd.com/routerjson",
        timeout_seconds: int = 20,
        page_size: int = 10,
        scene_id: int = 1,
        fields: str = "",
        verify_ssl: bool = True,
    ) -> None:
        self.app_key = _clean_text(app_key)
        self.app_secret = _clean_text(app_secret)
        self.access_token = _clean_text(access_token)
        self.server_url = _clean_text(server_url) or "https://api.jd.com/routerjson"
        self.timeout_seconds = max(1, int(timeout_seconds))
        self.page_size = max(1, min(int(page_size), 50))
        self.scene_id = int(scene_id)
        self.fields = _clean_text(fields)
        self.verify_ssl = _as_bool(verify_ssl)

        missing = []
        if not self.app_key:
            missing.append("jd_union.app_key")
        if not self.app_secret:
            missing.append("jd_union.app_secret")
        if missing:
            raise RuntimeError(f"京东联盟配置缺失：{', '.join(missing)}")

    async def search_products(
        self,
        product: Dict[str, Any],
        conditions: MatchConditions,
    ) -> List[Dict[str, Any]]:
        keyword = self._build_keyword(product)
        if not keyword:
            return []

        payload = self._build_payload(product, keyword, conditions)
        request_body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        params = self._build_sys_params(request_body)
        timeout = aiohttp.ClientTimeout(total=self.timeout_seconds)
        headers = {
            "User-Agent": "tiktok-res-jd-union",
            "Content-Type": "application/json; charset=UTF-8",
        }

        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(
                self.server_url,
                params=params,
                data=request_body.encode("utf-8"),
                headers=headers,
                ssl=self.verify_ssl,
            ) as response:
                body = await response.text()
                if response.status >= 400:
                    raise RuntimeError(
                        f"京东联盟请求失败：HTTP {response.status} {body[:240]}"
                    )

        items = self._parse_items(body)
        return [self._normalize_item(item) for item in items if isinstance(item, dict)]

    def _build_keyword(self, product: Dict[str, Any]) -> str:
        title = _clean_text(product.get("title"))
        if not title:
            return ""
        title = re.sub(r"[|丨｜]+", " ", title)
        title = re.sub(r"[【】\\[\\]（）()]", " ", title)
        title = re.sub(r"\s+", " ", title).strip()
        return title[:60]

    def _build_payload(
        self,
        product: Dict[str, Any],
        keyword: str,
        conditions: MatchConditions,
    ) -> Dict[str, Any]:
        goods_req: Dict[str, Any] = {
            "keyword": keyword,
            "pageIndex": 1,
            "pageSize": self.result_limit,
            "sceneId": self.scene_id,
        }
        if self.fields:
            goods_req["fields"] = self.fields

        source_price = _as_float(product.get("price_yuan"))
        if source_price and conditions.price_float_percent is not None:
            delta = max(0.0, conditions.price_float_percent) / 100.0
            goods_req["pricefrom"] = round(max(source_price * (1 - delta), 0.0), 2)
            goods_req["priceto"] = round(source_price * (1 + delta), 2)

        return {"goodsReqDTO": goods_req}

    def _build_sys_params(self, request_body: str) -> Dict[str, Any]:
        now = datetime.now().astimezone()
        timestamp = now.strftime("%Y-%m-%d %H:%M:%S") + ".000" + now.strftime("%z")
        params: Dict[str, Any] = {
            "app_key": self.app_key,
            "method": self.tool_name,
            "v": "1.0",
            "timestamp": timestamp,
            "360buy_param_json": request_body,
        }
        if self.access_token:
            params["access_token"] = self.access_token
        params["sign"] = self._sign(params)
        return params

    def _sign(self, params: Dict[str, Any]) -> str:
        chunks = [self.app_secret]
        for key, value in sorted(params.items()):
            text = str(value)
            if text.startswith("@"):
                continue
            chunks.append(f"{key}{text}")
        chunks.append(self.app_secret)
        return hashlib.md5("".join(chunks).encode("utf-8")).hexdigest().upper()

    def _parse_items(self, body: str) -> List[Dict[str, Any]]:
        try:
            payload = json.loads(body)
        except json.JSONDecodeError as exc:
            raise RuntimeError("京东联盟返回了无法解析的 JSON") from exc

        error_response = payload.get("error_response")
        if isinstance(error_response, dict):
            code = _clean_text(error_response.get("code")) or "unknown"
            message = _clean_text(error_response.get("zh_desc") or error_response.get("msg")) or "未知错误"
            raise RuntimeError(f"京东联盟商品查询失败：{code} {message}")

        wrapper = (
            payload.get("jd_union_open_goods_query_response")
            or payload.get("jd_union_open_goods_query_responce")
            or payload
        )
        if not isinstance(wrapper, dict):
            raise RuntimeError("京东联盟返回结构异常")

        query_result = wrapper.get("queryResult", wrapper)
        if isinstance(query_result, str):
            try:
                query_result = json.loads(query_result)
            except json.JSONDecodeError as exc:
                raise RuntimeError("京东联盟 queryResult 解析失败") from exc
        if not isinstance(query_result, dict):
            raise RuntimeError("京东联盟 queryResult 结构异常")

        code = int(str(query_result.get("code", "0") or "0"))
        if code != 200:
            message = _clean_text(query_result.get("message")) or "未知错误"
            if code in {403, 440}:
                message = f"{message}，请确认京东联盟接口权限是否已开通"
            raise RuntimeError(f"京东联盟商品查询失败：{code} {message}")

        data = query_result.get("data")
        if isinstance(data, list):
            return [item for item in data if isinstance(item, dict)]
        if isinstance(data, dict):
            nested = data.get("data")
            if isinstance(nested, list):
                return [item for item in nested if isinstance(item, dict)]
            if nested and isinstance(nested, dict):
                return [nested]
            if data.get("skuId") or data.get("itemId"):
                return [data]
        return []

    def _normalize_item(self, item: Dict[str, Any]) -> Dict[str, Any]:
        image_info = item.get("imageInfo") or {}
        image_list = _ensure_list(image_info.get("imageList"))
        category_info = item.get("categoryInfo") or {}
        first_image = ""
        for image in image_list:
            if not isinstance(image, dict):
                continue
            first_image = _clean_text(image.get("url"))
            if first_image:
                break
        if not first_image:
            first_image = _clean_text(image_info.get("whiteImage"))

        material_url = _clean_text(item.get("materialUrl"))
        if material_url and not material_url.startswith("http"):
            material_url = f"https://{material_url.lstrip('/')}"

        purchase_price_info = item.get("purchasePriceInfo") or {}
        price_info = item.get("priceInfo") or {}
        price_yuan = (
            _as_float(purchase_price_info.get("purchasePrice"))
            or _as_float(price_info.get("lowestCouponPrice"))
            or _as_float(price_info.get("lowestPrice"))
            or _as_float(price_info.get("price"))
        )
        category_name = " / ".join(
            part
            for part in (
                _clean_text(category_info.get("cid1Name")),
                _clean_text(category_info.get("cid2Name")),
                _clean_text(category_info.get("cid3Name")),
            )
            if part
        )

        return {
            "product_id": _clean_text(item.get("itemId") or item.get("skuId")),
            "sku_id": _clean_text(item.get("skuId")),
            "item_id": _clean_text(item.get("itemId")),
            "platform": self.provider_name,
            "platform_label": self.platform_label,
            "title": _clean_text(item.get("skuName")),
            "price_yuan": price_yuan,
            "image": first_image,
            "detail_url": material_url,
            "comments": _as_float(item.get("comments")),
            "comments_count": _as_float(item.get("comments")),
            "good_comments_share": _as_float(item.get("goodCommentsShare")),
            "in_order_count_30_days_sku": _as_float(
                item.get("inOrderCount30DaysSku") or item.get("inOrderCount30Days")
            ),
            "sales_count": _as_float(
                item.get("inOrderCount30DaysSku") or item.get("inOrderCount30Days")
            ),
            "sales_label": "近30天引单",
            "owner": _clean_text(item.get("owner")),
            "brand_name": _clean_text(item.get("brandName")),
            "category_name": category_name,
            "shop_name": _clean_text((item.get("shopInfo") or {}).get("shopName")),
            "raw": item,
        }


def build_jd_union_client(config: Any) -> JdUnionCatalogClient:
    config_data = getattr(config, "config", config) or {}
    jd_config = config_data.get("jd_union") or {}
    return JdUnionCatalogClient(
        app_key=str(jd_config.get("app_key") or ""),
        app_secret=str(jd_config.get("app_secret") or ""),
        access_token=str(jd_config.get("access_token") or ""),
        server_url=str(jd_config.get("server_url") or "https://api.jd.com/routerjson"),
        timeout_seconds=int(jd_config.get("timeout_seconds") or 20),
        page_size=int(jd_config.get("page_size") or 10),
        scene_id=int(jd_config.get("scene_id") or 1),
        fields=str(jd_config.get("fields") or ""),
        verify_ssl=_as_bool(jd_config.get("verify_ssl", True)),
    )
