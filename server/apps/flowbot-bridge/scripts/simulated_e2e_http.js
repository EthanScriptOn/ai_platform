"use strict";

const http = require("http");
const https = require("https");
const { spawn } = require("child_process");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getHttpModule(urlObject) {
  return urlObject.protocol === "https:" ? https : http;
}

function requestJson(method, target, payload = null, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const targetUrl = new URL(target);
    const body = payload == null ? "" : JSON.stringify(payload);
    const transport = getHttpModule(targetUrl);
    const req = transport.request(
      {
        protocol: targetUrl.protocol,
        hostname: targetUrl.hostname,
        port: targetUrl.port || undefined,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        method,
        timeout: timeoutMs,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`http_${res.statusCode}:${raw.slice(0, 500)}`));
            return;
          }
          try {
            resolve(raw.trim() ? JSON.parse(raw) : {});
          } catch (error) {
            reject(new Error(`invalid_json:${error.message}:${raw.slice(0, 500)}`));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("request_timeout")));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function createServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        port: Number(address.port),
        baseUrl: `http://127.0.0.1:${address.port}`,
      });
    });
  });
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function waitFor(fn, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await fn();
    if (result) {
      return result;
    }
    await sleep(100);
  }
  throw new Error(`wait_timeout:${label}`);
}

function spawnProcess(label, command, args, options = {}) {
  const logs = [];
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  const pushLog = (streamName) => (chunk) => {
    const text = String(chunk || "");
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      const entry = `[${label}:${streamName}] ${line}`;
      logs.push(entry);
      if (logs.length > 300) {
        logs.shift();
      }
    }
  };
  child.stdout.on("data", pushLog("stdout"));
  child.stderr.on("data", pushLog("stderr"));
  return { child, logs };
}

function terminateProcess(proc) {
  return new Promise((resolve) => {
    if (!proc || proc.killed || proc.exitCode != null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
    }, 3000);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    proc.kill("SIGTERM");
  });
}

module.exports = {
  collectBody,
  createServer,
  requestJson,
  sendJson,
  sleep,
  spawnProcess,
  terminateProcess,
  waitFor,
};
