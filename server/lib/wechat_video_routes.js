"use strict";

function createWechatVideoRoutes({
  HOST,
  PORT,
  WECHAT_COLLECTOR_INSTALL_BASE_URL,
  WECHAT_COLLECTOR_LOCAL_DIRECT_BASE_URL,
  WECHAT_COLLECTOR_PUBLIC_BASE_URL,
  clearWechatCaptures,
  collectorJson,
  completeWechatCollectorCommand,
  createWechatCollectorToken,
  downloadWechatCapture,
  getWechatCollectorStatus,
  openWechatCollectorBrowser,
  revealWechatCapture,
  sendJson,
  sendWechatCollectorCommand,
  startWechatCollector,
  startWechatCollectorPackage,
  stopWechatCollector,
  stopWechatCollectorPackage,
  streamWechatCapturePreview,
  trustWechatCollectorCert,
  updateWechatCollectorClient,
  wechatCollectorStatusForToken,
  wechatTokenFromRequest,
}) {
  function handleWechatVideoRoute(req, res, url, method, readPayload) {
    if (method === "POST" && url.pathname === "/api/wechat-video/agent/status") {
      readPayload()
        .then((payload) => {
          const token = wechatTokenFromRequest(req, payload, url);
          if (!token) throw new Error("missing wechat collector token");
          const clientId = String(
            req.headers["x-yuebai-collector-client"] || payload.clientId || ""
          ).trim();
          const client = updateWechatCollectorClient(token, clientId, payload.status || payload);
          sendJson(res, { ok: true, clientId: client?.clientId || clientId });
        })
        .catch((error) => sendJson(res, { ok: false, error: error.message }, 400));
      return true;
    }
    if (method === "GET" && url.pathname === "/api/wechat-video/agent/command") {
      try {
        const token = wechatTokenFromRequest(req, {}, url);
        if (!token) throw new Error("missing wechat collector token");
        const clientId = String(
          req.headers["x-yuebai-collector-client"] || url.searchParams.get("clientId") || ""
        ).trim();
        const client = updateWechatCollectorClient(token, clientId);
        const command = client?.queue.shift() || null;
        sendJson(res, {
          ok: true,
          command: command || { id: "", path: "", options: {}, noop: true },
        });
      } catch (error) {
        sendJson(res, { ok: false, error: error.message }, 401);
      }
      return true;
    }
    if (method === "POST" && url.pathname === "/api/wechat-video/agent/command-result") {
      readPayload()
        .then((payload) => {
          const token = wechatTokenFromRequest(req, payload, url);
          if (!token) throw new Error("missing wechat collector token");
          completeWechatCollectorCommand(token, payload.commandId || "", payload.payload || payload.status || {});
          sendJson(res, { ok: true });
        })
        .catch((error) => sendJson(res, { ok: false, error: error.message }, 400));
      return true;
    }
    if (url.pathname === "/api/wechat-video/status") {
      const token = url.searchParams.get("token") || "";
      if (token) {
        sendJson(res, wechatCollectorStatusForToken(token));
        return true;
      }
      getWechatCollectorStatus()
        .then((data) => sendJson(res, data))
        .catch((error) => sendJson(res, { ok: false, error: error.message }, 500));
      return true;
    }
    if (method === "POST" && url.pathname === "/api/wechat-video/client-token") {
      const token = createWechatCollectorToken();
      sendJson(res, {
        ok: true,
        token,
        status: wechatCollectorStatusForToken(token),
      });
      return true;
    }
    if (method === "GET" && url.pathname === "/api/wechat-video/client-status") {
      sendJson(res, wechatCollectorStatusForToken(url.searchParams.get("token") || ""));
      return true;
    }
    if (method === "POST" && url.pathname === "/api/wechat-video/client-command") {
      readPayload()
        .then((payload) => {
          const token = String(payload.token || "").trim();
          const commandPath = String(payload.path || "").trim();
          if (!token) throw new Error("missing token");
          if (!commandPath.startsWith("/api/")) throw new Error("invalid command path");
          return sendWechatCollectorCommand(token, commandPath, payload.options || {});
        })
        .then((data) => sendJson(res, data))
        .catch((error) => sendJson(res, { ok: false, error: error.message }, 400));
      return true;
    }
    if (url.pathname === "/api/wechat-video/config") {
      const requestOrigin = `http://${req.headers.host || `${HOST}:${PORT}`}`;
      sendJson(res, {
        ok: true,
        collectorBaseUrl: WECHAT_COLLECTOR_PUBLIC_BASE_URL,
        installBaseUrl: WECHAT_COLLECTOR_INSTALL_BASE_URL || requestOrigin,
        localDirectBaseUrl: WECHAT_COLLECTOR_LOCAL_DIRECT_BASE_URL,
        remoteMode: true,
        packageControlEnabled:
          /^127\.0\.0\.1$|^localhost$|^\[::1\]$/.test(HOST),
      });
      return true;
    }
    if (url.pathname === "/api/wechat-video/captures") {
      collectorJson("/api/captures")
        .then((data) => sendJson(res, data))
        .catch((error) => sendJson(res, { ok: false, error: error.message }, 500));
      return true;
    }
    if (method === "POST" && url.pathname === "/api/wechat-video/start") {
      readPayload()
        .then((payload) => startWechatCollector(payload))
        .then((data) => sendJson(res, data))
        .catch((error) => sendJson(res, { ok: false, error: error.message }, 500));
      return true;
    }
    if (method === "POST" && url.pathname === "/api/wechat-video/set-type") {
      readPayload()
        .then((payload) =>
          collectorJson("/api/set-type", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: payload.type || "all" }),
          })
        )
        .then((data) => sendJson(res, data))
        .catch((error) => sendJson(res, { ok: false, error: error.message }, 500));
      return true;
    }
    if (method === "POST" && url.pathname === "/api/wechat-video/trust-cert") {
      trustWechatCollectorCert()
        .then((data) => sendJson(res, data))
        .catch((error) => sendJson(res, { ok: false, error: error.message }, 500));
      return true;
    }
    if (method === "POST" && url.pathname === "/api/wechat-video/stop") {
      stopWechatCollector()
        .then((data) => sendJson(res, data))
        .catch((error) => sendJson(res, { ok: false, error: error.message }, 500));
      return true;
    }
    if (method === "POST" && url.pathname === "/api/wechat-video/package-start") {
      startWechatCollectorPackage()
        .then((data) => sendJson(res, data, data.ok ? 200 : 400))
        .catch((error) => sendJson(res, { ok: false, error: error.message }, 500));
      return true;
    }
    if (method === "POST" && url.pathname === "/api/wechat-video/package-stop") {
      stopWechatCollectorPackage()
        .then((data) => sendJson(res, data))
        .catch((error) => sendJson(res, { ok: false, error: error.message }, 500));
      return true;
    }
    if (method === "POST" && url.pathname === "/api/wechat-video/download") {
      readPayload()
        .then((payload) => downloadWechatCapture(payload))
        .then((data) => sendJson(res, data))
        .catch((error) => sendJson(res, { ok: false, error: error.message }, 500));
      return true;
    }
    if (method === "GET" && url.pathname === "/api/wechat-video/preview") {
      const id = url.searchParams.get("id") || "";
      const token = url.searchParams.get("token") || "";
      streamWechatCapturePreview(req, res, id, token)
        .catch((error) => sendJson(res, { ok: false, error: error.message }, 500));
      return true;
    }
    if (method === "POST" && url.pathname === "/api/wechat-video/clear") {
      clearWechatCaptures()
        .then((data) => sendJson(res, data))
        .catch((error) => sendJson(res, { ok: false, error: error.message }, 500));
      return true;
    }
    if (method === "POST" && url.pathname === "/api/wechat-video/reveal") {
      readPayload()
        .then((payload) => revealWechatCapture(payload))
        .then((data) => sendJson(res, data))
        .catch((error) => sendJson(res, { ok: false, error: error.message }, 500));
      return true;
    }
    if (method === "POST" && url.pathname === "/api/wechat-video/open-browser") {
      openWechatCollectorBrowser()
        .then((data) => sendJson(res, data, data.ok ? 200 : 400))
        .catch((error) => sendJson(res, { ok: false, error: error.message }, 500));
      return true;
    }
    return false;
  }

  return { handleWechatVideoRoute };
}

module.exports = { createWechatVideoRoutes };
