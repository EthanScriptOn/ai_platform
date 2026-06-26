import os
import re
import urllib.parse
import urllib.request
import json
import html
import math
import ssl
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed, TimeoutError as FutureTimeoutError
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

import feedparser
from fastapi import FastAPI, HTTPException, Query, Request
from pydantic import BaseModel, Field

from edgar import Company, set_identity
try:
    from newsplease import NewsPlease
except Exception:
    NewsPlease = None

try:
    import browser_cookie3
except Exception:
    browser_cookie3 = None

try:
    import bs4
    import httpx
    import twscrape.api as twscrape_api_mod
    import twscrape.xclid as twscrape_xclid_mod
    from twscrape.account import Account as TwscrapeAccount
    from twscrape import API as TwscrapeAPI, AccountsPool as TwscrapeAccountsPool, gather as twscrape_gather
    from twscrape.xclid import INDICES_REGEX, XClIdGen, cacl_anim_key, get_tw_page_text, parse_anim_arr, parse_vk_bytes
except Exception:
    bs4 = None
    httpx = None
    twscrape_api_mod = None
    twscrape_xclid_mod = None
    TwscrapeAccount = None
    TwscrapeAPI = None
    TwscrapeAccountsPool = None
    twscrape_gather = None
    INDICES_REGEX = None
    XClIdGen = None
    cacl_anim_key = None
    get_tw_page_text = None
    parse_anim_arr = None
    parse_vk_bytes = None


CONFIG_PATH = os.getenv("INTEL_API_CONFIG_PATH", os.path.join(os.path.dirname(__file__), "config.json"))


def load_local_config(path: str) -> Dict[str, Any]:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except Exception:
        return {}


LOCAL_CONFIG = load_local_config(CONFIG_PATH)
LLM_CONFIG = LOCAL_CONFIG.get("llm", {}) if isinstance(LOCAL_CONFIG.get("llm"), dict) else {}
BUDGET_CONFIG = LOCAL_CONFIG.get("budget", {}) if isinstance(LOCAL_CONFIG.get("budget"), dict) else {}
X_CONFIG = LOCAL_CONFIG.get("x", {}) if isinstance(LOCAL_CONFIG.get("x"), dict) else {}
SEC_CONFIG = LOCAL_CONFIG.get("sec", {}) if isinstance(LOCAL_CONFIG.get("sec"), dict) else {}


def config_value(env_name: str, config_dict: Dict[str, Any], config_key: str, default: Any) -> Any:
    env_value = os.getenv(env_name)
    if env_value is not None and env_value != "":
        return env_value
    value = config_dict.get(config_key)
    return default if value is None else value


def config_int(env_name: str, config_dict: Dict[str, Any], config_key: str, default: int) -> int:
    value = config_value(env_name, config_dict, config_key, default)
    try:
        return int(value)
    except Exception:
        return default


def config_bool(env_name: str, config_dict: Dict[str, Any], config_key: str, default: bool) -> bool:
    value = config_value(env_name, config_dict, config_key, default)
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


SEC_IDENTITY = config_value("INTEL_API_SEC_IDENTITY", SEC_CONFIG, "identity", "CodexEval test@example.com")
set_identity(SEC_IDENTITY)

app = FastAPI(title="Intel API", version="0.1.0")

DEFAULT_FEED_TIMEOUT_SEC = 5
DEFAULT_GDELT_TIMEOUT_SEC = 8
OPENAI_BASE_URL = config_value("INTEL_API_OPENAI_BASE_URL", LLM_CONFIG, "base_url", "https://myclaudeproxy.xyz/")
OPENAI_API_KEY = os.getenv("INTEL_API_OPENAI_API_KEY") or os.getenv("OPENAI_API_KEY") or LLM_CONFIG.get("api_key")
OPENAI_WEB_SEARCH_MODEL = config_value("INTEL_API_OPENAI_WEB_MODEL", LLM_CONFIG, "web_search_model", "gpt-5.4-mini")
OPENAI_QUERY_EXPAND_MODEL = config_value("INTEL_API_OPENAI_EXPAND_MODEL", LLM_CONFIG, "query_expand_model", OPENAI_WEB_SEARCH_MODEL)
OPENAI_SSL_VERIFY = config_bool("INTEL_API_OPENAI_SSL_VERIFY", LLM_CONFIG, "ssl_verify", False)
DEFAULT_MAX_EXPANSION_QUERIES = config_int("INTEL_API_DEFAULT_MAX_EXPANSION_QUERIES", BUDGET_CONFIG, "max_expansion_queries", 2)
DEFAULT_MAX_FOLLOWUP_QUERIES = config_int("INTEL_API_DEFAULT_MAX_FOLLOWUP_QUERIES", BUDGET_CONFIG, "max_followup_queries", 1)
DEFAULT_MAX_ROUNDS = config_int("INTEL_API_DEFAULT_MAX_ROUNDS", BUDGET_CONFIG, "max_rounds", 2)
DEFAULT_ROUND1_PER_QUERY_LIMIT = config_int("INTEL_API_DEFAULT_ROUND1_PER_QUERY_LIMIT", BUDGET_CONFIG, "round1_per_query_limit", 4)
DEFAULT_FOLLOWUP_PER_QUERY_LIMIT = config_int("INTEL_API_DEFAULT_FOLLOWUP_PER_QUERY_LIMIT", BUDGET_CONFIG, "followup_per_query_limit", 3)
X_DEFAULT_PROFILE = config_value("INTEL_API_X_CHROME_PROFILE", X_CONFIG, "chrome_profile", "Profile 10")
X_DEFAULT_PROXY = (
    os.getenv("INTEL_API_X_PROXY")
    or X_CONFIG.get("proxy")
    or os.getenv("all_proxy")
    or os.getenv("ALL_PROXY")
    or os.getenv("https_proxy")
    or os.getenv("HTTPS_PROXY")
    or os.getenv("http_proxy")
    or os.getenv("HTTP_PROXY")
)


def parse_boolish(value: Any, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def resolve_openai_runtime(
    request: Optional[Request] = None,
    *,
    web_search_model: Optional[str] = None,
    query_expand_model: Optional[str] = None,
) -> Dict[str, Any]:
    headers = request.headers if request is not None else {}
    return {
        "base_url": (headers.get("x-intel-openai-base-url") or OPENAI_BASE_URL).strip(),
        "api_key": (headers.get("x-intel-openai-api-key") or OPENAI_API_KEY or "").strip(),
        "ssl_verify": parse_boolish(headers.get("x-intel-openai-ssl-verify"), OPENAI_SSL_VERIFY),
        "web_search_model": (web_search_model or OPENAI_WEB_SEARCH_MODEL).strip(),
        "query_expand_model": (query_expand_model or OPENAI_QUERY_EXPAND_MODEL).strip(),
    }


def is_dashscope_runtime(runtime: Optional[Dict[str, Any]]) -> bool:
    base_url = str((runtime or {}).get("base_url") or "").lower()
    return "dashscope.aliyuncs.com" in base_url


def isoformat_or_none(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def compute_time_window(days: int) -> Dict[str, Any]:
    date_to = datetime.now().date()
    date_from = date_to - timedelta(days=max(days - 1, 0))
    return {
        "days": days,
        "date_from": date_from.isoformat(),
        "date_to": date_to.isoformat(),
    }


def article_to_dict(article: Any) -> Dict[str, Any]:
    maintext = article.maintext or ""
    return {
        "title": article.title,
        "description": article.description,
        "date_publish": isoformat_or_none(article.date_publish),
        "authors": article.authors,
        "language": article.language,
        "image_url": article.image_url,
        "source_domain": article.source_domain,
        "url": article.url,
        "maintext": maintext,
        "maintext_len": len(maintext),
    }


def extract_article_fallback(url: str) -> Dict[str, Any]:
    html_text = None
    if httpx is not None:
        try:
            response = httpx.get(url, headers={"User-Agent": "intel-api/0.1"}, timeout=12, follow_redirects=True)
            response.raise_for_status()
            html_text = response.text
        except Exception:
            html_text = None
    if html_text is None:
        html_text = fetch_url_text(url, timeout=12)
    if not html_text:
        raise HTTPException(status_code=502, detail="Article extraction fetch failed")
    if bs4 is None:
        raise HTTPException(status_code=503, detail="Article extraction dependencies unavailable")

    soup = bs4.BeautifulSoup(html_text, "html.parser")
    title = None
    if soup.title and soup.title.string:
        title = soup.title.string.strip()
    if not title:
        og_title = soup.find("meta", attrs={"property": "og:title"}) or soup.find("meta", attrs={"name": "og:title"})
        if og_title and og_title.get("content"):
            title = og_title.get("content").strip()

    def meta_content(*attrs: Dict[str, str]) -> Optional[str]:
        for attr in attrs:
            tag = soup.find("meta", attrs=attr)
            if tag and tag.get("content"):
                value = tag.get("content").strip()
                if value:
                    return value
        return None

    paragraphs: List[str] = []
    article_node = soup.find("article")
    text_nodes = article_node.find_all("p") if article_node else soup.find_all("p")
    for node in text_nodes:
        text = node.get_text(" ", strip=True)
        if len(text) >= 30:
            paragraphs.append(text)
    maintext = "\n\n".join(paragraphs[:80]).strip()

    parsed_url = urllib.parse.urlparse(url)
    author = meta_content({"name": "author"}, {"property": "author"}, {"property": "article:author"})
    published = meta_content(
        {"property": "article:published_time"},
        {"name": "pubdate"},
        {"name": "publishdate"},
        {"name": "date"},
    )

    return {
        "title": title,
        "description": meta_content({"name": "description"}, {"property": "og:description"}),
        "date_publish": published,
        "authors": [author] if author else [],
        "language": (soup.html.get("lang") if soup.html else None),
        "image_url": meta_content({"property": "og:image"}, {"name": "og:image"}),
        "source_domain": parsed_url.netloc,
        "url": url,
        "maintext": maintext,
        "maintext_len": len(maintext),
    }


def extract_article_from_url(url: str) -> Dict[str, Any]:
    if NewsPlease is not None:
        try:
            article = NewsPlease.from_url(url)
        except Exception:
            article = None
        if article is not None:
            item = article_to_dict(article)
            if any([item.get("title"), item.get("description"), item.get("maintext")]):
                return item
    return extract_article_fallback(url)


def strip_code_fence(text: str) -> str:
    candidate = text.strip()
    if not candidate.startswith("```"):
        return candidate

    lines = candidate.splitlines()
    if not lines:
        return candidate
    if lines[0].startswith("```"):
        lines = lines[1:]
    if lines and lines[-1].strip() == "```":
        lines = lines[:-1]
    return "\n".join(lines).strip()


def safe_json_loads(text: str) -> Optional[Any]:
    candidate = strip_code_fence(text)
    try:
        return json.loads(candidate)
    except Exception:
        return None


def normalize_openai_base_url(base_url: str) -> str:
    cleaned = (base_url or "").strip()
    if not cleaned:
        raise ValueError("missing OpenAI base URL")
    return cleaned.rstrip("/")


def build_responses_endpoint(base_url: str) -> str:
    normalized = normalize_openai_base_url(base_url)
    if normalized.endswith("/v1"):
        return f"{normalized}/responses"
    return f"{normalized}/v1/responses"


def extract_openai_response_text(response_payload: Dict[str, Any]) -> str:
    parts: List[str] = []
    for output_item in response_payload.get("output", []) or []:
        if not isinstance(output_item, dict):
            continue
        for content_item in output_item.get("content", []) or []:
            if not isinstance(content_item, dict):
                continue
            content_type = content_item.get("type")
            if content_type in {"output_text", "text"} and content_item.get("text"):
                parts.append(content_item["text"])
    if parts:
        return "\n".join(parts).strip()
    for key in ("output_text", "text"):
        value = response_payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def collect_url_citations(value: Any, out: List[Dict[str, Any]]) -> None:
    if isinstance(value, dict):
        annotations = value.get("annotations")
        if isinstance(annotations, list):
            for annotation in annotations:
                if not isinstance(annotation, dict):
                    continue
                url = annotation.get("url")
                if not url:
                    continue
                out.append(
                    {
                        "title": annotation.get("title"),
                        "url": url,
                        "type": annotation.get("type"),
                    }
                )
        for nested in value.values():
            collect_url_citations(nested, out)
    elif isinstance(value, list):
        for nested in value:
            collect_url_citations(nested, out)


def dedupe_citations(citations: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    seen = set()
    items = []
    for citation in citations:
        url = citation.get("url")
        key = url or json.dumps(citation, sort_keys=True, ensure_ascii=False)
        if key in seen:
            continue
        seen.add(key)
        items.append(citation)
    return items


def build_web_search_prompt(query: str, days: int, limit: int) -> str:
    window = compute_time_window(days)
    return (
        "你是一个情报检索助手。"
        f"请搜索 {window['date_from']} 到 {window['date_to']} 之间与“{query}”最相关的公开网页信息。"
        f"最多返回 {limit} 条高价值结果。"
        "输出严格 JSON，不要 Markdown，不要解释。"
        'JSON 格式为：{"summary":"一句话总结","items":[{"title":"","source":"","published_at":"","url":"","summary":"","evidence_level":""}]}。'
        "如果日期不确定，published_at 填空字符串。"
        "evidence_level 只允许：official / major_media / industry_media / social / unknown。"
    )


def call_openai_response_api(payload: Dict[str, Any], timeout_sec: int, runtime: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    runtime = runtime or resolve_openai_runtime()
    api_key = runtime.get("api_key") or ""
    if not api_key:
        raise HTTPException(status_code=500, detail="missing OPENAI API key; set INTEL_API_OPENAI_API_KEY or OPENAI_API_KEY")
    if httpx is None:
        raise HTTPException(status_code=500, detail="httpx is required for openai response api")

    base_url = normalize_openai_base_url(runtime.get("base_url") or OPENAI_BASE_URL)
    endpoint = build_responses_endpoint(base_url)
    with httpx.Client(timeout=timeout_sec, verify=bool(runtime.get("ssl_verify"))) as client:
        response = client.post(
            endpoint,
            json=payload,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "User-Agent": "intel-api-web-search/0.1",
            },
        )
        response.raise_for_status()
        raw = response.text
    response_payload = json.loads(raw)
    output_text = extract_openai_response_text(response_payload)
    parsed = safe_json_loads(output_text) if output_text else None
    citations: List[Dict[str, Any]] = []
    collect_url_citations(response_payload, citations)
    return {
        "endpoint": endpoint,
        "model": payload.get("model"),
        "tool_type": ",".join(tool.get("type", "") for tool in payload.get("tools", []) if isinstance(tool, dict)),
        "output_text": output_text,
        "parsed_output": parsed if isinstance(parsed, dict) else None,
        "citations": dedupe_citations(citations),
        "raw_response": response_payload,
    }


def call_openai_web_search(
    query: str,
    days: int,
    limit: int,
    model: str,
    tool_type: str,
    timeout_sec: int,
    runtime: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    payload = {
        "model": model,
        "input": build_web_search_prompt(query=query, days=days, limit=limit),
        "tools": [
            {
                "type": tool_type,
            }
        ],
    }
    return call_openai_response_api(payload=payload, timeout_sec=timeout_sec, runtime=runtime)


def build_query_expansion_prompt(query: str, days: int, max_queries: int) -> str:
    window = compute_time_window(days)
    return (
        "你是一个查询扩展器，不负责回答问题，只负责把用户查询改写成更适合公开互联网情报检索的搜索计划。"
        f"用户原始查询：{query}。"
        f"检索时间窗：{window['date_from']} 到 {window['date_to']}。"
        f"最多输出 {max_queries} 条查询。"
        "输出严格 JSON，不要 Markdown，不要解释。"
        'JSON 格式为：{"entity_type":"","reasoning_brief":"","canonical_terms":[],"aliases":[],"intent_terms":[],"relation_terms":[],"queries":[{"query":"","why":"","priority":1}]}。'
        "entity_type 只允许：person / company / theme / policy / unknown。"
        "queries 必须是适合搜索引擎或新闻检索的自然表达，避免空泛词，避免重复。"
        "优先把用户语言对齐到媒体语言、披露语言、英文规范名、常见动作词。"
        "如果用户查询本身已经很完整，也可以保留原词作为 priority 1。"
    )


def normalize_query_plan(plan: Optional[Dict[str, Any]], original_query: str, max_queries: int) -> Dict[str, Any]:
    safe_plan = plan if isinstance(plan, dict) else {}
    raw_queries = safe_plan.get("queries")
    normalized_queries: List[Dict[str, Any]] = []
    seen = set()

    if isinstance(raw_queries, list):
        for idx, item in enumerate(raw_queries):
            if isinstance(item, dict):
                query = (item.get("query") or "").strip()
                why = (item.get("why") or "").strip()
                priority = item.get("priority")
            else:
                query = str(item).strip()
                why = ""
                priority = idx + 1
            key = normalize_text(query)
            if not query or not key or key in seen:
                continue
            seen.add(key)
            normalized_queries.append(
                {
                    "query": query,
                    "why": why,
                    "priority": priority if isinstance(priority, int) else idx + 1,
                }
            )
            if len(normalized_queries) >= max_queries:
                break

    original_key = normalize_text(original_query)
    if not any(normalize_text(item["query"]) == original_key for item in normalized_queries):
        normalized_queries.insert(0, {"query": original_query, "why": "original_query", "priority": 1})

    safe_plan["entity_type"] = safe_plan.get("entity_type") or "unknown"
    safe_plan["canonical_terms"] = safe_plan.get("canonical_terms") if isinstance(safe_plan.get("canonical_terms"), list) else []
    safe_plan["aliases"] = safe_plan.get("aliases") if isinstance(safe_plan.get("aliases"), list) else []
    safe_plan["intent_terms"] = safe_plan.get("intent_terms") if isinstance(safe_plan.get("intent_terms"), list) else []
    safe_plan["relation_terms"] = safe_plan.get("relation_terms") if isinstance(safe_plan.get("relation_terms"), list) else []
    safe_plan["reasoning_brief"] = safe_plan.get("reasoning_brief")
    safe_plan["queries"] = normalized_queries[:max_queries]
    return safe_plan


def expand_query_with_llm(
    query: str,
    days: int,
    max_queries: int,
    timeout_sec: int = 25,
    runtime: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    runtime = runtime or resolve_openai_runtime()
    payload = {
        "model": runtime.get("query_expand_model") or OPENAI_QUERY_EXPAND_MODEL,
        "input": build_query_expansion_prompt(query=query, days=days, max_queries=max_queries),
    }
    result = call_openai_response_api(payload=payload, timeout_sec=timeout_sec, runtime=runtime)
    return {
        "model": runtime.get("query_expand_model") or OPENAI_QUERY_EXPAND_MODEL,
        "plan": normalize_query_plan(result.get("parsed_output"), query, max_queries=max_queries),
        "raw_output_text": result.get("output_text"),
        "raw_response": result.get("raw_response"),
    }


def build_followup_reader_prompt(
    query: str,
    days: int,
    max_queries: int,
    query_plan: Dict[str, Any],
    round_items: List[Dict[str, Any]],
    round_number: int,
    prior_themes: Optional[List[str]] = None,
) -> str:
    window = compute_time_window(days)
    compact_items = []
    for item in round_items[:10]:
        compact_items.append(
            {
                "title": item.get("title"),
                "source": item.get("source"),
                "published_at": item.get("published_at"),
                "summary": item.get("summary"),
                "matched_query": item.get("matched_query"),
            }
        )
    payload_text = json.dumps(
        {
            "original_query": query,
            "days": days,
            "date_from": window["date_from"],
            "date_to": window["date_to"],
            "round_number": round_number,
            "prior_themes": prior_themes or [],
            "query_plan": query_plan,
            "round_items": compact_items,
        },
        ensure_ascii=False,
    )
    return (
        "你是一个检索代理的下一轮支线规划器。"
        "你的任务不是总结新闻，而是读本轮搜索结果后，判断下一轮最值得追的研究支线。"
        f"当前统一检索时间窗是 {window['date_from']} 到 {window['date_to']}。"
        f"最多选择 {max_queries} 条下一轮查询。"
        "先识别潜在支线，再只保留最有信息增益的少数支线。"
        "优先考虑这些高层维度：政策/政治影响、监管、客户、供应链、事故/运营异常、资本市场、财报/披露、技术验证、竞争映射。"
        "不要机械重复已经跑过的查询，不要泛泛而谈，不要扩散太多。"
        "如果信息增益已经明显下降，允许返回空的 selected_queries。"
        "输出严格 JSON，不要 Markdown，不要解释。"
        'JSON 格式为：{"themes":[],"followup_reasoning":"","branches":[{"name":"","type":"","importance":0.0,"evidence_strength":0.0,"why_it_matters":"","queries":[{"query":"","why":"","priority":1,"lane":""}]}],"selected_branches":[""],"selected_queries":[{"query":"","why":"","priority":1,"lane":"","branch":""}],"routing_hints":{"policy":false,"filings":false,"x":false,"specialized_b":false}}。'
        'type 只允许：policy / regulation / customers / supply_chain / capital_markets / filings / social / technology / operations / competition / general。'
        'lane 只允许：policy / regulation / customers / supply_chain / capital_markets / filings / social / technology / operations / competition / general。'
        "importance 和 evidence_strength 用 0 到 1 的小数。"
        "selected_branches 填要继续追的支线名；selected_queries 是从这些支线里真正要执行的下一轮查询。"
        "下面是输入数据："
        f"{payload_text}"
    )


def normalize_round2_plan(plan: Optional[Dict[str, Any]], max_queries: int) -> Dict[str, Any]:
    safe_plan = plan if isinstance(plan, dict) else {}
    safe_plan["themes"] = safe_plan.get("themes") if isinstance(safe_plan.get("themes"), list) else []
    safe_plan["followup_reasoning"] = safe_plan.get("followup_reasoning")
    routing_hints = safe_plan.get("routing_hints") if isinstance(safe_plan.get("routing_hints"), dict) else {}
    safe_plan["routing_hints"] = {
        "policy": bool(routing_hints.get("policy")),
        "filings": bool(routing_hints.get("filings")),
        "x": bool(routing_hints.get("x")),
        "specialized_b": bool(routing_hints.get("specialized_b")),
    }
    allowed_types = {
        "policy",
        "regulation",
        "customers",
        "supply_chain",
        "capital_markets",
        "filings",
        "social",
        "technology",
        "operations",
        "competition",
        "general",
    }

    def normalize_branch_taxonomy(raw_value: Any) -> str:
        value = normalize_text(raw_value)
        if value in allowed_types:
            return value
        taxonomy_aliases = {
            "政策": "policy",
            "政治": "policy",
            "policy/politics": "policy",
            "监管": "regulation",
            "合规": "regulation",
            "客户": "customers",
            "订单": "customers",
            "供应链": "supply_chain",
            "供应": "supply_chain",
            "资本市场": "capital_markets",
            "融资": "capital_markets",
            "ipo": "capital_markets",
            "上市": "capital_markets",
            "财报": "filings",
            "披露": "filings",
            "公告": "filings",
            "社交": "social",
            "x": "social",
            "twitter": "social",
            "技术": "technology",
            "产品": "technology",
            "运营": "operations",
            "事故": "operations",
            "发射": "operations",
            "竞争": "competition",
            "对标": "competition",
        }
        for alias, target in taxonomy_aliases.items():
            if alias in value:
                return target
        return "general"

    normalized_branches: List[Dict[str, Any]] = []
    seen_branch_names = set()
    raw_branches = safe_plan.get("branches")
    if isinstance(raw_branches, list):
        for idx, branch in enumerate(raw_branches):
            if not isinstance(branch, dict):
                continue
            branch_name = (branch.get("name") or "").strip()
            branch_key = normalize_text(branch_name)
            if not branch_name or not branch_key or branch_key in seen_branch_names:
                continue
            seen_branch_names.add(branch_key)
            branch_type = normalize_branch_taxonomy(branch.get("type") or branch_name)
            raw_queries = branch.get("queries")
            normalized_branch_queries: List[Dict[str, Any]] = []
            seen_queries = set()
            if isinstance(raw_queries, list):
                for q_idx, item in enumerate(raw_queries):
                    if not isinstance(item, dict):
                        continue
                    query = (item.get("query") or "").strip()
                    key = normalize_text(query)
                    if not query or not key or key in seen_queries:
                        continue
                    seen_queries.add(key)
                    lane = normalize_branch_taxonomy(item.get("lane") or branch_type)
                    normalized_branch_queries.append(
                        {
                            "query": query,
                            "why": (item.get("why") or "").strip(),
                            "priority": item.get("priority") if isinstance(item.get("priority"), int) else q_idx + 1,
                            "lane": lane,
                            "branch": branch_name,
                        }
                    )
            normalized_branches.append(
                {
                    "name": branch_name,
                    "type": branch_type,
                    "importance": clamp_score(branch.get("importance")),
                    "evidence_strength": clamp_score(branch.get("evidence_strength")),
                    "why_it_matters": (branch.get("why_it_matters") or "").strip(),
                    "queries": normalized_branch_queries,
                }
            )

    selected_branches = safe_plan.get("selected_branches") if isinstance(safe_plan.get("selected_branches"), list) else []
    normalized_selected_branch_names = []
    selected_branch_keys = set()
    for name in selected_branches:
        branch_name = str(name or "").strip()
        branch_key = normalize_text(branch_name)
        if not branch_name or not branch_key or branch_key in selected_branch_keys:
            continue
        selected_branch_keys.add(branch_key)
        normalized_selected_branch_names.append(branch_name)

    normalized_selected_queries: List[Dict[str, Any]] = []
    selected_query_keys = set()
    raw_selected_queries = safe_plan.get("selected_queries")
    if isinstance(raw_selected_queries, list):
        for idx, item in enumerate(raw_selected_queries):
            if not isinstance(item, dict):
                continue
            query = (item.get("query") or "").strip()
            key = normalize_text(query)
            if not query or not key or key in selected_query_keys:
                continue
            selected_query_keys.add(key)
            lane = normalize_branch_taxonomy(item.get("lane") or item.get("branch"))
            normalized_selected_queries.append(
                {
                    "query": query,
                    "why": (item.get("why") or "").strip(),
                    "priority": item.get("priority") if isinstance(item.get("priority"), int) else idx + 1,
                    "lane": lane,
                    "branch": (item.get("branch") or "").strip(),
                }
            )
            if len(normalized_selected_queries) >= max_queries:
                break

    if not normalized_selected_queries and normalized_branches:
        branch_lookup = {normalize_text(branch["name"]): branch for branch in normalized_branches}
        candidate_branches = []
        if normalized_selected_branch_names:
            for name in normalized_selected_branch_names:
                branch = branch_lookup.get(normalize_text(name))
                if branch:
                    candidate_branches.append(branch)
        else:
            candidate_branches = sorted(
                normalized_branches,
                key=lambda item: (item.get("importance", 0.0), item.get("evidence_strength", 0.0)),
                reverse=True,
            )
        for branch in candidate_branches:
            for item in branch.get("queries", []):
                key = normalize_text(item.get("query"))
                if not key or key in selected_query_keys:
                    continue
                selected_query_keys.add(key)
                normalized_selected_queries.append(item)
                if len(normalized_selected_queries) >= max_queries:
                    break
            if len(normalized_selected_queries) >= max_queries:
                break

    safe_plan["branches"] = normalized_branches
    safe_plan["selected_branches"] = normalized_selected_branch_names
    safe_plan["selected_queries"] = normalized_selected_queries[:max_queries]
    safe_plan["round2_queries"] = safe_plan["selected_queries"]
    return safe_plan


def has_policy_branch(plan: Dict[str, Any]) -> bool:
    for theme in plan.get("themes", []) or []:
        normalized = normalize_text(theme)
        if "policy" in normalized or "regulation" in normalized or "监管" in theme or "政策" in theme:
            return True
    for item in plan.get("selected_queries", []) or plan.get("round2_queries", []) or []:
        lane = normalize_text(item.get("lane"))
        query = normalize_text(item.get("query"))
        if lane in {"policy", "regulation"}:
            return True
        if any(term in query for term in ["policy", "regulation", "white house", "trump", "faa", "dod", "nasa", "export control", "tariff"]):
            return True
    for branch in plan.get("branches", []) or []:
        branch_type = normalize_text(branch.get("type"))
        branch_name = normalize_text(branch.get("name"))
        if branch_type in {"policy", "regulation"}:
            return True
        if any(term in branch_name for term in ["policy", "regulation", "监管", "政策"]):
            return True
    hints = plan.get("routing_hints") or {}
    return bool(hints.get("policy"))


def clamp_score(value: Any) -> float:
    try:
        score = float(value)
    except (TypeError, ValueError):
        return 0.0
    return max(0.0, min(1.0, score))


def default_policy_branch(query: str) -> Dict[str, Any]:
    return {
        "name": "政策/监管外生影响",
        "type": "policy",
        "importance": 0.55,
        "evidence_strength": 0.2,
        "why_it_matters": "公司类对象默认保留政策、监管、政府合同与外部政治变量支线。",
        "queries": [
            {
                "query": f"{query} policy OR regulation OR White House OR FAA OR NASA OR DoD June 2026",
                "why": "补一条政策/监管/政府合同外生影响支线。",
                "priority": 99,
                "lane": "policy",
                "branch": "政策/监管外生影响",
            }
        ],
    }


def analyze_followup_results_with_llm(
    query: str,
    days: int,
    max_queries: int,
    query_plan: Dict[str, Any],
    round_items: List[Dict[str, Any]],
    round_number: int,
    prior_themes: Optional[List[str]] = None,
    timeout_sec: int = 25,
    runtime: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    runtime = runtime or resolve_openai_runtime()
    payload = {
        "model": runtime.get("query_expand_model") or OPENAI_QUERY_EXPAND_MODEL,
        "input": build_followup_reader_prompt(
            query=query,
            days=days,
            max_queries=max_queries,
            query_plan=query_plan,
            round_items=round_items,
            round_number=round_number,
            prior_themes=prior_themes,
        ),
    }
    result = call_openai_response_api(payload=payload, timeout_sec=timeout_sec, runtime=runtime)
    return {
        "model": runtime.get("query_expand_model") or OPENAI_QUERY_EXPAND_MODEL,
        "plan": normalize_round2_plan(result.get("parsed_output"), max_queries=max_queries),
        "raw_output_text": result.get("output_text"),
        "raw_response": result.get("raw_response"),
    }


def filing_to_dict(filing: Any) -> Dict[str, Any]:
    return {
        "company": getattr(filing, "company", None),
        "cik": str(getattr(filing, "cik", "")),
        "form": getattr(filing, "form", None),
        "filing_date": isoformat_or_none(getattr(filing, "filing_date", None)),
        "accession_no": getattr(filing, "accession_no", None),
        "primary_document": getattr(filing, "primary_document", None),
        "homepage_url": getattr(filing, "homepage_url", None),
        "filing_url": getattr(filing, "filing_url", None),
    }


def parse_forms(forms: str) -> List[str]:
    return [item.strip() for item in forms.split(",") if item.strip()]


def google_news_search_feed(query: str, hl: str = "en-US", gl: str = "US", ceid: str = "US:en") -> str:
    quoted = urllib.parse.quote(query)
    return f"https://news.google.com/rss/search?q={quoted}&hl={hl}&gl={gl}&ceid={ceid}"


BASE_GOOGLE_NEWS_VARIANTS = [
    {"hl": "en-US", "gl": "US", "ceid": "US:en", "label": "google_news_us"},
    {"hl": "en-GB", "gl": "GB", "ceid": "GB:en", "label": "google_news_uk"},
]

CJK_GOOGLE_NEWS_VARIANT = {"hl": "zh-TW", "gl": "TW", "ceid": "TW:zh-Hant", "label": "google_news_tw"}
KOREAN_GOOGLE_NEWS_VARIANT = {"hl": "ko", "gl": "KR", "ceid": "KR:ko", "label": "google_news_kr"}

GLOBAL_SOURCE_POOL = [
    {"label": "reuters", "domain": "reuters.com"},
    {"label": "bloomberg", "domain": "bloomberg.com"},
    {"label": "wsj", "domain": "wsj.com"},
    {"label": "ft", "domain": "ft.com"},
    {"label": "cnbc", "domain": "cnbc.com"},
    {"label": "yahoo_finance", "domain": "finance.yahoo.com"},
    {"label": "bbc", "domain": "bbc.com"},
    {"label": "ap", "domain": "apnews.com"},
]

POLICY_POLITICS_SOURCE_POOL = [
    {"label": "white_house", "domain": "whitehouse.gov"},
    {"label": "ofac", "domain": "ofac.treasury.gov"},
    {"label": "bis", "domain": "bis.gov"},
    {"label": "ustr", "domain": "ustr.gov"},
    {"label": "ftc", "domain": "ftc.gov"},
    {"label": "doj_antitrust", "domain": "justice.gov"},
    {"label": "federal_reserve", "domain": "federalreserve.gov"},
    {"label": "treasury", "domain": "treasurydirect.gov"},
    {"label": "federal_register", "domain": "federalregister.gov"},
]

SEMICONDUCTOR_SOURCE_POOL = [
    {"label": "digitimes", "domain": "digitimes.com"},
    {"label": "tomshardware", "domain": "tomshardware.com"},
    {"label": "eetimes", "domain": "eetimes.com"},
    {"label": "trendforce", "domain": "trendforce.com"},
    {"label": "anandtech", "domain": "anandtech.com"},
    {"label": "crn_asia", "domain": "crnasia.com"},
    {"label": "businesskorea", "domain": "businesskorea.co.kr"},
    {"label": "koreajoongangdaily", "domain": "koreajoongangdaily.joins.com"},
]

KOREA_SOURCE_POOL = [
    {"label": "businesskorea", "domain": "businesskorea.co.kr"},
    {"label": "koreajoongangdaily", "domain": "koreajoongangdaily.joins.com"},
    {"label": "koreatimes", "domain": "koreatimes.co.kr"},
    {"label": "maeil_business", "domain": "pulsenews.co.kr"},
]

TAIWAN_SOURCE_POOL = [
    {"label": "digitimes", "domain": "digitimes.com"},
    {"label": "udn", "domain": "udn.com"},
    {"label": "cna", "domain": "focustaiwan.tw"},
]

QUANTUM_SOURCE_POOL = [
    {"label": "quanta", "domain": "quantamagazine.org"},
    {"label": "the_quantum_insider", "domain": "thequantuminsider.com"},
    {"label": "quantum_computing_report", "domain": "quantumcomputingreport.com"},
    {"label": "ibm_quantum", "domain": "ibm.com"},
    {"label": "google_quantum", "domain": "blog.google"},
    {"label": "ionq", "domain": "ionq.com"},
    {"label": "rigetti", "domain": "rigetti.com"},
    {"label": "psiquantum", "domain": "psiquantum.com"},
]

PHYSICAL_AI_SOURCE_POOL = [
    {"label": "nvidia_blog", "domain": "blogs.nvidia.com"},
    {"label": "nvidia_newsroom", "domain": "nvidianews.nvidia.com"},
    {"label": "ieee_spectrum", "domain": "spectrum.ieee.org"},
    {"label": "figure", "domain": "figure.ai"},
    {"label": "apptronik", "domain": "apptronik.com"},
    {"label": "agility_robotics", "domain": "agilityrobotics.com"},
    {"label": "boston_dynamics", "domain": "bostondynamics.com"},
    {"label": "waymo", "domain": "waymo.com"},
    {"label": "reuters", "domain": "reuters.com"},
]

SPACE_SOURCE_POOL = [
    {"label": "spacenews", "domain": "spacenews.com"},
    {"label": "payloadspace", "domain": "payloadspace.com"},
    {"label": "nasa", "domain": "nasa.gov"},
    {"label": "spacex", "domain": "spacex.com"},
    {"label": "rocketlab", "domain": "rocketlabcorp.com"},
    {"label": "faa", "domain": "faa.gov"},
]

BIOTECH_SOURCE_POOL = [
    {"label": "biospace", "domain": "biospace.com"},
    {"label": "gen_eng_news", "domain": "genengnews.com"},
    {"label": "fierce_biotech", "domain": "fiercebiotech.com"},
    {"label": "fierce_pharma", "domain": "fiercepharma.com"},
    {"label": "fda", "domain": "fda.gov"},
    {"label": "clinicaltrials", "domain": "clinicaltrials.gov"},
    {"label": "reuters", "domain": "reuters.com"},
]

AUTONOMY_SOURCE_POOL = [
    {"label": "waymo", "domain": "waymo.com"},
    {"label": "zoox", "domain": "zoox.com"},
    {"label": "aurora", "domain": "aurora.tech"},
    {"label": "wayve", "domain": "wayve.ai"},
    {"label": "reuters", "domain": "reuters.com"},
    {"label": "nvidia_blog", "domain": "blogs.nvidia.com"},
    {"label": "nvidia_newsroom", "domain": "nvidianews.nvidia.com"},
]

VALIDATED_SECTOR_SOURCES = {
    "quantum": [
        {"label": "quanta", "domain": "quantamagazine.org", "status": "validated", "notes": "High-quality research coverage; public and accessible"},
        {"label": "the_quantum_insider", "domain": "thequantuminsider.com", "status": "validated", "notes": "Quantum industry vertical; publicly accessible"},
        {"label": "quantum_computing_report", "domain": "quantumcomputingreport.com", "status": "validated", "notes": "Quantum industry tracking and company coverage"},
        {"label": "ibm_quantum", "domain": "ibm.com", "status": "validated", "notes": "Official IBM Quantum / Research signal"},
        {"label": "google_quantum", "domain": "blog.google", "status": "validated", "notes": "Official Google announcements, sparse but clean"},
        {"label": "ionq", "domain": "ionq.com", "status": "validated", "notes": "Official company updates; investor-heavy"},
        {"label": "rigetti", "domain": "rigetti.com", "status": "validated", "notes": "Official company updates; investor-heavy"},
        {"label": "psiquantum", "domain": "psiquantum.com", "status": "validated", "notes": "Official company updates; useful for private-market quantum signal"},
    ],
    "physical_ai_robotics": [
        {"label": "nvidia_blog", "domain": "blogs.nvidia.com", "status": "validated", "notes": "High signal for Physical AI ecosystem moves"},
        {"label": "nvidia_newsroom", "domain": "nvidianews.nvidia.com", "status": "validated", "notes": "Partnership and product launch signal"},
        {"label": "ieee_spectrum", "domain": "spectrum.ieee.org", "status": "validated", "notes": "Strong engineering and robotics editorial signal"},
        {"label": "figure", "domain": "figure.ai", "status": "validated", "notes": "Official humanoid robot company updates"},
        {"label": "apptronik", "domain": "apptronik.com", "status": "validated", "notes": "Official humanoid robotics company updates"},
        {"label": "agility_robotics", "domain": "agilityrobotics.com", "status": "validated", "notes": "Official humanoid deployment and product updates"},
        {"label": "boston_dynamics", "domain": "bostondynamics.com", "status": "validated", "notes": "Official robotics platform and deployment signal"},
        {"label": "waymo", "domain": "waymo.com", "status": "validated", "notes": "Useful crossover for autonomy / robotics deployment"},
        {"label": "reuters", "domain": "reuters.com", "status": "validated", "notes": "Independent verification layer"},
    ],
    "commercial_space": [
        {"label": "spacenews", "domain": "spacenews.com", "status": "validated", "notes": "Strong commercial space vertical outlet"},
        {"label": "payloadspace", "domain": "payloadspace.com", "status": "validated", "notes": "Commercial space vertical with good company and launch coverage"},
        {"label": "nasa", "domain": "nasa.gov", "status": "validated", "notes": "Official mission and program source"},
        {"label": "spacex", "domain": "spacex.com", "status": "validated", "notes": "Official company updates"},
        {"label": "rocketlab", "domain": "rocketlabcorp.com", "status": "validated", "notes": "Official company updates; lighter signal"},
        {"label": "faa", "domain": "faa.gov", "status": "validated", "notes": "Regulatory launch signal"},
    ],
    "biotech": [
        {"label": "biospace", "domain": "biospace.com", "status": "validated", "notes": "Public biotech industry coverage; accessible"},
        {"label": "gen_eng_news", "domain": "genengnews.com", "status": "validated", "notes": "Engineering and biotech industry coverage; accessible"},
        {"label": "fierce_biotech", "domain": "fiercebiotech.com", "status": "validated", "notes": "High-signal biotech industry coverage"},
        {"label": "fierce_pharma", "domain": "fiercepharma.com", "status": "validated", "notes": "High-signal pharma industry coverage"},
        {"label": "fda", "domain": "fda.gov", "status": "validated", "notes": "Official regulatory source"},
        {"label": "clinicaltrials", "domain": "clinicaltrials.gov", "status": "validated", "notes": "Official trial registry"},
        {"label": "reuters", "domain": "reuters.com", "status": "validated", "notes": "Independent verification layer"},
    ],
    "autonomous_driving": [
        {"label": "waymo", "domain": "waymo.com", "status": "validated", "notes": "Official deployment and safety updates"},
        {"label": "zoox", "domain": "zoox.com", "status": "validated", "notes": "Official robotaxi company updates"},
        {"label": "aurora", "domain": "aurora.tech", "status": "validated", "notes": "Official autonomous trucking and platform updates"},
        {"label": "wayve", "domain": "wayve.ai", "status": "validated", "notes": "Official embodied AI and autonomy updates"},
        {"label": "reuters", "domain": "reuters.com", "status": "validated", "notes": "Independent coverage of robotaxi ecosystem"},
        {"label": "nvidia_blog", "domain": "blogs.nvidia.com", "status": "validated", "notes": "Infrastructure / autonomy ecosystem signal"},
        {"label": "nvidia_newsroom", "domain": "nvidianews.nvidia.com", "status": "validated", "notes": "Partnership and platform signal"},
    ],
}

OFFICIAL_DISCLOSURE_SOURCES = [
    {
        "label": "sec_edgar",
        "source": "SEC EDGAR",
        "status": "validated",
        "coverage": "US listed company filings, latest filings, structured financials",
    },
    {
        "label": "cninfo",
        "source": "巨潮资讯",
        "status": "validated",
        "coverage": "A-share announcements and reports",
    },
]

OFFICIAL_CORPORATE_SOURCES = [
    {
        "label": "company_ir",
        "source": "Company Investor Relations pages",
        "status": "validated",
        "coverage": "Earnings releases, shareholder letters, investor decks, event calendars",
        "notes": "Per-company official source pattern; not a single fixed domain",
    },
    {
        "label": "earnings_webcast",
        "source": "Company earnings webcasts / transcripts",
        "status": "validated",
        "coverage": "Quarterly earnings calls, prepared remarks, Q&A audio/video",
        "notes": "Usually linked from company IR pages",
    },
]

OFFICIAL_POLICY_SOURCES = [
    {
        "label": "white_house_presidential_actions",
        "source": "White House Presidential Actions",
        "url": "https://www.whitehouse.gov/presidential-actions/",
        "status": "validated",
        "coverage": "Executive orders, presidential memoranda, official action statements",
    },
    {
        "label": "ofac_recent_actions",
        "source": "OFAC Recent Actions",
        "url": "https://ofac.treasury.gov/recent-actions",
        "status": "validated",
        "coverage": "Sanctions updates, general licenses, FAQs, list changes",
    },
    {
        "label": "ofac_press_releases",
        "source": "OFAC Press Releases",
        "url": "https://ofac.treasury.gov/press-releases",
        "status": "validated",
        "coverage": "Sanctions-related press releases and enforcement notices",
    },
    {
        "label": "bis_news_updates",
        "source": "BIS News & Updates",
        "url": "https://www.bis.gov/news-updates",
        "status": "validated",
        "coverage": "Export controls, entity list updates, BIS policy changes",
    },
    {
        "label": "bis_ear",
        "source": "BIS EAR",
        "url": "https://www.bis.gov/regulations/ear",
        "status": "validated",
        "coverage": "Export Administration Regulations reference and rule changes",
    },
    {
        "label": "ustr_press_releases",
        "source": "USTR Press Releases",
        "url": "https://ustr.gov/about-us/policy-offices/press-office/press-releases",
        "status": "validated",
        "coverage": "Trade policy, tariffs, Section 301 actions, hearings and consultations",
    },
    {
        "label": "ftc_merger_review",
        "source": "FTC Merger Review",
        "url": "https://www.ftc.gov/enforcement/merger-review",
        "status": "validated",
        "coverage": "Merger review process and public competition enforcement guidance",
    },
    {
        "label": "doj_antitrust_case_filings",
        "source": "DOJ Antitrust Case Filings",
        "url": "https://www.justice.gov/atr/antitrust-case-filings",
        "status": "validated",
        "coverage": "Antitrust merger cases, competition enforcement case filings",
    },
    {
        "label": "federal_reserve",
        "source": "Federal Reserve",
        "url": "https://www.federalreserve.gov/",
        "status": "validated",
        "coverage": "FOMC, speeches, policy statements, macro and financial system signals",
    },
    {
        "label": "treasury_auctions",
        "source": "TreasuryDirect Auctions",
        "url": "https://www.treasurydirect.gov/auctions/announcements-data-results/",
        "status": "validated",
        "coverage": "Treasury auction announcements, data, and results",
    },
]

OFFICIAL_POLICY_SOURCE_CONFIG = {
    "white_house_presidential_actions": {
        "source": "White House Presidential Actions",
        "url": "https://www.whitehouse.gov/presidential-actions/",
        "domains": ["whitehouse.gov"],
        "include_keywords": ["presidential", "executive", "memorandum", "proclamation", "order"],
        "exclude_titles": ["Executive Orders", "Proclamations", "Presidential Actions"],
        "signal_tags": ["executive_action", "geopolitics"],
    },
    "ofac_recent_actions": {
        "source": "OFAC Recent Actions",
        "url": "https://ofac.treasury.gov/recent-actions",
        "domains": ["ofac.treasury.gov"],
        "include_keywords": ["sanctions", "ofac", "general license", "faq", "action", "recent"],
        "signal_tags": ["sanctions", "geopolitics"],
    },
    "ofac_press_releases": {
        "source": "OFAC Press Releases",
        "url": "https://ofac.treasury.gov/press-releases",
        "domains": ["ofac.treasury.gov"],
        "include_keywords": ["press release", "sanctions", "ofac", "treasury"],
        "exclude_keywords": ["sanctions-programs-and-country-information", "sanctions-list-service", "other-ofac-sanctions-lists"],
        "signal_tags": ["sanctions", "geopolitics"],
    },
    "bis_news_updates": {
        "source": "BIS News & Updates",
        "url": "https://www.bis.gov/news-updates",
        "domains": ["bis.gov"],
        "include_keywords": ["export", "entity list", "bis", "rule", "update", "control"],
        "signal_tags": ["export_control", "industrial_policy"],
    },
    "bis_ear": {
        "source": "BIS EAR",
        "url": "https://www.bis.gov/regulations/ear",
        "domains": ["bis.gov"],
        "include_keywords": ["ear", "regulation", "export", "rule", "control"],
        "exclude_keywords": ["interactive-commerce-control-list"],
        "signal_tags": ["export_control", "regulation"],
    },
    "ustr_press_releases": {
        "source": "USTR Press Releases",
        "url": "https://ustr.gov/about-us/policy-offices/press-office/press-releases",
        "domains": ["ustr.gov"],
        "include_keywords": ["press release", "tariff", "section 301", "trade", "ustr"],
        "signal_tags": ["tariff", "trade_policy"],
    },
    "ftc_merger_review": {
        "source": "FTC Merger Review",
        "url": "https://www.ftc.gov/enforcement/merger-review",
        "domains": ["ftc.gov"],
        "include_keywords": ["merger", "competition", "antitrust", "ftc", "review"],
        "exclude_titles": ["Steps in the Review Process"],
        "signal_tags": ["antitrust", "merger_review"],
    },
    "doj_antitrust_case_filings": {
        "source": "DOJ Antitrust Case Filings",
        "url": "https://www.justice.gov/atr/antitrust-case-filings",
        "domains": ["justice.gov"],
        "include_keywords": ["antitrust", "case", "filing", "merger", "justice"],
        "exclude_keywords": ["cases_index_list_case_type", "cases_index_list_case_violation"],
        "signal_tags": ["antitrust", "merger_review"],
    },
    "federal_reserve": {
        "source": "Federal Reserve",
        "url": "https://www.federalreserve.gov/",
        "domains": ["federalreserve.gov"],
        "include_keywords": ["fomc", "speech", "statement", "minutes", "federal reserve", "press release"],
        "exclude_titles": ["Board of Governors of the Federal Reserve System", "Federal Reserve Banks", "Structure of the Federal Reserve System"],
        "signal_tags": ["macro_policy", "rates", "liquidity"],
    },
    "treasury_auctions": {
        "source": "TreasuryDirect Auctions",
        "url": "https://www.treasurydirect.gov/auctions/announcements-data-results/",
        "domains": ["treasurydirect.gov"],
        "include_keywords": ["auction", "announcement", "treasury", "bill", "note", "bond"],
        "exclude_titles": ["Announcements, Data & Results"],
        "signal_tags": ["rates", "liquidity", "funding"],
    },
}

PROFESSIONAL_RESEARCH_SOURCES = [
    {
        "label": "alphasense",
        "source": "AlphaSense",
        "url": "https://www.alpha-sense.com/blog/product/turbulent-market-expert-call-transcripts/",
        "status": "public_entry_only",
        "coverage": "Expert transcripts, sell-side search, transcript search",
        "notes": "Professional / paid platform; not treated as anonymous fulltext source",
    },
    {
        "label": "glg_library",
        "source": "GLG Library",
        "url": "https://glg.com/how-we-help/expert-content/library",
        "status": "public_entry_only",
        "coverage": "Expert call transcripts and insight library",
        "notes": "Professional / paid platform; useful as source-type reference",
    },
    {
        "label": "tegus",
        "source": "Tegus",
        "url": "https://www.tegus.com/",
        "status": "public_entry_only",
        "coverage": "Expert transcript and investment research workflow platform",
        "notes": "Professional / paid platform; not anonymous scraping target",
    },
    {
        "label": "factset",
        "source": "FactSet",
        "url": "https://insight.factset.com/",
        "status": "public_entry_only",
        "coverage": "Professional market data, transcript and ownership research workflow",
        "notes": "Professional / paid platform; public site mainly documents capabilities",
    },
]

OFFICIAL_SITE_ADAPTERS = [
    {
        "label": "hengerda_official",
        "source": "恒而达官网",
        "match": ["300946", "恒而达", "sms maschinenbau"],
        "pages": [
            "http://www.hengda-china.com/",
        ],
        "keywords": ["螺纹磨床", "滚珠丝杠", "行星滚柱丝杠", "工业母机", "SMS Maschinenbau", "数控装备"],
    },
    {
        "label": "qinchuan_official",
        "source": "秦川机官网",
        "match": ["000837", "秦川机床"],
        "pages": [
            "https://www.qinchuan.com/",
            "https://www.qinchuan.com/list-8-1.html",
        ],
        "keywords": ["螺纹磨床", "丝杠", "滚珠丝杠", "机器人减速器", "数控", "精密磨床"],
    },
    {
        "label": "dingsmotion_official",
        "source": "DINGS Official",
        "match": ["鼎智科技", "micro ball screw", "微型丝杠", "linear actuator"],
        "pages": [
            "https://www.dingsmotion.com/",
        ],
        "keywords": ["Stepper Ball Screw Linear Actuator", "Lead Screw Linear Actuator", "Gripper", "Linear Actuator", "Ball Screw"],
    },
    {
        "label": "huachen_official",
        "source": "华辰装备官网",
        "match": ["300809", "华辰装备", "华辰精密装备"],
        "pages": [
            "https://www.hiecise.com/",
            "https://www.hiecise.com/cpzx/jmlwmc/551.html",
            "https://www.hiecise.com/gsyw/",
        ],
        "keywords": ["精密螺纹磨床", "数控直线导轨磨床", "亚μ磨削", "机器人制造", "华辰资讯", "高端精密装备"],
    },
]


def source_from_title(title: Optional[str]) -> Optional[str]:
    if not title or " - " not in title:
        return None
    return title.rsplit(" - ", 1)[-1].strip()


def base_title(title: Optional[str]) -> str:
    if not title:
        return ""
    if " - " in title:
        return title.rsplit(" - ", 1)[0].strip()
    return title.strip()


def normalize_text(value: Optional[str]) -> str:
    if not value:
        return ""
    lowered = value.lower()
    lowered = re.sub(r"[^a-z0-9\u4e00-\u9fff\uac00-\ud7af\s]", " ", lowered)
    lowered = re.sub(r"\s+", " ", lowered).strip()
    return lowered


def http_get_text(url: str, timeout: int = 10, headers: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    request_headers = {"User-Agent": "Mozilla/5.0"}
    if "sec.gov" in url:
        request_headers["User-Agent"] = SEC_IDENTITY
    if headers:
        request_headers.update(headers)
    request = urllib.request.Request(url, headers=request_headers)
    open_kwargs: Dict[str, Any] = {"timeout": timeout}
    if "treasurydirect.gov" in url:
        open_kwargs["context"] = ssl._create_unverified_context()
    with urllib.request.urlopen(request, **open_kwargs) as response:
        raw = response.read()
        charset = response.headers.get_content_charset() or "utf-8"
        text = raw.decode(charset, errors="ignore")
        return {
            "url": response.geturl(),
            "text": text,
            "content_type": response.headers.get("Content-Type"),
        }


def clean_anchor_text(value: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(value or "")).strip()


def absolutize_url(base_url: str, href: str) -> Optional[str]:
    href = (href or "").strip()
    if not href or href.startswith("#") or href.startswith("javascript:") or href.startswith("mailto:"):
        return None
    return urllib.parse.urljoin(base_url, href)


def extract_links_from_html(base_url: str, html_text: str) -> List[Dict[str, str]]:
    if bs4 is not None:
        soup = bs4.BeautifulSoup(html_text, "html.parser")
        items: List[Dict[str, str]] = []
        for anchor in soup.find_all("a", href=True):
            url = absolutize_url(base_url, anchor.get("href"))
            text = clean_anchor_text(anchor.get_text(" ", strip=True))
            if url:
                items.append({"title": text, "url": url})
        return items

    pattern = re.compile(r'<a[^>]+href=["\']([^"\']+)["\'][^>]*>(.*?)</a>', re.IGNORECASE | re.DOTALL)
    items: List[Dict[str, str]] = []
    for href, inner in pattern.findall(html_text):
        url = absolutize_url(base_url, href)
        text = clean_anchor_text(re.sub(r"<[^>]+>", " ", inner))
        if url:
            items.append({"title": text, "url": url})
    return items


def decode_duckduckgo_redirect(url: str) -> str:
    try:
        parsed = urllib.parse.urlparse(url)
        query = urllib.parse.parse_qs(parsed.query)
        if "uddg" in query and query["uddg"]:
            return urllib.parse.unquote(query["uddg"][0])
    except Exception:
        return url
    return url


def domain_matches(url: str, domains: List[str]) -> bool:
    try:
        host = urllib.parse.urlparse(url).netloc.lower()
    except Exception:
        return False
    return any(host == domain or host.endswith(f".{domain}") for domain in domains)


def extract_date_hint(text: str) -> Optional[str]:
    if not text:
        return None
    patterns = [
        r"\b(20\d{2}-\d{2}-\d{2})\b",
        r"\b(20\d{2}/\d{2}/\d{2})\b",
        r"/(20\d{2})/(\d{2})/(\d{2})/",
        r"\b((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2},\s+20\d{2})\b",
    ]
    lowered = text.lower()
    for pattern in patterns:
        match = re.search(pattern, lowered, re.IGNORECASE)
        if match:
            if len(match.groups()) == 3 and match.group(1).startswith("20"):
                return f"{match.group(1)}-{match.group(2)}-{match.group(3)}"
            return match.group(1)
    return None


def policy_signal_tags(source_label: str, title: str, url: str) -> List[str]:
    tags = list(OFFICIAL_POLICY_SOURCE_CONFIG.get(source_label, {}).get("signal_tags", []))
    blob = f"{title} {url}".lower()
    rules = [
        ("sanctions", ["sanction", "designation", "general license", "ofac"]),
        ("export_control", ["export control", "entity list", "ear", "chip-related", "diffusion rule"]),
        ("tariff", ["tariff", "section 301", "duties"]),
        ("antitrust", ["antitrust", "competition"]),
        ("merger_review", ["merger"]),
        ("macro_policy", ["fomc", "minutes", "statement", "speech", "federal reserve"]),
        ("rates", ["auction", "bill", "bond", "note", "yield"]),
        ("geopolitics", ["national security", "russia", "china", "syria", "cuba", "north korea", "iran"]),
        ("industrial_policy", ["semiconductor", "artificial intelligence", "firearms rule", "fab", "manufacturing"]),
        ("regulation", ["rule", "regulation", "memorandum", "executive order"]),
    ]
    for tag, keywords in rules:
        if any(keyword in blob for keyword in keywords) and tag not in tags:
            tags.append(tag)
    return tags


def split_csv_param(value: Optional[str]) -> List[str]:
    if not value:
        return []
    return [item.strip() for item in value.split(",") if item.strip()]


def should_skip_policy_link(source_config: Dict[str, Any], title: str, url: str) -> bool:
    title_clean = clean_anchor_text(title)
    lowered_title = title_clean.lower()
    lowered_url = url.lower()
    for exact in source_config.get("exclude_titles", []):
        if lowered_title == exact.lower():
            return True
    for bad in source_config.get("exclude_keywords", []):
        bad_lower = bad.lower()
        if bad_lower in lowered_title or bad_lower in lowered_url:
            return True
    if lowered_title in {"skip to main content", "home"}:
        return True
    return False


def policy_link_score(source_config: Dict[str, Any], title: str, url: str) -> int:
    score = 0
    blob = f"{title} {url}".lower()
    if domain_matches(url, source_config["domains"]):
        score += 2
    for keyword in source_config.get("include_keywords", []):
        if keyword.lower() in blob:
            score += 2
    if re.search(r"/(news|press|release|actions?|speeches|statement|minutes|auction|rule|filings?)/", blob):
        score += 2
    if url.lower().endswith(".pdf"):
        score += 1
    if len(clean_anchor_text(title)) >= 20:
        score += 1
    if any(
        bad in blob
        for bad in [
            "privacy",
            "contact",
            "search",
            "facebook",
            "linkedin",
            "instagram",
            "youtube",
            "skip to main content",
            "default.htm",
            "sanctions-list-service",
            "other-ofac-sanctions-lists",
            "interactive-commerce-control-list",
        ]
    ):
        score -= 6
    return score


def fetch_official_policy_entries(source_label: str, limit: int = 10, timeout: int = 10) -> Dict[str, Any]:
    config = OFFICIAL_POLICY_SOURCE_CONFIG.get(source_label)
    if not config:
        return {"items": [], "errors": [{"source": source_label, "error": "unknown source"}]}

    try:
        payload = http_get_text(config["url"], timeout=timeout)
    except Exception as exc:
        return {"items": [], "errors": [{"source": source_label, "url": config["url"], "error": str(exc)}]}

    raw_links = extract_links_from_html(payload["url"], payload["text"])
    items: List[Dict[str, Any]] = []
    seen = set()
    for link in raw_links:
        title = clean_anchor_text(link.get("title", ""))
        url = link.get("url") or ""
        if not title or not url:
            continue
        if should_skip_policy_link(config, title, url):
            continue
        score = policy_link_score(config, title, url)
        if score < 4:
            continue
        key = (title, url)
        if key in seen:
            continue
        seen.add(key)
        items.append(
            {
                "source_label": source_label,
                "source": config["source"],
                "title": title,
                "url": url,
                "published_hint": extract_date_hint(f"{title} {url}"),
                "source_page": payload["url"],
                "score": score,
                "type": "official_policy",
                "signal_tags": policy_signal_tags(source_label, title, url),
            }
        )

    items.sort(key=lambda item: item["score"], reverse=True)
    return {"items": items[:limit], "errors": []}


def duckduckgo_search(query: str, timeout: int = 10, limit: int = 8) -> List[Dict[str, str]]:
    search_url = f"https://html.duckduckgo.com/html/?q={urllib.parse.quote(query)}"
    try:
        payload = http_get_text(search_url, timeout=timeout)
    except Exception:
        return []
    links = extract_links_from_html(search_url, payload["text"])
    items: List[Dict[str, str]] = []
    seen = set()
    for item in links:
        title = item.get("title") or ""
        raw_url = item.get("url") or ""
        url = decode_duckduckgo_redirect(raw_url)
        if not url.startswith("http"):
            continue
        key = (title, url)
        if key in seen:
            continue
        seen.add(key)
        items.append({"title": title, "url": url})
        if len(items) >= limit:
            break
    return items


def ir_result_score(title: str, url: str) -> int:
    score = 0
    blob = f"{title} {url}".lower()
    if "investor" in blob or "investors" in blob:
        score += 4
    if "/ir" in blob or "ir." in blob:
        score += 3
    if "shareholder" in blob:
        score += 2
    if "events" in blob or "presentations" in blob:
        score += 2
    if "earnings" in blob or "results" in blob or "quarter" in blob:
        score += 2
    if any(host in blob for host in ["sec.gov", "news.google.com", "reuters.com", "bloomberg.com"]):
        score -= 3
    return score


def discover_ir_urls(ticker: str, company_name: Optional[str], timeout: int = 10, limit: int = 6) -> List[Dict[str, Any]]:
    queries = []
    if company_name:
        queries.append(f'"{company_name}" investor relations')
        queries.append(f'"{company_name}" earnings webcast')
    queries.append(f"{ticker} investor relations")

    candidates: List[Dict[str, Any]] = []
    seen = set()
    for query in queries:
        for item in duckduckgo_search(query, timeout=timeout, limit=10):
            score = ir_result_score(item["title"], item["url"])
            if score <= 0:
                continue
            key = item["url"]
            if key in seen:
                continue
            seen.add(key)
            candidates.append(
                {
                    "title": item["title"],
                    "url": item["url"],
                    "discovery_query": query,
                    "score": score,
                }
            )
    candidates.sort(key=lambda item: item["score"], reverse=True)
    return candidates[:limit]


def classify_ir_link(title: str, url: str) -> Optional[str]:
    blob = f"{title} {url}".lower()
    if "transcript" in blob or "prepared remarks" in blob:
        return "transcript"
    if "webcast" in blob or "conference call" in blob or "listen" in blob or "replay" in blob:
        return "webcast"
    if "presentation" in blob or "slides" in blob or "deck" in blob:
        return "presentation"
    if "press release" in blob or "earnings release" in blob or "results" in blob:
        return "press_release"
    if "event" in blob or "earnings" in blob or "quarter" in blob:
        return "event_page"
    return None


def extract_quarter_hint(value: str) -> Optional[str]:
    patterns = [
        r"\b(q[1-4])\s*(?:fy)?\s*(20\d{2})\b",
        r"\b(first|second|third|fourth)\s+quarter\s+(20\d{2})\b",
        r"\b(20\d{2})\s+(first|second|third|fourth)\s+quarter\b",
    ]
    lowered = value.lower()
    for pattern in patterns:
        match = re.search(pattern, lowered, re.IGNORECASE)
        if match:
            return clean_anchor_text(match.group(0))
    year_match = re.search(r"\b20\d{2}\b", lowered)
    if year_match and any(term in lowered for term in ["earnings", "results", "quarter"]):
        return year_match.group(0)
    return None


def earnings_link_score(kind: str, title: str, url: str) -> int:
    weights = {
        "transcript": 8,
        "webcast": 7,
        "presentation": 6,
        "press_release": 6,
        "event_page": 4,
    }
    score = weights.get(kind, 1)
    blob = f"{title} {url}".lower()
    if re.search(r"\b20(2[5-9]|3\d)\b", blob):
        score += 2
    if "q1" in blob or "q2" in blob or "q3" in blob or "q4" in blob:
        score += 2
    if "earnings" in blob or "results" in blob or "quarter" in blob:
        score += 2
    return score


def extract_earnings_items_from_sec_filings(ticker: str, timeout: int = 10, limit: int = 6) -> Dict[str, Any]:
    errors: List[Dict[str, Any]] = []
    items: List[Dict[str, Any]] = []
    try:
        company = Company(ticker.upper())
        recent_filings = company.get_filings(form="8-K").head(limit)
    except Exception as exc:
        return {"items": [], "errors": [{"url": "sec_fallback", "error": f"8-K lookup failed: {exc}"}]}

    for filing in recent_filings:
        filing_info = filing_to_dict(filing)
        filing_url = filing_info.get("homepage_url") or filing_info.get("filing_url")
        if not filing_url:
            continue
        try:
            payload = http_get_text(filing_url, timeout=timeout)
        except Exception as exc:
            errors.append({"url": filing_url, "error": str(exc)})
            continue

        page_text = payload["text"]
        lowered = page_text.lower()
        if not any(term in lowered for term in ["earnings", "quarterly results", "conference call", "webcast"]):
            continue

        links = extract_links_from_html(payload["url"], page_text)
        found = False
        for link in links:
            kind = classify_ir_link(link.get("title", ""), link.get("url", ""))
            if not kind:
                continue
            items.append(
                {
                    "title": link.get("title") or f"SEC filing link | {kind}",
                    "url": link.get("url"),
                    "kind": kind,
                    "quarter_hint": extract_quarter_hint(f"{link.get('title', '')} {payload['text'][:800]}"),
                    "source_page": payload["url"],
                    "source_type": "sec_filing",
                    "filing_date": filing_info.get("filing_date"),
                    "score": earnings_link_score(kind, link.get("title", ""), link.get("url", "")) + 1,
                }
            )
            found = True

        if not found:
            items.append(
                {
                    "title": f"SEC filing mention | {filing_info.get('form') or '8-K'}",
                    "url": filing_info.get("filing_url") or filing_info.get("homepage_url"),
                    "kind": "press_release",
                    "quarter_hint": extract_quarter_hint(payload["text"][:1200]),
                    "source_page": payload["url"],
                    "source_type": "sec_filing",
                    "filing_date": filing_info.get("filing_date"),
                    "score": 3,
                }
            )

    deduped: List[Dict[str, Any]] = []
    seen = set()
    for item in sorted(items, key=lambda record: record["score"], reverse=True):
        key = (item["kind"], item["url"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)
    return {"items": deduped, "errors": errors}


def extract_ir_index(
    ticker: str,
    company_name: Optional[str],
    ir_url: Optional[str] = None,
    timeout: int = 10,
    max_pages: int = 3,
) -> Dict[str, Any]:
    ir_candidates: List[Dict[str, Any]] = []
    if ir_url:
        ir_candidates.append({"title": "Provided IR URL", "url": ir_url, "discovery_query": "provided", "score": 100})
    ir_candidates.extend(discover_ir_urls(ticker, company_name, timeout=timeout, limit=max_pages + 2))

    deduped_candidates: List[Dict[str, Any]] = []
    seen_candidate_urls = set()
    for candidate in ir_candidates:
        url = candidate["url"]
        if url in seen_candidate_urls:
            continue
        seen_candidate_urls.add(url)
        deduped_candidates.append(candidate)
    ir_candidates = deduped_candidates[: max_pages + 1]

    items: List[Dict[str, Any]] = []
    visited_pages = set()
    page_errors: List[Dict[str, Any]] = []

    for candidate in ir_candidates[:max_pages]:
        page_url = candidate["url"]
        if page_url in visited_pages:
            continue
        visited_pages.add(page_url)
        try:
            payload = http_get_text(page_url, timeout=timeout)
        except Exception as exc:
            page_errors.append({"url": page_url, "error": str(exc)})
            continue

        first_level_links = extract_links_from_html(payload["url"], payload["text"])
        event_candidates: List[Dict[str, Any]] = []
        for link in first_level_links:
            kind = classify_ir_link(link.get("title", ""), link.get("url", ""))
            if not kind:
                continue
            record = {
                "title": link.get("title"),
                "url": link.get("url"),
                "kind": kind,
                "quarter_hint": extract_quarter_hint(f"{link.get('title', '')} {link.get('url', '')}"),
                "source_page": payload["url"],
                "score": earnings_link_score(kind, link.get("title", ""), link.get("url", "")),
            }
            items.append(record)
            if kind == "event_page":
                event_candidates.append(record)

        for event_link in sorted(event_candidates, key=lambda item: item["score"], reverse=True)[:2]:
            event_url = event_link["url"]
            if event_url in visited_pages:
                continue
            visited_pages.add(event_url)
            try:
                event_payload = http_get_text(event_url, timeout=timeout)
            except Exception as exc:
                page_errors.append({"url": event_url, "error": str(exc)})
                continue
            for link in extract_links_from_html(event_payload["url"], event_payload["text"]):
                kind = classify_ir_link(link.get("title", ""), link.get("url", ""))
                if not kind or kind == "event_page":
                    continue
                items.append(
                    {
                        "title": link.get("title"),
                        "url": link.get("url"),
                        "kind": kind,
                        "quarter_hint": extract_quarter_hint(f"{link.get('title', '')} {link.get('url', '')}"),
                        "source_page": event_payload["url"],
                        "score": earnings_link_score(kind, link.get("title", ""), link.get("url", "")) + 1,
                    }
                )

    deduped_items: List[Dict[str, Any]] = []
    seen_items = set()
    for item in sorted(items, key=lambda record: record["score"], reverse=True):
        key = (item["kind"], item["url"])
        if key in seen_items:
            continue
        seen_items.add(key)
        deduped_items.append(item)

    if not deduped_items:
        sec_fallback = extract_earnings_items_from_sec_filings(ticker, timeout=timeout, limit=6)
        deduped_items = sec_fallback["items"]
        page_errors.extend(sec_fallback["errors"])

    latest_by_kind: Dict[str, Dict[str, Any]] = {}
    for item in deduped_items:
        latest_by_kind.setdefault(item["kind"], item)

    return {
        "ir_candidates": ir_candidates,
        "items": deduped_items,
        "latest_by_kind": latest_by_kind,
        "page_errors": page_errors,
    }


def source_weight(source: Optional[str]) -> int:
    weights = {
        "Reuters": 5,
        "Bloomberg.com": 5,
        "Bloomberg": 5,
        "The Wall Street Journal": 5,
        "WSJ": 5,
        "Financial Times": 5,
        "CNBC": 4,
        "Barron's": 4,
        "Fortune": 4,
        "Nikkei Asia": 4,
        "BBC": 4,
        "AP News": 4,
        "Yahoo Finance": 3,
        "Seeking Alpha": 2,
        "NVIDIA Newsroom": 2,
        "Apple": 2,
        "Businesskorea": 3,
        "Korea JoongAng Daily": 3,
        "The Korea Times": 3,
        "TheElec": 4,
        "DigiTimes": 3,
        "TrendForce": 3,
        "EE Times": 3,
        "The Quantum Insider": 3,
        "Quantum Computing Report": 3,
        "IEEE Spectrum": 3,
        "Payload": 3,
        "BioSpace": 3,
        "GEN": 3,
        "巨潮资讯": 4,
        "恒而达官网": 3,
        "秦川机官网": 3,
        "华辰装备官网": 3,
        "DINGS Official": 3,
    }
    return weights.get(source or "", 1)


EVENT_RULES = [
    (
        "incident_risk",
        [
            "fire",
            "blaze",
            "explosion",
            "leak",
            "gas leak",
            "toxic gas",
            "evacuated",
            "injured",
            "shutdown",
            "outage",
            "accident",
            "probe",
            "investigation",
            "起火",
            "火灾",
            "泄漏",
            "事故",
            "停产",
            "疏散",
            "受伤",
        ],
    ),
    (
        "capital_markets",
        [
            "listing",
            "ipo",
            "nasdaq",
            "us listing",
            "share sale",
            "fund raising",
            "赴美上市",
            "上市",
            "ipo",
        ],
    ),
    (
        "partnerships_customers",
        [
            "partnership",
            "partner",
            "customer",
            "nvidia",
            "microsoft",
            "openai",
            "supply deal",
            "multiyear",
            "合作",
            "客户",
            "供货",
            "签约",
        ],
    ),
    (
        "operations_supply_chain",
        [
            "capacity",
            "wafer",
            "plant",
            "fab",
            "hbm",
            "memory",
            "dram",
            "nand",
            "chip shortage",
            "factory",
            "生产",
            "产能",
            "工厂",
            "晶圆",
            "存储",
            "供应链",
        ],
    ),
    (
        "policy_regulation",
        [
            "tariff",
            "export control",
            "sanction",
            "regulator",
            "antitrust",
            "lawsuit",
            "policy",
            "调查",
            "监管",
            "制裁",
            "关税",
            "出口管制",
            "诉讼",
        ],
    ),
]


def classify_event(title: Optional[str], summary: Optional[str]) -> str:
    haystack = normalize_text(" ".join(filter(None, [title, summary])))
    for label, keywords in EVENT_RULES:
        for keyword in keywords:
            if normalize_text(keyword) in haystack:
                return label
    return "general"


def category_priority(category: str) -> int:
    priorities = {
        "incident_risk": 5,
        "capital_markets": 4,
        "partnerships_customers": 4,
        "operations_supply_chain": 3,
        "policy_regulation": 3,
        "general": 1,
    }
    return priorities.get(category, 1)


def split_aliases(value: Optional[str]) -> List[str]:
    if not value:
        return []
    return [item.strip() for item in value.split(",") if item.strip()]


def dedupe_news_items(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    deduped: Dict[str, Dict[str, Any]] = {}
    for item in items:
        dedupe_key = normalize_text(item.get("base_title") or item.get("title"))
        if not dedupe_key:
            continue

        candidate_score = source_weight(item.get("source"))
        if dedupe_key not in deduped:
            item["matched_aliases"] = [item["query_used"]]
            item["recall_sources"] = [item.get("recall_source")]
            item["duplicate_count"] = 1
            deduped[dedupe_key] = item
            continue

        existing = deduped[dedupe_key]
        existing["duplicate_count"] += 1
        if item["query_used"] not in existing["matched_aliases"]:
            existing["matched_aliases"].append(item["query_used"])
        if item.get("recall_source") and item["recall_source"] not in existing["recall_sources"]:
            existing["recall_sources"].append(item["recall_source"])
        if candidate_score > source_weight(existing.get("source")):
            for field in ["title", "base_title", "google_news_url", "published", "source", "summary", "url", "detail_url"]:
                if item.get(field):
                    existing[field] = item.get(field)
    return list(deduped.values())


def fetch_url_text(url: str, timeout: int = 8) -> Optional[str]:
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "intel-api/0.1"})
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.read().decode("utf-8", "ignore")
    except Exception:
        return None


def fetch_feed(feed_url: str, timeout: int = DEFAULT_FEED_TIMEOUT_SEC) -> Dict[str, Any]:
    try:
        request = urllib.request.Request(feed_url, headers={"User-Agent": "intel-api/0.1"})
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = response.read()
        parsed = feedparser.parse(payload)
        return {"parsed": parsed, "error": None}
    except Exception as exc:
        return {"parsed": feedparser.FeedParserDict(entries=[]), "error": str(exc)}


def x_profile_cookie_file(profile_name: str = X_DEFAULT_PROFILE) -> str:
    return os.path.expanduser(f"~/Library/Application Support/Google/Chrome/{profile_name}/Cookies")


def extract_x_cookie_bundle(profile_name: str = X_DEFAULT_PROFILE) -> Dict[str, Any]:
    if browser_cookie3 is None:
        return {"ok": False, "error": "browser_cookie3 not installed", "cookies": {}, "profile": profile_name}

    cookie_file = x_profile_cookie_file(profile_name)
    if not os.path.exists(cookie_file):
        return {"ok": False, "error": f"cookie file not found: {cookie_file}", "cookies": {}, "profile": profile_name}

    cookies: Dict[str, str] = {}
    errors: List[str] = []
    for domain in ["x.com", ".x.com", "twitter.com", ".twitter.com"]:
        try:
            for cookie in browser_cookie3.chrome(cookie_file=cookie_file, domain_name=domain):
                cookies[cookie.name] = cookie.value
        except Exception as exc:
            errors.append(f"{domain}: {exc}")

    required = ["auth_token", "ct0", "twid"]
    present = {key: bool(cookies.get(key)) for key in required + ["guest_id"]}
    ok = all(present[key] for key in required)
    return {
        "ok": ok,
        "profile": profile_name,
        "cookie_file": cookie_file,
        "cookies": cookies,
        "present": present,
        "errors": errors,
    }


def sanitize_x_cookie_info(info: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "ok": info.get("ok"),
        "profile": info.get("profile"),
        "cookie_file": info.get("cookie_file"),
        "present": info.get("present"),
        "errors": info.get("errors"),
    }


def fetch_current_x_ops(timeout: int = 20) -> Dict[str, str]:
    if not X_DEFAULT_PROXY:
        env = os.environ.copy()
    else:
        env = {
            **os.environ,
            "https_proxy": X_DEFAULT_PROXY,
            "http_proxy": X_DEFAULT_PROXY,
            "all_proxy": X_DEFAULT_PROXY,
        }

    js = subprocess.check_output(
        ["curl", "-k", "-L", "-s", "https://abs.twimg.com/responsive-web/client-web/main.e5c51e2a.js"],
        env=env,
        timeout=timeout,
    ).decode("utf-8", "ignore")

    op_names = [
        "SearchTimeline",
        "UserByScreenName",
        "UserTweets",
        "TweetDetail",
        "UserTweetsAndReplies",
        "UserMedia",
    ]
    ops: Dict[str, str] = {}
    for name in op_names:
        match = re.search(rf'queryId:"([A-Za-z0-9_-]+)",operationName:"{name}"', js)
        if match:
            ops[name] = f"{match.group(1)}/{name}"
    return ops


def ensure_twscrape_runtime_patched() -> Dict[str, Any]:
    if any(x is None for x in [bs4, httpx, twscrape_api_mod, twscrape_xclid_mod, XClIdGen, INDICES_REGEX]):
        return {"ok": False, "error": "twscrape runtime dependencies unavailable"}

    try:
        ops = fetch_current_x_ops()
    except Exception as exc:
        return {"ok": False, "error": f"failed to fetch current X ops: {exc}"}

    for name, value in ops.items():
        setattr(twscrape_api_mod, f"OP_{name}", value)

    async def patched_create() -> "XClIdGen":
        clt = httpx.AsyncClient(headers={"user-agent": "Mozilla/5.0"}, follow_redirects=True, verify=False)
        try:
            text = await get_tw_page_text("https://x.com/tesla", clt)
            soup = bs4.BeautifulSoup(text, "html.parser")
            vk = parse_vk_bytes(soup)
            try:
                items = await twscrape_xclid_mod.parse_anim_idx(str(soup), clt)
            except Exception:
                main_js = (
                    await clt.get("https://abs.twimg.com/responsive-web/client-web/main.e5c51e2a.js")
                ).text
                items = [int(match.group(2)) for match in INDICES_REGEX.finditer(main_js)]
                if not items:
                    raise

            arr = parse_anim_arr(soup, vk)
            frame_time = 1
            for idx in items[1:]:
                frame_time *= vk[idx] % 16
            frame_time = math.floor(frame_time / 10 + 0.5) * 10
            frame_idx = vk[items[0]] % len(arr)
            frame_row = arr[frame_idx]
            frame_dur = float(frame_time) / 4096
            anim_key = cacl_anim_key(frame_row, frame_dur)
            return XClIdGen(vk, anim_key)
        finally:
            await clt.aclose()

    twscrape_xclid_mod.XClIdGen.create = staticmethod(patched_create)
    return {"ok": True, "ops": ops}


async def run_x_search(query: str, limit: int, profile_name: str = X_DEFAULT_PROFILE) -> Dict[str, Any]:
    if TwscrapeAPI is None or TwscrapeAccountsPool is None or twscrape_gather is None:
        return {"ok": False, "error": "twscrape is not installed", "items": []}

    cookies_info = extract_x_cookie_bundle(profile_name)
    if not cookies_info["ok"]:
        return {"ok": False, "error": cookies_info.get("error") or "missing required X cookies", "items": [], "status": cookies_info}

    patch_status = ensure_twscrape_runtime_patched()
    if not patch_status["ok"]:
        return {"ok": False, "error": patch_status["error"], "items": [], "status": patch_status}

    db_file = os.path.join(tempfile.gettempdir(), f"intel_api_x_{re.sub(r'[^a-zA-Z0-9_-]+', '_', profile_name)}.db")
    pool = TwscrapeAccountsPool(db_file)
    cookie_str = "; ".join(f"{k}={v}" for k, v in cookies_info["cookies"].items())
    await pool.delete_accounts("chrome_profile_runtime")
    await pool.add_account_cookies("chrome_profile_runtime", cookie_str)

    api = TwscrapeAPI(pool, debug=False, proxy=X_DEFAULT_PROXY)
    try:
        tweets = await twscrape_gather(api.search(query, limit=limit))
    except Exception as exc:
        return {
            "ok": False,
            "error": str(exc),
            "items": [],
            "patch_status": patch_status,
            "status": cookies_info,
        }

    items = []
    for tweet in tweets:
        items.append(
            {
                "id": getattr(tweet, "id", None),
                "date": isoformat_or_none(getattr(tweet, "date", None)),
                "url": getattr(tweet, "url", None),
                "lang": getattr(tweet, "lang", None),
                "like_count": getattr(tweet, "likeCount", None),
                "reply_count": getattr(tweet, "replyCount", None),
                "retweet_count": getattr(tweet, "retweetCount", None),
                "bookmark_count": getattr(tweet, "bookmarkCount", None),
                "quote_count": getattr(tweet, "quoteCount", None),
                "raw_content": getattr(tweet, "rawContent", None),
                "rendered_content": getattr(tweet, "renderedContent", None),
                "username": getattr(getattr(tweet, "user", None), "username", None),
                "displayname": getattr(getattr(tweet, "user", None), "displayname", None),
                "user_id": getattr(getattr(tweet, "user", None), "id", None),
            }
        )

    return {
        "ok": True,
        "items": items,
        "patch_status": patch_status,
        "status": cookies_info,
        "profile": profile_name,
        "proxy": X_DEFAULT_PROXY,
    }


async def x_graphql_request(
    operation_name: str,
    variables: Dict[str, Any],
    referer: str,
    profile_name: str = X_DEFAULT_PROFILE,
) -> Dict[str, Any]:
    if TwscrapeAccount is None or XClIdGen is None:
        return {"ok": False, "error": "X runtime dependencies unavailable"}

    cookies_info = extract_x_cookie_bundle(profile_name)
    if not cookies_info["ok"]:
        return {"ok": False, "error": cookies_info.get("error") or "missing required X cookies", "status": cookies_info}

    patch_status = ensure_twscrape_runtime_patched()
    if not patch_status["ok"]:
        return {"ok": False, "error": patch_status["error"], "status": cookies_info}

    op = (patch_status.get("ops") or {}).get(operation_name)
    if not op:
        return {"ok": False, "error": f"missing operation id for {operation_name}", "status": cookies_info}

    xclid = await XClIdGen.create()
    account = TwscrapeAccount(
        username="chrome_profile_runtime",
        password="_",
        email="_",
        email_password="_",
        user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
        active=True,
        cookies=cookies_info["cookies"],
        locks={},
        stats={},
        headers={},
    )
    client = account.make_client(proxy=X_DEFAULT_PROXY)
    try:
        url = f"{twscrape_api_mod.GQL_URL}/{op}"
        params = {"variables": variables, "features": twscrape_api_mod.GQL_FEATURES}
        if operation_name in {"SearchTimeline", "ListLatestTweetsTimeline"}:
            params["fieldToggles"] = {"withArticleRichContentState": False}
        if operation_name == "UserMedia":
            params["fieldToggles"] = {"withArticlePlainText": False}
        path = f"/i/api/graphql/{op}"
        headers = {
            "referer": referer,
            "x-client-transaction-id": xclid.calc("GET", path),
        }
        response = await client.get(
            url,
            params={k: json.dumps(v, separators=(",", ":")) if isinstance(v, dict) else str(v) for k, v in params.items()},
            headers=headers,
            timeout=20,
        )
        payload = None
        try:
            payload = response.json()
        except Exception:
            payload = None
        return {
            "ok": response.status_code == 200,
            "status_code": response.status_code,
            "content_type": response.headers.get("content-type"),
            "payload": payload,
            "text": response.text[:4000],
            "status": cookies_info,
            "patch_status": patch_status,
        }
    finally:
        await client.aclose()


def parse_x_user_result(result: Dict[str, Any]) -> Dict[str, Any]:
    legacy = result.get("legacy") or {}
    core = result.get("core") or {}
    return {
        "rest_id": result.get("rest_id"),
        "id": result.get("id"),
        "screen_name": core.get("screen_name") or legacy.get("screen_name"),
        "name": core.get("name") or legacy.get("name"),
        "description": legacy.get("description"),
        "followers_count": legacy.get("followers_count"),
        "friends_count": legacy.get("friends_count"),
        "media_count": legacy.get("media_count"),
        "statuses_count": legacy.get("statuses_count"),
        "profile_image_url": ((result.get("avatar") or {}).get("image_url") or legacy.get("profile_image_url_https")),
        "profile_banner_url": legacy.get("profile_banner_url"),
        "created_at": legacy.get("created_at") or core.get("created_at"),
        "verified": legacy.get("verified"),
        "is_blue_verified": result.get("is_blue_verified"),
    }


def parse_x_tweet_entries(
    payload: Dict[str, Any],
    limit: int,
    fallback_screen_name: Optional[str] = None,
    fallback_name: Optional[str] = None,
) -> List[Dict[str, Any]]:
    instructions = (
        (((payload.get("data") or {}).get("user") or {}).get("result") or {})
        .get("timeline", {})
        .get("timeline", {})
        .get("instructions", [])
    )
    items: List[Dict[str, Any]] = []
    seen = set()
    for instruction in instructions:
        entries = instruction.get("entries") or []
        for entry in entries:
            content = entry.get("content") or {}
            item_content = content.get("itemContent") or {}
            tweet_result = ((item_content.get("tweet_results") or {}).get("result") or {})
            if tweet_result.get("__typename") != "Tweet":
                continue
            legacy = tweet_result.get("legacy") or {}
            user_result = (((tweet_result.get("core") or {}).get("user_results") or {}).get("result") or {})
            user_legacy = user_result.get("legacy") or {}
            rest_id = tweet_result.get("rest_id")
            if not rest_id or rest_id in seen:
                continue
            seen.add(rest_id)
            screen_name = user_legacy.get("screen_name") or fallback_screen_name
            display_name = user_legacy.get("name") or fallback_name
            items.append(
                {
                    "id": rest_id,
                    "created_at": legacy.get("created_at"),
                    "full_text": legacy.get("full_text"),
                    "lang": legacy.get("lang"),
                    "favorite_count": legacy.get("favorite_count"),
                    "reply_count": legacy.get("reply_count"),
                    "retweet_count": legacy.get("retweet_count"),
                    "quote_count": legacy.get("quote_count"),
                    "bookmark_count": legacy.get("bookmark_count"),
                    "view_count": (((tweet_result.get("views") or {}).get("count"))),
                    "screen_name": screen_name,
                    "name": display_name,
                    "url": f"https://x.com/{screen_name}/status/{rest_id}" if screen_name else None,
                }
            )
            if len(items) >= limit:
                return items
    return items


def parse_meta_content(page: str, attr: str, value: str) -> Optional[str]:
    pattern = rf'<meta\s+[^>]*{attr}="{re.escape(value)}"[^>]*content="([^"]+)"'
    match = re.search(pattern, page, re.IGNORECASE)
    if match:
        return html.unescape(match.group(1)).strip()
    return None


def text_matches_company(text: str, company_keys: List[str]) -> bool:
    normalized_text = normalize_text(text)
    return any(normalize_text(key) and normalize_text(key) in normalized_text for key in company_keys)


def text_matches_any(text: str, keywords: List[str]) -> bool:
    normalized_text = normalize_text(text)
    return any(normalize_text(key) and normalize_text(key) in normalized_text for key in keywords)


def html_to_text(page: str) -> str:
    without_scripts = re.sub(r"<script.*?>.*?</script>", " ", page, flags=re.IGNORECASE | re.DOTALL)
    without_styles = re.sub(r"<style.*?>.*?</style>", " ", without_scripts, flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"<[^>]+>", " ", without_styles)
    return html.unescape(re.sub(r"\s+", " ", text)).strip()


def extract_keyword_snippets(page: str, keywords: List[str], limit: int = 4) -> List[str]:
    text = html_to_text(page)
    if not text:
        return []
    segments = re.split(r"[。！？；;|]|(?<=\>)|(?<=>>)", text)
    snippets: List[str] = []
    seen = set()
    for segment in segments:
        clean = re.sub(r"\s+", " ", segment).strip()
        if len(clean) < 8 or len(clean) > 180:
            continue
        if not text_matches_any(clean, keywords):
            continue
        norm = normalize_text(clean)
        if norm in seen:
            continue
        seen.add(norm)
        snippets.append(clean)
        if len(snippets) >= limit:
            break
    return snippets


LOW_VALUE_TITLE_PATTERNS = [
    r"^\s*$",
    r"^businesskorea\s*-\s*businesskorea$",
    r"^updates\s*-\s*spacex$",
    r"^investor relations\s*-\s*ionq(?:\s*-\s*investor relations)?$",
    r"^-+\s*rigetti computing$",
]

LOW_VALUE_URL_PATTERNS = [
    r"/articleList\.html",
    r"/search(?:/|$)",
    r"[?&]output=1(?:&|$)",
    r"/rss(?:/|$|[.?])",
    r"/feed(?:/|$|[.?])",
]


def title_has_content(title: Optional[str], source: Optional[str] = None) -> bool:
    if not title:
        return False
    cleaned = html.unescape(re.sub(r"\s+", " ", title)).strip()
    if len(cleaned) < 6:
        return False
    normalized = normalize_text(cleaned)
    if not normalized:
        return False
    if source and normalized == normalize_text(source):
        return False
    for pattern in LOW_VALUE_TITLE_PATTERNS:
        if re.search(pattern, cleaned, re.IGNORECASE):
            return False
    return True


def url_looks_like_content(url: Optional[str]) -> bool:
    if not url:
        return False
    for pattern in LOW_VALUE_URL_PATTERNS:
        if re.search(pattern, url, re.IGNORECASE):
            return False
    return True


def filter_contentish_items(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    filtered: List[Dict[str, Any]] = []
    for item in items:
        title = item.get("title")
        source = item.get("source")
        url = item.get("url") or item.get("google_news_url") or item.get("link")
        summary = item.get("summary") or item.get("description")
        article = item.get("article")

        if not title_has_content(title, source):
            continue
        if url and not url_looks_like_content(url):
            continue
        if article is not None:
            maintext = (article or {}).get("maintext") if isinstance(article, dict) else None
            description = (article or {}).get("description") if isinstance(article, dict) else None
            if not any([maintext, description, summary, title]):
                continue
        filtered.append(item)
    return filtered


def google_variants_for_query(query: str, mode: str = "auto") -> List[Dict[str, str]]:
    variants = list(BASE_GOOGLE_NEWS_VARIANTS)
    if mode == "single":
        return variants[:1]
    if re.search(r"[\uac00-\ud7af]", query):
        variants.append(KOREAN_GOOGLE_NEWS_VARIANT)
    if re.search(r"[\u4e00-\u9fff]", query):
        variants.append(CJK_GOOGLE_NEWS_VARIANT)
    return variants


def fetch_google_news_entries(
    query: str,
    days: int,
    limit: int,
    variant_mode: str = "auto",
    timeout: int = DEFAULT_FEED_TIMEOUT_SEC,
) -> Dict[str, Any]:
    items: List[Dict[str, Any]] = []
    errors: List[Dict[str, Any]] = []
    variants = google_variants_for_query(query, mode=variant_mode)
    per_variant_limit = max(2, min(limit, max(1, limit // 2)))

    for variant in variants:
        feed_url = google_news_search_feed(
            f"{query} when:{days}d",
            hl=variant["hl"],
            gl=variant["gl"],
            ceid=variant["ceid"],
        )
        result = fetch_feed(feed_url, timeout=timeout)
        parsed = result["parsed"]
        if result["error"]:
            errors.append(
                {
                    "stage": "google_news",
                    "query": query,
                    "variant": variant["label"],
                    "feed_url": feed_url,
                    "error": result["error"],
                }
            )
            continue
        for entry in parsed.entries[:per_variant_limit]:
            title = getattr(entry, "title", None)
            items.append(
                {
                    "title": title,
                    "base_title": base_title(title),
                    "google_news_url": getattr(entry, "link", None),
                    "url": getattr(entry, "link", None),
                    "published": getattr(entry, "published", None),
                    "source": source_from_title(title),
                    "summary": getattr(entry, "summary", None),
                    "query_used": query,
                    "feed_url": feed_url,
                    "recall_source": variant["label"],
                }
            )

    return {
        "items": dedupe_news_items(items)[:limit],
        "errors": errors,
    }


def primary_company_anchor(alias_list: List[str], company_name: Optional[str]) -> str:
    if company_name:
        return company_name
    return next((alias for alias in alias_list if " " in alias or len(alias) > 3), alias_list[0])


def choose_source_pool(alias_list: List[str], company_name: Optional[str]) -> Dict[str, Any]:
    priority_pool: List[Dict[str, str]] = []
    general_pool: List[Dict[str, str]] = []
    source_tags: List[str] = []
    alias_blob = " ".join(alias_list + ([company_name] if company_name else []))

    if re.search(r"ionq|rigetti|psiquantum|d wave|dwave|quantum|量子", alias_blob, re.IGNORECASE):
        priority_pool.extend(QUANTUM_SOURCE_POOL)
        source_tags.append("quantum")
    if re.search(r"figure|agility|apptronik|humanoid|physical ai|robot|robotaxi|waymo|aurora|nuro|自动驾驶|机器人", alias_blob, re.IGNORECASE):
        priority_pool.extend(PHYSICAL_AI_SOURCE_POOL)
        priority_pool.extend(AUTONOMY_SOURCE_POOL)
        source_tags.append("physical_ai_robotics")
    if re.search(r"spacex|rocket lab|blue origin|firefly|commercial space|space|航天", alias_blob, re.IGNORECASE):
        priority_pool.extend(SPACE_SOURCE_POOL)
        source_tags.append("commercial_space")
    if re.search(r"biotech|pharma|drug|fda|clinical|医药|生物", alias_blob, re.IGNORECASE):
        priority_pool.extend(BIOTECH_SOURCE_POOL)
        source_tags.append("biotech")

    if re.search(r"[\uac00-\ud7af]|sk hynix|samsung|hyundai|lg", alias_blob, re.IGNORECASE):
        priority_pool.extend(KOREA_SOURCE_POOL)
        source_tags.append("korea")
    if re.search(r"tsmc|台积电|台積電|mediatek|foxconn", alias_blob, re.IGNORECASE):
        priority_pool.extend(TAIWAN_SOURCE_POOL)
        source_tags.append("taiwan")

    general_pool.extend(SEMICONDUCTOR_SOURCE_POOL)
    general_pool.extend(GLOBAL_SOURCE_POOL)

    deduped: Dict[str, Dict[str, str]] = {}
    for item in priority_pool + general_pool:
        deduped[item["domain"]] = item
    source_pool = list(deduped.values())
    site_scope_max_sources = min(len(source_pool), 12 if priority_pool else 6)
    return {
        "source_pool": source_pool,
        "source_tags": source_tags,
        "site_scope_max_sources": site_scope_max_sources,
    }


def fetch_site_scoped_entries(
    query_anchor: str,
    alias_list: List[str],
    source_pool: List[Dict[str, str]],
    days: int,
    limit_per_source: int = 2,
    max_sources: int = 6,
) -> Dict[str, Any]:
    scoped_sources = source_pool[:max_sources]

    def fetch_for_source(source: Dict[str, str]) -> Dict[str, Any]:
        local_items: List[Dict[str, Any]] = []
        local_anchor = query_anchor
        if source["domain"].endswith(".co.kr") or "joins.com" in source["domain"]:
            local_anchor = next((alias for alias in alias_list if re.search(r"[\uac00-\ud7af]", alias)), query_anchor)
        elif source["domain"] in {"digitimes.com", "udn.com", "focustaiwan.tw"}:
            local_anchor = next((alias for alias in alias_list if re.search(r"[\u4e00-\u9fff]", alias)), query_anchor)
        scoped_query = f"\"{local_anchor}\" site:{source['domain']}"
        result = fetch_google_news_entries(scoped_query, days=days, limit=limit_per_source, variant_mode="single")
        for item in result["items"]:
            item["recall_source"] = f"site_scope:{source['label']}"
            local_items.append(item)
        return {
            "items": local_items,
            "errors": result["errors"],
        }

    items: List[Dict[str, Any]] = []
    errors: List[Dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=min(6, max(1, len(scoped_sources)))) as executor:
        futures = [executor.submit(fetch_for_source, source) for source in scoped_sources]
        for future in as_completed(futures):
            try:
                result = future.result()
                items.extend(result["items"])
                errors.extend(result["errors"])
            except Exception as exc:
                errors.append({"stage": "site_scoped_recall", "query": query_anchor, "error": str(exc)})
                continue
    return {
        "items": dedupe_news_items(items),
        "errors": errors,
    }


def fetch_businesskorea_direct_entries(company_keys: List[str], limit: int = 4, timeout: int = 6) -> List[Dict[str, Any]]:
    list_url = "https://www.businesskorea.co.kr/news/articleList.html?view_type=sm"
    page = fetch_url_text(list_url, timeout=timeout)
    if not page:
        return []

    ids = [int(match) for match in re.findall(r"articleView\.html\?idxno=(\d+)", page)]
    if not ids:
        return []

    latest_id = max(ids)
    candidate_ids = list(range(latest_id, max(latest_id - 50, 0), -1))
    def fetch_one(idx: int) -> Optional[Dict[str, Any]]:
        article_url = f"https://www.businesskorea.co.kr/news/articleView.html?idxno={idx}"
        article_page = fetch_url_text(article_url, timeout=max(2, min(4, timeout)))
        if not article_page:
            return None

        title = parse_meta_content(article_page, "name", "title")
        description = parse_meta_content(article_page, "name", "description")
        published = parse_meta_content(article_page, "property", "article:published_time")
        combined = " ".join(filter(None, [title, description]))
        if not combined or not text_matches_company(combined, company_keys):
            return None

        return {
            "title": title,
            "base_title": base_title(title),
            "google_news_url": article_url,
            "url": article_url,
            "published": published,
            "source": "Businesskorea",
            "summary": description,
            "query_used": company_keys[0],
            "feed_url": list_url,
            "recall_source": "direct:businesskorea",
        }

    items: List[Dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=6) as executor:
        futures = [executor.submit(fetch_one, idx) for idx in candidate_ids]
        for future in as_completed(futures):
            item = future.result()
            if not item:
                continue
            items.append(item)
            if len(items) >= limit:
                break

    return dedupe_news_items(items)


def fetch_thelec_direct_entries(company_keys: List[str], limit: int = 4, timeout: int = 6) -> List[Dict[str, Any]]:
    search_term = next((key for key in company_keys if re.search(r"[\uac00-\ud7af]", key)), company_keys[0])
    search_url = f"https://www.thelec.kr/news/articleList.html?sc_word={urllib.parse.quote(search_term)}"
    page = fetch_url_text(search_url, timeout=timeout)
    if not page:
        return []

    items: List[Dict[str, Any]] = []
    seen_urls = set()
    for url, title in re.findall(
        r'<a href="(https://www\.thelec\.kr/news/articleView\.html\?idxno=\d+)"[^>]*><(?:DIV|H2)[^>]*>(.*?)</(?:DIV|H2)>',
        page,
        re.IGNORECASE | re.DOTALL,
    ):
        clean_title = html.unescape(re.sub(r"<[^>]+>", " ", title)).replace("\xa0", " ").strip()
        if url in seen_urls or not text_matches_company(clean_title, company_keys):
            continue
        seen_urls.add(url)
        items.append(
            {
                "title": clean_title,
                "base_title": base_title(clean_title),
                "google_news_url": url,
                "url": url,
                "published": None,
                "source": "TheElec",
                "summary": None,
                "query_used": search_term,
                "feed_url": search_url,
                "recall_source": "direct:thelec",
            }
        )
        if len(items) >= limit:
            break

    return dedupe_news_items(items)


def fetch_official_site_entries(ticker: str, company_keys: List[str], limit: int = 6, timeout: int = 6) -> List[Dict[str, Any]]:
    match_blob = " ".join([ticker] + company_keys)
    candidates = [
        adapter
        for adapter in OFFICIAL_SITE_ADAPTERS
        if any(normalize_text(token) in normalize_text(match_blob) for token in adapter["match"])
    ]
    if not candidates:
        return []

    items: List[Dict[str, Any]] = []
    for adapter in candidates:
        for url in adapter["pages"]:
            page = fetch_url_text(url, timeout=timeout)
            if not page:
                continue

            page_title = parse_meta_content(page, "property", "og:title") or parse_meta_content(page, "name", "title")
            page_description = (
                parse_meta_content(page, "property", "og:description")
                or parse_meta_content(page, "name", "description")
            )

            snippets = extract_keyword_snippets(page, adapter["keywords"], limit=3)
            if page_description and text_matches_any(page_description, adapter["keywords"]):
                snippets.insert(0, page_description)
            if page_title and text_matches_any(page_title, adapter["keywords"]):
                snippets.insert(0, page_title)

            deduped_snippets: List[str] = []
            seen = set()
            for snippet in snippets:
                norm = normalize_text(snippet)
                if not norm or norm in seen:
                    continue
                seen.add(norm)
                deduped_snippets.append(snippet)

            for snippet in deduped_snippets[:3]:
                title = f"{adapter['source']} | {snippet[:80]}"
                items.append(
                    {
                        "title": title,
                        "base_title": base_title(title),
                        "google_news_url": url,
                        "url": url,
                        "published": None,
                        "source": adapter["source"],
                        "summary": snippet,
                        "query_used": company_keys[0] if company_keys else ticker,
                        "feed_url": url,
                        "recall_source": f"official:{adapter['label']}",
                    }
                )
                if len(items) >= limit:
                    return dedupe_news_items(items)

    return dedupe_news_items(items)


def strip_html_tags(value: Optional[str]) -> str:
    if not value:
        return ""
    text = re.sub(r"<[^>]+>", " ", value)
    clean = html.unescape(re.sub(r"\s+", " ", text)).strip()
    clean = re.sub(r"\s+([：:，。,；;）》])", r"\1", clean)
    clean = re.sub(r"([（《])\s+", r"\1", clean)
    return clean


def fetch_cninfo_disclosure_entries(
    ticker: str,
    company_name: Optional[str],
    company_keys: List[str],
    days: int,
    limit: int = 6,
    timeout: int = 10,
) -> List[Dict[str, Any]]:
    if not re.fullmatch(r"\d{6}", ticker):
        return []

    keyword = company_name or next((key for key in company_keys if re.search(r"[\u4e00-\u9fff]", key)), ticker)
    end_date = datetime.now().strftime("%Y-%m-%d")
    start_date = datetime.fromtimestamp(max(0, datetime.now().timestamp() - days * 86400)).strftime("%Y-%m-%d")
    payload = urllib.parse.urlencode(
        {
            "searchkey": keyword,
            "pageNum": "1",
            "pageSize": str(max(3, min(limit, 10))),
            "sortName": "",
            "sortType": "",
            "category": "",
            "plate": "",
            "seDate": f"{start_date}~{end_date}",
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        "https://www.cninfo.com.cn/new/fulltextSearch/full",
        data=payload,
        headers={
            "User-Agent": "Mozilla/5.0",
            "X-Requested-With": "XMLHttpRequest",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            result = json.loads(response.read().decode("utf-8"))
    except Exception:
        return []

    announcements = result.get("announcements") or []
    items: List[Dict[str, Any]] = []
    for ann in announcements:
        if ann.get("secCode") != ticker:
            continue
        announcement_id = ann.get("announcementId")
        adjunct_url = ann.get("adjunctUrl")
        if not announcement_id or not adjunct_url:
            continue

        title = strip_html_tags(ann.get("announcementTitle") or ann.get("shortTitle"))
        short_title = strip_html_tags(ann.get("shortTitle") or ann.get("announcementTitle"))
        org_id = ann.get("orgId")
        announcement_time = ann.get("announcementTime")
        published = None
        date_str = None
        if announcement_time:
            try:
                published_dt = datetime.fromtimestamp(int(announcement_time) / 1000)
                published = published_dt.isoformat()
                date_str = published_dt.strftime("%Y-%m-%d")
            except Exception:
                published = None
                date_str = None

        detail_url = (
            f"https://www.cninfo.com.cn/new/disclosure/detail?stockCode={ticker}"
            f"&announcementId={announcement_id}"
        )
        if org_id:
            detail_url += f"&orgId={urllib.parse.quote(str(org_id))}"
        if date_str:
            detail_url += f"&announcementTime={date_str}"

        items.append(
            {
                "title": f"巨潮资讯 | {title or short_title}",
                "base_title": base_title(short_title or title),
                "google_news_url": f"https://static.cninfo.com.cn/{adjunct_url.lstrip('/')}",
                "url": f"https://static.cninfo.com.cn/{adjunct_url.lstrip('/')}",
                "detail_url": detail_url,
                "published": published,
                "source": "巨潮资讯",
                "summary": short_title or title,
                "query_used": keyword,
                "feed_url": "https://www.cninfo.com.cn/new/fulltextSearch/full",
                "recall_source": "official:cninfo",
            }
        )
        if len(items) >= limit:
            break

    return dedupe_news_items(items)


def fetch_gdelt_entries(
    query: str,
    days: int,
    limit: int,
    timeout: int = DEFAULT_GDELT_TIMEOUT_SEC,
) -> Dict[str, Any]:
    params = urllib.parse.urlencode(
        {
            "query": query,
            "mode": "artlist",
            "format": "json",
            "maxrecords": str(limit),
            "sort": "datedesc",
            "timespan": f"{days}d",
        }
    )
    url = f"https://api.gdeltproject.org/api/v2/doc/doc?{params}"
    request = urllib.request.Request(url, headers={"User-Agent": "intel-api/0.1"})

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception as exc:
        return {
            "items": [],
            "errors": [{"stage": "gdelt", "query": query, "url": url, "error": str(exc)}],
        }

    articles = payload.get("articles", [])
    items: List[Dict[str, Any]] = []
    for article in articles[:limit]:
        title = article.get("title")
        items.append(
            {
                "title": title,
                "base_title": base_title(title),
                "google_news_url": article.get("url"),
                "url": article.get("url"),
                "published": article.get("seendate") or article.get("socialimage"),
                "source": article.get("domain"),
                "summary": article.get("snippet"),
                "query_used": query,
                "feed_url": url,
                "recall_source": "gdelt",
            }
        )
    return {
        "items": dedupe_news_items(items),
        "errors": [],
    }


ENTITY_STOPWORDS = {
    "the",
    "and",
    "with",
    "after",
    "says",
    "said",
    "supply",
    "plant",
    "factory",
    "company",
    "shares",
    "stock",
    "today",
    "latest",
    "breaking",
    "report",
    "news",
    "market",
    "media",
    "group",
    "inc",
    "corp",
    "ltd",
    "limited",
    "semiconductor",
    "memory",
    "chip",
    "how",
    "this",
    "new",
    "york",
    "week",
    "review",
    "quote",
    "price",
    "forecast",
}


GENERIC_CONTEXT_TERMS = {
    "fire",
    "gas",
    "injury",
    "injured",
    "accident",
    "probe",
    "lawsuit",
    "regulator",
    "ipo",
    "listing",
    "partnership",
    "customer",
    "plant",
    "factory",
    "capacity",
    "hbm",
    "dram",
    "nand",
    "cheongju",
    "wuxi",
    "phoenix",
    "taiwan",
    "korea",
    "us",
    "nasdaq",
}


def extract_dynamic_terms(text: str, company_keys: List[str]) -> List[str]:
    candidates: List[str] = []

    for match in re.findall(r"\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b", text):
        candidates.append(match)
    for match in re.findall(r"\b[A-Z]{2,6}\b", text):
        candidates.append(match)
    for match in re.findall(r"[\u4e00-\u9fff]{2,8}", text):
        candidates.append(match)

    clean_terms: List[str] = []
    company_key_set = {normalize_text(key) for key in company_keys if key}
    for candidate in candidates:
        normalized = normalize_text(candidate)
        if not normalized or normalized in ENTITY_STOPWORDS or normalized in company_key_set:
            continue
        if len(normalized) <= 1:
            continue
        if len(normalized.split()) > 3:
            continue
        clean_terms.append(candidate.strip())

    return clean_terms


def build_dynamic_expansion_queries(
    alias_list: List[str], raw_items: List[Dict[str, Any]], max_queries: int = 4
) -> List[Dict[str, str]]:
    evidence_by_term: Dict[str, Dict[str, Any]] = {}
    company_anchor = next((alias for alias in alias_list if " " in alias or len(alias) > 3), alias_list[0])

    for item in raw_items:
        evidence_text = " ".join(filter(None, [item.get("title"), item.get("summary")]))
        for term in extract_dynamic_terms(evidence_text, alias_list):
            normalized = normalize_text(term)
            bucket = evidence_by_term.setdefault(
                normalized,
                {"term": term, "sources": set(), "occurrences": 0},
            )
            bucket["occurrences"] += 1
            if item.get("source"):
                bucket["sources"].add(item["source"])

    ranked_terms = sorted(
        evidence_by_term.values(),
        key=lambda item: (len(item["sources"]), item["occurrences"], item["term"] in GENERIC_CONTEXT_TERMS),
        reverse=True,
    )

    expansion_queries: List[Dict[str, str]] = []
    seen = set()
    for item in ranked_terms:
        term = item["term"]
        normalized = normalize_text(term)
        if normalized in seen:
            continue
        if len(item["sources"]) < 2 and item["occurrences"] < 2 and normalized not in GENERIC_CONTEXT_TERMS:
            continue
        seen.add(normalized)
        expansion_queries.append(
            {
                "query": f"\"{company_anchor}\" \"{term}\"",
                "trigger_term": term,
            }
        )
        if len(expansion_queries) >= max_queries:
            break

    return expansion_queries


POLICY_QUERY_TERM_MAP = {
    "sanctions": ["sanction", "sanctions", "制裁", "ofac"],
    "export_control": ["export control", "entity list", "出口管制", "bis"],
    "tariff": ["tariff", "tariffs", "关税", "ustr", "301"],
    "antitrust": ["antitrust", "merger", "反垄断", "并购审查", "ftc", "doj"],
    "macro_policy": ["fed", "fomc", "rate", "rates", "降息", "加息", "利率", "流动性", "treasury", "white house"],
}


def infer_policy_query(query: str) -> Dict[str, Any]:
    normalized = normalize_text(query)
    matched_tags: List[str] = []
    for tag, terms in POLICY_QUERY_TERM_MAP.items():
        if any(normalize_text(term) in normalized for term in terms):
            matched_tags.append(tag)

    should_search = bool(matched_tags)
    keyword = query.strip() if should_search and len(query.strip()) <= 48 else None
    return {
        "should_search": should_search,
        "signal_tag": ",".join(matched_tags) if matched_tags else None,
        "keyword": keyword,
    }


def source_strategy_overview() -> Dict[str, Any]:
    return {
        "keep_as_core": {
            "a_class": [
                "official_disclosure_sources",
                "official_corporate_sources",
                "official_policy_sources",
            ],
            "c_class": [
                "account_sources",
                "professional_research_sources",
            ],
        },
        "keep_as_specialized_supplement": {
            "b_class": [
                "official_site_adapters",
                "official_disclosure_sources",
                "validated_sectors",
                "rss",
            ],
        },
        "web_search_first": {
            "b_class": [
                "global",
                "policy_politics",
                "semiconductor",
                "korea",
                "taiwan",
                "quantum",
                "physical_ai_robotics",
                "commercial_space",
                "biotech",
                "autonomous_driving",
            ],
        },
        "deprioritized_entrypoints": [
            {
                "endpoint": "/api/b/news/search",
                "reason": "Broad public-web discovery is now web-search-first.",
            },
            {
                "endpoint": "/api/b/news/company-events?mode=news|deep",
                "reason": "Use mainly as company-targeted supplement after web discovery, not as the primary browser substitute.",
            },
        ],
    }


def coerce_item_source_type(item: Dict[str, Any]) -> str:
    source = normalize_text(item.get("source"))
    if item.get("channel") == "web":
        return "web"
    if item.get("channel") == "policy":
        return "policy"
    if item.get("channel") == "x":
        return "x"
    if item.get("channel") == "filing":
        return "filing"
    if item.get("channel") == "earnings_call":
        return "earnings_call"
    if item.get("channel") == "official_site":
        return "official_site"
    if "cninfo" in source:
        return "disclosure"
    return item.get("channel") or "other"


def to_unified_item(
    *,
    title: Optional[str],
    url: Optional[str],
    source: Optional[str],
    published_at: Optional[str],
    summary: Optional[str],
    evidence_level: str,
    channel: str,
    extra: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    item = {
        "title": title,
        "url": url,
        "source": source,
        "published_at": published_at,
        "summary": summary,
        "evidence_level": evidence_level,
        "channel": channel,
    }
    if extra:
        item.update(extra)
    item["source_type"] = coerce_item_source_type(item)
    return item


def normalize_web_items(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    normalized = []
    for item in items:
        normalized.append(
            to_unified_item(
                title=item.get("title"),
                url=item.get("url"),
                source=item.get("source") or "web",
                published_at=item.get("published_at"),
                summary=item.get("summary"),
                evidence_level=item.get("evidence_level") or "unknown",
                channel="web",
            )
        )
    return normalized


def normalize_web_items_with_query(items: List[Dict[str, Any]], matched_query: str) -> List[Dict[str, Any]]:
    normalized = normalize_web_items(items)
    for item in normalized:
        item["matched_query"] = matched_query
    return normalized


def attach_query_provider_metadata(
    items: List[Dict[str, Any]],
    matched_query: str,
    provider: str,
) -> List[Dict[str, Any]]:
    for item in items:
        item["matched_query"] = matched_query
        item["search_provider"] = provider
    return items


def normalize_policy_items(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    normalized = []
    for item in items:
        normalized.append(
            to_unified_item(
                title=item.get("title"),
                url=item.get("url"),
                source=item.get("source") or item.get("source_label") or "official policy",
                published_at=item.get("published_hint"),
                summary=", ".join(item.get("signal_tags", []) or []),
                evidence_level="official",
                channel="policy",
                extra={"signal_tags": item.get("signal_tags", [])},
            )
        )
    return normalized


def normalize_company_event_items(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    normalized = []
    for item in items:
        recall_sources = item.get("recall_sources") or []
        if any(str(src).startswith("official:") for src in recall_sources):
            channel = "official_site"
            evidence_level = "official"
        elif any(str(src).startswith("gdelt") for src in recall_sources):
            channel = "news"
            evidence_level = "major_media"
        else:
            channel = "news"
            evidence_level = "industry_media"
        normalized.append(
            to_unified_item(
                title=item.get("title"),
                url=item.get("detail_url") or item.get("url"),
                source=item.get("source"),
                published_at=item.get("published"),
                summary=item.get("summary"),
                evidence_level=evidence_level,
                channel=channel,
                extra={
                    "matched_aliases": item.get("matched_aliases", []),
                    "recall_sources": recall_sources,
                    "event_category": classify_event(item.get("title"), item.get("summary")),
                },
            )
        )
    return normalized


def normalize_filing_items(ticker: str, items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    normalized = []
    for item in items:
        title = f"{ticker.upper()} {item.get('form') or 'filing'}"
        summary = f"SEC filing {item.get('form') or ''} on {item.get('filing_date') or ''}".strip()
        normalized.append(
            to_unified_item(
                title=title,
                url=item.get("filing_url") or item.get("homepage_url"),
                source="SEC EDGAR",
                published_at=item.get("filing_date"),
                summary=summary,
                evidence_level="official",
                channel="filing",
                extra={"form": item.get("form"), "accession_no": item.get("accession_no")},
            )
        )
    return normalized


def normalize_earnings_call_items(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    normalized = []
    for item in items:
        title = item.get("title") or item.get("kind") or "earnings call item"
        normalized.append(
            to_unified_item(
                title=title,
                url=item.get("url"),
                source=item.get("source") or "Company IR",
                published_at=item.get("date"),
                summary=item.get("quarter_hint") or item.get("kind"),
                evidence_level="official",
                channel="earnings_call",
                extra={"kind": item.get("kind"), "quarter_hint": item.get("quarter_hint")},
            )
        )
    return normalized


def normalize_x_items(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    normalized = []
    for item in items:
        user = ((item.get("user") or {}).get("username") or (item.get("user") or {}).get("displayname") or "X")
        text = item.get("raw_content") or item.get("content") or ""
        normalized.append(
            to_unified_item(
                title=(text[:90] + "...") if len(text) > 90 else text,
                url=item.get("url"),
                source=f"X:@{user}" if user and user != "X" else "X / Twitter",
                published_at=item.get("date"),
                summary=text,
                evidence_level="social",
                channel="x",
                extra={
                    "like_count": item.get("like_count"),
                    "reply_count": item.get("reply_count"),
                    "retweet_count": item.get("retweet_count"),
                },
            )
        )
    return normalized


def dedupe_unified_items(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    deduped: Dict[str, Dict[str, Any]] = {}
    for item in items:
        key = normalize_text(item.get("url")) or normalize_text(item.get("title"))
        if not key:
            continue
        if key not in deduped:
            deduped[key] = item
            continue
        existing = deduped[key]
        if item.get("evidence_level") == "official" and existing.get("evidence_level") != "official":
            deduped[key] = item
    return list(deduped.values())


def unified_item_sort_key(item: Dict[str, Any]) -> Any:
    evidence_rank = {
        "official": 5,
        "major_media": 4,
        "industry_media": 3,
        "social": 2,
        "unknown": 1,
    }.get(item.get("evidence_level"), 1)
    published = item.get("published_at") or ""
    return (published, evidence_rank)


def run_sync_with_timeout(wait_timeout_sec: int, func: Any, *args: Any, **kwargs: Any) -> Any:
    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(func, *args, **kwargs)
        try:
            return future.result(timeout=wait_timeout_sec)
        except FutureTimeoutError as exc:
            raise TimeoutError(f"timed out after {wait_timeout_sec}s") from exc


def choose_search_center_providers(
    query_item: Dict[str, Any],
    query_plan: Dict[str, Any],
    include_b_provider: bool,
) -> List[str]:
    providers = ["web_search"]
    if include_b_provider:
        providers.append("b_news")

    lane = normalize_text(query_item.get("lane"))
    query_text = query_item.get("query") or ""
    policy_hint = infer_policy_query(query_text)
    if lane in {"policy", "regulation"} or policy_hint["should_search"]:
        providers.append("a_policy")

    entity_type = normalize_text(query_plan.get("entity_type"))
    if entity_type == "company" and lane in {"filings", "customers", "supply_chain", "operations", "competition", "general"}:
        providers.append("b_company")

    deduped = []
    seen = set()
    for provider in providers:
        if provider not in seen:
            seen.add(provider)
            deduped.append(provider)
    return deduped


def build_provider_query(
    provider: str,
    query_item: Dict[str, Any],
    query_plan: Dict[str, Any],
    root_query: str,
) -> str:
    original_query = (query_item.get("query") or root_query or "").strip()
    if provider != "b_news":
        return original_query

    canonical_terms = [str(item).strip() for item in (query_plan.get("canonical_terms") or []) if str(item).strip()]
    aliases = [str(item).strip() for item in (query_plan.get("aliases") or []) if str(item).strip()]
    pieces: List[str] = []

    if original_query:
        raw_parts = re.split(r"\s+OR\s+|\|", original_query, flags=re.IGNORECASE)
        for part in raw_parts:
            cleaned = re.sub(r'["“”]', " ", part)
            cleaned = re.sub(r"\b(after|before):\S+", " ", cleaned, flags=re.IGNORECASE)
            cleaned = re.sub(r"\b\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}\b", " ", cleaned)
            cleaned = re.sub(r"\s+", " ", cleaned).strip()
            if cleaned:
                pieces.append(cleaned)

    pieces.extend(canonical_terms[:2])
    pieces.extend(aliases[:2])

    deduped: List[str] = []
    seen = set()
    for piece in pieces:
        key = normalize_text(piece)
        if not key or key in seen:
            continue
        seen.add(key)
        deduped.append(piece)

    if not deduped:
        return original_query
    return " ".join(deduped[:3])


def run_search_provider(
    provider: str,
    query_item: Dict[str, Any],
    *,
    root_query: str,
    query_plan: Dict[str, Any],
    days: int,
    per_query_limit: int,
    mode: str,
    include_raw_web: bool,
    ticker: Optional[str],
    company_name: Optional[str],
    aliases: Optional[str],
    openai_runtime: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    query = query_item.get("query")
    if not query:
        return {"provider": provider, "count": 0, "items": []}
    provider_query = build_provider_query(provider, query_item, query_plan=query_plan, root_query=root_query)

    if provider == "web_search":
        timeout_sec = 120 if is_dashscope_runtime(openai_runtime) else (70 if mode == "deep" else 45)
        payload = perform_web_search_demo(
            q=provider_query,
            days=days,
            limit=per_query_limit,
            model=(openai_runtime or {}).get("web_search_model") or OPENAI_WEB_SEARCH_MODEL,
            tool_type="web_search",
            timeout_sec=timeout_sec,
            include_raw=include_raw_web,
            runtime_override=openai_runtime,
        )
        items = attach_query_provider_metadata(
            normalize_web_items_with_query(payload.get("items", []), matched_query=query),
            matched_query=query,
            provider=provider,
        )
        return {
            "provider": provider,
            "count": payload.get("count", 0),
            "summary": payload.get("summary"),
            "items": items,
            "provider_query": provider_query,
        }

    if provider == "b_news":
        payload = search_news_urls(
            query=provider_query,
            days=days,
            limit=min(8, max(2, per_query_limit)),
            source=None,
            timeout_sec=min(DEFAULT_FEED_TIMEOUT_SEC, 8),
        )
        items = attach_query_provider_metadata(
            normalize_company_event_items(payload.get("items", [])),
            matched_query=query,
            provider=provider,
        )
        return {
            "provider": provider,
            "count": len(items),
            "summary": f"B新闻补充 {len(items)} 条",
            "items": items,
            "partial": payload.get("partial"),
            "errors": payload.get("errors", []),
            "provider_query": provider_query,
        }

    if provider == "a_policy":
        policy_hint = infer_policy_query(provider_query)
        payload = get_latest_policy_updates(
            source="all",
            limit_per_source=max(2, min(3, per_query_limit)),
            timeout_sec=8,
            signal_tag=policy_hint["signal_tag"],
            keyword=policy_hint["keyword"] or root_query,
        )
        items = attach_query_provider_metadata(
            normalize_policy_items(payload.get("items", [])[:per_query_limit]),
            matched_query=query,
            provider=provider,
        )
        return {
            "provider": provider,
            "count": len(items),
            "summary": f"官方政策源 {len(items)} 条",
            "items": items,
            "partial": payload.get("partial"),
            "errors": payload.get("errors", []),
            "provider_query": provider_query,
        }

    if provider == "b_company":
        anchor = ticker or company_name or root_query
        payload = company_news_events(
            ticker=anchor,
            company_name=company_name,
            aliases=aliases,
            days=days,
            limit_per_alias=max(1, min(2, per_query_limit)),
            dynamic_rounds=0,
            mode="fast",
            timeout_sec=6,
        )
        items = attach_query_provider_metadata(
            normalize_company_event_items(payload.get("items", [])[:per_query_limit]),
            matched_query=query,
            provider=provider,
        )
        return {
            "provider": provider,
            "count": len(items),
            "summary": f"B公司事件补充 {len(items)} 条",
            "items": items,
            "partial": payload.get("partial"),
            "errors": payload.get("errors", []),
            "recall_plan": payload.get("recall_plan"),
            "provider_query": provider_query,
        }

    raise ValueError(f"unknown provider: {provider}")


def execute_search_center_queries(
    queries: List[Dict[str, Any]],
    root_query: str,
    query_plan: Dict[str, Any],
    days: int,
    per_query_limit: int,
    mode: str,
    include_raw_web: bool,
    include_b_provider: bool,
    ticker: Optional[str],
    company_name: Optional[str],
    aliases: Optional[str],
    openai_runtime: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    results: List[Dict[str, Any]] = []
    errors: List[Dict[str, Any]] = []
    items: List[Dict[str, Any]] = []
    provider_runs: List[Dict[str, Any]] = []
    provider_stats: Dict[str, Dict[str, int]] = {}

    for item in queries:
        query = item.get("query")
        if not query:
            continue
        provider_names = choose_search_center_providers(item, query_plan=query_plan, include_b_provider=include_b_provider)
        query_result = {
            "query": query,
            "why": item.get("why"),
            "lane": item.get("lane"),
            "branch": item.get("branch"),
            "count": 0,
            "summary": None,
            "providers_run": [],
        }
        for provider in provider_names:
            try:
                payload = run_search_provider(
                    provider,
                    item,
                    root_query=root_query,
                    query_plan=query_plan,
                    days=days,
                    per_query_limit=per_query_limit,
                    mode=mode,
                    include_raw_web=include_raw_web,
                    ticker=ticker,
                    company_name=company_name,
                    aliases=aliases,
                    openai_runtime=openai_runtime,
                )
                provider_entry = {
                    "provider": provider,
                    "provider_query": payload.get("provider_query"),
                    "count": payload.get("count", 0),
                    "summary": payload.get("summary"),
                }
                query_result["providers_run"].append(provider_entry)
                provider_runs.append({"query": query, **provider_entry})
                stats_bucket = provider_stats.setdefault(provider, {"queries": 0, "items": 0, "errors": 0})
                stats_bucket["queries"] += 1
                stats_bucket["items"] += payload.get("count", 0)
                if payload.get("partial") or payload.get("errors"):
                    stats_bucket["errors"] += len(payload.get("errors", [])) or 1
                if payload.get("items"):
                    items.extend(payload["items"])
                    query_result["count"] += len(payload["items"])
                    if not query_result["summary"] and payload.get("summary"):
                        query_result["summary"] = payload.get("summary")
                for provider_error in payload.get("errors", []) or []:
                    errors.append({"query": query, "provider": provider, "error": provider_error})
            except HTTPException as exc:
                provider_runs.append({"query": query, "provider": provider, "count": 0, "summary": None})
                stats_bucket = provider_stats.setdefault(provider, {"queries": 0, "items": 0, "errors": 0})
                stats_bucket["queries"] += 1
                stats_bucket["errors"] += 1
                errors.append({"query": query, "provider": provider, "error": exc.detail})
            except Exception as exc:
                provider_runs.append({"query": query, "provider": provider, "count": 0, "summary": None})
                stats_bucket = provider_stats.setdefault(provider, {"queries": 0, "items": 0, "errors": 0})
                stats_bucket["queries"] += 1
                stats_bucket["errors"] += 1
                errors.append({"query": query, "provider": provider, "error": str(exc)})
        results.append(query_result)
    return {
        "queries_run": results,
        "items": items,
        "errors": errors,
        "provider_runs": provider_runs,
        "provider_stats": provider_stats,
    }


class ExtractArticleRequest(BaseModel):
    url: str = Field(..., description="Public article URL")


class ExtractArticlesRequest(BaseModel):
    urls: List[str] = Field(..., description="Public article URLs")


@app.get("/health")
def health() -> Dict[str, str]:
    return {"status": "ok", "sec_identity": SEC_IDENTITY}


def perform_web_search_demo(
    *,
    q: str,
    days: int,
    limit: int,
    model: str,
    tool_type: str,
    timeout_sec: int,
    include_raw: bool,
    runtime_override: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    time_window = compute_time_window(days)
    try:
        result = call_openai_web_search(
            query=q,
            days=days,
            limit=limit,
            model=model,
            tool_type=tool_type,
            timeout_sec=timeout_sec,
            runtime=runtime_override,
        )
    except HTTPException:
        raise
    except httpx.HTTPStatusError as exc:
        body = exc.response.text if exc.response is not None else ""
        status_code = exc.response.status_code if exc.response is not None else 502
        reason = exc.response.reason_phrase if exc.response is not None else "HTTP error"
        raise HTTPException(
            status_code=502,
            detail={
                "stage": "openai_web_search",
                "status": status_code,
                "reason": reason,
                "body": body[:4000],
            },
        ) from exc
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore")
        raise HTTPException(
            status_code=502,
            detail={
                "stage": "openai_web_search",
                "status": exc.code,
                "reason": exc.reason,
                "body": detail[:4000],
            },
        ) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail={"stage": "openai_web_search", "error": str(exc)}) from exc

    parsed_output = result["parsed_output"] or {}
    items = parsed_output.get("items") if isinstance(parsed_output, dict) else None
    if not isinstance(items, list):
        items = []

    response = {
        "query": q,
        "days": days,
        "time_window": time_window,
        "limit": limit,
        "provider": "openai_web_search",
        "base_url": OPENAI_BASE_URL,
        "model": result["model"],
        "tool_type": result["tool_type"],
        "summary": parsed_output.get("summary") if isinstance(parsed_output, dict) else None,
        "count": len(items),
        "items": items,
        "citations": result["citations"],
        "output_text": result["output_text"],
    }
    if include_raw:
        response["raw_response"] = result["raw_response"]
    return response


@app.get("/api/web/search")
def web_search_demo(
    request: Request,
    q: str = Query(..., description="Search query"),
    days: int = Query(7, ge=1, le=30),
    limit: int = Query(5, ge=1, le=10),
    model: str = Query(OPENAI_WEB_SEARCH_MODEL, description="OpenAI model for web search"),
    tool_type: str = Query("web_search", pattern="^(web_search|web_search_preview)$"),
    timeout_sec: int = Query(45, ge=5, le=120),
    include_raw: bool = Query(False, description="Whether to include raw upstream response"),
) -> Dict[str, Any]:
    runtime_override = resolve_openai_runtime(request, web_search_model=model)
    return perform_web_search_demo(
        q=q,
        days=days,
        limit=limit,
        model=model,
        tool_type=tool_type,
        timeout_sec=timeout_sec,
        include_raw=include_raw,
        runtime_override=runtime_override,
    )


@app.get("/api/search/config")
def get_search_config(request: Request) -> Dict[str, Any]:
    runtime = resolve_openai_runtime(request)
    return {
        "llm": {
            "base_url": runtime.get("base_url"),
            "api_key_configured": bool(runtime.get("api_key")),
            "web_search_model": runtime.get("web_search_model"),
            "query_expand_model": runtime.get("query_expand_model"),
            "ssl_verify": bool(runtime.get("ssl_verify")),
        },
        "budget": {
            "max_expansion_queries": DEFAULT_MAX_EXPANSION_QUERIES,
            "max_followup_queries": DEFAULT_MAX_FOLLOWUP_QUERIES,
            "max_rounds": DEFAULT_MAX_ROUNDS,
            "round1_per_query_limit": DEFAULT_ROUND1_PER_QUERY_LIMIT,
            "followup_per_query_limit": DEFAULT_FOLLOWUP_PER_QUERY_LIMIT,
        },
    }


@app.get("/api/search/unified")
async def unified_search(
    request: Request,
    q: str = Query(..., description="Natural-language search query"),
    days: int = Query(7, ge=1, le=30),
    limit: int = Query(8, ge=1, le=20),
    ticker: Optional[str] = Query(None, description="Optional ticker for structured A/B supplements"),
    company_name: Optional[str] = Query(None, description="Optional company name for structured supplements"),
    aliases: Optional[str] = Query(None, description="Optional comma-separated aliases"),
    ir_url: Optional[str] = Query(None, description="Optional IR URL for earnings-call discovery"),
    mode: str = Query("standard", pattern="^(standard|deep)$"),
    include_x: bool = Query(False, description="Whether to include X/Twitter search"),
    include_b_fallback: bool = Query(True, description="Whether to use legacy B search as fallback when web returns little"),
    include_query_expansion: bool = Query(True, description="Whether to use LLM query expansion before web search"),
    max_expansion_queries: int = Query(DEFAULT_MAX_EXPANSION_QUERIES, ge=1, le=6),
    max_followup_queries: int = Query(DEFAULT_MAX_FOLLOWUP_QUERIES, ge=0, le=6),
    max_rounds: int = Query(DEFAULT_MAX_ROUNDS, ge=1, le=5),
    round1_per_query_limit: int = Query(DEFAULT_ROUND1_PER_QUERY_LIMIT, ge=1, le=10),
    followup_per_query_limit: int = Query(DEFAULT_FOLLOWUP_PER_QUERY_LIMIT, ge=1, le=10),
    include_raw_web: bool = Query(False, description="Whether to include raw upstream web-search response"),
    web_search_model: Optional[str] = Query(None, description="Override web-search model"),
    query_expand_model: Optional[str] = Query(None, description="Override query-expansion model"),
) -> Dict[str, Any]:
    openai_runtime = resolve_openai_runtime(
        request,
        web_search_model=web_search_model,
        query_expand_model=query_expand_model,
    )
    time_window = compute_time_window(days)
    errors: List[Dict[str, Any]] = []
    section_status: Dict[str, Any] = {}
    unified_items: List[Dict[str, Any]] = []
    search_payload: Optional[Dict[str, Any]] = None
    query_plan: Dict[str, Any] = {"entity_type": "unknown", "queries": [{"query": q, "why": "original_query", "priority": 1}]}
    query_plan_raw: Optional[str] = None
    latest_followup_plan: Dict[str, Any] = {
        "themes": [],
        "branches": [],
        "selected_branches": [],
        "selected_queries": [],
        "round2_queries": [],
        "routing_hints": {"policy": False, "filings": False, "x": False, "specialized_b": False},
    }
    latest_followup_plan_raw: Optional[str] = None
    round_traces: List[Dict[str, Any]] = []
    aggregate_routing_hints = {"policy": False, "filings": False, "x": False, "specialized_b": False}
    discovered_themes: List[str] = []

    if include_query_expansion:
        try:
            expansion_result = expand_query_with_llm(
                query=q,
                days=days,
                max_queries=max_expansion_queries if mode == "standard" else min(6, max_expansion_queries + 2),
                timeout_sec=25,
                runtime=openai_runtime,
            )
            query_plan = expansion_result["plan"]
            query_plan_raw = expansion_result.get("raw_output_text")
            section_status["query_expansion"] = {
                "status": "ok",
                "entity_type": query_plan.get("entity_type"),
                "query_count": len(query_plan.get("queries", [])),
            }
        except HTTPException as exc:
            section_status["query_expansion"] = {"status": "partial", "entity_type": "unknown", "query_count": 1}
            errors.append({"section": "query_expansion", "error": exc.detail})
        except Exception as exc:
            section_status["query_expansion"] = {"status": "partial", "entity_type": "unknown", "query_count": 1}
            errors.append({"section": "query_expansion", "error": str(exc)})

    next_queries = (query_plan.get("queries", []) or [{"query": q, "why": "original_query", "priority": 1}])[:max_expansion_queries]
    seen_query_keys = {normalize_text(item.get("query")) for item in next_queries if item.get("query")}
    all_queries_run: List[Dict[str, Any]] = []
    all_search_items: List[Dict[str, Any]] = []
    all_search_errors: List[Dict[str, Any]] = []
    aggregate_provider_runs: List[Dict[str, Any]] = []
    aggregate_provider_stats: Dict[str, Dict[str, int]] = {}

    for round_number in range(1, max_rounds + 1):
        if not next_queries:
            break

        if round_number == 1:
            per_query_limit = min(round1_per_query_limit, max(1, limit))
        else:
            per_query_limit = min(followup_per_query_limit, max(1, limit))

        round_payload = execute_search_center_queries(
            queries=next_queries,
            root_query=q,
            query_plan=query_plan,
            days=days,
            per_query_limit=per_query_limit,
            mode=mode,
            include_raw_web=include_raw_web,
            include_b_provider=include_b_fallback,
            ticker=ticker,
            company_name=company_name,
            aliases=aliases,
            openai_runtime=openai_runtime,
        )
        round_items = round_payload.get("items", [])
        round_errors = round_payload.get("errors", [])
        unified_items.extend(round_items)
        all_search_items.extend(round_items)
        all_search_errors.extend(round_errors)
        all_queries_run.extend(round_payload.get("queries_run", []))
        aggregate_provider_runs.extend(round_payload.get("provider_runs", []))
        for provider, stats in (round_payload.get("provider_stats") or {}).items():
            bucket = aggregate_provider_stats.setdefault(provider, {"queries": 0, "items": 0, "errors": 0})
            bucket["queries"] += stats.get("queries", 0)
            bucket["items"] += stats.get("items", 0)
            bucket["errors"] += stats.get("errors", 0)

        trace_entry: Dict[str, Any] = {
            "round": round_number,
            "queries": round_payload.get("queries_run", []),
            "provider_runs": round_payload.get("provider_runs", []),
            "provider_stats": round_payload.get("provider_stats", {}),
            "count": len(round_items),
            "status": "ok" if not round_errors else "partial",
        }
        if round_errors:
            trace_entry["errors"] = round_errors
            errors.extend({"section": f"round{round_number}_search_center", **item} for item in round_errors)
        round_traces.append(trace_entry)
        section_status[f"round{round_number}_search_center"] = {
            "status": trace_entry["status"],
            "count": len(round_items),
            "queries_run": len(round_payload.get("queries_run", [])),
            "providers_used": sorted((round_payload.get("provider_stats") or {}).keys()),
        }

        if round_number >= max_rounds or max_followup_queries <= 0:
            break

        try:
            followup_result = analyze_followup_results_with_llm(
                query=q,
                days=days,
                max_queries=max_followup_queries,
                query_plan=query_plan,
                round_items=round_items,
                round_number=round_number + 1,
                prior_themes=discovered_themes,
                timeout_sec=25,
                runtime=openai_runtime,
            )
            latest_followup_plan = followup_result["plan"]
            latest_followup_plan_raw = followup_result.get("raw_output_text")
            if query_plan.get("entity_type") == "company" and not has_policy_branch(latest_followup_plan):
                policy_branch = default_policy_branch(q)
                latest_followup_plan["branches"] = (latest_followup_plan.get("branches", []) or []) + [policy_branch]
                if "政策/监管外生影响" not in (latest_followup_plan.get("themes") or []):
                    latest_followup_plan["themes"] = (latest_followup_plan.get("themes") or []) + ["政策/监管外生影响"]
                if "政策/监管外生影响" not in (latest_followup_plan.get("selected_branches") or []):
                    latest_followup_plan["selected_branches"] = (latest_followup_plan.get("selected_branches") or []) + ["政策/监管外生影响"]
                existing = latest_followup_plan.get("selected_queries", []) or []
                latest_followup_plan["selected_queries"] = (existing + policy_branch["queries"])[:max(max_followup_queries, 1)]
                latest_followup_plan["round2_queries"] = latest_followup_plan["selected_queries"]
                latest_followup_plan["routing_hints"]["policy"] = True
            trace_entry["followup_plan"] = latest_followup_plan
            trace_entry["branches"] = latest_followup_plan.get("branches", [])
            trace_entry["selected_branches"] = latest_followup_plan.get("selected_branches", [])
            if latest_followup_plan.get("themes"):
                for theme in latest_followup_plan["themes"]:
                    if theme not in discovered_themes:
                        discovered_themes.append(theme)
            hints = latest_followup_plan.get("routing_hints", {})
            for key in aggregate_routing_hints:
                aggregate_routing_hints[key] = aggregate_routing_hints[key] or bool(hints.get(key))
            section_status[f"round{round_number}_planner"] = {
                "status": "ok",
                "branch_count": len(latest_followup_plan.get("branches", [])),
                "selected_branch_count": len(latest_followup_plan.get("selected_branches", [])),
                "query_count": len(latest_followup_plan.get("selected_queries", [])),
                "themes": len(latest_followup_plan.get("themes", [])),
            }
        except HTTPException as exc:
            section_status[f"round{round_number}_planner"] = {"status": "partial", "branch_count": 0, "selected_branch_count": 0, "query_count": 0, "themes": 0}
            errors.append({"section": f"round{round_number}_planner", "error": exc.detail})
            break
        except Exception as exc:
            section_status[f"round{round_number}_planner"] = {"status": "partial", "branch_count": 0, "selected_branch_count": 0, "query_count": 0, "themes": 0}
            errors.append({"section": f"round{round_number}_planner", "error": str(exc)})
            break

        proposed_queries = latest_followup_plan.get("selected_queries", []) or latest_followup_plan.get("round2_queries", [])
        filtered_next_queries = []
        for item in proposed_queries:
            key = normalize_text(item.get("query"))
            if not key or key in seen_query_keys:
                continue
            seen_query_keys.add(key)
            filtered_next_queries.append(item)
        next_queries = filtered_next_queries

        if not next_queries:
            break

    search_payload = {
        "queries_run": all_queries_run,
        "items": all_search_items,
        "errors": all_search_errors,
        "provider_runs": aggregate_provider_runs,
        "provider_stats": aggregate_provider_stats,
    }
    section_status["search_center"] = {
        "status": "ok" if not search_payload.get("errors") else "partial",
        "count": len(search_payload.get("items", [])),
        "queries_run": len(search_payload.get("queries_run", [])),
        "providers_used": sorted(aggregate_provider_stats.keys()),
    }

    policy_hint = infer_policy_query(q)
    routing_hints = aggregate_routing_hints
    if routing_hints.get("policy"):
        policy_hint["should_search"] = True
    if any("policy" in normalize_text(theme) or "regulation" in normalize_text(theme) for theme in discovered_themes):
        policy_hint["should_search"] = True

    policy_payload = None
    if policy_hint["should_search"]:
        try:
            policy_payload = run_sync_with_timeout(
                15,
                get_latest_policy_updates,
                source="all",
                limit_per_source=max(2, min(4, limit)),
                timeout_sec=10,
                signal_tag=policy_hint["signal_tag"],
                keyword=policy_hint["keyword"],
            )
            policy_items = normalize_policy_items(policy_payload.get("items", [])[:limit])
            unified_items.extend(policy_items)
            section_status["a_policy"] = {
                "status": "ok" if not policy_payload.get("partial") else "partial",
                "count": len(policy_items),
            }
        except Exception as exc:
            section_status["a_policy"] = {"status": "partial", "count": 0}
            errors.append({"section": "a_policy", "error": str(exc)})

    filings_payload = None
    earnings_payload = None
    should_try_filings = bool(ticker) or bool(routing_hints.get("filings"))
    if should_try_filings and ticker:
        try:
            filings_payload = run_sync_with_timeout(12, get_latest_filing_urls, ticker=ticker, forms="10-K,10-Q,8-K")
            filing_items = normalize_filing_items(ticker, filings_payload.get("items", []))
            unified_items.extend(filing_items)
            section_status["a_filings"] = {"status": "ok", "count": len(filing_items)}
        except Exception as exc:
            section_status["a_filings"] = {"status": "partial", "count": 0}
            errors.append({"section": "a_filings", "error": str(exc)})

        try:
            earnings_payload = run_sync_with_timeout(
                12,
                get_latest_earnings_call,
                ticker=ticker,
                company_name=company_name,
                ir_url=ir_url,
                timeout_sec=10,
            )
            earnings_items = normalize_earnings_call_items((earnings_payload.get("items") or [])[:5])
            unified_items.extend(earnings_items)
            section_status["a_earnings"] = {
                "status": earnings_payload.get("status", "partial"),
                "count": len(earnings_items),
            }
        except Exception as exc:
            section_status["a_earnings"] = {"status": "partial", "count": 0}
            errors.append({"section": "a_earnings", "error": str(exc)})

    company_events_payload = None
    should_try_specialized_b = bool(ticker or company_name or aliases) or bool(routing_hints.get("specialized_b"))
    if should_try_specialized_b and (ticker or company_name or aliases):
        try:
            company_events_payload = run_sync_with_timeout(
                10,
                company_news_events,
                ticker=ticker or (company_name or q),
                company_name=company_name,
                aliases=aliases,
                days=days,
                limit_per_alias=max(2, min(4, limit)),
                dynamic_rounds=0,
                mode="fast",
                timeout_sec=6,
            )
            company_items = normalize_company_event_items(company_events_payload.get("items", [])[:limit])
            unified_items.extend(company_items)
            section_status["b_specialized"] = {
                "status": "ok" if not company_events_payload.get("partial") else "partial",
                "count": len(company_items),
            }
        except Exception as exc:
            section_status["b_specialized"] = {"status": "partial", "count": 0}
            errors.append({"section": "b_specialized", "error": str(exc)})

    b_fallback_payload = None
    web_item_count = len(search_payload.get("items", [])) if search_payload else 0
    # B 通用新闻已并入 search center，不再单独作为统一入口尾部 fallback 重跑。
    if False and include_b_fallback and web_item_count < max(2, limit // 3):
        try:
            b_fallback_payload = run_sync_with_timeout(
                10,
                search_news_urls,
                query=q,
                days=days,
                limit=min(limit, 8),
                source=None,
                timeout_sec=6,
            )
            fallback_items = normalize_company_event_items(b_fallback_payload.get("items", []))
            unified_items.extend(fallback_items)
            section_status["b_fallback"] = {
                "status": "ok" if not b_fallback_payload.get("partial") else "partial",
                "count": len(fallback_items),
            }
        except Exception as exc:
            section_status["b_fallback"] = {"status": "partial", "count": 0}
            errors.append({"section": "b_fallback", "error": str(exc)})

    x_payload = None
    if include_x or mode == "deep" or routing_hints.get("x"):
        try:
            x_payload = await run_x_search(query=q, limit=min(limit, 5), profile_name=X_DEFAULT_PROFILE)
            x_items = normalize_x_items(x_payload.get("items", []))
            unified_items.extend(x_items)
            section_status["c_x"] = {
                "status": "ok" if x_payload.get("ok") else "partial",
                "count": len(x_items),
            }
            if x_payload.get("error"):
                errors.append({"section": "c_x", "error": x_payload.get("error")})
        except Exception as exc:
            section_status["c_x"] = {"status": "partial", "count": 0}
            errors.append({"section": "c_x", "error": str(exc)})

    deduped_items = dedupe_unified_items(unified_items)
    deduped_items.sort(key=unified_item_sort_key, reverse=True)
    deduped_items = deduped_items[: limit * 3]

    response: Dict[str, Any] = {
        "query": q,
        "days": days,
        "time_window": time_window,
        "limit": limit,
        "mode": mode,
        "count": len(deduped_items),
        "items": deduped_items,
        "partial": bool(errors),
        "errors": errors,
        "section_status": section_status,
        "query_plan": query_plan,
        "followup_plan": latest_followup_plan,
        "branches": latest_followup_plan.get("branches", []),
        "selected_branches": latest_followup_plan.get("selected_branches", []),
        "round_traces": round_traces,
        "discovered_themes": discovered_themes,
        "budget": {
            "max_expansion_queries": max_expansion_queries,
            "max_followup_queries": max_followup_queries,
            "max_rounds": max_rounds,
            "round1_per_query_limit": round1_per_query_limit,
            "followup_per_query_limit": followup_per_query_limit,
        },
        "source_strategy": source_strategy_overview(),
        "llm_runtime": {
            "base_url": openai_runtime.get("base_url"),
            "web_search_model": openai_runtime.get("web_search_model"),
            "query_expand_model": openai_runtime.get("query_expand_model"),
            "ssl_verify": bool(openai_runtime.get("ssl_verify")),
            "api_key_configured": bool(openai_runtime.get("api_key")),
        },
    }
    if search_payload:
        response["search_queries_run"] = search_payload.get("queries_run")
        response["provider_runs"] = search_payload.get("provider_runs")
        response["provider_stats"] = search_payload.get("provider_stats")
        response["web_queries_run"] = search_payload.get("queries_run")
        response["web_count"] = len(search_payload.get("items", []))
    if round_traces:
        response["round1_queries"] = round_traces[0].get("queries", [])
    if len(round_traces) > 1:
        response["round2_queries"] = round_traces[1].get("queries", [])
    if company_events_payload:
        response["b_specialized_recall_plan"] = company_events_payload.get("recall_plan")
    if include_raw_web and search_payload and "raw_response" in search_payload:
        response["raw_web_response"] = search_payload["raw_response"]
    if query_plan_raw:
        response["query_plan_raw"] = query_plan_raw
    if latest_followup_plan_raw:
        response["followup_plan_raw"] = latest_followup_plan_raw
    return response


@app.get("/api/b/source-catalog")
def get_source_catalog() -> Dict[str, Any]:
    return {
        "a_class": {
            "official_disclosure_sources": OFFICIAL_DISCLOSURE_SOURCES,
            "official_corporate_sources": OFFICIAL_CORPORATE_SOURCES,
            "official_policy_sources": OFFICIAL_POLICY_SOURCES,
        },
        "b_class": {
            "global": GLOBAL_SOURCE_POOL,
            "policy_politics": POLICY_POLITICS_SOURCE_POOL,
            "semiconductor": SEMICONDUCTOR_SOURCE_POOL,
            "korea": KOREA_SOURCE_POOL,
            "taiwan": TAIWAN_SOURCE_POOL,
            "quantum": QUANTUM_SOURCE_POOL,
            "physical_ai_robotics": PHYSICAL_AI_SOURCE_POOL,
            "commercial_space": SPACE_SOURCE_POOL,
            "biotech": BIOTECH_SOURCE_POOL,
            "autonomous_driving": AUTONOMY_SOURCE_POOL,
        },
        "c_class": {
            "account_sources": [
                {
                    "label": "x_twitter",
                    "source": "X / Twitter",
                    "status": "experimental",
                    "mode": "logged-in browser cookies",
                    "profile": X_DEFAULT_PROFILE,
                }
            ],
            "professional_research_sources": PROFESSIONAL_RESEARCH_SOURCES,
        },
        "global": GLOBAL_SOURCE_POOL,
        "policy_politics": POLICY_POLITICS_SOURCE_POOL,
        "semiconductor": SEMICONDUCTOR_SOURCE_POOL,
        "korea": KOREA_SOURCE_POOL,
        "taiwan": TAIWAN_SOURCE_POOL,
        "quantum": QUANTUM_SOURCE_POOL,
        "physical_ai_robotics": PHYSICAL_AI_SOURCE_POOL,
        "commercial_space": SPACE_SOURCE_POOL,
        "biotech": BIOTECH_SOURCE_POOL,
        "autonomous_driving": AUTONOMY_SOURCE_POOL,
        "account_sources": [
            {
                "label": "x_twitter",
                "source": "X / Twitter",
                "status": "experimental",
                "mode": "logged-in browser cookies",
                "profile": X_DEFAULT_PROFILE,
            }
        ],
        "official_site_adapters": OFFICIAL_SITE_ADAPTERS,
        "official_disclosure_sources": OFFICIAL_DISCLOSURE_SOURCES,
        "official_corporate_sources": OFFICIAL_CORPORATE_SOURCES,
        "official_policy_sources": OFFICIAL_POLICY_SOURCES,
        "professional_research_sources": PROFESSIONAL_RESEARCH_SOURCES,
        "validated_sectors": VALIDATED_SECTOR_SOURCES,
        "source_strategy": source_strategy_overview(),
    }


@app.get("/api/c/x/status")
def get_x_status(
    profile_name: str = Query(X_DEFAULT_PROFILE, description="Chrome profile name, e.g. Profile 10"),
) -> Dict[str, Any]:
    cookies_info = extract_x_cookie_bundle(profile_name)
    patch_status = ensure_twscrape_runtime_patched()
    return {
        "source": "X / Twitter",
        "status": "ok" if cookies_info["ok"] and patch_status["ok"] else "partial",
        "profile": profile_name,
        "proxy": X_DEFAULT_PROXY,
        "cookies": sanitize_x_cookie_info(cookies_info),
        "runtime_patch": patch_status,
    }


@app.get("/api/c/x/search")
async def search_x_posts(
    query: str = Query(..., description="Search query for X / Twitter"),
    limit: int = Query(10, ge=1, le=50),
    profile_name: str = Query(X_DEFAULT_PROFILE, description="Chrome profile name, e.g. Profile 10"),
) -> Dict[str, Any]:
    result = await run_x_search(query=query, limit=limit, profile_name=profile_name)
    return {
        "source": "X / Twitter",
        "query": query,
        "limit": limit,
        "profile": profile_name,
        "experimental": True,
        "partial": not result.get("ok", False),
        "count": len(result.get("items", [])),
        "items": result.get("items", []),
        "error": result.get("error"),
        "status": sanitize_x_cookie_info(result.get("status") or {}),
        "runtime_patch": result.get("patch_status"),
    }


@app.get("/api/c/x/user")
async def get_x_user(
    username: str = Query(..., description="X / Twitter screen name, without @"),
    profile_name: str = Query(X_DEFAULT_PROFILE, description="Chrome profile name, e.g. Profile 10"),
) -> Dict[str, Any]:
    clean_username = username.lstrip("@").strip()
    result = await x_graphql_request(
        operation_name="UserByScreenName",
        variables={"screen_name": clean_username, "withSafetyModeUserFields": True},
        referer=f"https://x.com/{clean_username}",
        profile_name=profile_name,
    )
    payload = result.get("payload") or {}
    user_result = (((payload.get("data") or {}).get("user") or {}).get("result") or {})
    parsed = parse_x_user_result(user_result) if user_result else None
    return {
        "source": "X / Twitter",
        "username": clean_username,
        "profile": profile_name,
        "experimental": True,
        "partial": not result.get("ok", False),
        "status_code": result.get("status_code"),
        "item": parsed,
        "error": result.get("error"),
        "status": sanitize_x_cookie_info(result.get("status") or {}),
        "runtime_patch": result.get("patch_status"),
    }


@app.get("/api/c/x/user-tweets")
async def get_x_user_tweets(
    username: str = Query(..., description="X / Twitter screen name, without @"),
    limit: int = Query(10, ge=1, le=50),
    profile_name: str = Query(X_DEFAULT_PROFILE, description="Chrome profile name, e.g. Profile 10"),
) -> Dict[str, Any]:
    clean_username = username.lstrip("@").strip()
    user_lookup = await x_graphql_request(
        operation_name="UserByScreenName",
        variables={"screen_name": clean_username, "withSafetyModeUserFields": True},
        referer=f"https://x.com/{clean_username}",
        profile_name=profile_name,
    )
    payload = user_lookup.get("payload") or {}
    user_result = (((payload.get("data") or {}).get("user") or {}).get("result") or {})
    rest_id = user_result.get("rest_id")
    if not rest_id:
        return {
            "source": "X / Twitter",
            "username": clean_username,
            "profile": profile_name,
            "experimental": True,
            "partial": True,
            "count": 0,
            "items": [],
            "error": "failed to resolve user rest_id",
            "status": sanitize_x_cookie_info(user_lookup.get("status") or {}),
            "runtime_patch": user_lookup.get("patch_status"),
        }

    timeline = await x_graphql_request(
        operation_name="UserTweets",
        variables={
            "userId": rest_id,
            "count": min(limit, 20),
            "includePromotedContent": False,
            "withQuickPromoteEligibilityTweetFields": True,
            "withVoice": True,
            "withV2Timeline": True,
        },
        referer=f"https://x.com/{clean_username}",
        profile_name=profile_name,
    )
    timeline_payload = timeline.get("payload") or {}
    parsed_user = parse_x_user_result(user_result)
    items = parse_x_tweet_entries(
        timeline_payload,
        limit=limit,
        fallback_screen_name=parsed_user.get("screen_name"),
        fallback_name=parsed_user.get("name"),
    )
    return {
        "source": "X / Twitter",
        "username": clean_username,
        "profile": profile_name,
        "experimental": True,
        "partial": not timeline.get("ok", False),
        "count": len(items),
        "items": items,
        "user": parsed_user,
        "error": timeline.get("error"),
        "status_code": timeline.get("status_code"),
        "status": sanitize_x_cookie_info(timeline.get("status") or {}),
        "runtime_patch": timeline.get("patch_status"),
    }


@app.get("/api/a/company/{ticker}/filings")
def get_company_filings(
    ticker: str,
    form: str = Query("10-K"),
    limit: int = Query(3, ge=1, le=20),
) -> Dict[str, Any]:
    try:
        company = Company(ticker.upper())
        filings = company.get_filings(form=form).head(limit)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"SEC filings lookup failed: {exc}") from exc

    items = [filing_to_dict(filing) for filing in filings]
    return {"ticker": ticker.upper(), "form": form, "count": len(items), "items": items}


@app.get("/api/a/company/{ticker}/latest-filing-urls")
def get_latest_filing_urls(
    ticker: str,
    forms: str = Query("10-K,10-Q,8-K", description="Comma-separated SEC forms"),
) -> Dict[str, Any]:
    company = Company(ticker.upper())
    items = []
    errors = []

    for form in parse_forms(forms):
        try:
            filing = company.get_filings(form=form).latest()
            items.append(filing_to_dict(filing))
        except Exception as exc:
            errors.append({"form": form, "error": str(exc)})

    return {"ticker": ticker.upper(), "count": len(items), "items": items, "errors": errors}


@app.get("/api/a/company/{ticker}/financials/income-statement")
def get_income_statement(
    ticker: str,
    rows: int = Query(20, ge=1, le=200),
) -> Dict[str, Any]:
    try:
        company = Company(ticker.upper())
        statement = company.get_financials().income_statement()
        dataframe = statement.to_dataframe().head(rows)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Income statement lookup failed: {exc}") from exc

    records = dataframe.where(dataframe.notna(), None).to_dict(orient="records")
    return {
        "ticker": ticker.upper(),
        "rows": len(records),
        "columns": list(dataframe.columns),
        "items": records,
    }


@app.get("/api/a/company/{ticker}/earnings-call-latest")
def get_latest_earnings_call(
    ticker: str,
    company_name: Optional[str] = Query(None, description="Optional company name, improves IR discovery"),
    ir_url: Optional[str] = Query(None, description="Optional official investor relations page URL"),
    timeout_sec: int = Query(10, ge=3, le=20),
) -> Dict[str, Any]:
    normalized_ticker = ticker.upper()
    resolved_company_name = company_name
    if not resolved_company_name:
        try:
            resolved_company_name = Company(normalized_ticker).name
        except Exception:
            resolved_company_name = None

    index = extract_ir_index(
        normalized_ticker,
        resolved_company_name,
        ir_url=ir_url,
        timeout=timeout_sec,
    )
    latest = {
        "transcript_url": (index["latest_by_kind"].get("transcript") or {}).get("url"),
        "webcast_url": (index["latest_by_kind"].get("webcast") or {}).get("url"),
        "presentation_url": (index["latest_by_kind"].get("presentation") or {}).get("url"),
        "press_release_url": (index["latest_by_kind"].get("press_release") or {}).get("url"),
        "event_page_url": (index["latest_by_kind"].get("event_page") or {}).get("url"),
        "quarter_hint": next(
            (item.get("quarter_hint") for item in index["items"] if item.get("quarter_hint")),
            None,
        ),
    }
    return {
        "ticker": normalized_ticker,
        "company_name": resolved_company_name,
        "status": "ok" if index["items"] else "partial",
        "latest": latest,
        "ir_candidates": index["ir_candidates"],
        "page_errors": index["page_errors"],
        "count": len(index["items"]),
        "items": index["items"][:12],
    }


@app.get("/api/a/company/{ticker}/earnings-calls")
def list_earnings_calls(
    ticker: str,
    company_name: Optional[str] = Query(None, description="Optional company name, improves IR discovery"),
    ir_url: Optional[str] = Query(None, description="Optional official investor relations page URL"),
    timeout_sec: int = Query(10, ge=3, le=20),
    limit: int = Query(20, ge=1, le=50),
) -> Dict[str, Any]:
    normalized_ticker = ticker.upper()
    resolved_company_name = company_name
    if not resolved_company_name:
        try:
            resolved_company_name = Company(normalized_ticker).name
        except Exception:
            resolved_company_name = None

    index = extract_ir_index(
        normalized_ticker,
        resolved_company_name,
        ir_url=ir_url,
        timeout=timeout_sec,
    )
    return {
        "ticker": normalized_ticker,
        "company_name": resolved_company_name,
        "status": "ok" if index["items"] else "partial",
        "ir_candidates": index["ir_candidates"],
        "page_errors": index["page_errors"],
        "count": len(index["items"][:limit]),
        "items": index["items"][:limit],
    }


@app.get("/api/a/policy/latest")
def get_latest_policy_updates(
    source: str = Query("all", description="Policy source label or 'all'"),
    limit_per_source: int = Query(8, ge=1, le=20),
    timeout_sec: int = Query(10, ge=3, le=20),
    signal_tag: Optional[str] = Query(None, description="Optional signal tag or comma-separated tags, e.g. export_control,sanctions"),
    keyword: Optional[str] = Query(None, description="Optional keyword filter against title/url"),
) -> Dict[str, Any]:
    source_labels = (
        list(OFFICIAL_POLICY_SOURCE_CONFIG.keys())
        if source == "all"
        else [source]
    )

    items: List[Dict[str, Any]] = []
    errors: List[Dict[str, Any]] = []
    source_results: List[Dict[str, Any]] = []

    with ThreadPoolExecutor(max_workers=min(6, len(source_labels) or 1)) as executor:
        future_map = {
            executor.submit(fetch_official_policy_entries, label, limit_per_source, timeout_sec): label
            for label in source_labels
        }
        for future in as_completed(future_map):
            label = future_map[future]
            try:
                result = future.result()
            except Exception as exc:
                result = {"items": [], "errors": [{"source": label, "error": str(exc)}]}
            items.extend(result["items"])
            errors.extend(result["errors"])
            source_results.append({"source": label, "count": len(result["items"])})

    requested_tags = [tag.lower() for tag in split_csv_param(signal_tag)]
    keyword_norm = normalize_text(keyword) if keyword else ""
    if requested_tags:
        items = [
            item for item in items
            if any(tag.lower() in [signal.lower() for signal in item.get("signal_tags", [])] for tag in requested_tags)
        ]
    if keyword_norm:
        items = [
            item for item in items
            if keyword_norm in normalize_text(f"{item.get('title', '')} {item.get('url', '')}")
        ]

    items.sort(key=lambda item: (item.get("published_hint") or "", item.get("score", 0)), reverse=True)
    partial = bool(errors)
    return {
        "source": source,
        "signal_tag": signal_tag,
        "keyword": keyword,
        "partial": partial,
        "count": len(items),
        "items": items,
        "source_results": sorted(source_results, key=lambda item: item["source"]),
        "errors": errors,
    }


@app.post("/api/b/article/extract")
def extract_article(payload: ExtractArticleRequest) -> Dict[str, Any]:
    item = extract_article_from_url(payload.url)
    if not any([item.get("title"), item.get("description"), item.get("maintext")]):
        raise HTTPException(status_code=502, detail="Article extraction returned empty content")
    return item


@app.post("/api/b/articles/extract")
def extract_articles(payload: ExtractArticlesRequest) -> Dict[str, Any]:
    items = []
    errors = []
    for url in payload.urls:
        try:
            item = extract_article_from_url(url)
            if not any([item.get("title"), item.get("description"), item.get("maintext")]):
                errors.append({"url": url, "error": "empty content"})
                continue
            items.append(item)
        except Exception as exc:
            errors.append({"url": url, "error": str(exc)})
    return {"count": len(items), "items": items, "errors": errors}


@app.get("/api/b/rss")
def get_rss_feed(
    feed_url: str = Query(..., description="RSS feed URL"),
    limit: int = Query(10, ge=1, le=50),
    extract_articles: bool = Query(False, description="Also extract article body"),
    timeout_sec: int = Query(DEFAULT_FEED_TIMEOUT_SEC, ge=1, le=20),
) -> Dict[str, Any]:
    feed_result = fetch_feed(feed_url, timeout=timeout_sec)
    parsed = feed_result["parsed"]
    entries = []
    errors = []
    if feed_result["error"]:
        errors.append({"stage": "rss", "feed_url": feed_url, "error": feed_result["error"]})

    for entry in parsed.entries[:limit]:
        item = {
            "title": getattr(entry, "title", None),
            "link": getattr(entry, "link", None),
            "published": getattr(entry, "published", None),
            "summary": getattr(entry, "summary", None),
        }
        if extract_articles and item["link"]:
            try:
                item["article"] = extract_article_from_url(item["link"])
            except Exception as exc:
                item["article_error"] = str(exc)
        entries.append(item)
    entries = filter_contentish_items(entries)

    return {
        "feed_url": feed_url,
        "feed_title": getattr(parsed.feed, "title", None),
        "partial": bool(errors),
        "errors": errors,
        "count": len(entries),
        "items": entries,
    }


@app.get("/api/b/news/search")
def search_news_urls(
    query: str = Query(..., description="Search query"),
    days: int = Query(7, ge=1, le=30),
    limit: int = Query(10, ge=1, le=50),
    source: Optional[str] = Query(None, description="Optional source keyword, e.g. Reuters"),
    timeout_sec: int = Query(DEFAULT_FEED_TIMEOUT_SEC, ge=1, le=20),
) -> Dict[str, Any]:
    search_query = query
    if source:
        search_query = f"{source} {search_query}"
    result = fetch_google_news_entries(search_query, days=days, limit=limit, variant_mode="single", timeout=timeout_sec)
    items = filter_contentish_items(result["items"])
    feed_url = google_news_search_feed(f"{search_query} when:{days}d")

    return {
        "query": query,
        "source_filter": source,
        "days": days,
        "partial": bool(result["errors"]),
        "errors": result["errors"],
        "feed_url": feed_url,
        "count": len(items),
        "items": items,
    }


@app.get("/api/b/news/company")
def company_news_urls(
    ticker: str = Query(..., description="Ticker, e.g. AAPL"),
    company_name: Optional[str] = Query(None, description="Optional company name"),
    days: int = Query(7, ge=1, le=30),
    limit: int = Query(10, ge=1, le=50),
    source: Optional[str] = Query(None, description="Optional source keyword, e.g. Reuters"),
    timeout_sec: int = Query(DEFAULT_FEED_TIMEOUT_SEC, ge=1, le=20),
) -> Dict[str, Any]:
    terms = [ticker.upper()]
    if company_name:
        terms.insert(0, f"\"{company_name}\"")
    query = " OR ".join(terms)
    return search_news_urls(query=query, days=days, limit=limit, source=source, timeout_sec=timeout_sec)


@app.get("/api/b/news/company-events")
def company_news_events(
    ticker: str = Query(..., description="Ticker, e.g. AAPL"),
    company_name: Optional[str] = Query(None, description="Optional company name"),
    aliases: Optional[str] = Query(None, description="Comma-separated aliases, e.g. SK hynix,海力士,SK海力士"),
    days: int = Query(7, ge=1, le=30),
    limit_per_alias: int = Query(8, ge=1, le=20),
    dynamic_rounds: int = Query(1, ge=0, le=2),
    mode: str = Query("deep", pattern="^(fast|news|deep)$"),
    timeout_sec: int = Query(DEFAULT_FEED_TIMEOUT_SEC, ge=1, le=20),
) -> Dict[str, Any]:
    alias_list: List[str] = []
    if company_name:
        alias_list.append(company_name)
    alias_list.append(ticker.upper())
    alias_list.extend(split_aliases(aliases))

    seen_aliases = set()
    clean_aliases = []
    for alias in alias_list:
        key = normalize_text(alias)
        if key and key not in seen_aliases:
            seen_aliases.add(key)
            clean_aliases.append(alias)

    raw_items: List[Dict[str, Any]] = []
    recall_plan: List[Dict[str, Any]] = []
    errors: List[Dict[str, Any]] = []
    primary_alias = primary_company_anchor(clean_aliases, company_name)
    source_pool_config = choose_source_pool(clean_aliases, company_name)
    source_pool = source_pool_config["source_pool"]
    effective_dynamic_rounds = dynamic_rounds if mode == "deep" else 0

    if mode in {"news", "deep"}:
        def fetch_broad_for_alias(index: int, alias: str) -> Dict[str, Any]:
            google_result = fetch_google_news_entries(alias, days=days, limit=limit_per_alias, timeout=timeout_sec)
            gdelt_result = {"items": [], "errors": []}
            if alias == primary_alias:
                gdelt_result = fetch_gdelt_entries(alias, days=days, limit=max(3, limit_per_alias // 2))
            return {
                "index": index,
                "query": alias,
                "google_items": google_result["items"],
                "gdelt_items": gdelt_result["items"],
                "errors": google_result["errors"] + gdelt_result["errors"],
            }

        broad_results: List[Dict[str, Any]] = []
        with ThreadPoolExecutor(max_workers=min(6, max(1, len(clean_aliases)))) as executor:
            futures = [executor.submit(fetch_broad_for_alias, index, alias) for index, alias in enumerate(clean_aliases)]
            for future in as_completed(futures):
                try:
                    broad_results.append(future.result())
                except Exception as exc:
                    errors.append({"stage": "broad_recall", "query": primary_alias, "error": str(exc)})

        for result in sorted(broad_results, key=lambda item: item["index"]):
            raw_items.extend(result["google_items"])
            raw_items.extend(result["gdelt_items"])
            errors.extend(result["errors"])
            recall_plan.append(
                {
                    "stage": "broad_recall",
                    "query": result["query"],
                    "google_count": len(result["google_items"]),
                    "gdelt_count": len(result["gdelt_items"]),
                }
            )

        if mode == "deep":
            site_scoped_result = fetch_site_scoped_entries(
                primary_alias,
                clean_aliases,
                source_pool=source_pool,
                days=days,
                limit_per_source=max(1, min(2, limit_per_alias)),
                max_sources=source_pool_config["site_scope_max_sources"],
            )
            raw_items.extend(site_scoped_result["items"])
            errors.extend(site_scoped_result["errors"])
            recall_plan.append(
                {
                    "stage": "source_pool_recall",
                    "query": primary_alias,
                    "source_tags": source_pool_config["source_tags"],
                    "source_pool_count": len(source_pool),
                    "max_sources_used": source_pool_config["site_scope_max_sources"],
                    "site_scoped_count": len(site_scoped_result["items"]),
                    "sources_used": [item["label"] for item in source_pool[: source_pool_config["site_scope_max_sources"]]],
                }
            )

    direct_timeout = min(max(3, timeout_sec + 1), 8)
    direct_tasks = {}
    if mode in {"fast", "deep"}:
        direct_tasks["official_site"] = lambda: fetch_official_site_entries(ticker.upper(), clean_aliases, limit=6, timeout=direct_timeout)
        direct_tasks["cninfo"] = lambda: fetch_cninfo_disclosure_entries(
            ticker.upper(),
            company_name,
            clean_aliases,
            days=days,
            limit=6,
            timeout=max(4, min(10, timeout_sec + 2)),
        )
    if mode == "deep":
        direct_tasks["businesskorea"] = lambda: fetch_businesskorea_direct_entries(clean_aliases, limit=4, timeout=direct_timeout)
        direct_tasks["thelec"] = lambda: fetch_thelec_direct_entries(clean_aliases, limit=4, timeout=direct_timeout)

    direct_results: Dict[str, List[Dict[str, Any]]] = {
        "businesskorea": [],
        "thelec": [],
        "official_site": [],
        "cninfo": [],
    }
    if direct_tasks:
        with ThreadPoolExecutor(max_workers=len(direct_tasks)) as executor:
            future_map = {executor.submit(task): label for label, task in direct_tasks.items()}
            for future in as_completed(future_map):
                label = future_map[future]
                try:
                    direct_results[label] = future.result()
                except Exception as exc:
                    errors.append({"stage": "direct_source_adapters", "source": label, "query": primary_alias, "error": str(exc)})

    businesskorea_direct_items = direct_results["businesskorea"]
    thelec_direct_items = direct_results["thelec"]
    official_site_items = direct_results["official_site"]
    cninfo_disclosure_items = direct_results["cninfo"]
    raw_items.extend(businesskorea_direct_items)
    raw_items.extend(thelec_direct_items)
    raw_items.extend(official_site_items)
    raw_items.extend(cninfo_disclosure_items)
    if direct_tasks:
        recall_plan.append(
            {
                "stage": "direct_source_adapters",
                "query": primary_alias,
                "businesskorea_count": len(businesskorea_direct_items),
                "thelec_count": len(thelec_direct_items),
                "official_site_count": len(official_site_items),
                "cninfo_count": len(cninfo_disclosure_items),
            }
        )

    deduped_items = dedupe_news_items(raw_items)
    expansion_queries: List[Dict[str, str]] = []
    if effective_dynamic_rounds > 0 and deduped_items:
        expansion_queries = build_dynamic_expansion_queries(clean_aliases, deduped_items)

    expanded_items: List[Dict[str, Any]] = []
    for index, expansion in enumerate(expansion_queries):
        google_result = fetch_google_news_entries(
            expansion["query"],
            days=days,
            limit=max(4, limit_per_alias // 2),
            timeout=timeout_sec,
        )
        gdelt_result = fetch_gdelt_entries(expansion["query"], days=days, limit=3) if index == 0 else {"items": [], "errors": []}
        errors.extend(google_result["errors"])
        errors.extend(gdelt_result["errors"])
        combined = google_result["items"] + gdelt_result["items"]
        if combined:
            for item in combined:
                item["trigger_term"] = expansion["trigger_term"]
            expanded_items.extend(combined)
        recall_plan.append(
            {
                "stage": "dynamic_expansion",
                "query": expansion["query"],
                "trigger_term": expansion["trigger_term"],
                "google_count": len(google_result["items"]),
                "gdelt_count": len(gdelt_result["items"]),
            }
        )

    all_items = dedupe_news_items(raw_items + expanded_items)
    all_items = filter_contentish_items(all_items)
    for item in all_items:
        category = classify_event(item["base_title"], item.get("summary"))
        item["category"] = category
        item["score"] = (
            source_weight(item.get("source"))
            + category_priority(category)
            + min(item.get("duplicate_count", 1), 3)
            + min(len(item.get("recall_sources", [])), 3)
        )

    items = sorted(
        all_items,
        key=lambda item: (
            item["score"],
            item.get("duplicate_count", 1),
            len(item.get("recall_sources", [])),
            item.get("published") or "",
        ),
        reverse=True,
    )

    grouped: Dict[str, List[Dict[str, Any]]] = {}
    for item in items:
        grouped.setdefault(item["category"], []).append(item)

    return {
        "ticker": ticker.upper(),
        "company_name": company_name,
        "aliases_used": clean_aliases,
        "days": days,
        "mode": mode,
        "dynamic_rounds": effective_dynamic_rounds,
        "partial": bool(errors),
        "errors": errors,
        "source_pool_used": [item["label"] for item in source_pool],
        "recall_plan": recall_plan,
        "raw_result_count": len(raw_items),
        "expanded_result_count": len(expanded_items),
        "deduped_result_count": len(items),
        "items": items,
        "groups": grouped,
    }
