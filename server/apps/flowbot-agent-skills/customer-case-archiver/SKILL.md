---
name: customer-case-archiver
description: Use when WeCom messages may need silent local archiving as customer work items. Trigger for potential case feedback, bug/problem reports, feature/addition requests, or live incident handling discussions. Classify only into case_feedback, feature_request, or incident_handling, ingest into raw logs plus candidate threads with the bundled script, and usually reply NO_REPLY unless a visible reply is explicitly needed.
---

# Customer Case Archiver

Use this skill for customer-service style WeCom chats where the assistant should listen, classify, and archive locally without interrupting the conversation.

Prefer using this skill even when the evidence is still incomplete but likely belongs to one of the three categories. The script now stores raw messages and candidate threads before promoting a confirmed case.

When a customer-service report triggers a case, keep following messages from customer service, product, R&D, or operations in the same case as long as they are still discussing that same issue/request/incident.

## Categories

Only archive into one of these three categories:

- `case_feedback`
  Bug reports, usage problems, complaints, "it is broken", "cannot use", failed operations, abnormal behavior.
- `feature_request`
  Requests for new capability, workflow change, optimization, "add this feature", "support X".
- `incident_handling`
  Ongoing online issue handling, production troubleshooting, service recovery, emergency coordination.

If the message does not clearly belong to one of the three categories, do not archive it.

## Default Behavior

- In group chats, prefer silent background work.
- Err on the side of ingesting a candidate thread rather than skipping likely customer-work messages.
- If you archived successfully and nobody explicitly asked for a visible answer, reply with only `NO_REPLY`.
- If you are directly asked to summarize or answer, you may give a short visible reply after archiving.
- Never hand-edit archive files. Always use the bundled script.
- If multiple people are discussing different topics in the same group, split them into separate archive payloads by topic. Do not mix two different threads into one case just because they are close in time.
- If product or R&D joins after the first feedback and continues discussing the same case, include those follow-up messages in the same archive payload.
- Keep `messages[].content` in the original wording received from the current pipeline. Do not translate, polish, or rewrite it.

## Workflow

1. Read the incoming text plus any image description or voice transcript already available in context.
2. Decide the best-fit category out of the three allowed ones.
3. If messages are interleaved, isolate only the evidence that belongs to the same topic and same ongoing thread.
4. Build a structured payload using the currently related messages you can see.
5. Run the archive script with that payload. The script will ingest raw messages, update a candidate thread, and promote a case only when enough evidence exists.
6. Return `NO_REPLY` unless a visible answer is clearly required.

## Payload Schema

Use this JSON shape:

```json
{
  "chat_id": "wecom-group-id",
  "chat_name": "群名称",
  "sender": "发送人",
  "message_time": "2026-04-21 18:30:00",
  "category": "case_feedback",
  "priority": "medium",
  "summary": "用户反馈登录后一直转圈，无法进入系统",
  "keywords": ["登录", "转圈", "无法进入"],
  "confidence": 0.92,
  "messages": [
    {
      "msg_id": "optional-msg-id",
      "time": "2026-04-21 18:30:00",
      "sender": "张三",
      "type": "text",
      "content": "登录后一直转圈，进不去"
    }
  ]
}
```

Rules:

- `category` must be exactly one of the three allowed values.
- `priority` must be one of `low`, `medium`, `high`, `urgent`.
- `summary` should be one sentence in Chinese.
- `keywords` should be 2 to 6 useful phrases.
- `messages` should include the current user-visible evidence. If multiple consecutive messages in the same turn are relevant, include all of them.
- `messages` should include the full related dialogue for that case in the current turn, not just the first customer-service complaint.
- `messages` may represent a partial thread. It is okay to send the current related slice now and let the local pipeline merge it into an existing candidate thread later.
- For interleaved group chats, `messages` must include only the messages that belong to the same topic. If Zhang San is reporting a login loop and Li Si is requesting Excel export, create two separate archives instead of one mixed payload.
- If Wang Wu from product asks follow-up questions and Zhao Liu from R&D replies with troubleshooting notes for Zhang San's login loop, keep those messages in the same case payload.

## Command

Run the bundled script with its absolute path and pipe the JSON via stdin:

```bash
cat <<'JSON' | python3 "/Users/yuebuy/Documents/New project/flowbot-agent-skills/customer-case-archiver/scripts/archive_issue.py"
{
  "chat_id": "wecom-group-id",
  "chat_name": "群名称",
  "sender": "发送人",
  "message_time": "2026-04-21 18:30:00",
  "category": "case_feedback",
  "priority": "medium",
  "summary": "用户反馈登录后一直转圈，无法进入系统",
  "keywords": ["登录", "转圈", "无法进入"],
  "confidence": 0.92,
  "messages": [
    {
      "msg_id": "optional-msg-id",
      "time": "2026-04-21 18:30:00",
      "sender": "张三",
      "type": "text",
      "content": "登录后一直转圈，进不去"
    }
  ]
}
JSON
```

The script automatically:

- creates the local archive root
- appends incoming messages to `raw-messages.jsonl`
- writes or updates `threads/<THREAD_ID>.json`
- writes or updates `threads/<THREAD_ID>.md`
- appends thread lifecycle events to `thread-events.jsonl`
- promotes a candidate thread into a case when enough evidence exists
- appends case lifecycle events to `issues.jsonl`
- writes `cases/<CASE_ID>.json`
- writes `cases/<CASE_ID>.md`
- writes `conversations/<CASE_ID>.json`
- writes `conversations/<CASE_ID>.md`

## Archive Location

By default the archive root is:

`/Users/yuebuy/Documents/New project/customer-bot-data`

## Response Policy

- Archived silently in background: reply only `NO_REPLY`
- Not one of the three categories and no visible help needed: reply only `NO_REPLY`
- Explicit summary/request for help: archive first, then answer briefly
