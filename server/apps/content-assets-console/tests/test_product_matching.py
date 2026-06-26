from __future__ import annotations

import pytest

from tiktok_res_app.product_matching import MatchConditions, MatchRequest, ProductMatchAgent


class _FakeCatalogClient:
    provider_name = "jd"
    platform_label = "京东"
    tool_name = "jd.union.open.goods.query"

    async def search_products(self, product, conditions):
        return [
                {
                    "product_id": "sku-1",
                    "title": f"{product['title']} 同款",
                    "price_yuan": product.get("price_yuan"),
                    "score": 0.93,
                    "platform": "jd",
                    "platform_label": "京东",
                    "brand_name": "迪士尼",
                    "comments_count": 126,
                    "good_comments_share": 98,
                    "sales_count": 88,
                    "sales_label": "近30天引单",
                },
            {
                "product_id": "sku-2",
                "title": "相似款",
                "price_yuan": 99,
                "score": 0.7,
                "platform": "jd",
                "platform_label": "京东",
            },
        ]


@pytest.mark.asyncio
async def test_product_match_agent_normalizes_and_ranks_candidates():
    agent = ProductMatchAgent(catalog_client=_FakeCatalogClient())
    result = await agent.run(
        MatchRequest(
            products=[
                {
                    "product_id": "dy-1",
                    "promotion_id": "promo-1",
                    "title": "迪士尼包包",
                    "show_price_yuan": 129,
                }
            ],
            conditions=MatchConditions(same_product=True, similar_product=True, limit_per_product=2),
        )
    )

    assert result["product_count"] == 1
    assert result["matched_count"] == 1
    first = result["results"][0]
    assert first["source_product"]["source_product_id"] == "dy-1"
    assert first["candidates"][0]["product_id"] == "sku-1"
    assert first["candidates"][0]["match_type"] == "疑似同款"
    assert first["candidates"][0]["platform"] == "jd"
    assert first["candidates"][0]["platform_label"] == "京东"
    assert first["candidates"][0]["brand_name"] == "迪士尼"
    assert first["candidates"][0]["comments_count"] == 126
    assert first["candidates"][0]["good_comments_share"] == 98
    assert first["candidates"][0]["sales_count"] == 88
    assert first["tool_calls"][0]["name"] == "jd.union.open.goods.query"


@pytest.mark.asyncio
async def test_product_match_agent_continues_when_one_platform_errors():
    class _FailingDouyinClient:
        provider_name = "douyin"
        platform_label = "抖音"
        tool_name = "alliance.materialsProductsSearch"

        async def search_products(self, product, conditions):
            raise RuntimeError("抖音精选联盟商品查询触发限流")

    agent = ProductMatchAgent(
        catalog_clients={
            "douyin": _FailingDouyinClient(),
            "jd": _FakeCatalogClient(),
        }
    )
    result = await agent.run(
        MatchRequest(
            products=[
                {
                    "product_id": "dy-1",
                    "promotion_id": "promo-1",
                    "title": "迪士尼包包",
                    "show_price_yuan": 129,
                }
            ],
            platforms=["douyin", "jd"],
            conditions=MatchConditions(same_product=True, similar_product=True, limit_per_product=2),
        )
    )

    first = result["results"][0]
    assert first["candidates"][0]["platform"] == "jd"
    assert any("抖音精选联盟商品查询触发限流" in note for note in first["agent_notes"])
    assert any(call.get("error") for call in first["tool_calls"] if call["platform"] == "douyin")


@pytest.mark.asyncio
async def test_product_match_agent_ignores_price_when_tolerance_is_empty():
    class _PriceAgnosticClient:
        provider_name = "jd"
        platform_label = "京东"
        tool_name = "jd.union.open.goods.query"

        async def search_products(self, product, conditions):
            return [
                {
                    "product_id": "same-title",
                    "title": "迪士尼 双肩包 女款",
                    "price_yuan": 9999,
                    "platform": "jd",
                    "platform_label": "京东",
                    "good_comments_share": 98,
                }
            ]

    agent = ProductMatchAgent(catalog_client=_PriceAgnosticClient())
    result = await agent.run(
        MatchRequest(
            products=[{"product_id": "dy-2", "title": "迪士尼 双肩包 女款", "show_price_yuan": 239}],
            conditions=MatchConditions(
                same_product=True,
                similar_product=True,
                price_float_percent=None,
                limit_per_product=3,
            ),
        )
    )

    candidates = result["results"][0]["candidates"]
    assert len(candidates) == 1
    assert candidates[0]["product_id"] == "same-title"
    assert candidates[0]["match_type"] == "疑似同款"


@pytest.mark.asyncio
async def test_product_match_agent_uses_query_variants_and_brand_filtering():
    class _VariantClient:
        provider_name = "taobao"
        platform_label = "淘宝"
        tool_name = "taobao.tbk.dg.material.optional.upgrade"

        def __init__(self) -> None:
            self.queries = []

        async def search_products(self, product, conditions):
            title = product["title"]
            self.queries.append(title)
            if "Slazenger 运动鞋" in title:
                return [
                    {
                        "product_id": "real-match",
                        "title": "史莱辛格Slazenger 轻奢运动跑鞋轻便舒适跑步鞋轻便运动鞋男女款",
                        "brand_name": "Slazenger/史莱辛格",
                        "shop_name": "环球嗨购",
                        "price_yuan": 99,
                        "platform": "taobao",
                        "platform_label": "淘宝",
                        "raw": {"category_name": "跑步鞋"},
                    }
                ]
            return [
                {
                    "product_id": f"noise-{len(self.queries)}",
                    "title": "儿童网面白鞋 W21绿色单网男女百搭",
                    "brand_name": "未知",
                    "shop_name": "柒柒童鞋小店",
                    "price_yuan": 39.7,
                    "platform": "taobao",
                    "platform_label": "淘宝",
                    "raw": {"category_name": "儿童跑步鞋"},
                }
            ]

    client = _VariantClient()
    agent = ProductMatchAgent(catalog_clients={"taobao": client})
    result = await agent.run(
        MatchRequest(
            products=[
                {
                    "product_id": "dy-slz",
                    "title": "【Slazenger】清风3.0百年轻奢品牌男女户外透气慢跑运动鞋W21",
                    "show_price_yuan": 79.9,
                }
            ],
            platforms=["taobao"],
            conditions=MatchConditions(
                same_product=True,
                similar_product=True,
                price_float_percent=None,
                limit_per_product=3,
            ),
        )
    )

    first = result["results"][0]
    assert any("Slazenger 运动鞋" == query for query in client.queries)
    assert [item["product_id"] for item in first["candidates"]] == ["real-match"]
    assert first["candidates"][0]["confidence_label"] in {"高可信", "中可信"}
    assert len(first["tool_calls"][0]["query_variants"]) >= 2


@pytest.mark.asyncio
async def test_product_match_agent_filters_small_paper_pack_candidates():
    class _PaperCatalogClient:
        provider_name = "jd"
        platform_label = "京东"
        tool_name = "jd.union.open.goods.query"

        def __init__(self) -> None:
            self.queries = []

        async def search_products(self, product, conditions):
            self.queries.append(product["title"])
            return [
                {
                    "product_id": "pack-2",
                    "title": "清风卷纸有芯金装原木加厚4层125g*2卷卫生纸家用纸巾",
                    "price_yuan": 5.9,
                    "platform": "jd",
                    "platform_label": "京东",
                    "brand_name": "清风",
                    "raw": {
                        "categoryInfo": {
                            "cid1Name": "家清纸品",
                            "cid2Name": "生活用纸",
                            "cid3Name": "卷纸",
                        },
                        "specInfo": {"color": "4层 125g*2卷"},
                    },
                },
                {
                    "product_id": "pack-3",
                    "title": "清风卷纸有芯金装原木加厚4层125g*3卷卫生纸家用纸巾",
                    "price_yuan": 8.9,
                    "platform": "jd",
                    "platform_label": "京东",
                    "brand_name": "清风",
                    "raw": {
                        "categoryInfo": {
                            "cid1Name": "家清纸品",
                            "cid2Name": "生活用纸",
                            "cid3Name": "卷纸",
                        },
                        "specInfo": {"color": "4层 125g*3卷"},
                    },
                },
                {
                    "product_id": "pack-27",
                    "title": "清风有芯卷纸 原木金装4层200克*27卷 卫生纸 纸巾整箱 厕纸 卷筒纸",
                    "price_yuan": 54.8,
                    "platform": "jd",
                    "platform_label": "京东",
                    "brand_name": "清风",
                    "good_comments_share": 99,
                    "sales_count": 5000,
                    "raw": {
                        "categoryInfo": {
                            "cid1Name": "家清纸品",
                            "cid2Name": "生活用纸",
                            "cid3Name": "卷纸",
                        },
                        "specInfo": {"color": "4层 200g*27卷 整箱"},
                    },
                },
                {
                    "product_id": "pack-24-140",
                    "title": "清风有芯卷纸原木纯品4层140克*24卷压花小卷纸",
                    "price_yuan": 55.9,
                    "platform": "jd",
                    "platform_label": "京东",
                    "brand_name": "清风",
                    "good_comments_share": 100,
                    "sales_count": 300,
                    "raw": {
                        "categoryInfo": {
                            "cid1Name": "家清纸品",
                            "cid2Name": "生活用纸",
                            "cid3Name": "卷纸",
                        },
                        "specInfo": {"color": "4层 140g*24卷"},
                    },
                },
                {
                    "product_id": "pack-24",
                    "title": "清风原木金装4层卷纸125g*24卷整箱加厚装厕纸家用纸巾",
                    "price_yuan": 39.9,
                    "platform": "jd",
                    "platform_label": "京东",
                    "brand_name": "清风",
                    "good_comments_share": 98,
                    "raw": {
                        "categoryInfo": {
                            "cid1Name": "家清纸品",
                            "cid2Name": "生活用纸",
                            "cid3Name": "卷纸",
                        },
                        "specInfo": {"color": "4层 125g*24卷 整箱"},
                    },
                },
            ]

    client = _PaperCatalogClient()
    agent = ProductMatchAgent(catalog_client=client)
    result = await agent.run(
        MatchRequest(
            products=[
                {
                    "product_id": "dy-paper-1",
                    "title": "清风原木金装4层卷纸125克24卷整箱加厚装厕纸可冲水亲肤家用纸巾",
                    "show_price_yuan": 39.9,
                }
            ],
            conditions=MatchConditions(
                same_product=True,
                similar_product=True,
                price_float_percent=None,
                limit_per_product=3,
            ),
        )
    )

    candidates = result["results"][0]["candidates"]
    candidate_ids = [item["product_id"] for item in candidates]
    assert candidate_ids[0] == "pack-24"
    assert candidate_ids.index("pack-24") < candidate_ids.index("pack-24-140")
    assert "pack-2" not in candidate_ids
    assert "pack-3" not in candidate_ids
    assert candidates[0]["confidence_label"] in {"高可信", "中可信"}
    assert "规格接近" in candidates[0]["match_reason"]
    assert "清风 卷纸 24卷" in client.queries
    assert "清风 125克 24卷 卷纸" in client.queries
    assert "清风 运动鞋" not in client.queries


@pytest.mark.asyncio
async def test_product_match_agent_builds_fishing_query_variants_and_keeps_similar_candidates():
    class _FishingCatalogClient:
        provider_name = "taobao"
        platform_label = "淘宝"
        tool_name = "taobao.tbk.dg.material.optional.upgrade"

        def __init__(self) -> None:
            self.queries = []

        async def search_products(self, product, conditions):
            title = product["title"]
            self.queries.append(title)
            if title == "钓鱼打窝饵料":
                return [
                    {
                        "product_id": "fish-match",
                        "title": "钓鱼王压缩膨化窝料鱼饵料鲫鲤草鱼打窝料方块饵料鱼食糠饼腥香+酒米",
                        "price_yuan": 15.0,
                        "platform": "taobao",
                        "platform_label": "淘宝",
                        "brand_name": "钓鱼王",
                        "raw": {"category_name": "运动户外 / 垂钓用品 / 鱼饵"},
                    }
                ]
            return []

    client = _FishingCatalogClient()
    agent = ProductMatchAgent(catalog_client=client)
    result = await agent.run(
        MatchRequest(
            products=[
                {
                    "product_id": "dy-fish-1",
                    "title": "李 拍一发二 四季可用钓鱼打窝饵料轻松钓鲫鲤草鳊青必备",
                    "show_price_yuan": 99,
                }
            ],
            platforms=["taobao"],
            conditions=MatchConditions(
                same_product=True,
                similar_product=True,
                price_float_percent=None,
                limit_per_product=3,
            ),
        )
    )

    candidates = result["results"][0]["candidates"]
    assert [item["product_id"] for item in candidates] == ["fish-match"]
    assert candidates[0]["score"] >= 0.4
    assert "钓鱼打窝饵料" in client.queries
    assert "钓鱼窝料" in client.queries
    assert any("饵料" in query for query in client.queries if query != "钓鱼打窝饵料")
