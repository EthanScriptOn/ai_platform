from __future__ import annotations

import hashlib
import hmac
import json
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import aiohttp

from .schemas import MatchConditions

_SHANGHAI_TZ = timezone(timedelta(hours=8))


def _clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _as_float(value: Any) -> Optional[float]:
    try:
        if value in (None, ""):
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _as_bool(value: Any, default: bool = True) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _ensure_https(url: Any) -> str:
    text = _clean_text(url)
    if not text:
        return ""
    if text.startswith("//"):
        return f"https:{text}"
    return text


def _sanitize_message(value: Any) -> str:
    text = _clean_text(value)
    if not text:
        return ""
    text = re.sub(r"https?://\S+", "", text).strip(" ，,;；")
    return _clean_text(text)


def _sort_payload(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _sort_payload(value[key]) for key in sorted(value.keys())}
    if isinstance(value, list):
        return [_sort_payload(item) for item in value]
    return value


class DouyinBuyinCatalogClient:
    provider_name = "douyin"
    platform_label = "抖音"
    tool_name = "alliance.materialsProductsSearch"
    result_limit = 3

    def __init__(
        self,
        *,
        app_key: str,
        app_secret: str,
        access_token: str,
        server_url: str = "https://openapi-fxg.jinritemai.com",
        pid: str = "",
        timeout_seconds: int = 20,
        page_size: int = 3,
        search_type: int = 1,
        sort_type: int = 1,
        share_status: int = 1,
        verify_ssl: bool = True,
    ) -> None:
        self.app_key = _clean_text(app_key)
        self.app_secret = _clean_text(app_secret)
        self.access_token = _clean_text(access_token)
        self.server_url = _clean_text(server_url).rstrip("/") or "https://openapi-fxg.jinritemai.com"
        self.pid = _clean_text(pid)
        self.timeout_seconds = max(1, int(timeout_seconds))
        self.page_size = max(1, min(int(page_size), self.result_limit))
        self.search_type = int(search_type or 1)
        self.sort_type = int(sort_type or 1)
        self.share_status = int(share_status or 1)
        self.verify_ssl = _as_bool(verify_ssl)

        missing = []
        if not self.app_key:
            missing.append("douyin_buyin.app_key")
        if not self.app_secret:
            missing.append("douyin_buyin.app_secret")
        if not self.access_token:
            missing.append("douyin_buyin.access_token")
        if missing:
            raise RuntimeError(f"抖音精选联盟配置缺失：{', '.join(missing)}")

    async def search_products(
        self,
        product: Dict[str, Any],
        conditions: MatchConditions,
    ) -> List[Dict[str, Any]]:
        keyword = self._build_keyword(product)
        if not keyword:
            return []

        payload = self._build_payload(keyword)
        request_body = self._marshal(payload)
        params = self._build_query_params(request_body)
        timeout = aiohttp.ClientTimeout(total=self.timeout_seconds)
        headers = {
            "User-Agent": "tiktok-res-douyin-buyin",
            "Content-Type": "application/json; charset=UTF-8",
        }
        url = f"{self.server_url}/alliance/materialsProductsSearch"

        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(
                url,
                params=params,
                data=request_body.encode("utf-8"),
                headers=headers,
                ssl=self.verify_ssl,
            ) as response:
                body = await response.text()
                if response.status >= 400:
                    raise RuntimeError(
                        f"抖音精选联盟请求失败：HTTP {response.status} {body[:240]}"
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
        return title[:80]

    def _build_payload(self, keyword: str) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "title": keyword,
            "search_type": self.search_type,
            "sort_type": self.sort_type,
            "page": 1,
            "page_size": self.page_size,
            "share_status": self.share_status,
        }
        if self.pid:
            payload["pid"] = self.pid
        return payload

    def _marshal(self, payload: Dict[str, Any]) -> str:
        return json.dumps(
            _sort_payload(payload),
            ensure_ascii=False,
            separators=(",", ":"),
        )

    def _build_query_params(self, request_body: str) -> Dict[str, str]:
        timestamp = datetime.now(_SHANGHAI_TZ).strftime("%Y-%m-%d %H:%M:%S")
        method = self.tool_name
        return {
            "method": method,
            "app_key": self.app_key,
            "access_token": self.access_token,
            "sign": self._sign(method, timestamp, request_body),
            "timestamp": timestamp,
            "v": "2",
            "sign_method": "hmac-sha256",
        }

    def _sign(self, method: str, timestamp: str, request_body: str) -> str:
        param_pattern = (
            f"app_key{self.app_key}"
            f"method{method}"
            f"param_json{request_body}"
            f"timestamp{timestamp}"
            "v2"
        )
        sign_pattern = f"{self.app_secret}{param_pattern}{self.app_secret}"
        return hmac.new(
            self.app_secret.encode("utf-8"),
            sign_pattern.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()

    def _parse_items(self, body: str) -> List[Dict[str, Any]]:
        try:
            payload = json.loads(body)
        except json.JSONDecodeError as exc:
            raise RuntimeError("抖音精选联盟返回了无法解析的 JSON") from exc

        code = int(str(payload.get("code") or "0"))
        if code != 10000:
            sub_code = _clean_text(payload.get("sub_code")) or "unknown"
            message = (
                _sanitize_message(payload.get("sub_msg"))
                or _sanitize_message(payload.get("msg"))
                or "未知错误"
            )
            if code == 60000 or "request-limited" in sub_code:
                raise RuntimeError(f"抖音精选联盟商品查询触发限流，请稍后重试（{sub_code}）")
            if code in {40003, 40004}:
                raise RuntimeError(f"抖音精选联盟商品查询参数异常：{sub_code} {message}")
            if code in {50002, 90000}:
                raise RuntimeError(f"抖音精选联盟商品查询失败：{sub_code} {message}")
            raise RuntimeError(f"抖音精选联盟商品查询失败：{code} {sub_code} {message}")

        data = payload.get("data")
        if not isinstance(data, dict):
            return []
        products = data.get("products")
        if isinstance(products, list):
            return [item for item in products if isinstance(item, dict)]
        if isinstance(products, dict):
            return [products]
        return []

    def _normalize_item(self, item: Dict[str, Any]) -> Dict[str, Any]:
        price_yuan = (
            self._price_cent_to_yuan(item.get("coupon_price"))
            or self._price_cent_to_yuan(item.get("price"))
        )
        return {
            "product_id": _clean_text(item.get("product_id")),
            "platform": self.provider_name,
            "platform_label": self.platform_label,
            "title": _clean_text(item.get("title")),
            "price_yuan": price_yuan,
            "image": _ensure_https(item.get("cover")),
            "detail_url": _ensure_https(item.get("detail_url")),
            "shop_name": _clean_text(item.get("shop_name")),
            "brand_name": _clean_text(item.get("brand_name")),
            "shop_id": _clean_text(item.get("shop_id")),
            "cos_fee": self._price_cent_to_yuan(item.get("cos_fee")),
            "cos_ratio": _as_float(item.get("cos_ratio")),
            "good_comments_share": _as_float(item.get("good_comments_share")),
            "in_order_count_30_days_sku": self._parse_sales_count(item.get("sales")),
            "sales_count": self._parse_sales_count(item.get("sales")),
            "sales_label": "销量",
            "raw": item,
        }

    @staticmethod
    def _price_cent_to_yuan(value: Any) -> Optional[float]:
        number = _as_float(value)
        if number is None:
            return None
        return round(number / 100.0, 2)

    @staticmethod
    def _parse_sales_count(value: Any) -> Optional[float]:
        text = _clean_text(value)
        if not text:
            return None
        text = text.replace(",", "").replace("+", "")
        try:
            return float(text)
        except ValueError:
            pass

        match = re.search(r"(\d+(?:\.\d+)?)\s*万", text)
        if match:
            return round(float(match.group(1)) * 10000, 2)

        digits = re.findall(r"\d+(?:\.\d+)?", text)
        if digits:
            try:
                return float(digits[0])
            except ValueError:
                return None
        return None


def build_douyin_buyin_client(config: Any) -> DouyinBuyinCatalogClient:
    config_data = getattr(config, "config", config) or {}
    douyin_config = config_data.get("douyin_buyin") or {}
    return DouyinBuyinCatalogClient(
        app_key=str(douyin_config.get("app_key") or ""),
        app_secret=str(douyin_config.get("app_secret") or ""),
        access_token=str(douyin_config.get("access_token") or ""),
        server_url=str(douyin_config.get("server_url") or "https://openapi-fxg.jinritemai.com"),
        pid=str(douyin_config.get("pid") or ""),
        timeout_seconds=int(douyin_config.get("timeout_seconds") or 20),
        page_size=int(douyin_config.get("page_size") or 3),
        search_type=int(douyin_config.get("search_type") or 1),
        sort_type=int(douyin_config.get("sort_type") or 1),
        share_status=int(douyin_config.get("share_status") or 1),
        verify_ssl=_as_bool(douyin_config.get("verify_ssl", True)),
    )
