from __future__ import annotations

import json
import re
import hashlib
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from typing import Any, Dict, List, Optional, Sequence

from config import ConfigLoader


PLATFORM_QUIDAO = {
    "taobao": 1,
    "tb": 1,
    "jd": 2,
    "jingdong": 2,
}


def _clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _as_int(value: Any) -> Optional[int]:
    text = _clean_text(value)
    if not text or not re.fullmatch(r"\d+", text):
        return None
    try:
        return int(text)
    except (TypeError, ValueError):
        return None


def _json_or_default(value: Any, default: Any) -> Any:
    if value in (None, ""):
        return default
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value)
    except Exception:
        return default


def _nested_get(data: Dict[str, Any], *keys: str) -> Any:
    current: Any = data
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def _walk_values(value: Any):
    if isinstance(value, dict):
        for item in value.values():
            yield from _walk_values(item)
    elif isinstance(value, list):
        for item in value:
            yield from _walk_values(item)
    else:
        yield value


def _first_int(*values: Any) -> Optional[int]:
    for value in values:
        parsed = _as_int(value)
        if parsed is not None:
            return parsed
    return None


def _extract_taobao_numeric_item_id(raw: Dict[str, Any]) -> Optional[int]:
    for value in _walk_values(raw):
        text = _clean_text(value)
        if not text:
            continue
        match = re.fullmatch(r"(\d{9,15})(?:coin|vip\d+)", text, re.I)
        if match:
            return _as_int(match.group(1))
    return None


def _extract_numeric_id_from_url(platform: str, detail_url: str) -> Optional[int]:
    url = _clean_text(detail_url)
    if not url:
        return None
    if platform == "jd":
        patterns = (
            r"item\.jd\.com/(\d+)\.html",
            r"[?&](?:sku|skuId|wareId|itemId)=(\d+)",
        )
    elif platform == "taobao":
        patterns = (
            r"[?&](?:id|item_id|itemId|auctionNumId)=(\d+)",
            r"item\.taobao\.com/item\.htm.*?[?&]id=(\d+)",
        )
    else:
        patterns = ()
    for pattern in patterns:
        match = re.search(pattern, url, re.I)
        if match:
            return _as_int(match.group(1))
    return None


def _extract_taobao_item_token_from_url(detail_url: str) -> str:
    url = _clean_text(detail_url)
    if not url:
        return ""
    parsed = urllib.parse.urlparse(url)
    query = urllib.parse.parse_qs(parsed.query)
    for key in ("id", "item_id", "itemId", "auctionNumId"):
        values = query.get(key) or []
        for value in values:
            text = _clean_text(value)
            if text:
                return text
    return ""


def extract_comment_lookup_ids(payload: Dict[str, Any]) -> Dict[str, Any]:
    platform = _clean_text(payload.get("platform")).lower()
    raw = payload.get("raw") if isinstance(payload.get("raw"), dict) else {}
    detail_url = _clean_text(payload.get("detail_url"))
    sku_id = _first_int(
        payload.get("sku_id"),
        payload.get("item_id"),
        payload.get("product_id"),
        raw.get("sku_id"),
        raw.get("skuId"),
        raw.get("item_id"),
        raw.get("itemId"),
        raw.get("wareId"),
        raw.get("auctionNumId"),
        _nested_get(raw, "item_basic_info", "item_id"),
        _nested_get(raw, "item_basic_info", "itemId"),
        _nested_get(raw, "item_basic_info", "auctionNumId"),
        _nested_get(raw, "publish_info", "item_id"),
        _nested_get(raw, "publish_info", "itemId"),
        _nested_get(raw, "scope_info", "item_id"),
        _nested_get(raw, "scope_info", "itemId"),
        _extract_taobao_numeric_item_id(raw) if platform == "taobao" else None,
        _extract_numeric_id_from_url(platform, detail_url),
    )
    goods_ids = [
        _clean_text(value)
        for value in (
            payload.get("product_id"),
            payload.get("item_id"),
            payload.get("sku_id"),
            raw.get("goods_id"),
            raw.get("goodsId"),
            raw.get("goods_sign"),
            raw.get("goodsSign"),
            raw.get("item_id"),
            raw.get("itemId"),
            raw.get("sku_id"),
            raw.get("skuId"),
        )
        if _clean_text(value)
    ]
    return {
        "platform": platform,
        "qudao": PLATFORM_QUIDAO.get(platform),
        "sku_id": sku_id,
        "goods_ids": list(dict.fromkeys(goods_ids)),
        "detail_url": detail_url,
    }


class TaobaoCommentItemResolver:
    def __init__(self, config: ConfigLoader):
        cfg = (getattr(config, "config", config) or {}).get("taobao_union") or {}
        if not isinstance(cfg, dict):
            cfg = {}
        self.gateway_url = _clean_text(cfg.get("gateway_url")) or "http://gw.api.taobao.com/router/rest"
        self.app_key = _clean_text(cfg.get("app_key"))
        self.app_secret = _clean_text(cfg.get("app_secret"))
        self.session_key = _clean_text(cfg.get("session_key"))
        self.biz_scene_id = int(cfg.get("biz_scene_id") or 1)
        self.timeout_seconds = max(1, int(cfg.get("timeout_seconds") or 20))

    def enabled(self) -> bool:
        return bool(self.gateway_url and self.app_key and self.app_secret)

    def resolve(self, lookup: Dict[str, Any]) -> Optional[int]:
        if lookup.get("sku_id") or lookup.get("platform") != "taobao" or not self.enabled():
            return None

        candidates: List[str] = []
        url_token = _extract_taobao_item_token_from_url(lookup.get("detail_url") or "")
        if url_token:
            candidates.append(url_token)
        candidates.extend(str(item) for item in (lookup.get("goods_ids") or []))

        for item_id in dict.fromkeys(_clean_text(item) for item in candidates):
            if not item_id or _as_int(item_id):
                continue
            resolved = self._resolve_by_item_info(item_id)
            if resolved:
                return resolved
        return None

    def _resolve_by_item_info(self, item_id: str) -> Optional[int]:
        api_params = {
            "item_id": item_id,
            "biz_scene_id": self.biz_scene_id,
        }
        payload = self._call_taobao("taobao.tbk.item.info.upgrade.get", api_params)
        wrapper = payload.get("tbk_item_info_upgrade_get_response") if isinstance(payload, dict) else {}
        if not isinstance(wrapper, dict):
            return None
        details = (((wrapper.get("results") or {}).get("tbk_item_detail")) or [])
        if isinstance(details, dict):
            details = [details]
        for item in details:
            if isinstance(item, dict):
                resolved = _extract_taobao_numeric_item_id(item)
                if resolved:
                    return resolved
        return None

    def _call_taobao(self, method: str, api_params: Dict[str, Any]) -> Dict[str, Any]:
        sys_params: Dict[str, Any] = {
            "app_key": self.app_key,
            "v": "2.0",
            "format": "json",
            "sign_method": "md5",
            "method": method,
            "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }
        if self.session_key:
            sys_params["session"] = self.session_key
        sys_params["sign"] = self._sign({**api_params, **sys_params})

        request_url = f"{self.gateway_url}?{urllib.parse.urlencode(sys_params)}"
        data = urllib.parse.urlencode(api_params).encode("utf-8")
        request = urllib.request.Request(
            request_url,
            data=data,
            headers={
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "User-Agent": "tiktok-res-taobao-comment-resolver",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                body = response.read().decode("utf-8", errors="replace")
        except (urllib.error.URLError, TimeoutError):
            return {}
        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            return {}
        if isinstance(payload, dict) and isinstance(payload.get("error_response"), dict):
            return {}
        return payload if isinstance(payload, dict) else {}

    def _sign(self, params: Dict[str, Any]) -> str:
        chunks = [self.app_secret]
        for key, value in sorted(params.items()):
            if isinstance(value, (dict, list, tuple, set)):
                continue
            text = "true" if value is True else "false" if value is False else str(value)
            if text.startswith("@"):
                continue
            chunks.append(f"{key}{text}")
        chunks.append(self.app_secret)
        return hashlib.md5("".join(chunks).encode("utf-8")).hexdigest().upper()


def load_union_comment_settings(config: ConfigLoader) -> Optional[Dict[str, Any]]:
    cfg = (getattr(config, "config", config) or {}).get("union_comments_mysql") or {}
    if not isinstance(cfg, dict) or not cfg.get("enabled"):
        return None
    host = _clean_text(cfg.get("host"))
    user = _clean_text(cfg.get("user"))
    password = str(cfg.get("password") or "")
    database = _clean_text(cfg.get("database"))
    table_prefix = _clean_text(cfg.get("table_prefix")) or "fa_"
    try:
        port = int(cfg.get("port") or 3306)
    except (TypeError, ValueError):
        port = 3306
    if not (host and user and password and database):
        raise RuntimeError("union_comments_mysql 配置不完整，请检查 host/user/password/database")
    return {
        "host": host,
        "port": port,
        "user": user,
        "password": password,
        "database": database,
        "table_prefix": table_prefix,
    }


class UnionCommentRepository:
    def __init__(self, settings: Dict[str, Any]):
        try:
            import pymysql
            from pymysql.cursors import DictCursor
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError("缺少 pymysql，请先安装 MySQL 依赖") from exc
        self._pymysql = pymysql
        self._dict_cursor = DictCursor
        self.settings = settings
        self.prefix = settings.get("table_prefix") or "fa_"

    def _connect(self):
        return self._pymysql.connect(
            host=self.settings["host"],
            port=int(self.settings["port"]),
            user=self.settings["user"],
            password=self.settings["password"],
            database=self.settings["database"],
            charset="utf8mb4",
            autocommit=True,
            cursorclass=self._dict_cursor,
        )

    def _table(self, name: str) -> str:
        if not re.fullmatch(r"[A-Za-z0-9_]+", self.prefix):
            raise RuntimeError("union_comments_mysql.table_prefix 非法")
        return f"`{self.prefix}{name}`"

    def query(self, lookup: Dict[str, Any], *, limit: int = 8, offset: int = 0) -> Dict[str, Any]:
        qudao = lookup.get("qudao")
        sku_id = lookup.get("sku_id")
        goods_ids = [item for item in (lookup.get("goods_ids") or []) if item]
        if not qudao:
            return self._empty_result(lookup, "当前只支持京东和淘宝评论查询")
        if not sku_id and not goods_ids:
            return self._empty_result(lookup, "没有可用于查询评论的真实商品 ID")

        subject = self._find_subject(qudao, sku_id, goods_ids)
        page_limit = max(1, min(int(limit), 30))
        page_offset = max(0, int(offset))
        logs = self._find_logs(subject, qudao, sku_id, goods_ids, page_limit, page_offset)
        return {
            "enabled": True,
            "platform": lookup.get("platform") or "",
            "qudao": qudao,
            "sku_id": sku_id,
            "goods_ids": goods_ids,
            "matched": bool(subject or logs),
            "subject": self._format_subject(subject),
            "stats": self._stats(subject, logs),
            "comments": [self._format_log(item) for item in logs],
            "pagination": {
                "limit": page_limit,
                "offset": page_offset,
                "returned": len(logs),
            },
            "message": "" if subject or logs else "暂未查到评论。打开商品页后，等待插件上传再刷新。",
        }

    def _find_subject(
        self,
        qudao: int,
        sku_id: Optional[int],
        goods_ids: Sequence[str],
    ) -> Optional[Dict[str, Any]]:
        clauses = ["qudao = %s"]
        params: List[Any] = [qudao]
        match_clauses = []
        if sku_id:
            match_clauses.append("skuId = %s")
            params.append(sku_id)
        if goods_ids:
            placeholders = ", ".join(["%s"] * len(goods_ids))
            match_clauses.append(f"goods_id IN ({placeholders})")
            match_clauses.append(f"goods_sign IN ({placeholders})")
            params.extend(goods_ids)
            params.extend(goods_ids)
        clauses.append("(" + " OR ".join(match_clauses) + ")")
        sql = (
            f"SELECT * FROM {self._table('union_comments')} "
            f"WHERE {' AND '.join(clauses)} ORDER BY update_time DESC, id DESC LIMIT 1"
        )
        with self._connect() as conn:
            with conn.cursor() as cursor:
                cursor.execute(sql, params)
                return cursor.fetchone()

    def _find_logs(
        self,
        subject: Optional[Dict[str, Any]],
        qudao: int,
        sku_id: Optional[int],
        goods_ids: Sequence[str],
        limit: int,
        offset: int = 0,
    ) -> List[Dict[str, Any]]:
        clauses: List[str] = []
        params: List[Any] = []
        if subject:
            clauses.append("cid = %s")
            params.append(subject["id"])
        if sku_id:
            clauses.append("(skuId = %s)")
            params.append(sku_id)
        if goods_ids:
            placeholders = ", ".join(["%s"] * len(goods_ids))
            clauses.append(f"(goods_id IN ({placeholders}) OR goods_sign IN ({placeholders}))")
            params.extend(goods_ids)
            params.extend(goods_ids)
        if not clauses:
            return []
        sql = (
            f"SELECT * FROM {self._table('union_comment_logs')} "
            f"WHERE {' OR '.join(clauses)} ORDER BY feedbackDate DESC, id DESC LIMIT %s OFFSET %s"
        )
        params.append(limit)
        params.append(offset)
        with self._connect() as conn:
            with conn.cursor() as cursor:
                cursor.execute(sql, params)
                rows = cursor.fetchall() or []
        return [row for row in rows if not subject or int(row.get("cid") or 0) == int(subject["id"]) or int(row.get("skuId") or 0) == int(sku_id or 0)]

    def _stats(self, subject: Optional[Dict[str, Any]], logs: List[Dict[str, Any]]) -> Dict[str, Any]:
        if not subject:
            return {
                "comment_count": len(logs),
                "tag_count": 0,
                "latest_feedback_date": logs[0].get("feedbackDate") if logs else None,
            }
        with self._connect() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    f"SELECT COUNT(*) AS count, MAX(feedbackDate) AS latest FROM {self._table('union_comment_logs')} WHERE cid = %s",
                    (subject["id"],),
                )
                row = cursor.fetchone() or {}
        tags = _json_or_default(subject.get("tags"), [])
        return {
            "comment_count": int(row.get("count") or 0),
            "tag_count": len(tags) if isinstance(tags, list) else 0,
            "latest_feedback_date": row.get("latest"),
        }

    @staticmethod
    def _format_subject(subject: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        if not subject:
            return None
        return {
            "id": subject.get("id"),
            "sku_id": subject.get("skuId"),
            "goods_id": subject.get("goods_id"),
            "goods_title": subject.get("goods_title"),
            "goods_url": subject.get("goods_url"),
            "tags": _json_or_default(subject.get("tags"), []),
            "tags_maps": _json_or_default(subject.get("tags_maps"), []),
            "updated_at": subject.get("update_time"),
        }

    @staticmethod
    def _format_log(row: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "id": row.get("id"),
            "comment_id": row.get("commentId"),
            "content": row.get("content") or "",
            "score": row.get("score"),
            "sku_id": row.get("skuId"),
            "goods_id": row.get("goods_id"),
            "specifications": _json_or_default(row.get("specifications"), {}),
            "images": _json_or_default(row.get("images"), []),
            "feedback_date": row.get("feedbackDate"),
            "created_at": row.get("create_time"),
        }

    @staticmethod
    def _empty_result(lookup: Dict[str, Any], message: str) -> Dict[str, Any]:
        return {
            "enabled": True,
            "platform": lookup.get("platform") or "",
            "qudao": lookup.get("qudao"),
            "sku_id": lookup.get("sku_id"),
            "goods_ids": lookup.get("goods_ids") or [],
            "matched": False,
            "subject": None,
            "stats": {"comment_count": 0, "tag_count": 0, "latest_feedback_date": None},
            "comments": [],
            "message": message,
        }


def query_union_comments(config: ConfigLoader, payload: Dict[str, Any], *, limit: int = 8, offset: int = 0) -> Dict[str, Any]:
    settings = load_union_comment_settings(config)
    lookup = extract_comment_lookup_ids(payload)
    if lookup.get("platform") == "taobao" and not lookup.get("sku_id"):
        resolved_sku_id = TaobaoCommentItemResolver(config).resolve(lookup)
        if resolved_sku_id:
            lookup["sku_id"] = resolved_sku_id
    if not settings:
        return {
            **UnionCommentRepository._empty_result(lookup, "评论库未配置"),
            "enabled": False,
        }
    return UnionCommentRepository(settings).query(lookup, limit=limit, offset=offset)
