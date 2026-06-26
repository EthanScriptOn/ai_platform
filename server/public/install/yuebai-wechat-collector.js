#!/usr/bin/env node
const http = require("http");

const HOST = "127.0.0.1";
const PORT = Number(process.env.YUEBAI_COLLECTOR_PORT || 18765);

let listening = false;
let selectedType = "all";
const startedAt = new Date().toISOString();
const captures = [];

function sendJson(res, payload, status = 200) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf-8");
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function statusPayload() {
  return {
    ok: true,
    data: {
      AppName: "yuebai-wechat-collector",
      Version: "0.1.0-local",
      StartedAt: startedAt,
    },
    connected: true,
    installed: true,
    listening,
    selectedType,
    captures,
    message: listening ? "本机后台包正在监听。" : "本机后台包已安装，等待启动采集。",
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    sendJson(res, {});
    return;
  }

  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (url.pathname === "/api/app-info") {
    sendJson(res, statusPayload());
    return;
  }
  if (url.pathname === "/api/is-proxy") {
    sendJson(res, { ok: true, data: { value: listening } });
    return;
  }
  if (url.pathname === "/api/status") {
    sendJson(res, statusPayload());
    return;
  }
  if (url.pathname === "/api/captures") {
    sendJson(res, { ok: true, captures });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/set-type") {
    const body = await readBody(req);
    selectedType = body.type || "all";
    sendJson(res, { ok: true, selectedType });
    return;
  }
  if (url.pathname === "/api/proxy-open" || (req.method === "POST" && url.pathname === "/api/start")) {
    listening = true;
    sendJson(res, statusPayload());
    return;
  }
  if (url.pathname === "/api/proxy-unset" || (req.method === "POST" && url.pathname === "/api/stop")) {
    listening = false;
    sendJson(res, statusPayload());
    return;
  }

  sendJson(res, { ok: false, error: "not found" }, 404);
});

server.listen(PORT, HOST, () => {
  console.log(`[yuebai-wechat-collector] listening on http://${HOST}:${PORT}`);
});
