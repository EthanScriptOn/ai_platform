"use strict";

function createDashboardSummaryUtils({
  AGENT_PRIMARY_WAKE_NAME,
  normalizePriority,
  readJsonFile,
}) {
  function compareTimeDesc(left, right, fieldCandidates) {
    const leftValue = fieldCandidates.map((field) => left?.[field]).find(Boolean) || "";
    const rightValue = fieldCandidates.map((field) => right?.[field]).find(Boolean) || "";
    return String(rightValue).localeCompare(String(leftValue));
  }
  
  function summarizeReason(reason) {
    const reasonMap = {
      accepted: "已通过过滤",
      archived: "已归档",
      archive_failed: "归档失败",
      archive_disabled: "归档功能关闭",
      ignored_by_llm: "模型判断无需归档",
      review_required: "需要人工复核",
      category_not_matched: "未命中三类业务",
      llm_classify_failed: "大模型分类失败",
      llm_request_failed: "大模型请求失败",
      llm_parse_failed: "大模型返回格式错误",
      llm_repair_failed: "大模型修复失败",
      llm_category_none: "大模型判断为非问题类消息",
      content_empty: "没有可用内容",
      self_test_only: "识别为自测消息，已跳过",
      self_sent_message: "机器人自己发送的消息，已跳过",
      roomid_missing: "缺少 roomid",
      feishu_chat_id_missing: "缺少飞书 chat_id",
      notify_type_not_supported: "通知类型不支持",
    };
    if (reasonMap[reason]) {
      return reasonMap[reason];
    }
    if (String(reason).startsWith("roomid_filtered:")) {
      return `企微群过滤：${String(reason).slice("roomid_filtered:".length)}`;
    }
    if (String(reason).startsWith("feishu_chat_id_filtered:")) {
      return `飞书群过滤：${String(reason).slice("feishu_chat_id_filtered:".length)}`;
    }
    if (String(reason).startsWith("msg_type_filtered:")) {
      return `消息类型过滤：${String(reason).slice("msg_type_filtered:".length)}`;
    }
    if (String(reason).startsWith("notify_type_not_supported:")) {
      return `通知类型过滤：${String(reason).slice("notify_type_not_supported:".length)}`;
    }
    return reason || "未知";
  }
  
  function summarizePoolStatus(status) {
    const statusMap = {
      pending: "待批处理",
      processing: "批处理中",
      ignored: "已忽略",
      review_required: "待人工复核",
      case_created: "已建新 Case",
      case_appended: "已追加到已有 Case",
      case_activity_appended: "已追加为 Case 活动",
    };
    return statusMap[String(status || "").trim()] || String(status || "未知状态");
  }
  
  function summarizeAgentTaskStatus(status) {
    const statusMap = {
      pending: `待${AGENT_PRIMARY_WAKE_NAME}处理`,
      claimed: `${AGENT_PRIMARY_WAKE_NAME}处理中`,
      replied: `${AGENT_PRIMARY_WAKE_NAME}已发出回复`,
      completed: `${AGENT_PRIMARY_WAKE_NAME}已完成`,
      ignored: "无需处理",
      failed: "处理失败",
    };
    return statusMap[String(status || "").trim()] || String(status || "未知状态");
  }
  
  function summarizeThreadReason(reason) {
    const reasonMap = {
      candidate: "证据还不够，暂时保留在线索池",
      ready: "已经达到成案条件，等待提升",
      promoted: "已提升为正式 case",
      "insufficient-evidence": "消息还不足以单独成案",
      "multi-message-thread": "已聚合到多条消息 thread",
      "multi-party-discussion": "多人围绕同一问题在讨论",
      "media-evidence": "包含图片或语音等补充证据",
      "high-priority-confidence": "高优先级且置信度较高",
      "already-linked": "已经关联到 case",
    };
    return reasonMap[reason] || reason || "等待进一步归纳";
  }
  
  function buildCountBreakdown(items, getLabel) {
    const counts = new Map();
    for (const item of items) {
      const label = String(getLabel(item) || "未知");
      counts.set(label, (counts.get(label) || 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([label, count]) => ({ label, count }))
      .sort((left, right) => right.count - left.count || String(left.label).localeCompare(String(right.label)));
  }
  
  function readCaseArtifacts(item) {
    const paths = item?.paths || {};
    const caseDetail = paths.json ? readJsonFile(paths.json, null) : null;
    const conversationDetail = paths.conversation_json ? readJsonFile(paths.conversation_json, null) : null;
    return {
      caseDetail,
      conversationDetail,
    };
  }
  
  function getItemRoomId(item) {
    return String(
      item?.roomId
        || item?.room_id
        || item?.chat_id
        || item?.chatId
        || "",
    );
  }
  
  function getItemRoomName(item) {
    return String(
      item?.roomName
        || item?.room_name
        || item?.chat_name
        || item?.chatName
        || item?.groupName
        || item?.group_name
        || item?.conversationName
        || item?.conversation_name
        || "",
    );
  }

  function getItemPlatform(item) {
    const explicit = String(item?.platform || item?.source || item?.rawData?.source || "").trim().toLowerCase();
    if (explicit === "feishu" || explicit === "lark") {
      return "feishu";
    }
    if (explicit === "wecom" || explicit === "wework" || explicit === "wechat_work") {
      return "wecom";
    }
    const traceId = String(item?.traceId || item?.trace_id || "").trim();
    const roomId = getItemRoomId(item);
    if (traceId.startsWith("feishu:") || String(roomId || "").startsWith("oc_")) {
      return "feishu";
    }
    return "wecom";
  }

  function getItemGuid(item) {
    const direct = String(item?.guid || item?.clientGuid || item?.client_guid || item?.instanceGuid || "").trim();
    if (direct) {
      return direct;
    }
    const traceId = String(item?.traceId || item?.trace_id || "").trim();
    const firstPart = traceId.split(":")[0] || "";
    return firstPart && firstPart !== "no-guid" ? firstPart : "";
  }

  function getItemEventTime(item) {
    return String(
      item?.receivedAt
        || item?.eventTime
        || item?.event_time
        || item?.updatedAt
        || item?.updated_at
        || item?.createdAt
        || item?.created_at
        || item?.sendTimeIso
        || item?.send_time
        || "",
    ).trim();
  }

  function getMeaningfulRoomName(item, roomId = getItemRoomId(item)) {
    const name = getItemRoomName(item).trim();
    if (!name || name === String(roomId || "").trim()) {
      return "";
    }
    return name;
  }

  function parseRoomNameMap(value) {
    const map = new Map();
    String(value || "").split(/\r?\n|,/).forEach((line) => {
      const text = String(line || "").trim();
      if (!text) return;
      const separatorIndex = text.includes("=") ? text.indexOf("=") : text.indexOf(":");
      if (separatorIndex <= 0) return;
      const id = text.slice(0, separatorIndex).trim();
      const name = text.slice(separatorIndex + 1).trim();
      if (id && name) {
        map.set(id, name);
      }
    });
    return map;
  }
  
  function filterItemsByRoom(items, selectedRoomId, getRoomId = getItemRoomId) {
    if (!selectedRoomId) {
      return items;
    }
    return items.filter((item) => String(getRoomId(item) || "") === selectedRoomId);
  }
  
  function buildAvailableRooms({
    callbackEvents = [],
    filterEvents = [],
    normalizedEvents = [],
    archiveEvents = [],
    cases = [],
    threads = [],
  } = {}) {
    const roomMeta = new Map();
  
    function touchRoom(item, countKey = "messageCount") {
      const roomId = getItemRoomId(item);
      if (!roomId) {
        return;
      }
      const prev = roomMeta.get(roomId) || {
        id: roomId,
        name: getMeaningfulRoomName(item, roomId) || "",
        platform: getItemPlatform(item),
        guid: getItemGuid(item),
        guidTime: getItemEventTime(item),
        messageCount: 0,
        caseCount: 0,
        threadCount: 0,
      };
      const nextName = getMeaningfulRoomName(item, roomId);
      const nextPlatform = getItemPlatform(item);
      const nextGuid = getItemGuid(item);
      const nextGuidTime = getItemEventTime(item);
      const shouldUseNextGuid = Boolean(nextGuid)
        && (!prev.guid || !prev.guidTime || !nextGuidTime || String(nextGuidTime) >= String(prev.guidTime));
      const next = {
        ...prev,
        name: nextName || prev.name || "",
        platform: prev.platform || nextPlatform,
        guid: shouldUseNextGuid ? nextGuid : (prev.guid || ""),
        guidTime: shouldUseNextGuid ? nextGuidTime : (prev.guidTime || ""),
      };
      next[countKey] = Number(next[countKey] || 0) + 1;
      roomMeta.set(roomId, next);
    }
  
    callbackEvents.forEach((item) => touchRoom(item, "messageCount"));
    filterEvents.forEach((item) => touchRoom(item, "messageCount"));
    normalizedEvents.forEach((item) => touchRoom(item, "messageCount"));
    archiveEvents.forEach((item) => touchRoom(item, "messageCount"));
    cases.forEach((item) => touchRoom(item, "caseCount"));
    threads.forEach((item) => touchRoom(item, "threadCount"));
  
    const configuredRoomNames = parseRoomNameMap(process.env.FLOWBOT_ROOM_NAME_MAP);
    return Array.from(roomMeta.values()).map((room) => {
      const { guidTime, ...rest } = room;
      return {
        ...rest,
        name: configuredRoomNames.get(room.id) || room.name || "",
      };
    }).sort((left, right) => {
      return Number(right.messageCount || 0) - Number(left.messageCount || 0)
        || Number(right.caseCount || 0) - Number(left.caseCount || 0)
        || Number(right.threadCount || 0) - Number(left.threadCount || 0)
        || left.id.localeCompare(right.id);
    });
  }
  
  function buildSimpleCountBreakdown(values) {
    const counter = new Map();
    for (const raw of Array.isArray(values) ? values : []) {
      const label = String(raw || "").trim();
      if (!label) {
        continue;
      }
      counter.set(label, (counter.get(label) || 0) + 1);
    }
    return Array.from(counter.entries())
      .map(([label, count]) => ({ label, count }))
      .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
  }
  
  function parseDashboardTimeMs(value) {
    const ts = Date.parse(String(value || "").trim());
    return Number.isFinite(ts) ? ts : null;
  }
  
  function computeTaskDurationMs(task) {
    const claimedAt = parseDashboardTimeMs(task?.claimedAt);
    const completedAt = parseDashboardTimeMs(task?.completedAt);
    if (!Number.isFinite(claimedAt) || !Number.isFinite(completedAt) || completedAt < claimedAt) {
      return null;
    }
    return completedAt - claimedAt;
  }
  
  function computeLatencyPartMs(startValue, endValue) {
    const start = parseDashboardTimeMs(startValue);
    const end = parseDashboardTimeMs(endValue);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      return null;
    }
    return end - start;
  }
  
  function computeDashboardAgeMs(value, nowMs = Date.now()) {
    const ts = parseDashboardTimeMs(value);
    if (!Number.isFinite(ts) || ts > nowMs) {
      return null;
    }
    return nowMs - ts;
  }
  
  function buildAttentionItem({ kind, severity = "info", title, count = 0, summary = "", action = "", items = [] }) {
    return {
      kind,
      severity,
      title,
      count,
      summary,
      action,
      items,
    };
  }
  
  function summarizeAgentTaskForDashboard(task) {
    const durationMs = computeTaskDurationMs(task);
    const queueWaitMs = computeLatencyPartMs(task?.sendTimeIso, task?.claimedAt);
    const processingMs = computeLatencyPartMs(task?.agentStartedAt || task?.claimedAt, task?.agentFinishedAt || task?.completedAt);
    const replySendMs = computeLatencyPartMs(task?.agentFinishedAt, task?.replySentAt || task?.completedAt);
    const totalMs = computeLatencyPartMs(task?.sendTimeIso, task?.replySentAt || task?.completedAt);
    return {
      taskId: String(task?.taskId || "").trim(),
      traceId: String(task?.traceId || "").trim(),
      roomId: String(task?.roomId || task?.rawRoomId || "").trim(),
      roomName: String(task?.roomName || task?.roomId || "").trim(),
      senderName: String(task?.senderName || task?.senderId || "").trim(),
      senderId: String(task?.senderId || "").trim(),
      status: String(task?.status || "").trim(),
      statusLabel: summarizeAgentTaskStatus(task?.status),
      routeReason: String(task?.routeReason || "").trim(),
      note: String(task?.note || "").trim(),
      responseSummary: String(task?.responseSummary || "").trim(),
      sendTimeIso: String(task?.sendTimeIso || "").trim(),
      claimedAt: String(task?.claimedAt || "").trim(),
      agentStartedAt: String(task?.agentStartedAt || "").trim(),
      agentFinishedAt: String(task?.agentFinishedAt || "").trim(),
      replySentAt: String(task?.replySentAt || "").trim(),
      completedAt: String(task?.completedAt || "").trim(),
      updatedAt: String(task?.updatedAt || "").trim(),
      durationMs,
      queueWaitMs,
      processingMs,
      replySendMs,
      totalMs,
      llmSteps: Number(task?.llmSteps || 0) || 0,
      toolCallCount: Number(task?.toolCallCount || 0) || 0,
      toolNames: Array.isArray(task?.toolNames) ? task.toolNames : [],
    };
  }

  return {
    buildAttentionItem,
    buildAvailableRooms,
    buildCountBreakdown,
    buildSimpleCountBreakdown,
    compareTimeDesc,
    computeDashboardAgeMs,
    computeLatencyPartMs,
    computeTaskDurationMs,
    filterItemsByRoom,
    getItemRoomId,
    getItemRoomName,
    parseDashboardTimeMs,
    readCaseArtifacts,
    summarizeAgentTaskForDashboard,
    summarizeAgentTaskStatus,
    summarizePoolStatus,
    summarizeReason,
    summarizeThreadReason,
  };
}

module.exports = { createDashboardSummaryUtils };
