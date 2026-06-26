"use strict";

const crypto = require("crypto");
const fs = require("fs");

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf-8")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function parsePagination(searchParams, { defaultPageSize = 20, maxPageSize = 100 } = {}) {
  const page = Math.max(1, Number.parseInt(searchParams.get("page") || "1", 10) || 1);
  const rawPageSize = Number.parseInt(
    searchParams.get("pageSize") || searchParams.get("limit") || String(defaultPageSize),
    10
  );
  const pageSize = Math.min(maxPageSize, Math.max(1, rawPageSize || defaultPageSize));
  return { page, pageSize };
}

function paginateItems(items, { page, pageSize }) {
  const total = Array.isArray(items) ? items.length : 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const normalizedPage = Math.min(Math.max(1, page), totalPages);
  const start = (normalizedPage - 1) * pageSize;
  return {
    page: normalizedPage,
    pageSize,
    total,
    totalPages,
    items: (items || []).slice(start, start + pageSize),
  };
}

function paginationMeta(pageData) {
  const { items, ...meta } = pageData || {};
  return meta;
}

function parseMysqlJson(value, fallback) {
  const raw = String(value || "").trim();
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function extractJsonFromText(text = "") {
  const raw = String(text || "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  try {
    return JSON.parse(candidate);
  } catch {
    const objectStart = candidate.indexOf("{");
    const objectEnd = candidate.lastIndexOf("}");
    if (objectStart >= 0 && objectEnd > objectStart) return JSON.parse(candidate.slice(objectStart, objectEnd + 1));
    const start = candidate.indexOf("[");
    const end = candidate.lastIndexOf("]");
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new Error("千问返回内容不是合法 JSON。");
  }
}

function stableId(documentTitle, unit) {
  const evidence = unit?.source_evidence || [];
  const raw = `{"document_title": ${JSON.stringify(documentTitle)}, "evidence": ${JSON.stringify(
    evidence
  ).replace(/,/g, ", ")}, "title": ${JSON.stringify(unit?.title)}}`;
  return crypto.createHash("sha1").update(raw).digest("hex").slice(0, 16);
}

module.exports = {
  extractJsonFromText,
  paginateItems,
  paginationMeta,
  parseMysqlJson,
  parsePagination,
  readJsonl,
  stableId,
};
