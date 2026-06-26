from __future__ import annotations

CATEGORY_LABELS = {
    "case_feedback": "问题反馈",
    "feature_request": "需求新增",
    "incident_handling": "线上问题处理",
}

THREAD_TYPE_LABELS = {
    "case_feedback": "反馈 Case",
    "feature_request": "功能诉求",
    "question": "提问题",
    "chat": "闲聊",
}

MESSAGE_ROLE_LABELS = {
    "problem_report": "问题反馈",
    "feature_request": "功能诉求",
    "question": "提问",
    "chitchat": "闲聊",
    "evidence": "补充证据",
    "developer_question": "研发追问",
    "user_reply": "用户补充",
    "troubleshooting_update": "排查进展",
    "diagnosis": "排查结论",
    "workaround": "临时规避",
    "resolution": "最终解决",
    "waiting_upstream": "等待上游",
    "waiting_user": "等待用户",
    "other": "其他",
}

CASE_STATUS_LABELS = {
    "open": "待确认",
    "investigating": "排查中",
    "waiting_user": "等待用户补充",
    "waiting_development": "等待研发处理",
    "waiting_upstream": "等待上游处理",
    "diagnosed": "已给结论",
    "resolved": "已解决",
    "closed": "已关闭",
}

PRIORITY_ORDER = {
    "P3": 0,
    "P2": 1,
    "P1": 2,
    "P0": 3,
}

PRIORITY_ALIASES = {
    "p0": "P0",
    "urgent": "P0",
    "p1": "P1",
    "high": "P1",
    "p2": "P2",
    "medium": "P2",
    "normal": "P2",
    "p3": "P3",
    "low": "P3",
}

THREAD_MATCH_WINDOW_MINUTES = 45
CASE_MATCH_WINDOW_MINUTES = 90
THREAD_MATCH_MIN_SCORE = 0.2
CASE_MATCH_MIN_SCORE = 0.2
SAME_SENDER_SPLIT_MAX_TOPIC_SCORE = 0.08
DIFFERENT_SENDER_MIN_TOPIC_SCORE = 0.25
SAME_SENDER_SPLIT_MAX_KEYWORD_SCORE = 0.01
SAME_SENDER_SPLIT_MAX_SUMMARY_SCORE = 0.18
DIFFERENT_SENDER_MIN_KEYWORD_SCORE = 0.08
DIFFERENT_SENDER_MIN_SUMMARY_SCORE = 0.18
