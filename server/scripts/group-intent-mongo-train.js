#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { MongoClient, ObjectId } = require("mongodb");
const execFileAsync = promisify(execFile);

const DEFAULTS = {
  mongoUri:
    process.env.MONGO_URI ||
    "mongodb://pro_rw:facai%40188@dds-m5e25dbbf852d4941.mongodb.rds.aliyuncs.com:3717,dds-m5e25dbbf852d4942.mongodb.rds.aliyuncs.com:3717/admin?replicaSet=mgset-92139473&authSource=admin",
  mongoDb: process.env.MONGO_DB || "wechat",
  mongoCollection: process.env.MONGO_COLLECTION || "normal",
  qwenLabelUrl: process.env.GROUP_INTENT_QWEN_LABEL_URL || "http://47.104.81.250/api/group-intent/qwen-label",
  trainUrl: process.env.GROUP_INTENT_TRAIN_URL || "http://47.104.81.250/api/group-intent/train",
  recentDocLimit: Number(process.env.GROUP_INTENT_RECENT_DOC_LIMIT || 4000),
  sampleSize: Number(process.env.GROUP_INTENT_SAMPLE_SIZE || 150),
  batchSize: Number(process.env.GROUP_INTENT_BATCH_SIZE || 5),
  maxPerGroup: Number(process.env.GROUP_INTENT_MAX_PER_GROUP || 4),
  cursorOverlapMs: Number(process.env.GROUP_INTENT_CURSOR_OVERLAP_MS || 300000),
  futureCursorToleranceMs: Number(process.env.GROUP_INTENT_FUTURE_CURSOR_TOLERANCE_MS || 300000),
  maxRecentProcessedIds: Number(process.env.GROUP_INTENT_MAX_RECENT_IDS || 3000),
  mongoQueryRetryCount: Number(process.env.GROUP_INTENT_MONGO_QUERY_RETRY_COUNT || 3),
  mongoQueryRetryDelayMs: Number(process.env.GROUP_INTENT_MONGO_QUERY_RETRY_DELAY_MS || 2000),
  mongoFetcher: String(process.env.GROUP_INTENT_MONGO_FETCHER || "python").trim().toLowerCase(),
  requestRetryCount: Number(process.env.GROUP_INTENT_REQUEST_RETRY_COUNT || 3),
  requestRetryDelayMs: Number(process.env.GROUP_INTENT_REQUEST_RETRY_DELAY_MS || 3000),
  requestTimeoutMs: Number(process.env.GROUP_INTENT_REQUEST_TIMEOUT_MS || 60000),
  statePath: String(process.env.GROUP_INTENT_STATE_PATH || "").trim(),
  candidateOnly: String(process.env.GROUP_INTENT_CANDIDATE_ONLY || "").trim() === "1",
  dryRun: String(process.env.GROUP_INTENT_DRY_RUN || "").trim() === "1",
};

const CANDIDATE_PATTERNS = [
  { pattern: /(求推荐|求链接|给个链接|发个链接|这款怎么买|怎么买|怎么拍|拍哪项|拍哪个|怎么买最划算)/, score: 5 },
  { pattern: /(值得买吗|能不能买|可以买|还想买|想买个|想入|准备买|要买|补货|补个|再囤点|囤点)/, score: 5 },
  { pattern: /(哪个系列|哪款|哪个|合适吗|适合.*吗|有货吗|没货|搜不到|选哪个|哪个好)/, score: 4 },
  { pattern: /(券怎么领|怎么抢|有券吗|券呢|好价|最低价|更好的价格|价格出来|红包|会员价|划算|凑单)/, score: 4 },
  { pattern: /(拼单|一起拼|跟一单|缺个凑单|还差个|缺个|预留名额|有没人一起|有人一起拼)/, score: 4 },
  { pattern: /(贵吗|便宜吗|显瘦|好看吗|那.*套装呢|一体的啊|来活动|又可以了吗|开团了吗|还有活动吗|出售|有需要联系)/, score: 3 },
  { pattern: /(想|买|求|推荐|链接|口令|下单|有没有|会员|口味)/, score: 1 },
];

function computeCandidateScore(text = "") {
  const value = String(text || "").trim();
  if (!value) return 0;
  return CANDIDATE_PATTERNS.reduce((total, rule) => (rule.pattern.test(value) ? total + rule.score : total), 0);
}

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
    candidateScore: computeCandidateScore(text),
    candidateLike: computeCandidateScore(text) > 0,
  };
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

function chunk(items = [], size = 10) {
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

function ensureParentDir(filePath = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function loadState(statePath = "") {
  if (!statePath || !fs.existsSync(statePath)) {
    return { lastRequestTime: "", lastObjectId: "", recentProcessedIds: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    const recentProcessedIds = Array.isArray(parsed.recentProcessedIds)
      ? parsed.recentProcessedIds.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
    const explicitLastObjectId = String(parsed.lastObjectId || "").trim();
    const derivedLastObjectId = ObjectId.isValid(explicitLastObjectId)
      ? explicitLastObjectId
      : [...recentProcessedIds].filter((item) => ObjectId.isValid(item)).sort().pop() || "";
    return {
      lastRequestTime: String(parsed.lastRequestTime || "").trim(),
      lastObjectId: derivedLastObjectId,
      recentProcessedIds,
    };
  } catch {
    return { lastRequestTime: "", lastObjectId: "", recentProcessedIds: [] };
  }
}

function saveState(statePath = "", state = {}) {
  ensureParentDir(statePath);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
}

function writeTrainReport(outputDir = "", startedAt = new Date(), report = {}) {
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `train-${timestampLabel(startedAt)}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf-8");
  return outputPath;
}

function buildIncrementalQuery(state = {}) {
  const lastObjectId = String(state.lastObjectId || "").trim();
  if (ObjectId.isValid(lastObjectId)) {
    return {
      query: {
        _id: {
          $gt: new ObjectId(lastObjectId),
        },
      },
      cursorMode: "object_id",
      sort: { _id: 1 },
    };
  }

  const lastMs = Date.parse(state.lastRequestTime || "");
  if (!Number.isFinite(lastMs)) {
    return {
      query: {},
      cursorMode: "recent_window_fallback",
      sort: { request_time: -1, _id: -1 },
    };
  }

  if (lastMs > Date.now() + Math.max(0, DEFAULTS.futureCursorToleranceMs)) {
    return {
      query: {},
      cursorMode: "future_time_fallback",
      sort: { request_time: -1, _id: -1 },
    };
  }

  return {
    query: {
      request_time: {
        $gte: new Date(lastMs - Math.max(0, DEFAULTS.cursorOverlapMs)),
      },
    },
    cursorMode: "request_time",
    sort: { request_time: 1, _id: 1 },
  };
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

async function labelBatchWithFallback(batch = [], batchErrors = []) {
  if (!batch.length) return [];
  const input = batch.map((item) => item.text).join("\n");
  try {
    const qwenPayload = await postJson(DEFAULTS.qwenLabelUrl, { input });
    const qwenItems = Array.isArray(qwenPayload.items) ? qwenPayload.items : [];
    return batch.map((source, index) => ({
      sampleId: source.id,
      speaker: source.sender,
      text: source.text,
      raw: source.text,
      label: qwenItems[index]?.label === "intervene" ? "intervene" : "ignore",
      reason: String(qwenItems[index]?.reason || "").trim(),
      groupId: source.groupId,
      wxId: source.wxId,
      requestTime: source.requestTime,
    }));
  } catch (error) {
    if (batch.length === 1) {
      batchErrors.push({
        sampleId: batch[0].id,
        text: batch[0].text,
        error: serializeError(error),
      });
      return [];
    }
    const midpoint = Math.ceil(batch.length / 2);
    const left = await labelBatchWithFallback(batch.slice(0, midpoint), batchErrors);
    const right = await labelBatchWithFallback(batch.slice(midpoint), batchErrors);
    return [...left, ...right];
  }
}

function isRetryableMongoError(error) {
  const message = String(error?.message || "");
  return /MongoNetworkTimeoutError|timed out|ECONNRESET|ETIMEDOUT|connection .* closed/i.test(message);
}

async function runMongoQuery(task) {
  let lastError = null;
  for (let attempt = 1; attempt <= Math.max(1, DEFAULTS.mongoQueryRetryCount); attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      const shouldRetry = attempt < DEFAULTS.mongoQueryRetryCount && isRetryableMongoError(error);
      if (!shouldRetry) throw error;
      await sleep(DEFAULTS.mongoQueryRetryDelayMs * attempt);
    }
  }
  throw lastError;
}

function buildPythonCursorConfig(state = {}, cursorConfig = {}) {
  return {
    mode: String(cursorConfig.cursorMode || "recent_window_fallback"),
    lastRequestTime: String(state.lastRequestTime || "").trim(),
    lastObjectId: String(state.lastObjectId || "").trim(),
    recentDocLimit: DEFAULTS.recentDocLimit,
    cursorOverlapMs: DEFAULTS.cursorOverlapMs,
  };
}

async function fetchDocsViaPython(state = {}, cursorConfig = {}) {
  const pythonCode = `
import json, os
from datetime import datetime, timedelta
from pymongo import MongoClient
from bson import ObjectId

cfg = json.loads(os.environ["GROUP_INTENT_PY_FETCH_CONFIG"])
client = MongoClient(
    os.environ["GROUP_INTENT_MONGO_URI"],
    authMechanism="SCRAM-SHA-256",
    serverSelectionTimeoutMS=10000,
    socketTimeoutMS=120000,
    connectTimeoutMS=10000,
    maxPoolSize=2,
    minPoolSize=0,
)
col = client[os.environ["GROUP_INTENT_MONGO_DB"]][os.environ["GROUP_INTENT_MONGO_COLLECTION"]]

query = {}
mode = cfg.get("mode") or "recent_window_fallback"
if mode == "object_id" and cfg.get("lastObjectId"):
    query = {"_id": {"$gt": ObjectId(cfg["lastObjectId"])}}
    sort = [("_id", 1)]
elif mode == "request_time" and cfg.get("lastRequestTime"):
    iso = cfg["lastRequestTime"]
    fmt = "%Y-%m-%dT%H:%M:%S.%fZ" if "." in iso else "%Y-%m-%dT%H:%M:%SZ"
    dt = datetime.strptime(iso, fmt) - timedelta(milliseconds=max(0, int(cfg.get("cursorOverlapMs") or 0)))
    query = {"request_time": {"$gte": dt}}
    sort = [("request_time", 1), ("_id", 1)]
else:
    sort = [("request_time", -1), ("_id", -1)]

projection = {"_id": 1, "code": 1, "request_time": 1, "wxId": 1, "request": 1}
docs = list(col.find(query, projection).sort(sort).limit(int(cfg.get("recentDocLimit") or 4000)))

def normalize(doc):
    doc["_id"] = str(doc.get("_id") or "")
    rt = doc.get("request_time")
    if hasattr(rt, "isoformat"):
        doc["request_time"] = rt.isoformat() + "Z"
    return doc

print(json.dumps([normalize(doc) for doc in docs], ensure_ascii=False, default=str))
`.trim();

  const { stdout } = await execFileAsync("python3", ["-c", pythonCode], {
    maxBuffer: 50 * 1024 * 1024,
    env: {
      ...process.env,
      GROUP_INTENT_PY_FETCH_CONFIG: JSON.stringify(buildPythonCursorConfig(state, cursorConfig)),
      GROUP_INTENT_MONGO_URI: DEFAULTS.mongoUri,
      GROUP_INTENT_MONGO_DB: DEFAULTS.mongoDb,
      GROUP_INTENT_MONGO_COLLECTION: DEFAULTS.mongoCollection,
    },
  });
  return JSON.parse(String(stdout || "[]"));
}

async function main() {
  const outputDir = path.join(process.cwd(), "runtime", "group-intent-mongo-train");
  const statePath = DEFAULTS.statePath || path.join(outputDir, "state.json");
  const state = loadState(statePath);
  const shouldUsePythonFetcher = DEFAULTS.mongoFetcher !== "node";
  const client = shouldUsePythonFetcher
    ? null
    : new MongoClient(DEFAULTS.mongoUri, {
        authMechanism: "SCRAM-SHA-256",
        serverSelectionTimeoutMS: 10000,
        socketTimeoutMS: 120000,
        connectTimeoutMS: 10000,
        maxPoolSize: 2,
        minPoolSize: 0,
      });
  const startedAt = new Date();
  const groups = new Map();
  let docs = [];
  let cursorConfig = null;
  let recentRecords = [];
  let groupSummaries = [];
  let excludedGroups = new Set();
  let eligibleRecords = [];
  let candidateLikeCount = 0;
  let sampled = [];
  let labeledItems = [];
  let labelBatchErrors = [];
  let trainResult = null;

  try {
    cursorConfig = buildIncrementalQuery(state);
    docs = shouldUsePythonFetcher
      ? await fetchDocsViaPython(state, cursorConfig)
      : await (async () => {
          await client.connect();
          const collection = client.db(DEFAULTS.mongoDb).collection(DEFAULTS.mongoCollection);
          return runMongoQuery(() =>
            collection
              .find(cursorConfig.query, {
                projection: {
                  _id: 1,
                  code: 1,
                  request_time: 1,
                  wxId: 1,
                  request: 1,
                },
              })
              .sort(cursorConfig.sort)
              .limit(DEFAULTS.recentDocLimit)
              .toArray()
          );
        })();

    const recentProcessedIds = new Set(state.recentProcessedIds || []);
    recentRecords = docs
      .filter((doc) => Number(doc.code || 0) === 203)
      .map(buildMessageRecord)
      .filter(Boolean)
      .filter((item) => !recentProcessedIds.has(item.id));

    for (const record of recentRecords) {
      const list = groups.get(record.groupId) || [];
      list.push(record);
      groups.set(record.groupId, list);
    }

    groupSummaries = [...groups.values()].map(summarizeGroup);
    excludedGroups = new Set(groupSummaries.filter(shouldExcludeGroup).map((item) => item.groupId));
    eligibleRecords = [...groups.entries()]
      .filter(([groupId]) => !excludedGroups.has(groupId))
      .flatMap(([, records]) => records)
      .filter((record) => record.text.length >= 2 && record.text.length <= 120);
    candidateLikeCount = eligibleRecords.filter((record) => record.candidateLike).length;

    sampled = [];
    const seenTexts = new Set();
    const sortedGroups = [...groups.entries()]
      .filter(([groupId]) => !excludedGroups.has(groupId))
      .sort((a, b) => b[1].length - a[1].length);

    for (const [, records] of sortedGroups) {
      let taken = 0;
      const rankedRecords = records
        .slice()
        .sort((a, b) => {
          if ((b.candidateScore || 0) !== (a.candidateScore || 0)) return (b.candidateScore || 0) - (a.candidateScore || 0);
          if (Number(Boolean(a.promoLike)) !== Number(Boolean(b.promoLike))) return Number(Boolean(a.promoLike)) - Number(Boolean(b.promoLike));
          return a.text.length - b.text.length;
        });
      for (const record of rankedRecords) {
        if (sampled.length >= DEFAULTS.sampleSize) break;
        if (taken >= DEFAULTS.maxPerGroup) break;
        if (record.text.length < 2 || record.text.length > 120) continue;
        if (DEFAULTS.candidateOnly && !record.candidateLike) continue;
        if (seenTexts.has(record.text)) continue;
        seenTexts.add(record.text);
        sampled.push(record);
        taken += 1;
      }
      if (sampled.length >= DEFAULTS.sampleSize) break;
    }

    labeledItems = [];
    for (const batch of chunk(sampled, DEFAULTS.batchSize)) {
      const labeledBatch = await labelBatchWithFallback(batch, labelBatchErrors);
      for (const item of labeledBatch) {
        labeledItems.push({ ...item, index: labeledItems.length });
      }
    }

    if (labeledItems.length && !DEFAULTS.dryRun) {
      trainResult = await postJson(DEFAULTS.trainUrl, { items: labeledItems });
    }

    const labelCounts = labeledItems.reduce(
      (acc, item) => {
        acc[item.label] = (acc[item.label] || 0) + 1;
        return acc;
      },
      { intervene: 0, ignore: 0 }
    );

    const report = {
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      config: DEFAULTS,
      statePath,
      previousState: state,
      cursor: {
        mode: cursorConfig.cursorMode,
        query: cursorConfig.query,
        sort: cursorConfig.sort,
        fetcher: shouldUsePythonFetcher ? "python" : "node",
      },
      sampling: {
        recentCode203Messages: recentRecords.length,
        totalGroups: groupSummaries.length,
        excludedGroupCount: excludedGroups.size,
        eligibleMessageCount: eligibleRecords.length,
        candidateLikeCount,
        candidateOnlyEnabled: DEFAULTS.candidateOnly,
        sampledMessageCount: labeledItems.length,
        rawFetchedDocCount: docs.length,
      },
      labelCounts,
      labelBatchErrors,
      trainResult,
      excludedGroups: groupSummaries
        .filter((item) => excludedGroups.has(item.groupId))
        .sort((a, b) => b.totalMessages - a.totalMessages)
        .slice(0, 30),
      samplePreview: labeledItems.slice(0, 50),
    };

    const outputPath = writeTrainReport(outputDir, startedAt, report);
    const mergedIds =
      labelBatchErrors.length === 0
        ? [...new Set([...(state.recentProcessedIds || []), ...recentRecords.map((item) => item.id)])]
        : [...new Set([...(state.recentProcessedIds || []), ...labeledItems.map((item) => item.sampleId)])];

    if (docs.length) {
      const nextState = {
        lastRequestTime: String(state.lastRequestTime || "").trim(),
        lastObjectId: String(state.lastObjectId || "").trim(),
        recentProcessedIds: mergedIds.slice(-DEFAULTS.maxRecentProcessedIds),
        lastReportPath: outputPath,
        lastRunAt: new Date().toISOString(),
      };
      if (labelBatchErrors.length === 0) {
        const latestDocTime = new Date(
          Math.max(...docs.map((item) => new Date(item.request_time || 0).getTime()).filter(Number.isFinite))
        ).toISOString();
        const latestObjectId = docs
          .map((item) => String(item?._id || "").trim())
          .filter((item) => ObjectId.isValid(item))
          .sort()
          .pop();
        nextState.lastRequestTime = latestDocTime;
        nextState.lastObjectId = latestObjectId || nextState.lastObjectId;
      }
      saveState(statePath, nextState);
    }

    console.log(
      JSON.stringify(
        {
          outputPath,
          statePath,
          sampledMessageCount: report.sampling.sampledMessageCount,
          labelCounts,
          labelBatchErrorCount: labelBatchErrors.length,
          trainResult,
        },
        null,
        2
      )
    );
  } catch (error) {
    const labelCounts = labeledItems.reduce(
      (acc, item) => {
        acc[item.label] = (acc[item.label] || 0) + 1;
        return acc;
      },
      { intervene: 0, ignore: 0 }
    );
    const failedReport = {
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      status: "failed",
      config: DEFAULTS,
      statePath,
      previousState: state,
      cursor: cursorConfig
        ? {
            mode: cursorConfig.cursorMode,
            query: cursorConfig.query,
            sort: cursorConfig.sort,
            fetcher: shouldUsePythonFetcher ? "python" : "node",
          }
        : null,
      sampling: {
        recentCode203Messages: recentRecords.length,
        totalGroups: groupSummaries.length,
        excludedGroupCount: excludedGroups.size,
        eligibleMessageCount: eligibleRecords.length,
        candidateLikeCount,
        candidateOnlyEnabled: DEFAULTS.candidateOnly,
        sampledMessageCount: labeledItems.length,
        sampledAttemptCount: sampled.length,
        rawFetchedDocCount: docs.length,
      },
      labelCounts,
      labelBatchErrors,
      trainResult,
      samplePreview: labeledItems.slice(0, 50),
      error: serializeError(error),
    };
    const outputPath = writeTrainReport(outputDir, startedAt, failedReport);
    saveState(statePath, {
      lastRequestTime: String(state.lastRequestTime || "").trim(),
      lastObjectId: String(state.lastObjectId || "").trim(),
      recentProcessedIds: [...new Set([...(state.recentProcessedIds || []), ...labeledItems.map((item) => item.sampleId)])].slice(
        -DEFAULTS.maxRecentProcessedIds
      ),
      lastReportPath: outputPath,
      lastRunAt: new Date().toISOString(),
      lastError: serializeError(error),
    });
    throw error;
  } finally {
    if (client) await client.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
