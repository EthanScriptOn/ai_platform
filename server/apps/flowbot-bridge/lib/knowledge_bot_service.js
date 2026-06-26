"use strict";

const crypto = require("crypto");

function createKnowledgeBotService({
  RAGFLOW_BASE_URL,
  RAGFLOW_CHAT_ID,
  RAGFLOW_ENABLED,
  RAGFLOW_LOGIN_EMAIL,
  RAGFLOW_LOGIN_PASSWORD,
  RAGFLOW_LOGIN_PUBLIC_KEY,
  RAGFLOW_TIMEOUT_MS,
  fetchImpl = fetch,
  mysqlRuntimeStore,
  requestJsonWithHeaders,
} = {}) {
  const authCache = {
    token: "",
    expiresAt: 0,
  };

  function isRagflowBotReady(chatId = RAGFLOW_CHAT_ID) {
    return Boolean(RAGFLOW_ENABLED && RAGFLOW_BASE_URL && RAGFLOW_LOGIN_EMAIL && RAGFLOW_LOGIN_PASSWORD && RAGFLOW_LOGIN_PUBLIC_KEY && String(chatId || "").trim());
  }

  function encryptPassword() {
    const encodedPassword = Buffer.from(RAGFLOW_LOGIN_PASSWORD, "utf8").toString("base64");
    const publicKey = crypto.createPublicKey(RAGFLOW_LOGIN_PUBLIC_KEY);
    return crypto.publicEncrypt(
      {
        key: publicKey,
        padding: crypto.constants.RSA_PKCS1_PADDING,
      },
      Buffer.from(encodedPassword, "utf8"),
    ).toString("base64");
  }

  async function getRagflowAuthorization(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && authCache.token && authCache.expiresAt > now) {
      return authCache.token;
    }
    const response = await fetchImpl(`${RAGFLOW_BASE_URL}/api/v1/auth/login`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: RAGFLOW_LOGIN_EMAIL,
        password: encryptPassword(),
      }),
      signal: AbortSignal.timeout(RAGFLOW_TIMEOUT_MS),
    });
    const rawText = await response.text();
    const payload = rawText ? JSON.parse(rawText) : {};
    if (!response.ok || Number(payload?.code || 0) !== 0) {
      throw new Error(`ragflow_login_failed:${rawText.slice(0, 500)}`);
    }
    const token = String(
      response.headers.get("authorization")
        || response.headers.get("Authorization")
        || payload?.data?.access_token
        || payload?.data?.token
        || payload?.access_token
        || payload?.authorization
        || "",
    ).trim();
    if (!token) {
      throw new Error(`ragflow_login_token_missing:${JSON.stringify(payload).slice(0, 500)}`);
    }
    authCache.token = token;
    authCache.expiresAt = now + 60 * 1000;
    return token;
  }

  async function ragflowJson(method, pathname, payload = null, { forceRefreshAuth = false } = {}) {
    if (!RAGFLOW_ENABLED) {
      throw new Error("ragflow_not_configured");
    }
    const target = `${RAGFLOW_BASE_URL}${pathname}`;
    const attempt = async (forceRefresh) => requestJsonWithHeaders(
      method,
      target,
      payload,
      { Authorization: `Bearer ${await getRagflowAuthorization(forceRefresh || forceRefreshAuth)}` },
      RAGFLOW_TIMEOUT_MS,
    );
    try {
      return await attempt(false);
    } catch (error) {
      if (!/http_401|http_403/i.test(String(error?.message || ""))) {
        throw error;
      }
      return attempt(true);
    }
  }

  async function listKnowledgeBots() {
    if (!RAGFLOW_ENABLED) {
      return {
        ok: true,
        provider: "ragflow",
        enabled: false,
        bots: [],
      };
    }
    const response = await ragflowJson("GET", "/api/v1/chats");
    const chats = Array.isArray(response?.data?.chats) ? response.data.chats : [];
    return {
      ok: true,
      provider: "ragflow",
      enabled: true,
      selectedBotId: String(RAGFLOW_CHAT_ID || "").trim(),
      bots: chats.map((item) => ({
        id: String(item?.id || "").trim(),
        name: String(item?.name || "未命名机器人").trim(),
        description: String(item?.description || "").trim(),
        kbNames: Array.isArray(item?.kb_names) ? item.kb_names.filter(Boolean) : [],
      })).filter((item) => item.id),
    };
  }

  async function createRagflowSession(chatId, name) {
    const uniqueName = `${String(name || "企业微信群问答").trim() || "企业微信群问答"} ${new Date().toISOString()} ${Math.random().toString(16).slice(2, 8)}`;
    const response = await ragflowJson(
      "POST",
      `/api/v1/chats/${encodeURIComponent(chatId)}/sessions`,
      { name: uniqueName },
    );
    const session = response?.data || {};
    const sessionId = String(session?.id || "").trim();
    if (!sessionId) {
      throw new Error(`ragflow_session_missing:${JSON.stringify(response).slice(0, 500)}`);
    }
    return sessionId;
  }

  function buildSessionStateKey(chatId, roomId) {
    const safeChatId = String(chatId || "default").trim() || "default";
    const safeRoomId = String(roomId || "global").trim() || "global";
    return `ragflow_sessions/${safeChatId}/${crypto.createHash("sha1").update(safeRoomId).digest("hex")}.json`;
  }

  function readStoredSession(chatId, roomId) {
    if (!mysqlRuntimeStore?.isEnabled?.()) return "";
    const state = mysqlRuntimeStore.readJsonKey(buildSessionStateKey(chatId, roomId), null);
    return String(state?.sessionId || "").trim();
  }

  function writeStoredSession(chatId, roomId, sessionId) {
    if (!mysqlRuntimeStore?.isEnabled?.() || !sessionId) return;
    mysqlRuntimeStore.writeJsonKey(buildSessionStateKey(chatId, roomId), {
      provider: "ragflow",
      chatId,
      roomId: roomId || "global",
      sessionId,
      updatedAt: new Date().toISOString(),
    });
  }

  function deleteStoredSession(chatId, roomId) {
    if (!mysqlRuntimeStore?.isEnabled?.()) return;
    mysqlRuntimeStore.deleteJsonKey(buildSessionStateKey(chatId, roomId));
  }

  async function getOrCreateRagflowSession(chatId, roomId, traceId) {
    const stored = readStoredSession(chatId, roomId);
    if (stored) return { sessionId: stored, reused: true };
    const label = [roomId, traceId].filter(Boolean).join(" / ") || "企业微信群问答";
    const sessionId = await createRagflowSession(chatId, label);
    writeStoredSession(chatId, roomId, sessionId);
    return { sessionId, reused: false };
  }

  async function collectRagflowCompletion(payload) {
    const response = await fetchImpl(`${RAGFLOW_BASE_URL}/api/v1/chat/completions`, {
      method: "POST",
      headers: {
        Accept: "text/event-stream, application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${await getRagflowAuthorization(false)}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(RAGFLOW_TIMEOUT_MS),
    });
    let raw = "";
    if (response.body) {
      const chunks = [];
      for await (const chunk of response.body) {
        chunks.push(Buffer.from(chunk));
      }
      raw = Buffer.concat(chunks).toString("utf8");
    } else {
      raw = await response.text();
    }
    if (!response.ok) {
      throw new Error(`ragflow_completion_http_${response.status}:${raw.slice(0, 500)}`);
    }
    let answer = "";
    let lastPayload = null;
    for (const block of raw.split(/\n\n+/g)) {
      const dataLine = block.split("\n").find((line) => line.startsWith("data:"));
      const text = dataLine ? dataLine.slice(5).trim() : block.trim();
      if (!text || text === "[DONE]") continue;
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        continue;
      }
      lastPayload = parsed;
      if (Number(parsed?.code || 0) !== 0) {
        throw new Error(parsed?.message || `ragflow_completion_failed:${text.slice(0, 300)}`);
      }
      const nextAnswer = String(parsed?.data?.answer || parsed?.answer || "").trim();
      if (nextAnswer) answer = nextAnswer;
    }
    if (!answer) {
      try {
        const parsed = JSON.parse(raw);
        lastPayload = parsed;
        answer = String(parsed?.data?.answer || parsed?.answer || "").trim();
      } catch {
        // SSE has already been parsed above.
      }
    }
    return { answer, raw: lastPayload || raw.slice(0, 1000) };
  }

  async function askKnowledgeBot({ query, chatId = RAGFLOW_CHAT_ID, roomId = "", traceId = "" } = {}) {
    const normalizedQuery = String(query || "").trim();
    const normalizedChatId = String(chatId || RAGFLOW_CHAT_ID || "").trim();
    if (!normalizedQuery) {
      throw new Error("query_required");
    }
    if (!isRagflowBotReady(normalizedChatId)) {
      throw new Error("knowledge_bot_not_configured");
    }
    const normalizedRoomId = String(roomId || "global").trim() || "global";
    let session = await getOrCreateRagflowSession(normalizedChatId, normalizedRoomId, traceId);
    let completion;
    try {
      completion = await collectRagflowCompletion({
        chat_id: normalizedChatId,
        session_id: session.sessionId,
        question: normalizedQuery,
        quote: true,
      });
    } catch (error) {
      const message = String(error?.message || error);
      if (!/session|conversation|not found|none|attributeerror|does not exist/i.test(message)) {
        throw error;
      }
      deleteStoredSession(normalizedChatId, normalizedRoomId);
      session = await getOrCreateRagflowSession(normalizedChatId, normalizedRoomId, traceId);
      completion = await collectRagflowCompletion({
        chat_id: normalizedChatId,
        session_id: session.sessionId,
        question: normalizedQuery,
        quote: true,
      });
    }
    if (!completion.answer) {
      throw new Error("knowledge_bot_empty_answer");
    }
    return {
      ok: true,
      provider: "ragflow",
      botId: normalizedChatId,
      roomId: normalizedRoomId,
      sessionId: session.sessionId,
      sessionReused: session.reused,
      answer: completion.answer,
      raw: completion.raw,
    };
  }

  return {
    askKnowledgeBot,
    isRagflowBotReady,
    listKnowledgeBots,
  };
}

module.exports = { createKnowledgeBotService };
