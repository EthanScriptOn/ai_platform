from __future__ import annotations

import json

import pytest

from tiktok_res_app.product_matching import MatchConditions, MatchRequest, ProductMatchAgent
from tiktok_res_app.product_matching.taobao_union import TaobaoUnionCatalogClient


class _FakeTaobaoResponse:
    def __init__(self, body: str, status: int = 200) -> None:
        self._body = body
        self.status = status

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def text(self) -> str:
        return self._body


class _FakeTaobaoSession:
    captured = {}

    def __init__(self, *args, **kwargs) -> None:
        self.timeout = kwargs.get("timeout")

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    def post(self, url, **kwargs):
        _FakeTaobaoSession.captured = {
            "url": url,
            "params": kwargs.get("params") or {},
            "data": kwargs.get("data") or {},
            "headers": kwargs.get("headers") or {},
            "ssl": kwargs.get("ssl"),
        }
        body = json.dumps(
            {
                "tbk_dg_material_optional_upgrade_response": {
                    "result_list": {
                        "map_data": [
                            {
                                "item_id": "tao-1",
                                "item_url": "//uland.taobao.com/item/edetail?id=tao-1",
                                "item_basic_info": {
                                    "title": "迪士尼 双肩包 女款",
                                    "short_title": "迪士尼双肩包",
                                    "pict_url": "//img.alicdn.com/imgextra/i1/test.jpg",
                                    "small_images": {
                                        "string": [
                                            "//img.alicdn.com/imgextra/i1/test.jpg",
                                            "//img.alicdn.com/imgextra/i2/test.jpg",
                                        ]
                                    },
                                    "shop_title": "淘宝旗舰店",
                                    "brand_name": "迪士尼",
                                    "seller_id": "9988",
                                    "volume": "1.8万+",
                                    "user_type": 1,
                                },
                                "price_promotion_info": {
                                    "zk_final_price": "239.00",
                                    "final_promotion_price": "219.00",
                                },
                                "publish_info": {
                                    "coupon_share_url": "//uland.taobao.com/coupon/edetail?id=abc"
                                },
                            }
                        ]
                    }
                }
            },
            ensure_ascii=False,
        )
        return _FakeTaobaoResponse(body)


@pytest.mark.asyncio
async def test_taobao_union_catalog_client_builds_request_and_parses_items(monkeypatch):
    from tiktok_res_app.product_matching import taobao_union as taobao_union_module

    monkeypatch.setattr(taobao_union_module.aiohttp, "ClientSession", _FakeTaobaoSession)

    client = TaobaoUnionCatalogClient(
        app_key="demo-app-key",
        app_secret="demo-app-secret",
        session_key="demo-session",
        pid="mm_3631805805_3111200372_115736250062",
        material_id=80309,
        verify_ssl=False,
    )
    items = await client.search_products(
        {"title": "迪士尼 双肩包", "price_yuan": 239.0},
        MatchConditions(limit_per_product=3, price_float_percent=10),
    )

    assert len(items) == 1
    assert items[0]["product_id"] == "tao-1"
    assert items[0]["platform"] == "taobao"
    assert items[0]["platform_label"] == "淘宝"
    assert items[0]["price_yuan"] == 219.0
    assert items[0]["image"] == "https://img.alicdn.com/imgextra/i1/test.jpg"
    assert items[0]["detail_url"] == "https://uland.taobao.com/item/edetail?id=tao-1"
    assert items[0]["shop_name"] == "淘宝旗舰店"
    assert items[0]["in_order_count_30_days_sku"] == 18000.0

    captured = _FakeTaobaoSession.captured
    assert captured["url"] == "http://gw.api.taobao.com/router/rest"
    assert captured["params"]["method"] == "taobao.tbk.dg.material.optional.upgrade"
    assert captured["params"]["app_key"] == "demo-app-key"
    assert captured["params"]["session"] == "demo-session"
    assert len(captured["params"]["sign"]) == 32
    assert captured["ssl"] is False
    assert captured["data"]["q"] == "迪士尼 双肩包"
    assert captured["data"]["page_size"] == 3
    assert captured["data"]["page_no"] == 1
    assert captured["data"]["adzone_id"] == "115736250062"
    assert captured["data"]["sort"] == "match_des"
    assert captured["data"]["start_price"] == 215
    assert captured["data"]["end_price"] == 263


def test_product_match_agent_requires_taobao_credentials():
    with pytest.raises(RuntimeError, match="taobao_union.app_key"):
        ProductMatchAgent(
            config={
                "product_matching": {"provider": "taobao_union"},
                "taobao_union": {"app_key": "", "app_secret": "", "pid": ""},
            }
        )


@pytest.mark.asyncio
async def test_product_match_agent_limits_taobao_candidates_to_top_three():
    class _FakeTaobaoCatalogClient:
        provider_name = "taobao"
        platform_label = "淘宝"
        tool_name = "taobao.tbk.dg.material.optional.upgrade"

        async def search_products(self, product, conditions):
            return [
                {"product_id": "tao-1", "title": f"{product['title']} 官方款", "price_yuan": 239},
                {"product_id": "tao-2", "title": f"{product['title']} 同款", "price_yuan": 238},
                {"product_id": "tao-3", "title": f"{product['title']} 相似款", "price_yuan": 237},
                {"product_id": "tao-4", "title": "完全不相关商品", "price_yuan": 499},
            ]

    agent = ProductMatchAgent(catalog_clients={"taobao": _FakeTaobaoCatalogClient()})
    result = await agent.run(
        MatchRequest(
            products=[{"product_id": "dy-1", "title": "迪士尼 双肩包 女款", "show_price_yuan": 239}],
            platforms=["taobao"],
            conditions=MatchConditions(limit_per_product=3),
        )
    )

    candidates = result["results"][0]["candidates"]
    assert len(candidates) == 3
    assert [item["product_id"] for item in candidates] == ["tao-1", "tao-2", "tao-3"]
    assert all(item["platform"] == "taobao" for item in candidates)
    assert result["results"][0]["tool_calls"][0]["platform_label"] == "淘宝"
