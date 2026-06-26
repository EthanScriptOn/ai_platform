from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from archive_constants import (
    CASE_MATCH_MIN_SCORE,
    CASE_MATCH_WINDOW_MINUTES,
    DIFFERENT_SENDER_MIN_KEYWORD_SCORE,
    DIFFERENT_SENDER_MIN_SUMMARY_SCORE,
    DIFFERENT_SENDER_MIN_TOPIC_SCORE,
    SAME_SENDER_SPLIT_MAX_KEYWORD_SCORE,
    SAME_SENDER_SPLIT_MAX_SUMMARY_SCORE,
    SAME_SENDER_SPLIT_MAX_TOPIC_SCORE,
    THREAD_MATCH_MIN_SCORE,
    THREAD_MATCH_WINDOW_MINUTES,
)
from archive_issue_common import format_time, parse_time
from archive_issue_payload import collect_people, extract_tokens


def build_case_id(now: datetime, payload: dict[str, Any]) -> str:
    seed = f"{payload['chat_id']}::{payload['summary']}::{format_time(now)}"
    suffix = abs(hash(seed)) % 10000
    return f"CASE-{now.strftime('%Y%m%d-%H%M%S')}-{suffix:04d}"


def build_thread_id(now: datetime, payload: dict[str, Any]) -> str:
    seed = f"{payload['chat_id']}::{payload['category']}::{payload['summary']}::{format_time(now)}"
    suffix = abs(hash(seed)) % 10000
    return f"THREAD-{now.strftime('%Y%m%d-%H%M%S')}-{suffix:04d}"


def keyword_score(left: list[str], right: list[str]) -> float:
    left_set = extract_tokens(" ".join(left))
    right_set = extract_tokens(" ".join(right))
    if not left_set or not right_set:
        return 0.0
    inter = len(left_set & right_set)
    union = len(left_set | right_set)
    return inter / union if union else 0.0


def summary_match(left: str, right: str) -> bool:
    a = left.strip().lower()
    b = right.strip().lower()
    if not a or not b:
        return False
    return a in b or b in a


def summary_score(left: str, right: str) -> float:
    left_set = extract_tokens(left)
    right_set = extract_tokens(right)
    if not left_set or not right_set:
        return 0.0
    inter = len(left_set & right_set)
    union = len(left_set | right_set)
    return inter / union if union else 0.0


def participant_score(left: list[str], right: list[str]) -> float:
    left_set = {item.strip() for item in left if str(item).strip()}
    right_set = {item.strip() for item in right if str(item).strip()}
    if not left_set or not right_set:
        return 0.0
    inter = len(left_set & right_set)
    union = len(left_set | right_set)
    return inter / union if union else 0.0


def compute_topic_score(payload: dict[str, Any], candidate: dict[str, Any]) -> tuple[float, bool, float, float]:
    keyword = keyword_score(payload["keywords"], candidate.get("keywords") or [])
    summary = summary_score(payload["summary"], str(candidate.get("summary") or ""))
    match = summary_match(payload["summary"], str(candidate.get("summary") or ""))
    topic = max(keyword, summary, 0.85 if match else 0.0)
    return topic, match, keyword, summary


def should_block_thread_merge(
    payload: dict[str, Any],
    candidate: dict[str, Any],
    people_score: float,
    topic_score: float,
    match: bool,
    keyword_raw: float,
    summary_raw: float,
) -> bool:
    payload_sender = str(payload["sender"]).strip()
    candidate_reporter = str(candidate.get("reporter") or "").strip()
    candidate_latest = str(candidate.get("latest_sender") or "").strip()
    same_sender = payload_sender and payload_sender in {candidate_reporter, candidate_latest}
    if (same_sender and not match and keyword_raw <= SAME_SENDER_SPLIT_MAX_KEYWORD_SCORE
            and summary_raw <= SAME_SENDER_SPLIT_MAX_SUMMARY_SCORE):
        return True
    if (not same_sender and people_score <= 0.0 and keyword_raw < DIFFERENT_SENDER_MIN_KEYWORD_SCORE
            and summary_raw < DIFFERENT_SENDER_MIN_SUMMARY_SCORE and topic_score < DIFFERENT_SENDER_MIN_TOPIC_SCORE):
        return True
    return False


def choose_thread(index_threads: list[dict[str, Any]], payload: dict[str, Any]) -> dict[str, Any] | None:
    current_time = parse_time(payload["last_message_time"])
    candidates: list[tuple[float, dict[str, Any]]] = []
    payload_people = collect_people(payload["messages"])
    for item in index_threads:
        if not isinstance(item, dict):
            continue
        if item.get("chat_id") != payload["chat_id"]:
            continue
        if item.get("category") != payload["category"]:
            continue
        last_time_raw = item.get("last_message_time") or item.get("updated_at")
        if not last_time_raw:
            continue
        last_time = parse_time(str(last_time_raw))
        if abs(current_time - last_time) > timedelta(minutes=THREAD_MATCH_WINDOW_MINUTES):
            continue
        people = participant_score(payload_people, item.get("participants") or [])
        topic, match, keyword_raw, summary_raw = compute_topic_score(payload, item)
        if should_block_thread_merge(payload, item, people, topic, match, keyword_raw, summary_raw):
            continue
        score = max(topic, people)
        if payload["sender"] == item.get("reporter"):
            score += 0.12
        if payload["sender"] == item.get("latest_sender"):
            score += 0.08
        if people > 0:
            score += 0.03
        candidates.append((score, item))
    if not candidates:
        return None
    candidates.sort(key=lambda entry: entry[0], reverse=True)
    best_score, best_item = candidates[0]
    if best_score < THREAD_MATCH_MIN_SCORE:
        return None
    return best_item


def choose_case(index_cases: list[dict[str, Any]], payload: dict[str, Any]) -> dict[str, Any] | None:
    current_time = parse_time(payload["last_message_time"])
    candidates: list[tuple[float, dict[str, Any]]] = []
    payload_people = collect_people(payload["messages"])
    for item in index_cases:
        if not isinstance(item, dict):
            continue
        if item.get("chat_id") != payload["chat_id"]:
            continue
        if item.get("category") != payload["category"]:
            continue
        last_time_raw = item.get("last_message_time") or item.get("updated_at")
        if not last_time_raw:
            continue
        last_time = parse_time(str(last_time_raw))
        if abs(current_time - last_time) > timedelta(minutes=CASE_MATCH_WINDOW_MINUTES):
            continue
        people = participant_score(payload_people, item.get("participants") or [])
        topic, match, keyword_raw, summary_raw = compute_topic_score(payload, item)
        if should_block_thread_merge(payload, item, people, topic, match, keyword_raw, summary_raw):
            continue
        score = max(topic, people)
        if payload["sender"] == item.get("reporter"):
            score += 0.08
        if payload["sender"] == item.get("latest_sender"):
            score += 0.05
        if people > 0:
            score += 0.02
        candidates.append((score, item))
    if not candidates:
        return None
    candidates.sort(key=lambda entry: entry[0], reverse=True)
    best_score, best_item = candidates[0]
    if best_score < CASE_MATCH_MIN_SCORE:
        return None
    return best_item
