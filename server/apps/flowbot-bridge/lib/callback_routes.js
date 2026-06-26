function createCallbackRoutes({
  ACCEPT_NOTIFY_TYPES,
  FEISHU_VERIFICATION_TOKEN,
  SUPPORTED_MSG_TYPES,
  appendEvent,
  appendFilterDecision,
  appendNormalizedEvent,
  appendRoutingDecision,
  buildFeishuTraceId,
  buildTraceId,
  collectBody,
  enrichMediaForMessage,
  evaluateFeishuPayload,
  isRoomIdAllowed,
  normalizeFeishuPayload,
  normalizePayload,
  pickFeishuSenderId,
  routeNormalizedMessage,
  safeParseJson,
  sendJson,
  upsertAgentTask,
  upsertMessagePoolEntry,
}) {
  function pickRejectedMessageData(data) {
    if (!data || typeof data !== "object") {
      return {};
    }
    return {
      content: data.content || "",
      quoteContent: data.quote_content || "",
      atList: Array.isArray(data.at_list) ? data.at_list : [],
      extraContent: data.extra_content || "",
      contentType: data.content_type ?? null,
      sender: data.sender || "",
      senderName: data.sender_name || "",
      receiver: data.receiver || "",
      roomId: data.roomid || "",
      roomName: data.room_name || data.chat_name || "",
      sendTime: data.sendtime ?? null,
      sendFlag: data.send_flag ?? null,
      flag: data.flag ?? null,
      referId: data.referid || "",
      appInfo: data.appinfo || "",
      title: data.title || "",
      desc: data.desc || "",
      url: data.url || "",
      fileName: data.file_name || "",
      rawKeys: Object.keys(data).sort(),
    };
  }

  function evaluatePayload(payload) {
    const notifyType = Number(payload?.notify_type || 0);
    const data = payload?.data || {};
    const roomId = String(data.roomid || "");
    const msgType = Number(data.msg_type || 0);
    const sendFlag = Number(data.send_flag || 0);

    if (!ACCEPT_NOTIFY_TYPES.has(notifyType)) {
      return { accepted: false, reason: `notify_type_not_supported:${notifyType}` };
    }

    if (sendFlag === 1) {
      return { accepted: false, reason: "self_sent_message" };
    }

    if (!roomId) {
      return { accepted: false, reason: "roomid_missing" };
    }

    if (!isRoomIdAllowed(roomId)) {
      return { accepted: false, reason: `roomid_filtered:${roomId}` };
    }

    if (!SUPPORTED_MSG_TYPES.has(msgType)) {
      return { accepted: false, reason: `msg_type_filtered:${msgType}` };
    }

    return { accepted: true, reason: "accepted" };
  }

  async function handleCallbackRoute(req, res, url) {
    if (req.method === "POST" && url.pathname === "/flowbot/callback") {
      const rawBody = await collectBody(req);
      const parsedBody = safeParseJson(rawBody);
      const event = {
        receivedAt: new Date().toISOString(),
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        headers: req.headers,
        rawBody,
        jsonBody: parsedBody,
      };

      const payload = parsedBody || {};
      const decision = evaluatePayload(payload);
      const traceId = buildTraceId(payload);
      appendFilterDecision({
        receivedAt: event.receivedAt,
        traceId,
        accepted: decision.accepted,
        reason: decision.reason,
        notifyType: payload?.notify_type ?? null,
        roomId: payload?.data?.roomid ?? "",
        msgType: payload?.data?.msg_type ?? null,
        seq: payload?.data?.seq ?? "",
        id: payload?.data?.id ?? "",
        senderName: payload?.data?.sender_name ?? "",
        rejectedMessageData: decision.accepted ? null : pickRejectedMessageData(payload?.data),
        rejectedRawPayload: decision.accepted ? null : payload,
      });

      let routeResult = null;
      if (decision.accepted) {
        appendEvent(event);
        const normalized = await enrichMediaForMessage(normalizePayload(payload, event));
        appendNormalizedEvent(normalized);
        routeResult = await routeNormalizedMessage(normalized);
        appendRoutingDecision({
          receivedAt: event.receivedAt,
          traceId: normalized.traceId,
          roomId: normalized.roomId,
          roomName: normalized.roomName || normalized.roomId || "",
          senderName: normalized.senderName || normalized.senderId || "",
          senderId: normalized.senderId || "",
          msgType: normalized.msgType,
          msgTypeName: normalized.msgTypeName,
          routeMode: routeResult.routeMode,
          routeReason: routeResult.routeReason,
          archiveTriggered: Boolean(routeResult.archiveTriggered),
          agentTriggered: Boolean(routeResult.agentTriggered),
          matchedAgentNames: routeResult.matchedAgentNames,
        });
        if (routeResult.archiveTriggered) {
          upsertMessagePoolEntry(normalized, {
            status: "pending",
            lastError: "",
            lastErrorDetail: "",
          });
        }
        if (routeResult.agentTriggered) {
          upsertAgentTask(normalized, routeResult, {
            status: "pending",
          });
        }
        console.log(`[flowbot-bridge] accepted callback ${traceId}`);
      } else {
        console.log(`[flowbot-bridge] ignored callback ${traceId} reason=${decision.reason}`);
      }

      sendJson(res, 200, {
        code: 200,
        message: decision.accepted ? "callback accepted" : "callback ignored",
        accepted: decision.accepted,
        reason: decision.reason,
        traceId,
        receivedAt: event.receivedAt,
        route: routeResult,
      });
      return true;
    }

    if (
      req.method === "POST"
      && (url.pathname === "/feishu/callback" || url.pathname === "/flowbot/feishu/callback")
    ) {
      const rawBody = await collectBody(req);
      const parsedBody = safeParseJson(rawBody) || {};
      const receivedAt = new Date().toISOString();

      if (parsedBody.type === "url_verification" && parsedBody.challenge) {
        const token = String(parsedBody.token || "").trim();
        if (FEISHU_VERIFICATION_TOKEN && token !== FEISHU_VERIFICATION_TOKEN) {
          sendJson(res, 403, { ok: false, error: "feishu_token_mismatch" });
          return true;
        }
        sendJson(res, 200, { challenge: parsedBody.challenge });
        return true;
      }

      const event = {
        receivedAt,
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        headers: req.headers,
        rawBody,
        jsonBody: parsedBody,
        source: "feishu",
      };
      const decision = evaluateFeishuPayload(parsedBody);
      const traceId = buildFeishuTraceId(parsedBody);
      appendFilterDecision({
        receivedAt,
        traceId,
        accepted: decision.accepted,
        reason: decision.reason,
        source: "feishu",
        eventType: parsedBody?.header?.event_type || "",
        roomId: parsedBody?.event?.message?.chat_id || "",
        msgType: parsedBody?.event?.message?.message_type || "",
        id: parsedBody?.event?.message?.message_id || "",
        senderName: pickFeishuSenderId(parsedBody?.event?.sender || {}),
      });

      let routeResult = null;
      if (decision.accepted) {
        appendEvent(event);
        const normalized = await enrichMediaForMessage(normalizeFeishuPayload(parsedBody, event));
        appendNormalizedEvent(normalized);
        routeResult = await routeNormalizedMessage(normalized);
        appendRoutingDecision({
          receivedAt,
          traceId: normalized.traceId,
          roomId: normalized.roomId,
          roomName: normalized.roomName || normalized.roomId || "",
          senderName: normalized.senderName || normalized.senderId || "",
          senderId: normalized.senderId || "",
          msgType: normalized.msgType,
          msgTypeName: normalized.msgTypeName,
          routeMode: routeResult.routeMode,
          routeReason: routeResult.routeReason,
          archiveTriggered: Boolean(routeResult.archiveTriggered),
          agentTriggered: Boolean(routeResult.agentTriggered),
          matchedAgentNames: routeResult.matchedAgentNames,
          source: "feishu",
        });
        if (routeResult.archiveTriggered) {
          upsertMessagePoolEntry(normalized, {
            status: "pending",
            lastError: "",
            lastErrorDetail: "",
          });
        }
        if (routeResult.agentTriggered) {
          upsertAgentTask(normalized, routeResult, {
            status: "pending",
          });
        }
        console.log(`[flowbot-bridge] accepted feishu callback ${traceId}`);
      } else {
        console.log(`[flowbot-bridge] ignored feishu callback ${traceId} reason=${decision.reason}`);
      }

      sendJson(res, 200, {
        code: 200,
        message: decision.accepted ? "feishu callback accepted" : "feishu callback ignored",
        accepted: decision.accepted,
        reason: decision.reason,
        traceId,
        receivedAt,
        route: routeResult,
      });
      return true;
    }

    return false;
  }

  return {
    evaluatePayload,
    handleCallbackRoute,
  };
}

module.exports = {
  createCallbackRoutes,
};
