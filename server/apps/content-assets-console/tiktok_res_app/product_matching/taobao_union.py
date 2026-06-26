from __future__ import annotations

import hashlib
import math
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


def _format_scalar(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


class TaobaoUnionCatalogClient:
    provider_name = "taobao"
    platform_label = "淘宝"
    result_limit = 3

    def __init__(
        self,
        *,
        app_key: str,
        app_secret: str,
        session_key: str = "",
        gateway_url: str = "http://gw.api.taobao.com/router/rest",
        pid: str = "",
        site_id: str = "",
        adzone_id: str = "",
        account_type: str = "agency",
        material_id: Any = 80309,
        biz_scene_id: int = 1,
        sort: str = "match_des",
        timeout_seconds: int = 20,
        verify_ssl: bool = True,
        service_app_key: str = "",
        service_app_secret: str = "",
    ) -> None:
        self.app_key = _clean_text(app_key)
        self.app_secret = _clean_text(app_secret)
        self.session_key = _clean_text(session_key)
        self.gateway_url = _clean_text(gateway_url) or "http://gw.api.taobao.com/router/rest"
        self.pid = _clean_text(pid)
        self.account_type = (_clean_text(account_type) or "agency").lower()
        self.material_id = material_id
        self.biz_scene_id = int(biz_scene_id or 1)
        self.sort = _clean_text(sort) or "match_des"
        self.timeout_seconds = max(1, int(timeout_seconds))
        self.verify_ssl = _as_bool(verify_ssl)
        self.service_app_key = _clean_text(service_app_key)
        self.service_app_secret = _clean_text(service_app_secret)

        pid_site_id = ""
        pid_adzone_id = ""
        if self.pid:
            parts = self.pid.split("_")
            if len(parts) >= 4:
                pid_site_id = parts[2].strip()
                pid_adzone_id = parts[3].strip()

        self.site_id = _clean_text(site_id) or pid_site_id
        self.adzone_id = _clean_text(adzone_id) or pid_adzone_id

        self.tool_name = (
            "taobao.tbk.sc.material.optional.upgrade"
            if self.account_type == "server"
            else "taobao.tbk.dg.material.optional.upgrade"
        )
        self.query_app_key = (
            self.service_app_key if self.account_type == "server" and self.service_app_key else self.app_key
        )
        self.query_app_secret = (
            self.service_app_secret
            if self.account_type == "server" and self.service_app_secret
            else self.app_secret
        )

        missing = []
        if not self.query_app_key:
            missing.append("taobao_union.app_key")
        if not self.query_app_secret:
            missing.append("taobao_union.app_secret")
        if not self.adzone_id:
            missing.append("taobao_union.adzone_id or taobao_union.pid")
        if self.account_type == "server" and not self.site_id:
            missing.append("taobao_union.site_id or taobao_union.pid")
        if missing:
            raise RuntimeError(f"淘宝联盟配置缺失：{', '.join(missing)}")

    async def search_products(
        self,
        product: Dict[str, Any],
        conditions: MatchConditions,
    ) -> List[Dict[str, Any]]:
        keyword = self._build_keyword(product)
        if not keyword:
            return []

        api_params = self._build_api_params(product, keyword, conditions)
        sys_params = self._build_sys_params(api_params)
        timeout = aiohttp.ClientTimeout(total=self.timeout_seconds)
        headers = {
            "User-Agent": "tiktok-res-taobao-union",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        }

        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(
                self.gateway_url,
                params=sys_params,
                data=api_params,
                headers=headers,
                ssl=self.verify_ssl,
            ) as response:
                body = await response.text()
                if response.status >= 400:
                    raise RuntimeError(
                        f"淘宝联盟请求失败：HTTP {response.status} {body[:240]}"
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

    def _build_api_params(
        self,
        product: Dict[str, Any],
        keyword: str,
        conditions: MatchConditions,
    ) -> Dict[str, Any]:
        params: Dict[str, Any] = {
            "q": keyword,
            "page_size": self.result_limit,
            "page_no": 1,
            "adzone_id": self.adzone_id,
            "biz_scene_id": self.biz_scene_id,
            "sort": self.sort,
        }
        if self.account_type == "server" and self.site_id:
            params["site_id"] = self.site_id
        if self.material_id not in (None, ""):
            params["material_id"] = self.material_id

        source_price = _as_float(product.get("price_yuan"))
        if source_price and conditions.price_float_percent is not None:
            delta = max(0.0, conditions.price_float_percent) / 100.0
            start_price = max(source_price * (1 - delta), 0.0)
            end_price = max(source_price * (1 + delta), start_price)
            # 淘宝联盟该接口对价格筛选更偏向整数值，直接传小数会触发
            # `Invalid arguments:end_price`。这里收敛为整数区间即可。
            params["start_price"] = int(math.floor(start_price))
            params["end_price"] = int(math.ceil(end_price))

        return params

    def _build_sys_params(self, api_params: Dict[str, Any]) -> Dict[str, Any]:
        params: Dict[str, Any] = {
            "app_key": self.query_app_key,
            "v": "2.0",
            "format": "json",
            "sign_method": "md5",
            "method": self.tool_name,
            "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }
        if self.session_key:
            params["session"] = self.session_key
        params["sign"] = self._sign({**api_params, **params})
        return params

    def _sign(self, params: Dict[str, Any]) -> str:
        chunks = [self.query_app_secret]
        for key, value in sorted(params.items()):
            if isinstance(value, (dict, list, tuple, set)):
                continue
            text = _format_scalar(value)
            if text.startswith("@"):
                continue
            chunks.append(f"{key}{text}")
        chunks.append(self.query_app_secret)
        return hashlib.md5("".join(chunks).encode("utf-8")).hexdigest().upper()

    def _parse_items(self, body: str) -> List[Dict[str, Any]]:
        try:
            payload = json.loads(body)
        except json.JSONDecodeError as exc:
            raise RuntimeError("淘宝联盟返回了无法解析的 JSON") from exc

        error_response = payload.get("error_response")
        if isinstance(error_response, dict):
            code = _clean_text(error_response.get("sub_code") or error_response.get("code")) or "unknown"
            message = (
                _clean_text(error_response.get("sub_msg"))
                or _clean_text(error_response.get("msg"))
                or "未知错误"
            )
            if code in {"isv.permission-api-package-limit", "11"}:
                message = f"{message}，请确认淘宝联盟接口权限与授权状态"
            raise RuntimeError(f"淘宝联盟商品查询失败：{code} {message}")

        wrapper = (
            payload.get("tbk_dg_material_optional_upgrade_response")
            or payload.get("tbk_sc_material_optional_upgrade_response")
            or payload
        )
        if not isinstance(wrapper, dict):
            raise RuntimeError("淘宝联盟返回结构异常")

        result_list = wrapper.get("result_list")
        if isinstance(result_list, dict):
            map_data = result_list.get("map_data")
            if isinstance(map_data, list):
                return [item for item in map_data if isinstance(item, dict)]
            if isinstance(map_data, dict):
                return [map_data]

        map_data = wrapper.get("map_data")
        if isinstance(map_data, list):
            return [item for item in map_data if isinstance(item, dict)]
        if isinstance(map_data, dict):
            return [map_data]
        return []

    def _normalize_item(self, item: Dict[str, Any]) -> Dict[str, Any]:
        basic = item.get("item_basic_info") if isinstance(item.get("item_basic_info"), dict) else {}
        price_info = (
            item.get("price_promotion_info")
            if isinstance(item.get("price_promotion_info"), dict)
            else {}
        )
        publish_info = item.get("publish_info") if isinstance(item.get("publish_info"), dict) else {}

        image = _ensure_https(basic.get("pict_url"))
        images = self._extract_images(basic.get("small_images"))
        if not image and images:
            image = images[0]
        if image and image not in images:
            images.insert(0, image)

        detail_url = _ensure_https(item.get("item_url"))
        item_id = _clean_text(item.get("item_id"))
        if not detail_url and item_id:
            detail_url = f"https://uland.taobao.com/item/edetail?id={item_id}"
        sales_count = self._parse_sales_count(
            basic.get("volume") or basic.get("annual_vol") or basic.get("tk_total_sales")
        )

        return {
            "product_id": item_id,
            "item_id": item_id,
            "platform": self.provider_name,
            "platform_label": self.platform_label,
            "title": _clean_text(basic.get("title") or basic.get("short_title")),
            "price_yuan": (
                _as_float(price_info.get("final_promotion_price"))
                or _as_float(price_info.get("zk_final_price"))
            ),
            "image": image,
            "detail_url": detail_url,
            "shop_name": _clean_text(basic.get("shop_title")),
            "brand_name": _clean_text(basic.get("brand_name")),
            "category_name": _clean_text(item.get("category_name") or basic.get("category_name")),
            "seller_id": _clean_text(basic.get("seller_id")),
            "good_comments_share": _as_float(item.get("good_comments_share")),
            "in_order_count_30_days_sku": sales_count,
            "sales_count": sales_count,
            "sales_label": "销量",
            "coupon_url": _ensure_https(
                publish_info.get("coupon_click_url") or publish_info.get("coupon_share_url")
            ),
            "raw": item,
        }

    def _extract_images(self, value: Any) -> List[str]:
        if isinstance(value, dict):
            nested = value.get("string")
            if isinstance(nested, list):
                return [_ensure_https(item) for item in nested if _ensure_https(item)]
            if isinstance(nested, str):
                image = _ensure_https(nested)
                return [image] if image else []
        if isinstance(value, list):
            return [_ensure_https(item) for item in value if _ensure_https(item)]
        if isinstance(value, str):
            image = _ensure_https(value)
            return [image] if image else []
        return []

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


def build_taobao_union_client(config: Any) -> TaobaoUnionCatalogClient:
    config_data = getattr(config, "config", config) or {}
    taobao_config = config_data.get("taobao_union") or {}
    return TaobaoUnionCatalogClient(
        app_key=str(taobao_config.get("app_key") or ""),
        app_secret=str(taobao_config.get("app_secret") or ""),
        session_key=str(taobao_config.get("session_key") or ""),
        gateway_url=str(taobao_config.get("gateway_url") or "http://gw.api.taobao.com/router/rest"),
        pid=str(taobao_config.get("pid") or ""),
        site_id=str(taobao_config.get("site_id") or ""),
        adzone_id=str(taobao_config.get("adzone_id") or ""),
        account_type=str(taobao_config.get("account_type") or "agency"),
        material_id=taobao_config.get("material_id", 80309),
        biz_scene_id=int(taobao_config.get("biz_scene_id") or 1),
        sort=str(taobao_config.get("sort") or "match_des"),
        timeout_seconds=int(taobao_config.get("timeout_seconds") or 20),
        verify_ssl=_as_bool(taobao_config.get("verify_ssl", True)),
        service_app_key=str(taobao_config.get("service_app_key") or ""),
        service_app_secret=str(taobao_config.get("service_app_secret") or ""),
    )
