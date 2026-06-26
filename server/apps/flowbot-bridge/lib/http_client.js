const http = require("http");
const https = require("https");

function getHttpModule(targetUrl) {
  return targetUrl.protocol === "https:" ? https : http;
}

function requestJson(method, target, payload, timeoutMs) {
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
            reject(new Error(`http_${res.statusCode}:${raw.slice(0, 300)}`));
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch (error) {
            reject(new Error(`invalid_json:${error.message}`));
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

function requestJsonWithHeaders(method, target, payload, headers = {}, timeoutMs) {
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
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`http_${res.statusCode}:${raw.slice(0, 1000)}`));
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch (error) {
            reject(new Error(`invalid_json:${error.message}:${raw.slice(0, 1000)}`));
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

function downloadBinaryWithHeaders(target, timeoutMs, headers = {}) {
  return new Promise((resolve, reject) => {
    const targetUrl = new URL(target);
    const transport = getHttpModule(targetUrl);
    const req = transport.request(
      {
        protocol: targetUrl.protocol,
        hostname: targetUrl.hostname,
        port: targetUrl.port || undefined,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        method: "GET",
        timeout: timeoutMs,
        headers,
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const nextUrl = new URL(res.headers.location, target).toString();
          res.resume();
          downloadBinaryWithHeaders(nextUrl, timeoutMs, headers).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => reject(new Error(`download_http_${res.statusCode}:${Buffer.concat(chunks).toString("utf8").slice(0, 300)}`)));
          return;
        }
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            buffer: Buffer.concat(chunks),
            contentType: String(res.headers["content-type"] || ""),
            sourceUrl: target,
          });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("download_timeout")));
    req.on("error", reject);
    req.end();
  });
}

function downloadBinary(target, timeoutMs) {
  return downloadBinaryWithHeaders(target, timeoutMs);
}

module.exports = {
  downloadBinary,
  downloadBinaryWithHeaders,
  getHttpModule,
  requestJson,
  requestJsonWithHeaders,
};
