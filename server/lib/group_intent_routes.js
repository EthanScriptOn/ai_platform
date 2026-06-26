"use strict";

function createGroupIntentRoutes({
  buildGroupIntentSampleInputWithQwen,
  createGroupIntentAutoTrainJob,
  labelGroupIntentWithQwen,
  listGroupIntentDomainTypes,
  loadGroupIntentAutoTrainJobs,
  predictGroupIntent,
  sendJson,
  streamGroupIntentSampleInputWithQwen,
  trainGroupIntentFastText,
}) {
  function handleGroupIntentRoute(req, res, url, method, readPayload) {
    if (method === "POST" && url.pathname === "/api/group-intent/qwen-label") {
      readPayload()
        .then((payload) => labelGroupIntentWithQwen(payload.input || ""))
        .then((data) => sendJson(res, { ok: true, ...data }))
        .catch((error) => sendJson(res, { ok: false, error: error.message }, 500));
      return true;
    }
    if (method === "POST" && url.pathname === "/api/group-intent/qwen-samples/stream") {
      readPayload()
        .then((payload) => streamGroupIntentSampleInputWithQwen(payload, res))
        .catch((error) => {
          if (!res.headersSent) sendJson(res, { ok: false, error: error.message }, 500);
          else if (!res.destroyed) {
            res.write(`data: ${JSON.stringify({ type: "error", error: error.message })}\n\n`);
            res.end();
          }
        });
      return true;
    }
    if (method === "POST" && url.pathname === "/api/group-intent/qwen-samples") {
      readPayload()
        .then((payload) => buildGroupIntentSampleInputWithQwen(payload.count || 100, payload.domainType))
        .then((data) => sendJson(res, { ok: true, ...data }))
        .catch((error) => sendJson(res, { ok: false, error: error.message }, 500));
      return true;
    }
    if (method === "GET" && url.pathname === "/api/group-intent/domain-types") {
      sendJson(res, { ok: true, items: listGroupIntentDomainTypes() });
      return true;
    }
    if (method === "POST" && url.pathname === "/api/group-intent/predict") {
      readPayload()
        .then((payload) => predictGroupIntent(payload.input || ""))
        .then((data) => sendJson(res, { ok: true, ...data }))
        .catch((error) => sendJson(res, { ok: false, error: error.message }, 500));
      return true;
    }
    if (method === "POST" && url.pathname === "/api/group-intent/train") {
      readPayload()
        .then((payload) => trainGroupIntentFastText(payload.items || []))
        .then((data) => sendJson(res, data))
        .catch((error) => sendJson(res, { ok: false, error: error.message }, 500));
      return true;
    }
    if (method === "GET" && url.pathname === "/api/group-intent/auto-train-jobs") {
      const jobs = loadGroupIntentAutoTrainJobs().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      sendJson(res, { ok: true, jobs });
      return true;
    }
    if (method === "POST" && url.pathname === "/api/group-intent/auto-train-jobs") {
      readPayload()
        .then((payload) => createGroupIntentAutoTrainJob(payload))
        .then((job) => sendJson(res, { ok: true, job }))
        .catch((error) => sendJson(res, { ok: false, error: error.message }, 500));
      return true;
    }
    if (method === "GET" && /^\/api\/group-intent\/auto-train-jobs\/[^/]+$/.test(url.pathname)) {
      const jobId = decodeURIComponent(url.pathname.split("/").pop() || "");
      const job = loadGroupIntentAutoTrainJobs().find((item) => item.id === jobId);
      if (!job) {
        sendJson(res, { ok: false, error: "任务不存在" }, 404);
        return true;
      }
      sendJson(res, { ok: true, job });
      return true;
    }
    return false;
  }

  return { handleGroupIntentRoute };
}

module.exports = { createGroupIntentRoutes };
