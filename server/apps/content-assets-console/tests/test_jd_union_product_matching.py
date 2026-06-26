from __future__ import annotations

import json

import pytest

from tiktok_res_app.product_matching import MatchConditions, MatchRequest, ProductMatchAgent
from tiktok_res_app.product_matching.jd_union import JdUnionCatalogClient


class _FakeJdResponse:
    def __init__(self, body: str, status: int = 200) -> None:
        self._body = body
        self.status = status

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def text(self) -> str:
        return self._body


class _FakeJdSession:
    captured = {}

    def __init__(self, *args, **kwargs) -> None:
        self.timeout = kwargs.get("timeout")

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    def post(self, url, **kwargs):
        _FakeJdSession.captured = {
            "url": url,
            "params": kwargs.get("params") or {},
            "data": kwargs.get("data"),
            "headers": kwargs.get("headers") or {},
            "ssl": kwargs.get("ssl"),
        }
        body = json.dumps(
            {
                "jd_union_open_goods_query_responce": {
                    "code": "0",
                    "queryResult": json.dumps(
                        {
                            "code": 200,
                            "message": "success",
                            "data": [
                                {
                                    "itemId": "jd-item-1",
                                    "skuId": 123456,
                                    "skuName": "迪士尼 双肩包 女款",
                                    "goodCommentsShare": 98,
                                    "inOrderCount30DaysSku": 88,
                                    "purchasePriceInfo": {"purchasePrice": 236},
                                    "priceInfo": {
                                        "lowestCouponPrice": 236,
                                        "lowestPrice": 249,
                                        "price": 269,
                                    },
                                    "imageInfo": {
                                        "imageList": [
                                            {"url": "https://img.example.com/1.jpg"},
                                        ]
                                    },
                                    "shopInfo": {"shopName": "京东自营"},
                                    "brandName": "迪士尼",
                                    "owner": "g",
                                    "categoryInfo": {
                                        "cid1Name": "箱包皮具",
                                        "cid2Name": "女包",
                                        "cid3Name": "女士双肩包",
                                    },
                                }
                            ],
                        },
                        ensure_ascii=False,
                    ),
                }
            },
            ensure_ascii=False,
        )
        return _FakeJdResponse(body)


@pytest.mark.asyncio
async def test_jd_union_catalog_client_builds_request_and_parses_items(monkeypatch):
    from tiktok_res_app.product_matching import jd_union as jd_union_module

    monkeypatch.setattr(jd_union_module.aiohttp, "ClientSession", _FakeJdSession)

    client = JdUnionCatalogClient(
        app_key="demo-app-key",
        app_secret="demo-app-secret",
        page_size=6,
        fields="similar,videoInfo",
        verify_ssl=False,
    )
    items = await client.search_products(
        {"title": "迪士尼 双肩包", "price_yuan": 239.0},
        MatchConditions(limit_per_product=3, price_float_percent=10),
    )

    assert len(items) == 1
    assert items[0]["product_id"] == "jd-item-1"
    assert items[0]["platform"] == "jd"
    assert items[0]["platform_label"] == "京东"
    assert items[0]["price_yuan"] == 236
    assert items[0]["image"] == "https://img.example.com/1.jpg"

    captured = _FakeJdSession.captured
    assert captured["url"] == "https://api.jd.com/routerjson"
    assert captured["params"]["method"] == "jd.union.open.goods.query"
    assert captured["params"]["app_key"] == "demo-app-key"
    assert len(captured["params"]["sign"]) == 32
    assert captured["ssl"] is False

    payload = json.loads(captured["data"].decode("utf-8"))
    assert payload["goodsReqDTO"]["keyword"] == "迪士尼 双肩包"
    assert payload["goodsReqDTO"]["pageSize"] == 3
    assert payload["goodsReqDTO"]["pricefrom"] == 215.1
    assert payload["goodsReqDTO"]["priceto"] == 262.9
    assert payload["goodsReqDTO"]["fields"] == "similar,videoInfo"


@pytest.mark.asyncio
async def test_product_match_agent_prefers_closer_title_and_price():
    class _FakeCatalogClient:
        provider_name = "jd_union"
        tool_name = "jd.union.open.goods.query"

        async def search_products(self, product, conditions):
            return [
                {
                    "product_id": "near",
                    "title": "迪士尼 双肩包 女款轻便",
                    "price_yuan": 239,
                    "good_comments_share": 96,
                    "in_order_count_30_days_sku": 50,
                    "raw": {
                        "categoryInfo": {
                            "cid1Name": "箱包皮具",
                            "cid2Name": "女包",
                            "cid3Name": "女士双肩包",
                        }
                    },
                },
                {
                    "product_id": "far",
                    "title": "保温杯 大容量",
                    "price_yuan": 399,
                    "good_comments_share": 99,
                    "in_order_count_30_days_sku": 500,
                },
            ]

    agent = ProductMatchAgent(catalog_client=_FakeCatalogClient())
    result = await agent.run(
        MatchRequest(
            products=[
                {
                    "product_id": "dy-100",
                    "title": "迪士尼 双肩包 女款",
                    "show_price_yuan": 239,
                    "category": "女士双肩包",
                }
            ],
            conditions=MatchConditions(
                same_product=True,
                similar_product=True,
                same_category=True,
                limit_per_product=2,
            ),
        )
    )

    ranked = result["results"][0]["candidates"]
    assert [item["product_id"] for item in ranked] == ["near", "far"]
    assert ranked[0]["platform"] == "jd"
    assert ranked[0]["confidence_label"] in {"高可信", "中可信"}
    assert ranked[0]["match_type"] == "疑似同款"
    assert "标题" in ranked[0]["match_reason"]


def test_product_match_agent_requires_jd_credentials():
    with pytest.raises(RuntimeError, match="jd_union.app_key"):
        ProductMatchAgent(
            config={
                "product_matching": {"provider": "jd_union"},
                "jd_union": {"app_key": "", "app_secret": ""},
            }
        )


@pytest.mark.asyncio
async def test_product_match_agent_rejects_unsupported_platform():
    class _FakeCatalogClient:
        provider_name = "jd"

        async def search_products(self, product, conditions):
            return []

    agent = ProductMatchAgent(catalog_client=_FakeCatalogClient())
    with pytest.raises(RuntimeError, match="暂未接入"):
        await agent.run(
            MatchRequest(
                products=[{"product_id": "dy-1", "title": "测试商品"}],
                platforms=["meituan"],
            )
        )
