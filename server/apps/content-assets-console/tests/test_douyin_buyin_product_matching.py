from __future__ import annotations

import json

import pytest

from tiktok_res_app.product_matching import MatchConditions, MatchRequest, ProductMatchAgent
from tiktok_res_app.product_matching.douyin_buyin import DouyinBuyinCatalogClient


class _FakeDouyinResponse:
    def __init__(self, body: str, status: int = 200) -> None:
        self._body = body
        self.status = status

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def text(self) -> str:
        return self._body


class _FakeDouyinSession:
    captured = {}

    def __init__(self, *args, **kwargs) -> None:
        self.timeout = kwargs.get("timeout")

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    def post(self, url, **kwargs):
        _FakeDouyinSession.captured = {
            "url": url,
            "params": kwargs.get("params") or {},
            "data": kwargs.get("data") or b"",
            "headers": kwargs.get("headers") or {},
            "ssl": kwargs.get("ssl"),
        }
        body = json.dumps(
            {
                "code": 10000,
                "msg": "success",
                "data": {
                    "products": [
                        {
                            "product_id": "dy-goods-1",
                            "title": "迪士尼 双肩包 女款",
                            "cover": "https://p3-aio.ecombdimg.com/test.jpg",
                            "detail_url": "https://haohuo.jinritemai.com/views/product/item2?id=1",
                            "price": 23900,
                            "coupon_price": 21900,
                            "cos_fee": 3585,
                            "cos_ratio": 15,
                            "shop_id": 7788,
                            "shop_name": "抖音旗舰店",
                            "brand_name": "迪士尼",
                            "sales": "1.8万+",
                        }
                    ]
                },
            },
            ensure_ascii=False,
        )
        return _FakeDouyinResponse(body)


class _FakeDouyinRateLimitSession:
    def __init__(self, *args, **kwargs) -> None:
        self.timeout = kwargs.get("timeout")

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    def post(self, url, **kwargs):
        body = json.dumps(
            {
                "code": 60000,
                "sub_code": "isv.request-limited",
                "sub_msg": "接口限流",
            },
            ensure_ascii=False,
        )
        return _FakeDouyinResponse(body)


@pytest.mark.asyncio
async def test_douyin_buyin_catalog_client_builds_request_and_parses_items(monkeypatch):
    from tiktok_res_app.product_matching import douyin_buyin as douyin_buyin_module

    monkeypatch.setattr(douyin_buyin_module.aiohttp, "ClientSession", _FakeDouyinSession)

    client = DouyinBuyinCatalogClient(
        app_key="7041082148056466979",
        app_secret="4c60d789-0c85-4f3b-a425-ced53b1521ee",
        access_token="demo-access-token",
        pid="dy_107212850798836826383_20709_1217005432",
        verify_ssl=False,
    )
    items = await client.search_products(
        {"title": "迪士尼 双肩包", "price_yuan": 239.0},
        MatchConditions(limit_per_product=3),
    )

    assert len(items) == 1
    assert items[0]["product_id"] == "dy-goods-1"
    assert items[0]["platform"] == "douyin"
    assert items[0]["platform_label"] == "抖音"
    assert items[0]["price_yuan"] == 219.0
    assert items[0]["image"] == "https://p3-aio.ecombdimg.com/test.jpg"
    assert items[0]["detail_url"] == "https://haohuo.jinritemai.com/views/product/item2?id=1"
    assert items[0]["shop_name"] == "抖音旗舰店"
    assert items[0]["in_order_count_30_days_sku"] == 18000.0
    assert items[0]["cos_fee"] == 35.85

    captured = _FakeDouyinSession.captured
    assert captured["url"] == "https://openapi-fxg.jinritemai.com/alliance/materialsProductsSearch"
    assert captured["params"]["method"] == "alliance.materialsProductsSearch"
    assert captured["params"]["app_key"] == "7041082148056466979"
    assert captured["params"]["access_token"] == "demo-access-token"
    assert captured["params"]["v"] == "2"
    assert captured["params"]["sign_method"] == "hmac-sha256"
    assert len(captured["params"]["sign"]) == 64
    assert captured["ssl"] is False

    payload = json.loads(captured["data"].decode("utf-8"))
    assert payload["title"] == "迪士尼 双肩包"
    assert payload["page"] == 1
    assert payload["page_size"] == 3
    assert payload["search_type"] == 1
    assert payload["sort_type"] == 1
    assert payload["share_status"] == 1
    assert payload["pid"] == "dy_107212850798836826383_20709_1217005432"


@pytest.mark.asyncio
async def test_douyin_buyin_catalog_client_surfaces_rate_limit(monkeypatch):
    from tiktok_res_app.product_matching import douyin_buyin as douyin_buyin_module

    monkeypatch.setattr(
        douyin_buyin_module.aiohttp,
        "ClientSession",
        _FakeDouyinRateLimitSession,
    )

    client = DouyinBuyinCatalogClient(
        app_key="7041082148056466979",
        app_secret="4c60d789-0c85-4f3b-a425-ced53b1521ee",
        access_token="demo-access-token",
    )

    with pytest.raises(RuntimeError, match="限流"):
        await client.search_products(
            {"title": "迪士尼 双肩包"},
            MatchConditions(limit_per_product=3),
        )


def test_product_match_agent_requires_douyin_credentials():
    with pytest.raises(RuntimeError, match="douyin_buyin.app_key"):
        ProductMatchAgent(
            config={
                "product_matching": {"provider": "douyin_buyin"},
                "douyin_buyin": {"app_key": "", "app_secret": "", "access_token": ""},
            }
        )


@pytest.mark.asyncio
async def test_product_match_agent_limits_douyin_candidates_to_top_three():
    class _FakeDouyinCatalogClient:
        provider_name = "douyin"
        platform_label = "抖音"
        tool_name = "alliance.materialsProductsSearch"

        async def search_products(self, product, conditions):
            return [
                {"product_id": "dy-1", "title": f"{product['title']} 官方同款", "price_yuan": 239},
                {"product_id": "dy-2", "title": f"{product['title']} 店铺同款", "price_yuan": 238},
                {"product_id": "dy-3", "title": f"{product['title']} 相似款", "price_yuan": 237},
                {"product_id": "dy-4", "title": "完全不相关商品", "price_yuan": 499},
            ]

    agent = ProductMatchAgent(catalog_clients={"douyin": _FakeDouyinCatalogClient()})
    result = await agent.run(
        MatchRequest(
            products=[{"product_id": "dy-source-1", "title": "迪士尼 双肩包 女款", "show_price_yuan": 239}],
            platforms=["douyin"],
            conditions=MatchConditions(limit_per_product=3),
        )
    )

    candidates = result["results"][0]["candidates"]
    assert len(candidates) == 3
    assert [item["product_id"] for item in candidates] == ["dy-1", "dy-2", "dy-3"]
    assert all(item["platform"] == "douyin" for item in candidates)
    assert result["results"][0]["tool_calls"][0]["platform_label"] == "抖音"
