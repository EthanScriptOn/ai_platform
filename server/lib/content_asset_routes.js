"use strict";

const { paginateItems, paginationMeta, parsePagination } = require("./data_utils");

function createContentAssetRoutes({
  CONTENT_ASSET_BASE_URL,
  CONTENT_ASSET_INSTALL_BASE_URL,
  CONTENT_ASSET_LOCAL_MEDIA_BASE_URL,
  CONTENT_ASSET_PUBLIC_BASE_URL,
  CONTENT_ASSET_REMOTE_TOKEN,
  HOST,
  PORT,
  completeContentAssetCommand,
  createContentAssetJobInMysql,
  createContentAssetToken,
  deleteContentAssetJobInMysql,
  ensureContentAssetMysqlSchema,
  getContentAssetJobFromMysql,
  isAiAdminMysqlEnabled,
  isContentAssetsLegacyApiPath,
  isContentAssetsReferer,
  loadContentAssetJobsFromMysql,
  proxyContentAssetsLegacyApi,
  sendContentAssetCommand,
  sendContentAssetCommandForToken,
  sendJson,
  updateContentAssetClient,
  updateContentAssetJobInMysql,
  updateLegacyContentAssetClient,
  contentAssetRemoteStatus,
}) {
  function assertContentAssetRemoteAuth(req) {
    if (!CONTENT_ASSET_REMOTE_TOKEN) return;
    const auth = String(req.headers.authorization || "");
    const token = auth.replace(/^Bearer\s+/i, "").trim();
    if (token !== CONTENT_ASSET_REMOTE_TOKEN) {
      throw new Error("content_asset_remote_unauthorized");
    }
  }

  function contentAssetTokenFromRequest(req, payload = {}, url = null) {
    const auth = String(req.headers.authorization || "").trim();
    if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
    return String(payload.token || url?.searchParams?.get("token") || "").trim();
  }

  function handleContentAssetRoute(req, res, url, method, readPayload) {
    if (method === "POST" && url.pathname === "/api/content-assets/agent/status") {
      readPayload()
        .then((payload) => {
          const token = contentAssetTokenFromRequest(req, payload, url);
          if (!token && CONTENT_ASSET_REMOTE_TOKEN) assertContentAssetRemoteAuth(req);
          const clientId = String(
            req.headers["x-yuebai-collector-client"] || payload.clientId || ""
          ).trim();
          const client = token
            ? updateContentAssetClient(token, clientId, payload.status || payload)
            : updateLegacyContentAssetClient(clientId, payload.status || payload);
          sendJson(res, { ok: true, clientId: client?.clientId || clientId });
        })
        .catch((error) => sendJson(res, { ok: false, error: error.message }, 400));
      return true;
    }
    if (method === "GET" && url.pathname === "/api/content-assets/agent/command") {
      try {
        const token = contentAssetTokenFromRequest(req, {}, url);
        if (!token && CONTENT_ASSET_REMOTE_TOKEN) assertContentAssetRemoteAuth(req);
        const clientId = String(
          req.headers["x-yuebai-collector-client"] || url.searchParams.get("clientId") || ""
        ).trim();
        const client = token ? updateContentAssetClient(token, clientId) : updateLegacyContentAssetClient(clientId);
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
    if (method === "POST" && url.pathname === "/api/content-assets/agent/command-result") {
      readPayload()
        .then((payload) => {
          const token = contentAssetTokenFromRequest(req, payload, url);
          if (!token && CONTENT_ASSET_REMOTE_TOKEN) assertContentAssetRemoteAuth(req);
          const clientId = String(req.headers["x-yuebai-collector-client"] || payload.clientId || "").trim();
          const commandToken = token || clientId;
          completeContentAssetCommand(commandToken, payload.commandId || "", payload.payload || payload.status || {});
          sendJson(res, { ok: true });
        })
        .catch((error) => sendJson(res, { ok: false, error: error.message }, 400));
      return true;
    }
    if (url.pathname === "/api/content-assets/remote/jobs/health") {
      try {
        assertContentAssetRemoteAuth(req);
        if (!isAiAdminMysqlEnabled()) {
          sendJson(res, { ok: false, error: "平台未启用 MySQL 存储，无法作为抖音采集任务中心。" }, 500);
          return true;
        }
        ensureContentAssetMysqlSchema();
        sendJson(res, { ok: true, storage: "server_mysql" });
      } catch (error) {
        sendJson(res, { ok: false, error: error.message }, 401);
      }
      return true;
    }
    if (method === "GET" && url.pathname === "/api/content-assets/remote/jobs") {
      try {
        assertContentAssetRemoteAuth(req);
        const pageData = paginateItems(
          loadContentAssetJobsFromMysql({ limit: 1000 }),
          parsePagination(url.searchParams, { defaultPageSize: 200, maxPageSize: 500 })
        );
        sendJson(res, {
          ok: true,
          jobs: pageData.items,
          pagination: paginationMeta(pageData),
          storage: "server_mysql",
        });
      } catch (error) {
        sendJson(res, { ok: false, error: error.message }, 500);
      }
      return true;
    }
    if (method === "POST" && url.pathname === "/api/content-assets/remote/jobs") {
      readPayload()
        .then((payload) => {
          assertContentAssetRemoteAuth(req);
          const clientId = String(req.headers["x-yuebai-collector-client"] || payload.clientId || "").trim();
          const job = createContentAssetJobInMysql(payload.job || payload, clientId);
          sendJson(res, { ok: true, job, storage: "server_mysql" });
        })
        .catch((error) => sendJson(res, { ok: false, error: error.message }, 500));
      return true;
    }
    if (method === "GET" && /^\/api\/content-assets\/remote\/jobs\/[^/]+$/.test(url.pathname)) {
      try {
        assertContentAssetRemoteAuth(req);
        const jobId = decodeURIComponent(url.pathname.split("/").pop() || "");
        const job = getContentAssetJobFromMysql(jobId);
        sendJson(res, { ok: true, job, storage: "server_mysql" });
      } catch (error) {
        sendJson(res, { ok: false, error: error.message }, 500);
      }
      return true;
    }
    if (method === "POST" && /^\/api\/content-assets\/remote\/jobs\/[^/]+\/update$/.test(url.pathname)) {
      const jobId = decodeURIComponent(url.pathname.split("/")[5] || "");
      readPayload()
        .then((payload) => {
          assertContentAssetRemoteAuth(req);
          const clientId = String(req.headers["x-yuebai-collector-client"] || payload.clientId || "").trim();
          const job = updateContentAssetJobInMysql(jobId, payload, clientId);
          sendJson(res, { ok: true, job, storage: "server_mysql" });
        })
        .catch((error) => sendJson(res, { ok: false, error: error.message }, 500));
      return true;
    }
    if (method === "POST" && /^\/api\/content-assets\/remote\/jobs\/[^/]+\/delete$/.test(url.pathname)) {
      const jobId = decodeURIComponent(url.pathname.split("/")[5] || "");
      try {
        assertContentAssetRemoteAuth(req);
        const job = deleteContentAssetJobInMysql(jobId);
        sendJson(res, { ok: true, job, storage: "server_mysql" });
      } catch (error) {
        sendJson(res, { ok: false, error: error.message }, 500);
      }
      return true;
    }
    if (isContentAssetsLegacyApiPath(url.pathname) || (url.pathname === "/api/health" && isContentAssetsReferer(req))) {
      proxyContentAssetsLegacyApi(req, res, url);
      return true;
    }
    if (url.pathname === "/api/content-assets/config") {
      const requestOrigin = `http://${req.headers.host || `${HOST}:${PORT}`}`;
      const token = url.searchParams.get("token") || "";
      sendJson(res, {
        ok: true,
        collectorBaseUrl: CONTENT_ASSET_PUBLIC_BASE_URL,
        localMediaBaseUrl: CONTENT_ASSET_LOCAL_MEDIA_BASE_URL,
        installBaseUrl: CONTENT_ASSET_INSTALL_BASE_URL || requestOrigin,
        remoteStatus: contentAssetRemoteStatus(token),
      });
      return true;
    }
    if (method === "POST" && url.pathname === "/api/content-assets/client-token") {
      const token = createContentAssetToken();
      sendJson(res, {
        ok: true,
        token,
        status: contentAssetRemoteStatus(token),
      });
      return true;
    }
    if (method === "GET" && url.pathname === "/api/content-assets/client-status") {
      sendJson(res, contentAssetRemoteStatus(url.searchParams.get("token") || ""));
      return true;
    }
    if (method === "POST" && url.pathname === "/api/content-assets/client-command") {
      readPayload()
        .then((payload) => {
          const token = String(payload.token || "").trim();
          const path = String(payload.path || "").trim();
          if (!token) throw new Error("missing token");
          if (!path.startsWith("/api/")) throw new Error("invalid content asset command path");
          return sendContentAssetCommandForToken(token, path, payload.options || {});
        })
        .then((data) => sendJson(res, data))
        .catch((error) => sendJson(res, { ok: false, error: error.message }, 400));
      return true;
    }
    if (url.pathname === "/api/content-assets/status") {
      sendJson(res, contentAssetRemoteStatus(url.searchParams.get("token") || ""));
      return true;
    }
    if (method === "GET" && url.pathname === "/api/content-assets/media") {
      const mediaPath = url.searchParams.get("path") || "";
      if (!mediaPath) {
        sendJson(res, { ok: false, error: "missing media path" }, 400);
        return true;
      }
      const target = new URL("/api/media", CONTENT_ASSET_PUBLIC_BASE_URL || CONTENT_ASSET_BASE_URL);
      target.searchParams.set("path", mediaPath);
      res.writeHead(302, {
        Location: target.toString(),
        "Cache-Control": "no-store",
      });
      res.end();
      return true;
    }
    if (method === "GET" && url.pathname === "/api/content-assets/jobs") {
      try {
        if (!isAiAdminMysqlEnabled()) {
          sendJson(res, {
            ok: true,
            jobs: [],
            pagination: paginationMeta(paginateItems([], parsePagination(url.searchParams))),
            storage: "disabled",
          });
          return true;
        }
        ensureContentAssetMysqlSchema();
        const pageData = paginateItems(
          loadContentAssetJobsFromMysql({ limit: 1000 }),
          parsePagination(url.searchParams, { defaultPageSize: 50, maxPageSize: 100 })
        );
        sendJson(res, {
          ok: true,
          jobs: pageData.items,
          pagination: paginationMeta(pageData),
          storage: "server_mysql",
        });
      } catch (error) {
        sendJson(res, { ok: false, error: error.message }, 500);
      }
      return true;
    }
    if (method === "POST" && url.pathname === "/api/content-assets/command") {
      readPayload()
        .then((payload) => {
          const path = String(payload.path || "").trim();
          if (!path.startsWith("/api/")) {
            throw new Error("invalid content asset command path");
          }
          return sendContentAssetCommand(path, payload.options || {});
        })
        .then((data) => sendJson(res, data))
        .catch((error) => sendJson(res, { ok: false, error: error.message }, 400));
      return true;
    }
    return false;
  }

  return {
    assertContentAssetRemoteAuth,
    contentAssetTokenFromRequest,
    handleContentAssetRoute,
  };
}

module.exports = { createContentAssetRoutes };
