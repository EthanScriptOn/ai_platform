"use strict";

const fs = require("fs");

function noStoreHeaders(extra = {}) {
  return {
    ...extra,
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    Pragma: "no-cache",
    Expires: "0",
  };
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, noStoreHeaders({
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  }));
  res.end(body);
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, noStoreHeaders({
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
  }));
  res.end(html);
}

function sendRedirect(res, statusCode, location) {
  res.writeHead(statusCode, noStoreHeaders({ Location: location }));
  res.end();
}

function pruneEmpty(value) {
  if (Array.isArray(value)) {
    const nextItems = value
      .map((item) => pruneEmpty(item))
      .filter((item) => item !== undefined);
    return nextItems.length ? nextItems : undefined;
  }
  if (!value || typeof value !== "object") {
    if (value === "" || value == null) {
      return undefined;
    }
    return value;
  }
  const next = {};
  for (const [key, current] of Object.entries(value)) {
    const cleaned = pruneEmpty(current);
    if (cleaned === undefined) {
      continue;
    }
    next[key] = cleaned;
  }
  return Object.keys(next).length ? next : undefined;
}

function sendFile(res, statusCode, filePath, contentType) {
  const data = fs.readFileSync(filePath);
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Content-Length": data.length,
    "Cache-Control": "public, max-age=31536000, immutable",
  });
  res.end(data);
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function safeParseJson(rawBody) {
  if (!rawBody || !rawBody.trim()) {
    return null;
  }
  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

module.exports = {
  collectBody,
  escapeHtml,
  pruneEmpty,
  safeParseJson,
  sendFile,
  sendHtml,
  sendJson,
  sendRedirect,
};
