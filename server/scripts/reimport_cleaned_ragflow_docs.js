#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { createAiAdminSchemaManager } = require("../lib/ai_admin_schema");
const { createMysqlCli, sqlString } = require("../lib/mysql_cli");
const { createRagflowTokenStore } = require("../lib/ragflow_token_store");
const { loadRuntimeConfig } = require("../lib/runtime_config");

function usage() {
  console.error("用法：node scripts/reimport_cleaned_ragflow_docs.js --input-dir /path/to/cleaned --backup-dir /path/to/backup");
  process.exit(2);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--input-dir") args.inputDir = argv[++i];
    else if (item === "--backup-dir") args.backupDir = argv[++i];
    else if (item === "--keep-existing") args.keepExisting = true;
    else usage();
  }
  if (!args.inputDir || !args.backupDir) usage();
  return args;
}

function stripOldDocumentId(fileName) {
  return String(fileName || "").replace(/^[0-9a-f]{32}__/i, "");
}

function encryptRagflowPassword(publicKey, password) {
  const encoded = Buffer.from(String(password || ""), "utf-8").toString("base64");
  const key = crypto.createPublicKey(publicKey);
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

async function main() {
  const args = parseArgs(process.argv);
  const root = path.resolve(__dirname, "..");
  const config = loadRuntimeConfig(root);
  const datasetId = String(config.RAGFLOW_DATASET_ID || "").trim();
  const baseUrl = String(config.RAGFLOW_BASE_URL || "").replace(/\/$/, "");
  if (!datasetId) throw new Error("缺少 RAGFlow dataset id。");
  if (!baseUrl) throw new Error("缺少 RAGFlow 地址。");

  const { runMysql } = createMysqlCli({
    bin: config.AI_ADMIN_MYSQL_BIN,
    host: config.AI_ADMIN_MYSQL_HOST,
    port: config.AI_ADMIN_MYSQL_PORT,
    database: config.AI_ADMIN_MYSQL_DATABASE,
    user: config.AI_ADMIN_MYSQL_USER,
    password: config.AI_ADMIN_MYSQL_PASSWORD,
  });
  const schema = createAiAdminSchemaManager({
    AI_ADMIN_MYSQL_AUTO_MIGRATE: config.AI_ADMIN_MYSQL_AUTO_MIGRATE,
    AI_ADMIN_STORAGE_BACKEND: config.AI_ADMIN_STORAGE_BACKEND,
    runAiAdminMysql: runMysql,
  });
  const tokenStore = createRagflowTokenStore({
    ensureRuntimeTokenMysqlSchema: schema.ensureRuntimeTokenMysqlSchema,
    isAiAdminMysqlEnabled: schema.isAiAdminMysqlEnabled,
    runAiAdminMysql: runMysql,
    sqlString,
  });

  async function login() {
    if (!config.RAGFLOW_LOGIN_EMAIL || !config.RAGFLOW_LOGIN_PASSWORD || !config.RAGFLOW_LOGIN_PUBLIC_KEY) {
      throw new Error("RAGFlow token 过期，且缺少登录配置。");
    }
    const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: config.RAGFLOW_LOGIN_EMAIL,
        password: encryptRagflowPassword(config.RAGFLOW_LOGIN_PUBLIC_KEY, config.RAGFLOW_LOGIN_PASSWORD),
      }),
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok || data.code !== 0) {
      throw new Error(data.message || text || `RAGFlow login HTTP ${response.status}`);
    }
    const authorization = response.headers.get("authorization") || response.headers.get("Authorization") || "";
    if (!authorization) throw new Error("RAGFlow 登录成功，但没有返回 token。");
    tokenStore.saveRagflowToken(authorization);
    return authorization;
  }

  async function requestJson(method, apiPath, payload) {
    let token = tokenStore.loadRagflowToken();
    if (!token) token = await login();
    const send = (authorization) =>
      fetch(`${baseUrl}${apiPath}`, {
        method,
        headers: {
          Authorization: `Bearer ${authorization}`,
          ...(payload ? { "Content-Type": "application/json" } : {}),
        },
        body: payload ? JSON.stringify(payload) : undefined,
      });
    let response = await send(token);
    if (response.status === 401 || response.status === 403) {
      token = await login();
      response = await send(token);
    }
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok || ![undefined, 0].includes(data.code)) {
      throw new Error(data.message || text || `RAGFlow HTTP ${response.status}`);
    }
    return data;
  }

  async function requestUpload(filePath, uploadName) {
    let token = tokenStore.loadRagflowToken();
    if (!token) token = await login();
    const form = new FormData();
    const content = fs.readFileSync(filePath);
    form.append("file", new Blob([content], { type: "text/markdown" }), uploadName);
    const send = (authorization) =>
      fetch(`${baseUrl}/api/v1/datasets/${encodeURIComponent(datasetId)}/documents`, {
        method: "POST",
        headers: { Authorization: `Bearer ${authorization}` },
        body: form,
      });
    let response = await send(token);
    if (response.status === 401 || response.status === 403) {
      token = await login();
      response = await send(token);
    }
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok || data.code !== 0) {
      throw new Error(data.message || text || `RAGFlow upload HTTP ${response.status}`);
    }
    return data;
  }

  async function listAllDocuments() {
    const docs = [];
    for (let page = 1; page <= 100; page += 1) {
      const data = await requestJson(
        "GET",
        `/api/v1/datasets/${encodeURIComponent(datasetId)}/documents?page=${page}&page_size=100`
      );
      const pageDocs = Array.isArray(data?.data?.docs) ? data.data.docs : [];
      docs.push(...pageDocs);
      if (pageDocs.length < 100) break;
    }
    return docs;
  }

  fs.mkdirSync(args.backupDir, { recursive: true });
  const currentDocs = await listAllDocuments();
  fs.writeFileSync(
    path.join(args.backupDir, "ragflow-documents-before-reimport.json"),
    JSON.stringify({ datasetId, baseUrl, count: currentDocs.length, docs: currentDocs }, null, 2),
    "utf-8"
  );
  console.log(JSON.stringify({ step: "listed", count: currentDocs.length }, null, 0));

  if (!args.keepExisting && currentDocs.length) {
    for (let i = 0; i < currentDocs.length; i += 50) {
      const ids = currentDocs.slice(i, i + 50).map((doc) => doc.id).filter(Boolean);
      if (ids.length) await requestJson("DELETE", `/api/v1/datasets/${encodeURIComponent(datasetId)}/documents`, { ids });
      console.log(JSON.stringify({ step: "deleted", done: Math.min(i + 50, currentDocs.length), total: currentDocs.length }, null, 0));
    }
  }

  const inputDir = path.resolve(args.inputDir);
  const files = fs
    .readdirSync(inputDir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => path.join(inputDir, name));
  if (!files.length) throw new Error(`没有找到 Markdown 文件：${inputDir}`);

  const uploaded = [];
  for (let i = 0; i < files.length; i += 1) {
    const filePath = files[i];
    const uploadName = stripOldDocumentId(path.basename(filePath));
    const data = await requestUpload(filePath, uploadName);
    const ids = (Array.isArray(data?.data) ? data.data : []).map((doc) => doc.id).filter(Boolean);
    uploaded.push({ source: filePath, uploadName, ids });
    console.log(JSON.stringify({ step: "uploaded", done: i + 1, total: files.length, uploadName, ids }, null, 0));
  }

  const documentIds = uploaded.flatMap((item) => item.ids);
  for (let i = 0; i < documentIds.length; i += 10) {
    const ids = documentIds.slice(i, i + 10);
    await requestJson("POST", `/api/v1/datasets/${encodeURIComponent(datasetId)}/chunks`, { document_ids: ids });
    console.log(JSON.stringify({ step: "parsed", done: Math.min(i + 10, documentIds.length), total: documentIds.length }, null, 0));
  }

  fs.writeFileSync(
    path.join(args.backupDir, "ragflow-reimport-result.json"),
    JSON.stringify({ datasetId, baseUrl, uploadedCount: uploaded.length, documentIds, uploaded }, null, 2),
    "utf-8"
  );
  console.log(JSON.stringify({ ok: true, uploaded: uploaded.length, documentIds: documentIds.length }, null, 0));
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
