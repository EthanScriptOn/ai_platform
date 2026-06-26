"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { renderRagflowEntriesMarkdown } = require("./knowledge_ingestion_format");

function createRagflowService({
  RAGFLOW_AGENT_ID,
  RAGFLOW_BASE_URL,
  RAGFLOW_DATASET_ID,
  RAGFLOW_LOGIN_EMAIL,
  RAGFLOW_LOGIN_PASSWORD,
  RAGFLOW_LOGIN_PUBLIC_KEY,
  RAGFLOW_SHARE_AUTH,
  REVIEW_RUN_DIR,
  fetchImpl = fetch,
  loadRagflowToken,
  loadDecisions,
  loadGovernedItems,
  renderApprovedMarkdown,
  saveRagflowToken,
}) {
  function getRagflowToken() {
    return String(loadRagflowToken?.() || "").trim();
  }

  function getRagflowDatasetId() {
    return String(RAGFLOW_DATASET_ID || "").trim();
  }

  function encryptRagflowPassword(password) {
    const encoded = Buffer.from(String(password || ""), "utf-8").toString("base64");
    const key = crypto.createPublicKey(RAGFLOW_LOGIN_PUBLIC_KEY);
    return crypto
      .publicEncrypt(
        {
          key,
          padding: crypto.constants.RSA_PKCS1_PADDING,
        },
        Buffer.from(encoded, "utf-8")
      )
      .toString("base64");
  }

  async function loginRagflow() {
    if (!RAGFLOW_LOGIN_EMAIL || !RAGFLOW_LOGIN_PASSWORD) {
      throw new Error("RAGFlow API token 已失效，且缺少登录账号或密码，无法自动刷新。");
    }
    let response;
    try {
      response = await fetchImpl(`${RAGFLOW_BASE_URL}/api/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: RAGFLOW_LOGIN_EMAIL,
          password: encryptRagflowPassword(RAGFLOW_LOGIN_PASSWORD),
        }),
      });
    } catch (error) {
      const message = String(error?.message || error);
      if (/fetch failed|ECONNREFUSED|Failed to fetch|connect/i.test(message)) {
        throw new Error(`本地未部署 RAGFlow，当前无法打开问答页面。请先启动 ${RAGFLOW_BASE_URL} 对应服务。`);
      }
      throw error;
    }
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok || data.code !== 0) {
      throw new Error(data.message || text || `RAGFlow login HTTP ${response.status}`);
    }
    const authorization =
      response.headers.get("authorization") || response.headers.get("Authorization") || "";
    const setCookie =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [response.headers.get("set-cookie")].filter(Boolean);
    if (!authorization) {
      throw new Error("RAGFlow 登录成功，但未返回 authorization。");
    }
    return { authorization, setCookie, user: data.data || null };
  }

  async function refreshRagflowToken() {
    const session = await loginRagflow();
    if (!saveRagflowToken?.(session.authorization)) {
      throw new Error("RAGFlow 登录成功，但 API Token 写入 MySQL 失败。");
    }
    return session.authorization;
  }

  async function ragflowRequest(method, apiPath, options = {}) {
    let token = getRagflowToken();
    if (!token) throw new Error("缺少 RAGFlow API token。");
    const headers = {
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    };
    let response = await fetchImpl(`${RAGFLOW_BASE_URL}${apiPath}`, {
      method,
      headers,
      body: options.body,
    });
    if (response.status === 401 || response.status === 403) {
      token = await refreshRagflowToken();
      response = await fetchImpl(`${RAGFLOW_BASE_URL}${apiPath}`, {
        method,
        headers: {
          ...headers,
          Authorization: `Bearer ${token}`,
        },
        body: options.body,
      });
    }
    return response;
  }

  async function createRagflowNativeSession() {
    const buildNativeChatUrl = (authorization, agentId = "") => {
      const baseTarget = agentId
        ? `${RAGFLOW_BASE_URL}/chat/${agentId}?isNew=`
        : `${RAGFLOW_BASE_URL}/chats`;
      return `${baseTarget}${baseTarget.includes("?") ? "&" : "?"}auth=${encodeURIComponent(authorization)}`;
    };
    if (RAGFLOW_SHARE_AUTH) {
      return {
        ok: true,
        authorization: "",
        user: null,
        mode: "share_auth",
        loginUrl: `${RAGFLOW_BASE_URL}/login`,
        targetUrl: buildNativeChatUrl(RAGFLOW_SHARE_AUTH, RAGFLOW_AGENT_ID),
      };
    }
    const { authorization, setCookie, user } = await loginRagflow();
    let targetAgentId = RAGFLOW_AGENT_ID;
    if (targetAgentId) {
      try {
        const chatListResponse = await fetchImpl(`${RAGFLOW_BASE_URL}/api/v1/chats`, {
          headers: {
            Authorization: `Bearer ${authorization}`,
          },
        });
        const raw = await chatListResponse.text();
        const payload = raw ? JSON.parse(raw) : {};
        const chats = Array.isArray(payload?.data?.chats) ? payload.data.chats : [];
        if (!chats.some((item) => item?.id === targetAgentId)) {
          targetAgentId = "";
        }
      } catch {
        targetAgentId = "";
      }
    }
    return {
      ok: true,
      authorization,
      setCookie,
      user,
      loginUrl: `${RAGFLOW_BASE_URL}/login?auth=${encodeURIComponent(authorization)}`,
      targetUrl: buildNativeChatUrl(authorization, targetAgentId),
    };
  }

  async function ragflowJson(method, apiPath, data) {
    const response = await ragflowRequest(method, apiPath, {
      headers: data ? { "Content-Type": "application/json" } : undefined,
      body: data ? JSON.stringify(data) : undefined,
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : {};
    if (!response.ok || ![undefined, 0].includes(parsed.code)) {
      throw new Error(parsed.message || text || `RAGFlow HTTP ${response.status}`);
    }
    return parsed;
  }

  async function uploadRagflowFile(datasetId, filePath) {
    const form = new FormData();
    const content = fs.readFileSync(filePath);
    form.append("file", new Blob([content], { type: "text/markdown" }), path.basename(filePath));
    const response = await ragflowRequest("POST", `/api/v1/datasets/${datasetId}/documents`, {
      body: form,
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : {};
    if (!response.ok || parsed.code !== 0) {
      throw new Error(parsed.message || text || `RAGFlow upload HTTP ${response.status}`);
    }
    return parsed;
  }

  async function importApprovedToRagflow() {
    const items = loadGovernedItems();
    const decisions = loadDecisions();
    const { markdown, count } = renderApprovedMarkdown(items, decisions);
    if (!count) return { ok: false, error: "还没有已通过的知识，请先审核并通过至少一条。" };

    const exportDir = path.join(REVIEW_RUN_DIR, "approved_ragflow_markdown");
    fs.mkdirSync(exportDir, { recursive: true });
    const outPath = path.join(exportDir, "approved_knowledge.md");
    fs.writeFileSync(outPath, markdown, "utf-8");

    const datasetId = getRagflowDatasetId();
    if (!datasetId) return { ok: false, error: "缺少 RAGFlow dataset_id。" };

    const encodedName = encodeURIComponent(path.basename(outPath));
    const docs = await ragflowJson(
      "GET",
      `/api/v1/datasets/${datasetId}/documents?keywords=${encodedName}&page=1&page_size=100`
    );
    const existing = (docs.data?.docs || [])
      .filter((doc) => doc.name === path.basename(outPath) || doc.location === path.basename(outPath))
      .map((doc) => doc.id);
    if (existing.length) {
      await ragflowJson("DELETE", `/api/v1/datasets/${datasetId}/documents`, { ids: existing });
    }

    const uploaded = await uploadRagflowFile(datasetId, outPath);
    const documentIds = (uploaded.data || []).map((doc) => doc.id).filter(Boolean);
    if (!documentIds.length) throw new Error("RAGFlow 上传成功但没有返回 document id。");
    await ragflowJson("POST", `/api/v1/datasets/${datasetId}/chunks`, { document_ids: documentIds });

    fs.writeFileSync(
      path.join(REVIEW_RUN_DIR, "ragflow_import_state.json"),
      JSON.stringify(
        {
          imported_at: new Date().toISOString(),
          base_url: RAGFLOW_BASE_URL,
          dataset_id: datasetId,
          document_name: path.basename(outPath),
          document_ids: documentIds,
          approved_count: count,
          path: outPath,
          replaced_document_ids: existing,
        },
        null,
        2
      ),
      "utf-8"
    );
    return {
      ok: true,
      count,
      path: outPath,
      document_name: path.basename(outPath),
      document_ids: documentIds,
      replaced_document_ids: existing,
    };
  }

  async function importMarkdownToRagflow({ markdown, fileName = "approved_knowledge.md" } = {}) {
    if (!String(markdown || "").trim()) {
      return { ok: false, error: "没有可导入的知识内容。" };
    }
    const exportDir = path.join(REVIEW_RUN_DIR, "approved_ragflow_markdown");
    fs.mkdirSync(exportDir, { recursive: true });
    const safeName = String(fileName || "approved_knowledge.md").replace(/[\\/:*?"<>|]+/g, "-");
    const outPath = path.join(exportDir, safeName.endsWith(".md") ? safeName : `${safeName}.md`);
    fs.writeFileSync(outPath, markdown, "utf-8");

    const datasetId = getRagflowDatasetId();
    if (!datasetId) return { ok: false, error: "缺少 RAGFlow dataset_id。" };

    const encodedName = encodeURIComponent(path.basename(outPath));
    const docs = await ragflowJson(
      "GET",
      `/api/v1/datasets/${datasetId}/documents?keywords=${encodedName}&page=1&page_size=100`
    );
    const existing = (docs.data?.docs || [])
      .filter((doc) => doc.name === path.basename(outPath) || doc.location === path.basename(outPath))
      .map((doc) => doc.id);
    if (existing.length) {
      await ragflowJson("DELETE", `/api/v1/datasets/${datasetId}/documents`, { ids: existing });
    }

    const uploaded = await uploadRagflowFile(datasetId, outPath);
    const documentIds = (uploaded.data || []).map((doc) => doc.id).filter(Boolean);
    if (!documentIds.length) throw new Error("RAGFlow 上传成功但没有返回 document id。");
    await ragflowJson("POST", `/api/v1/datasets/${datasetId}/chunks`, { document_ids: documentIds });
    return {
      ok: true,
      count: 1,
      path: outPath,
      document_name: path.basename(outPath),
      document_ids: documentIds,
      replaced_document_ids: existing,
      dataset_id: datasetId,
    };
  }

  async function importRagflowEntries(entries = [], { fileName = "approved_knowledge.md", title = "悦拜知识库" } = {}) {
    const list = Array.isArray(entries) ? entries.filter((entry) => String(entry?.final_content || "").trim()) : [];
    if (!list.length) return { ok: false, error: "没有可导入的知识条目。" };
    const markdown = renderRagflowEntriesMarkdown(list, title);
    const result = await importMarkdownToRagflow({ markdown, fileName });
    return { ...result, count: list.length, entries: list };
  }

  async function getRagflowChatInfo(chatId) {
    const response = await ragflowJson("GET", `/api/v1/chats`);
    const chats = response.data?.chats || [];
    const chat = chats.find((item) => item.id === chatId);
    if (!chat) {
      throw new Error(`未找到 RAGFlow Chat: ${chatId}`);
    }
    return chat;
  }

  async function createRagflowChatSession(chatId, name = "悦拜 AI 工具平台会话") {
    const response = await ragflowJson("POST", `/api/v1/chats/${chatId}/sessions`, { name });
    return response.data;
  }

  async function proxyRagflowChatCompletion(res, payload) {
    const response = await ragflowRequest("POST", "/api/v1/chat/completions", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const contentType = response.headers.get("content-type") || "text/event-stream; charset=utf-8";
    res.writeHead(response.status, {
      "Content-Type": contentType,
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Pragma: "no-cache",
      Expires: "0",
      Connection: "keep-alive",
    });
    if (!response.body) {
      res.end();
      return;
    }
    for await (const chunk of response.body) {
      res.write(Buffer.from(chunk));
    }
    res.end();
  }

  return {
    createRagflowChatSession,
    createRagflowNativeSession,
    getRagflowChatInfo,
    getRagflowDatasetId,
    getRagflowToken,
    importApprovedToRagflow,
    importMarkdownToRagflow,
    importRagflowEntries,
    proxyRagflowChatCompletion,
    ragflowJson,
    ragflowRequest,
    uploadRagflowFile,
  };
}

module.exports = {
  createRagflowService,
};
