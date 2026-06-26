#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const DEFAULTS = {
  mongoUri:
    process.env.MONGO_URI ||
    "mongodb://pro_rw:facai%40188@dds-m5e25dbbf852d4941.mongodb.rds.aliyuncs.com:3717,dds-m5e25dbbf852d4942.mongodb.rds.aliyuncs.com:3717/admin?replicaSet=mgset-92139473&authSource=admin",
  mongoDb: process.env.MONGO_DB || "wechat",
  mongoCollection: process.env.MONGO_COLLECTION || "normal",
  fasttextPredictUrl: process.env.GROUP_INTENT_PREDICT_URL || "http://47.104.81.250/api/group-intent/predict",
  qwenLabelUrl: process.env.GROUP_INTENT_QWEN_LABEL_URL || "http://47.104.81.250/api/group-intent/qwen-label",
  recentDocLimit: Number(process.env.GROUP_INTENT_RECENT_DOC_LIMIT || 12000),
  sampleSize: Number(process.env.GROUP_INTENT_SAMPLE_SIZE || 300),
  batchSize: Number(process.env.GROUP_INTENT_BATCH_SIZE || 5),
  maxPerGroup: Number(process.env.GROUP_INTENT_MAX_PER_GROUP || 4),
  requestRetryCount: Number(process.env.GROUP_INTENT_REQUEST_RETRY_COUNT || 3),
  requestRetryDelayMs: Number(process.env.GROUP_INTENT_REQUEST_RETRY_DELAY_MS || 3000),
  requestTimeoutMs: Number(process.env.GROUP_INTENT_REQUEST_TIMEOUT_MS || 60000),
};

function timestampLabel(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function extractXmlTagValue(xml = "", tagName = "") {
  const match = String(xml || "").match(new RegExp(`<${tagName}>([^<]+)</${tagName}>`, "i"));
  return match ? match[1].trim() : "";
}

function normalizeMessageText(raw = "", fallbackSender = "") {
  let text = String(raw || "").replace(/\r/g, "\n").trim();
  if (!text) return "";

  // Platform 4 payloads sometimes prefix the sender as "wxid_xxx:\n正文".
  const senderPrefix = String(fallbackSender || "").trim();
  if (senderPrefix && text.startsWith(`${senderPrefix}:\n`)) {
    text = text.slice(senderPrefix.length + 2).trim();
  }

  return text
    .replace(/\n+/g, " / ")
    .replace(/\s+/g, " ")
    .trim();
}

function isPromoLikeText(text = "") {
  const value = String(text || "");
  if (!value) return false;
  const slashSegments = value.split(" / ").length - 1;
  const patterns = [
    /https?:\/\//i,
    /p\.pinduoduo\.com/i,
    /(淘宝|京东|拼多多|店铺|口令|链接|拍\d|拍下|下单|领券|券后)/,
    /[￥¥💰]\s*\d+/,
    /(MU\d{3,}|CZ\d{2,}|[A-Za-z0-9]{6,}\/\s*[A-Z]{2}\d{3,})/,
    /(囤|补货|限时|长效留香|任选|最多\d+片|使用方法|适合人群|驱蚊成分|驱蚊时效|组合入手|官方旗舰|成分|功效|乳液|喷雾)/,
  ];
  return slashSegments >= 3 || patterns.some((pattern) => pattern.test(value));
}

function buildMessageRecord(doc = {}) {
  const request = doc.request || {};
  const data = request.data || {};
  const groupId = String(data.toUserName || data.username || data?.tousetname?.string || "").trim();
  if (!groupId.endsWith("@chatroom")) return null;
  const sender = String(data.fromUserName || "").trim();
  const msgSource = String(data.msgSource || "").trim();
  const silence = Number(extractXmlTagValue(msgSource, "silence") || 0);
  const memberCount = Number(extractXmlTagValue(msgSource, "membercount") || 0);
  const text = normalizeMessageText(data.msgContent || data.content || "", sender);

  if (!text) return null;

  return {
    id: String(doc._id || ""),
    code: Number(doc.code || 0),
    requestTime: new Date(doc.request_time || Date.now()).toISOString(),
    groupId,
    sender,
    text,
    wxId: String(doc.wxId || request.wxId || data.wechat || "").trim(),
    silence,
    memberCount,
    callbackMsg: String(request.msg || "").trim(),
    msgType: Number(data.msgType || 0),
    type: Number(data.type || 0),
    promoLike: isPromoLikeText(text),
  };
}

function shouldExcludeGroup(group = {}) {
  const total = group.totalMessages || 0;
  const uniqueSenders = group.uniqueSenderCount || 0;
  const topSenderRatio = group.topSenderRatio || 0;
  const promoRatio = group.promoLikeRatio || 0;
  const silenceRatio = group.silenceRatio || 0;

  if (total >= 4 && uniqueSenders <= 2 && promoRatio >= 0.55) return true;
  if (total >= 6 && uniqueSenders <= 3 && promoRatio >= 0.45 && silenceRatio >= 0.7) return true;
  if (total >= 6 && topSenderRatio >= 0.6 && promoRatio >= 0.35) return true;
  if (total >= 8 && topSenderRatio >= 0.5 && promoRatio >= 0.3 && silenceRatio >= 0.4) return true;
  if (total >= 8 && promoRatio >= 0.8) return true;
  return false;
}

function summarizeGroup(records = []) {
  const senderSet = new Set();
  const senderCounts = new Map();
  let promoLikeCount = 0;
  let silenceCount = 0;

  for (const record of records) {
    if (record.sender) senderSet.add(record.sender);
    if (record.sender) senderCounts.set(record.sender, (senderCounts.get(record.sender) || 0) + 1);
    if (record.promoLike) promoLikeCount += 1;
    if (record.silence) silenceCount += 1;
  }
  const topSenderCount = Math.max(0, ...senderCounts.values());

  return {
    groupId: records[0]?.groupId || "",
    totalMessages: records.length,
    uniqueSenderCount: senderSet.size,
    topSenderRatio: records.length ? topSenderCount / records.length : 0,
    promoLikeCount,
    promoLikeRatio: records.length ? promoLikeCount / records.length : 0,
    silenceRatio: records.length ? silenceCount / records.length : 0,
    sampleTexts: records.slice(0, 3).map((item) => item.text),
  };
}

function chunk(items = [], size = 50) {
  const batches = [];
  for (let index = 0; index < items.length; index += size) batches.push(items.slice(index, index + size));
  return batches;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function serializeError(error) {
  if (!error) return null;
  return {
    message: String(error.message || error),
    code: String(error.code || "").trim(),
    status: Number(error.status || 0) || undefined,
    name: String(error.name || "").trim(),
  };
}

function writeEvalReport(outputDir = "", startedAt = new Date(), report = {}) {
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `report-${timestampLabel(startedAt)}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf-8");
  return outputPath;
}

async function postJson(url, payload) {
  let lastError = null;
  for (let attempt = 1; attempt <= Math.max(1, DEFAULTS.requestRetryCount); attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1000, DEFAULTS.requestTimeoutMs));
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify(payload),
      });
      const text = await response.text();
      if (!response.ok) {
        const error = new Error(`${url} -> HTTP ${response.status}: ${text}`);
        error.status = response.status;
        throw error;
      }
      return text ? JSON.parse(text) : {};
    } catch (error) {
      if (error?.name === "AbortError") {
        const timeoutError = new Error(`${url} -> request timeout after ${DEFAULTS.requestTimeoutMs}ms`);
        timeoutError.code = "REQUEST_TIMEOUT";
        lastError = timeoutError;
      } else {
        lastError = error;
      }
      const shouldRetry =
        attempt < DEFAULTS.requestRetryCount &&
        (!lastError.status ||
          lastError.code === "REQUEST_TIMEOUT" ||
          [502, 503, 504].includes(Number(lastError.status)));
      if (!shouldRetry) throw lastError;
      await sleep(DEFAULTS.requestRetryDelayMs * attempt);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

async function evalBatchWithFallback(batch = [], batchErrors = []) {
  if (!batch.length) return [];
  const input = batch.map((item) => item.text).join("\n");
  try {
    const [qwenPayload, fasttextPayload] = await Promise.all([
      postJson(DEFAULTS.qwenLabelUrl, { input }),
      postJson(DEFAULTS.fasttextPredictUrl, { input }),
    ]);
    const qwenItems = Array.isArray(qwenPayload.items) ? qwenPayload.items : [];
    const fasttextItems = Array.isArray(fasttextPayload.items) ? fasttextPayload.items : [];
    return batch.map((item, index) => ({
      ...item,
      qwenLabel: qwenItems[index]?.label === "intervene" ? "intervene" : "ignore",
      qwenReason: String(qwenItems[index]?.reason || "").trim(),
      fasttextLabel: fasttextItems[index]?.label === "intervene" ? "intervene" : "ignore",
      fasttextConfidence: Number(fasttextItems[index]?.confidence || 0),
      fasttextReason: String(fasttextItems[index]?.reason || "").trim(),
    }));
  } catch (error) {
    if (batch.length === 1) {
      batchErrors.push({
        id: batch[0].id,
        text: batch[0].text,
        error: serializeError(error),
      });
      return [];
    }
    const midpoint = Math.ceil(batch.length / 2);
    const left = await evalBatchWithFallback(batch.slice(0, midpoint), batchErrors);
    const right = await evalBatchWithFallback(batch.slice(midpoint), batchErrors);
    return [...left, ...right];
  }
}

function computeMetrics(rows = []) {
  let tp = 0;
  let tn = 0;
  let fp = 0;
  let fn = 0;

  for (const row of rows) {
    if (row.qwenLabel === "intervene" && row.fasttextLabel === "intervene") tp += 1;
    if (row.qwenLabel === "ignore" && row.fasttextLabel === "ignore") tn += 1;
    if (row.qwenLabel === "ignore" && row.fasttextLabel === "intervene") fp += 1;
    if (row.qwenLabel === "intervene" && row.fasttextLabel === "ignore") fn += 1;
  }

  const total = rows.length;
  const accuracy = total ? (tp + tn) / total : 0;
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;

  return { total, tp, tn, fp, fn, accuracy, precision, recall, f1 };
}

async function main() {
  const client = new MongoClient(DEFAULTS.mongoUri, {
    authMechanism: "SCRAM-SHA-256",
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 30000,
    maxPoolSize: 2,
    minPoolSize: 0,
  });

  const startedAt = new Date();
  const groups = new Map();
  let recentRecords = [];
  let groupSummaries = [];
  let excludedGroups = new Set();
  let keptGroups = [];
  let sampled = [];
  let rows = [];
  let batchErrors = [];

  try {
    await client.connect();
    const collection = client.db(DEFAULTS.mongoDb).collection(DEFAULTS.mongoCollection);

    // We intentionally scan the most recent window via the request_time index,
    // then locally keep only code=203 text callbacks to avoid expensive full scans.
    const docs = await collection
      .find(
        {},
        {
          projection: {
            _id: 1,
            code: 1,
            request_time: 1,
            wxId: 1,
            request: 1,
          },
        }
      )
      .sort({ request_time: -1 })
      .limit(DEFAULTS.recentDocLimit)
      .toArray();

    recentRecords = docs
      .filter((doc) => Number(doc.code || 0) === 203)
      .map(buildMessageRecord)
      .filter(Boolean);

    for (const record of recentRecords) {
      const list = groups.get(record.groupId) || [];
      list.push(record);
      groups.set(record.groupId, list);
    }

    groupSummaries = [...groups.values()].map(summarizeGroup);
    excludedGroups = new Set(groupSummaries.filter(shouldExcludeGroup).map((item) => item.groupId));
    keptGroups = groupSummaries.filter((item) => !excludedGroups.has(item.groupId));

    sampled = [];
    const seenTexts = new Set();
    const sortedGroups = [...groups.entries()]
      .filter(([groupId]) => !excludedGroups.has(groupId))
      .sort((a, b) => b[1].length - a[1].length);

    for (const [, records] of sortedGroups) {
      let taken = 0;
      for (const record of records) {
        if (taken >= DEFAULTS.maxPerGroup) break;
        if (sampled.length >= DEFAULTS.sampleSize) break;
        if (record.text.length < 2 || record.text.length > 120) continue;
        if (seenTexts.has(record.text)) continue;
        seenTexts.add(record.text);
        sampled.push(record);
        taken += 1;
      }
      if (sampled.length >= DEFAULTS.sampleSize) break;
    }

    rows = [];
    for (const batch of chunk(sampled, DEFAULTS.batchSize)) {
      const evaluated = await evalBatchWithFallback(batch, batchErrors);
      rows.push(...evaluated);
    }

    const metrics = computeMetrics(rows);
    const mismatches = rows.filter((item) => item.qwenLabel !== item.fasttextLabel);
    const report = {
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      config: DEFAULTS,
      mongo: {
        db: DEFAULTS.mongoDb,
        collection: DEFAULTS.mongoCollection,
        recentDocLimit: DEFAULTS.recentDocLimit,
      },
      sampling: {
        recentCode203Messages: recentRecords.length,
        totalGroups: groupSummaries.length,
        excludedGroupCount: excludedGroups.size,
        keptGroupCount: keptGroups.length,
        sampledMessageCount: rows.length,
        sampledAttemptCount: sampled.length,
      },
      metrics,
      batchErrors,
      excludedGroups: groupSummaries
        .filter((item) => excludedGroups.has(item.groupId))
        .sort((a, b) => b.totalMessages - a.totalMessages)
        .slice(0, 30),
      keptGroupsPreview: keptGroups.sort((a, b) => b.totalMessages - a.totalMessages).slice(0, 30),
      mismatches: mismatches.slice(0, 100),
    };

    const outputDir = path.join(process.cwd(), "runtime", "group-intent-mongo-eval");
    const outputPath = writeEvalReport(outputDir, startedAt, report);

    console.log(JSON.stringify({ outputPath, ...report.metrics, sampling: report.sampling }, null, 2));
  } catch (error) {
    const outputDir = path.join(process.cwd(), "runtime", "group-intent-mongo-eval");
    const failedReport = {
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      status: "failed",
      config: DEFAULTS,
      sampling: {
        recentCode203Messages: recentRecords.length,
        totalGroups: groupSummaries.length,
        excludedGroupCount: excludedGroups.size,
        keptGroupCount: keptGroups.length,
        sampledMessageCount: rows.length,
        sampledAttemptCount: sampled.length,
      },
      partialMetrics: computeMetrics(rows),
      batchErrors,
      mismatches: rows.filter((item) => item.qwenLabel !== item.fasttextLabel).slice(0, 100),
      error: serializeError(error),
    };
    writeEvalReport(outputDir, startedAt, failedReport);
    throw error;
  } finally {
    await client.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
