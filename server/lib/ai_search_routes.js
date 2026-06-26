"use strict";

function createAiSearchRoutes({
  fetchSearchConfig,
  generateDirections,
  searchAndDraftArticle,
  sendJson,
}) {
  function writeStreamLine(res, payload) {
    res.write(`${JSON.stringify(payload)}\n`);
  }

  function handleAiSearchRoute(req, res, url, method, readPayload) {
    if (method === "GET" && url.pathname === "/api/ai-search/config") {
      Promise.resolve()
        .then(() => fetchSearchConfig())
        .then((data) => sendJson(res, { ok: true, ...data }))
        .catch((error) => sendJson(res, { ok: false, error: error.message }, 500));
      return true;
    }

    if (method === "POST" && url.pathname === "/api/ai-search/directions") {
      readPayload()
        .then((payload) =>
          generateDirections(
            payload.query || "",
            payload.config || {},
            payload.previousDirections || [],
            payload.preferenceChip || ""
          )
        )
        .then((data) => sendJson(res, { ok: true, ...data }))
        .catch((error) => sendJson(res, { ok: false, error: error.message }, 500));
      return true;
    }

    if (method === "POST" && url.pathname === "/api/ai-search/report") {
      readPayload()
        .then((payload) =>
          searchAndDraftArticle({
            query: payload.query || "",
            directions: payload.directions || [],
            searchCount: payload.searchCount,
            searchDepth: payload.searchDepth,
            runtimeConfig: payload.config || {},
          })
        )
        .then((data) => sendJson(res, { ok: true, ...data }))
        .catch((error) => sendJson(res, { ok: false, error: error.message }, 500));
      return true;
    }

    if (method === "POST" && url.pathname === "/api/ai-search/report-stream") {
      readPayload()
        .then(async (payload) => {
          res.writeHead(200, {
            "Content-Type": "application/x-ndjson; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          });
          if (typeof res.flushHeaders === "function") res.flushHeaders();
          writeStreamLine(res, { type: "start" });
          const data = await searchAndDraftArticle({
            query: payload.query || "",
            directions: payload.directions || [],
            searchCount: payload.searchCount,
            searchDepth: payload.searchDepth,
            runtimeConfig: payload.config || {},
            onProgress(event) {
              writeStreamLine(res, { type: "progress", ...event });
            },
          });
          writeStreamLine(res, { type: "result", ok: true, ...data });
          res.end();
        })
        .catch((error) => {
          if (!res.headersSent) {
            res.writeHead(200, {
              "Content-Type": "application/x-ndjson; charset=utf-8",
              "Cache-Control": "no-cache, no-transform",
              Connection: "keep-alive",
              "X-Accel-Buffering": "no",
            });
            if (typeof res.flushHeaders === "function") res.flushHeaders();
          }
          writeStreamLine(res, { type: "error", ok: false, error: error.message });
          res.end();
        });
      return true;
    }

    return false;
  }

  return { handleAiSearchRoute };
}

module.exports = { createAiSearchRoutes };
