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
  predictUrl: process.env.GROUP_INTENT_PREDICT_URL || "http://47.104.81.250/api/group-intent/predict",
  qwenLabelUrl: process.env.GROUP_INTENT_QWEN_LABEL_URL || "http://47.104.81.250/api/group-intent/qwen-label",
  recentDocLimit: Number(process.env.GROUP_INTENT_RECENT_DOC_LIMIT || 15000),
  sampleSize: Number(process.env.GROUP_INTENT_STRESS_SAMPLE_SIZE || 80),
  batchSize: Number(process.env.GROUP_INTENT_BATCH_SIZE || 5),
  maxPerGroup: Number(process.env.GROUP_INTENT_MAX_PER_GROUP || 3),
  requestRetryCount: Number(process.env.GROUP_INTENT_REQUEST_RETRY_COUNT || 3),
  requestRetryDelayMs: Number(process.env.GROUP_INTENT_REQUEST_RETRY_DELAY_MS || 3000),
  requestTimeoutMs: Number(process.env.GROUP_INTENT_REQUEST_TIMEOUT_MS || 60000),
};

const STRESS_REGEX =
  /(值不值得买|怎么买|怎么领|券怎么|更好的价格|最低价|凑单|拼单|一起拼|跟一单|补货|想买|求推荐|哪个|哪款|适合|链接|有没有|有货|拍哪项|怎么拍|划算)/;

const CONTROL_REGEX =
  /(不粘腻|好吸收|成膜|好吃|撑肚子|生二胎|我再发一下|我自己穿|哈哈|录视频|体验|测试|走不动路|最后一天|加补卷|好价|冲鸭)/;

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
  ];
  return slashSegments >= 3 || patterns.some((pattern) => pattern.test(value));
}

function buildMessageRecord(doc = {}) {
  let request = doc.request || {};
  if (Array.isArray(request)) request = request[0] && typeof request[0] === "object" ? request[0] : {};
  let data = request.data || {};
  if (Array.isArray(data)) data = data[0] && typeof data[0] === "object" ? data[0] : {};
  const groupId = String(data.toUserName || data.username || data?.tousetname?.string || "").trim();
  if (!groupId.endsWith("@chatroom")) return null;
  const sender = String(data.fromUserName || "").trim();
  const msgSource = String(data.msgSource || "").trim();
  const text = normalizeMessageText(data.msgContent || data.content || "", sender);
  if (!text) return null;

  return {
    id: String(doc._id || ""),
    requestTime: new Date(doc.request_time || Date.now()).toISOString(),
    groupId,
    sender,
    text,
    silence: Number(extractXmlTagValue(msgSource, "silence") || 0),
    promoLike: isPromoLikeText(text),
    stressLike: STRESS_REGEX.test(text),
    controlLike: CONTROL_REGEX.test(text),
  };
}

function chunk(items = [], size = 10) {
  const result = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
        lastError = new Error(`${url} -> request timeout after ${DEFAULTS.requestTimeoutMs}ms`);
        lastError.code = "REQUEST_TIMEOUT";
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

function safeDivide(a, b) {
  return b ? a / b : 0;
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
  const accuracy = safeDivide(tp + tn, total);
  const precision = safeDivide(tp, tp + fp);
  const recall = safeDivide(tp, tp + fn);
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;

  return { total, tp, tn, fp, fn, accuracy, precision, recall, f1 };
}

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

async function main() {
  const startedAt = new Date();
  const client = new MongoClient(DEFAULTS.mongoUri, {
    authMechanism: "SCRAM-SHA-256",
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 30000,
    maxPoolSize: 2,
    minPoolSize: 0,
  });

  try {
    await client.connect();
    const collection = client.db(DEFAULTS.mongoDb).collection(DEFAULTS.mongoCollection);
    const docs = await collection
      .find(
        {},
        {
          projection: {
            _id: 1,
            code: 1,
            request_time: 1,
            request: 1,
          },
        }
      )
      .sort({ request_time: -1 })
      .limit(DEFAULTS.recentDocLimit)
      .toArray();

    const records = docs
      .filter((doc) => Number(doc.code || 0) === 203)
      .map(buildMessageRecord)
      .filter(Boolean);

    const groups = new Map();
    for (const record of records) {
      const list = groups.get(record.groupId) || [];
      list.push(record);
      groups.set(record.groupId, list);
    }

    const selected = [];
    const seenTexts = new Set();
    const targetStress = Math.ceil(DEFAULTS.sampleSize * 0.65);
    const targetControl = DEFAULTS.sampleSize - targetStress;
    let stressCount = 0;
    let controlCount = 0;

    for (const [, groupRecords] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
      let taken = 0;
      for (const record of groupRecords) {
        if (taken >= DEFAULTS.maxPerGroup || selected.length >= DEFAULTS.sampleSize) break;
        if (record.text.length < 2 || record.text.length > 120 || seenTexts.has(record.text)) continue;

        const pickStress = record.stressLike && stressCount < targetStress;
        const pickControl =
          !record.stressLike &&
          (record.controlLike || record.promoLike) &&
          controlCount < targetControl;

        if (!pickStress && !pickControl) continue;

        selected.push({
          ...record,
          benchmarkType: pickStress ? "stress" : "control",
        });
        seenTexts.add(record.text);
        taken += 1;
        if (pickStress) stressCount += 1;
        if (pickControl) controlCount += 1;
      }
    }

    for (const batch of chunk(selected, DEFAULTS.batchSize)) {
      const input = batch.map((item) => item.text).join("\n");
      const [qwenPayload, fasttextPayload] = await Promise.all([
        postJson(DEFAULTS.qwenLabelUrl, { input }),
        postJson(DEFAULTS.predictUrl, { input }),
      ]);
      const qwenItems = qwenPayload.items || [];
      const fasttextItems = fasttextPayload.items || [];

      for (let index = 0; index < batch.length; index += 1) {
        batch[index].qwenLabel = qwenItems[index]?.label === "intervene" ? "intervene" : "ignore";
        batch[index].qwenReason = String(qwenItems[index]?.reason || "").trim();
        batch[index].fasttextLabel = fasttextItems[index]?.label === "intervene" ? "intervene" : "ignore";
        batch[index].fasttextConfidence = Number(fasttextItems[index]?.confidence || 0);
        batch[index].fasttextReason = String(fasttextItems[index]?.reason || "").trim();
      }
    }

    const report = {
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      config: DEFAULTS,
      sampling: {
        recentCode203Messages: records.length,
        selectedCount: selected.length,
        stressCount,
        controlCount,
      },
      metrics: computeMetrics(selected),
      stressMetrics: computeMetrics(selected.filter((item) => item.benchmarkType === "stress")),
      controlMetrics: computeMetrics(selected.filter((item) => item.benchmarkType === "control")),
      mismatches: selected.filter((item) => item.qwenLabel !== item.fasttextLabel),
      rows: selected,
    };

    const outputDir = path.join(process.cwd(), "runtime", "group-intent-qwen-stress-benchmark");
    fs.mkdirSync(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, `report-${timestampLabel(startedAt)}.json`);
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf-8");

    console.log(
      JSON.stringify(
        {
          outputPath,
          sampling: report.sampling,
          metrics: {
            ...report.metrics,
            accuracyPct: formatPercent(report.metrics.accuracy),
            precisionPct: formatPercent(report.metrics.precision),
            recallPct: formatPercent(report.metrics.recall),
            f1Pct: formatPercent(report.metrics.f1),
          },
          stressMetrics: {
            ...report.stressMetrics,
            recallPct: formatPercent(report.stressMetrics.recall),
            f1Pct: formatPercent(report.stressMetrics.f1),
          },
          controlMetrics: {
            ...report.controlMetrics,
            recallPct: formatPercent(report.controlMetrics.recall),
            f1Pct: formatPercent(report.controlMetrics.f1),
          },
          mismatches: report.mismatches.slice(0, 20).map((item) => ({
            benchmarkType: item.benchmarkType,
            qwenLabel: item.qwenLabel,
            fasttextLabel: item.fasttextLabel,
            fasttextConfidence: item.fasttextConfidence,
            text: item.text,
          })),
        },
        null,
        2
      )
    );
  } finally {
    await client.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
