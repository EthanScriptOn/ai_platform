from __future__ import annotations

import asyncio
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import aiohttp

from utils.logger import setup_logger

logger = setup_logger("APIClient")

_SHORT_URL_HOSTS = {"v.douyin.com", "v.iesdouyin.com", "iesdouyin.com"}


class DouyinAPIDiscoveryMixin:
    async def get_hot_search_board(self) -> Dict[str, Any]:
        """获取抖音热搜榜。返回归一化 dict，items 为热搜词条列表。"""
        params = await self._default_query()
        params.update({"detail_list": "1", "source": "6"})
        raw = await self._request_json(
            "/aweme/v1/web/hot/search/list/", params, suppress_error=True
        )
        # 热榜返回结构中数据在 data.word_list 或 word_list
        data_root = raw.get("data") if isinstance(raw.get("data"), dict) else raw
        word_list = data_root.get("word_list") if isinstance(data_root, dict) else None
        status_code = int(raw.get("status_code") or 0)
        items = word_list if isinstance(word_list, list) else []
        # 响应为空 + 非正常状态码时显式告警，方便排查 cookie 失效/签名失败
        if not items and (status_code or not raw):
            logger.warning(
                "Hot search board returned no items (status_code=%s). "
                "Check cookies / signature; Douyin may be rejecting the request.",
                status_code,
            )
        return {
            "items": items,
            "has_more": False,
            "max_cursor": 0,
            "status_code": status_code,
            "raw": raw,
        }

    async def search_aweme(
        self,
        keyword: str,
        *,
        offset: int = 0,
        count: int = 10,
        sort_type: int = 0,
        publish_time: int = 0,
    ) -> Dict[str, Any]:
        """搜索作品。

        Args:
            sort_type: 0 综合 / 1 最多点赞 / 2 最新发布
            publish_time: 0 不限 / 1 一天内 / 7 一周内 / 182 半年内
        """
        params = await self._default_query()
        params.update(
            {
                "keyword": keyword,
                "search_channel": "aweme_video_web",
                "sort_type": sort_type,
                "publish_time": publish_time,
                "search_source": "normal_search",
                "query_correct_type": "1",
                "is_filter_search": 1 if (sort_type or publish_time) else 0,
                "offset": offset,
                "count": count,
            }
        )
        raw = await self._request_json(
            "/aweme/v1/web/general/search/single/", params, suppress_error=True
        )
        # 搜索结果每条在 data[].aweme_info；需要拍平
        data_list = raw.get("data") if isinstance(raw.get("data"), list) else []
        items: List[Dict[str, Any]] = []
        for entry in data_list:
            if not isinstance(entry, dict):
                continue
            aweme_info = entry.get("aweme_info")
            if isinstance(aweme_info, dict):
                items.append(aweme_info)

        has_more_value = raw.get("has_more", 0)
        try:
            has_more = bool(int(has_more_value))
        except (TypeError, ValueError):
            has_more = bool(has_more_value)

        cursor_value = raw.get("cursor") or raw.get("offset") or 0
        try:
            next_offset = int(cursor_value)
        except (TypeError, ValueError):
            next_offset = 0

        status_code = int(raw.get("status_code") or 0)
        if not items and (status_code or not raw):
            logger.warning(
                "Search returned no items for keyword=%r (status_code=%s, offset=%s). "
                "Possible causes: cookies expired, signature rejected, or query blocked.",
                keyword,
                status_code,
                offset,
            )

        return {
            "items": items,
            "has_more": has_more,
            "max_cursor": next_offset,
            "status_code": status_code,
            "raw": raw,
        }

    async def get_aweme_comments(
        self,
        aweme_id: str,
        *,
        cursor: int = 0,
        count: int = 20,
        include_replies: bool = False,
    ) -> Dict[str, Any]:
        """获取作品评论列表（一页）。

        Args:
            aweme_id: 作品 ID
            cursor: 分页游标（首次传 0）
            count: 每页数量（抖音上限一般为 20）
            include_replies: 是否拉取每条评论的二级回复（额外请求）
        Returns:
            归一化后的分页响应 dict，items 为评论列表。
        """
        params = await self._default_query()
        params.update(
            {
                "aweme_id": aweme_id,
                "cursor": cursor,
                "count": count,
                "item_type": "0",
                "insert_ids": "",
                "whale_cut_token": "",
                "cut_version": "1",
                "rcFT": "",
            }
        )
        raw = await self._request_json("/aweme/v1/web/comment/list/", params)
        normalized = self._normalize_paged_response(raw, item_keys=["comments"])

        if include_replies:
            comments = normalized.get("items") or []
            for comment in comments:
                if not isinstance(comment, dict):
                    continue
                comment_id = comment.get("cid") or comment.get("comment_id")
                if not comment_id or int(comment.get("reply_comment_total") or 0) <= 0:
                    continue
                try:
                    reply_page = await self.get_aweme_comment_replies(
                        aweme_id=aweme_id, comment_id=str(comment_id), count=count
                    )
                    comment["_replies"] = reply_page.get("items") or []
                except Exception as exc:  # noqa: BLE001
                    logger.debug("Fetch reply for comment %s failed: %s", comment_id, exc)
        return normalized

    async def get_aweme_comment_replies(
        self,
        *,
        aweme_id: str,
        comment_id: str,
        cursor: int = 0,
        count: int = 20,
    ) -> Dict[str, Any]:
        """获取某条评论的二级回复列表。"""
        params = await self._default_query()
        params.update(
            {
                "item_id": aweme_id,
                "comment_id": comment_id,
                "cursor": cursor,
                "count": count,
            }
        )
        raw = await self._request_json("/aweme/v1/web/comment/list/reply/", params)
        return self._normalize_paged_response(raw, item_keys=["comments"])

    async def resolve_short_url(
        self, short_url: str, *, timeout_seconds: float = 10.0
    ) -> Optional[str]:
        """跟随短链 302，返回最终 URL。失败时返回 None。

        单独设置较短超时（默认 10s），避免被目标站挂死后拖慢整轮下载。
        HTTP 状态码 ≥ 400 时视为解析失败，返回 None 以避免把错误页 URL
        继续喂给下游 parser，从而在下游触发更隐晦的 "Unsupported URL" 噪声。
        """
        def _is_non_short_douyin_url(candidate: str) -> bool:
            parsed = urlparse(candidate)
            host = (parsed.netloc or "").lower()
            if not host or host in _SHORT_URL_HOSTS:
                return False
            if not (host.endswith("douyin.com") or host.endswith("iesdouyin.com")):
                return False
            path = parsed.path or ""
            return any(
                marker in path
                for marker in ("/video/", "/user/", "/note/", "/gallery/", "/slides/", "/live/", "/follow/live/", "/music/", "/collection/", "/mix/", "/share/video/")
            )

        def _best_resolved_url(response: aiohttp.ClientResponse) -> Optional[str]:
            history = list(getattr(response, "history", []) or [])
            candidates = [str(item.url) for item in history if getattr(item, "url", None)]
            if getattr(response, "url", None):
                candidates.append(str(response.url))
            for candidate in reversed(candidates):
                if _is_non_short_douyin_url(candidate):
                    return candidate
            return None

        async def _fetch_resolved_url(*, ssl_verify: bool) -> Optional[str]:
            await self._ensure_session()
            async with self._session.get(
                short_url,
                allow_redirects=True,
                timeout=aiohttp.ClientTimeout(total=timeout_seconds),
                proxy=self.proxy or None,
                ssl=ssl_verify,
            ) as response:
                final_url = str(response.url)
                best_url = _best_resolved_url(response)
                if response.status >= 400:
                    if best_url:
                        logger.warning(
                            "Short URL ended with HTTP %s, fallback to last resolved Douyin URL: %s -> %s",
                            response.status,
                            short_url,
                            best_url,
                        )
                        return best_url
                    logger.warning(
                        "Short URL resolved with HTTP %s (treated as failure): %s -> %s",
                        response.status,
                        short_url,
                        final_url,
                    )
                    return None
                return best_url or final_url

        try:
            return await _fetch_resolved_url(ssl_verify=True)
        except aiohttp.ClientConnectorCertificateError as exc:
            logger.warning(
                "Certificate verification failed while resolving short URL, retry without SSL verification: %s, error: %s",
                short_url,
                exc,
            )
            try:
                return await _fetch_resolved_url(ssl_verify=False)
            except Exception as retry_exc:
                logger.error(
                    "Failed to resolve short URL after SSL verification fallback: %s, error: %s",
                    short_url,
                    retry_exc,
                )
                return None
        except asyncio.TimeoutError:
            logger.error(
                "Timeout resolving short URL after %.1fs: %s",
                timeout_seconds,
                short_url,
            )
            return None
        except Exception as e:
            logger.error("Failed to resolve short URL: %s, error: %s", short_url, e)
            return None
