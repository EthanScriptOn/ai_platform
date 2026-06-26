from __future__ import annotations

import html
import json
import re
from typing import Any, Dict, List, Optional

import aiohttp

from utils.logger import setup_logger

logger = setup_logger("APIClient")


class DouyinAPILiveMixin:
    async def get_live_room_info(
        self, room_id: str, *, sec_user_id: str = ""
    ) -> Optional[Dict[str, Any]]:
        """通过房间号（web_rid）拉取直播间信息。

        返回包含 room_info + stream_url 的 dict；若房间不在直播中或接口失败返回 None。
        """
        params = await self._default_query()
        params.update(
            {
                "web_rid": room_id,
                "room_id_str": room_id,
                "enter_source": "",
                "is_need_double_stream": "false",
                "cookie_enabled": "true",
            }
        )
        if sec_user_id:
            params["sec_user_id"] = sec_user_id

        raw = await self._request_json(
            "/webcast/room/web/enter/",
            params,
            suppress_error=True,
        )
        if not raw:
            raw = await self._get_live_room_info_from_page(room_id)
        if not raw:
            return None

        data_section = raw.get("data") if isinstance(raw.get("data"), dict) else raw
        if not isinstance(data_section, dict):
            return None

        room_list = data_section.get("data")
        room = None
        if isinstance(room_list, list) and room_list:
            first = room_list[0]
            if isinstance(first, dict):
                room = first
        elif isinstance(data_section.get("room"), dict):
            room = data_section.get("room")
        elif isinstance(raw.get("room"), dict):
            room = raw.get("room")

        if not isinstance(room, dict):
            return None

        user = data_section.get("user") if isinstance(data_section, dict) else None
        return {
            "room": room,
            "user": user if isinstance(user, dict) else {},
            "raw": raw,
        }

    async def _get_live_room_info_from_page(self, web_rid: str) -> Dict[str, Any]:
        """Fallback for live pages whose room API returns an empty anti-bot response."""
        await self._ensure_session()
        if self._session is None:
            return {}

        url = f"https://live.douyin.com/{web_rid}"
        async def _fetch_page(*, ssl_verify: bool) -> str:
            async with self._session.get(
                url,
                headers={
                    **self.headers,
                    "Accept": "text/html,application/xhtml+xml",
                    "Referer": "https://www.douyin.com/",
                },
                proxy=self.proxy or None,
                allow_redirects=True,
                ssl=ssl_verify,
            ) as response:
                if response.status != 200:
                    logger.debug("Live page fallback failed: status=%s", response.status)
                    return ""
                return await response.text(errors="replace")

        try:
            text = await _fetch_page(ssl_verify=True)
        except aiohttp.ClientConnectorCertificateError as exc:
            logger.warning(
                "Certificate verification failed for live page, retry without SSL verification: %s",
                exc,
            )
            try:
                text = await _fetch_page(ssl_verify=False)
            except Exception as retry_exc:
                logger.debug("Live page fallback retry failed: %s", retry_exc)
                return {}
        except Exception as exc:
            logger.debug("Live page fallback request failed: %s", exc)
            return {}

        if not text:
            return {}

        return self._parse_live_room_info_from_page(text, web_rid)

    @classmethod
    def _parse_live_room_info_from_page(cls, html_text: str, web_rid: str) -> Dict[str, Any]:
        config = cls._extract_html_json_attr(html_text, "data-config")
        if not isinstance(config, dict):
            return {}

        stream = cls._extract_live_stream_urls(config)
        if not stream:
            return {}

        anchor = cls._extract_html_json_attr(html_text, "data-anchor-info")
        room_info = cls._extract_html_json_attr(html_text, "data-room-info")
        room_id = ""
        if isinstance(room_info, dict):
            room_id = str(room_info.get("roomId") or room_info.get("room_id") or "")

        user = {}
        if isinstance(anchor, dict):
            user = {
                "nickname": anchor.get("nickname") or "",
                "id_str": anchor.get("id_str") or "",
                "avatar": anchor.get("avatar") or "",
            }

        room = {
            "status": 2,
            "title": user.get("nickname") or "直播",
            "room_id": room_id,
            "room_id_str": room_id,
            "web_rid": web_rid,
            "stream_url": stream,
        }
        return {"data": {"room": room, "user": user}}

    @staticmethod
    def _extract_html_json_attr(html_text: str, attr_name: str) -> Any:
        match = re.search(rf'{re.escape(attr_name)}="([^"]+)"', html_text)
        if not match:
            return None
        try:
            return json.loads(html.unescape(match.group(1)))
        except Exception:
            return None

    @classmethod
    def _extract_live_stream_urls(cls, value: Any) -> Dict[str, Any]:
        stream_data_candidates: List[Dict[str, Any]] = []

        def walk(node: Any) -> None:
            if isinstance(node, dict):
                if isinstance(node.get("flv_pull_url"), dict) or isinstance(
                    node.get("hls_pull_url_map"), dict
                ):
                    stream_data_candidates.append(node)
                stream_data = node.get("stream_data")
                if isinstance(stream_data, str) and "pull-" in stream_data:
                    try:
                        parsed = json.loads(stream_data)
                    except Exception:
                        parsed = None
                    if isinstance(parsed, dict):
                        stream_data_candidates.append(parsed)
                for child in node.values():
                    walk(child)
            elif isinstance(node, list):
                for child in node:
                    walk(child)

        walk(value)

        for candidate in stream_data_candidates:
            if isinstance(candidate.get("flv_pull_url"), dict) or isinstance(
                candidate.get("hls_pull_url_map"), dict
            ):
                return candidate

            data = candidate.get("data")
            if not isinstance(data, dict):
                continue

            flv_map: Dict[str, str] = {}
            hls_map: Dict[str, str] = {}
            quality_names = {
                "origin": "ORIGIN",
                "uhd": "FULL_HD1",
                "hd": "HD1",
                "sd": "SD1",
                "ld": "LD",
            }
            for quality_key, quality_payload in data.items():
                if not isinstance(quality_payload, dict):
                    continue
                quality_name = quality_names.get(str(quality_key).lower(), str(quality_key).upper())
                main = quality_payload.get("main")
                if not isinstance(main, dict):
                    continue
                flv = main.get("flv")
                hls = main.get("hls")
                if isinstance(flv, str) and flv:
                    flv_map[quality_name] = flv
                if isinstance(hls, str) and hls:
                    hls_map[quality_name] = hls
            if flv_map or hls_map:
                return {"flv_pull_url": flv_map, "hls_pull_url_map": hls_map}

        return {}


