#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const DEFAULTS = {
  mongoUri:
    process.env.MONGO_URI ||
    "mongodb://pro_rw:facai%40188@dds-m5e25dbbf852d4941.mongodb.rds.aliyuncs.com:3717,dds-m5e25dbbf852d4942.mongodb.rds.aliyuncs.com:3717/admin?replicaSet=mgset-92139473&authSource=admin",
  mongoDb: process.env.MONGO_DB || "wechat",
  mongoCollection: process.env.MONGO_COLLECTION || "normal",
  statePath: String(process.env.GROUP_INTENT_STATE_PATH || "").trim(),
  latestLimit: Number(process.env.GROUP_INTENT_STATUS_LATEST_LIMIT || 8),
};

function loadState(statePath = "") {
  if (!statePath || !fs.existsSync(statePath)) {
    return { lastRequestTime: "", lastObjectId: "", recentProcessedIds: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    const recentProcessedIds = Array.isArray(parsed.recentProcessedIds)
      ? parsed.recentProcessedIds.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
    const lastObjectId =
      String(parsed.lastObjectId || "").trim() ||
      [...recentProcessedIds].filter((item) => /^[a-f0-9]{24}$/i.test(item)).sort().pop() ||
      "";
    return {
      lastRequestTime: String(parsed.lastRequestTime || "").trim(),
      lastObjectId,
      recentProcessedIds,
      lastRunAt: String(parsed.lastRunAt || "").trim(),
      lastReportPath: String(parsed.lastReportPath || "").trim(),
      lastError: parsed.lastError || null,
    };
  } catch {
    return { lastRequestTime: "", lastObjectId: "", recentProcessedIds: [] };
  }
}

async function main() {
  const outputDir = path.join(process.cwd(), "runtime", "group-intent-mongo-train");
  const statePath = DEFAULTS.statePath || path.join(outputDir, "state.json");
  const state = loadState(statePath);
  const pythonCode = `
import json, os
from pymongo import MongoClient
from bson import ObjectId

cfg = json.loads(os.environ["GROUP_INTENT_STATUS_CONFIG"])
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

last_oid = cfg.get("lastObjectId") or ""
query = {"_id": {"$gt": ObjectId(last_oid)}} if last_oid else {}
query_203 = dict(query)
query_203.update({"code": 203, "request.data.toUserName": {"$regex": "@chatroom$"}})

def shape(doc):
    request = doc.get("request") or {}
    if isinstance(request, list):
        request = request[0] if request and isinstance(request[0], dict) else {}
    data = request.get("data") or {}
    if isinstance(data, list):
        data = data[0] if data and isinstance(data[0], dict) else {}
    return {
        "_id": str(doc.get("_id") or ""),
        "request_time": str(doc.get("request_time") or ""),
        "code": doc.get("code"),
        "toUserName": data.get("toUserName"),
        "type": data.get("type"),
        "text": (data.get("msgContent") or data.get("content") or "")[:120],
    }

latest_docs = [
    shape(doc)
    for doc in col.find(query, {"_id":1,"request_time":1,"code":1,"request.data.toUserName":1,"request.data.msgContent":1,"request.data.content":1,"request.data.type":1})
        .sort([("_id", -1)])
        .limit(int(cfg.get("latestLimit") or 8))
]

latest_group_203 = [
    shape(doc)
    for doc in col.find(query_203, {"_id":1,"request_time":1,"code":1,"request.data.toUserName":1,"request.data.msgContent":1,"request.data.content":1,"request.data.type":1})
        .sort([("_id", -1)])
        .limit(int(cfg.get("latestLimit") or 8))
]

print(json.dumps({
    "lastObjectId": last_oid,
    "lastRequestTime": cfg.get("lastRequestTime") or "",
    "lastRunAt": cfg.get("lastRunAt") or "",
    "lastReportPath": cfg.get("lastReportPath") or "",
    "lastError": cfg.get("lastError"),
    "latestDocsAfterCursor": latest_docs,
    "latestGroup203AfterCursor": latest_group_203,
}, ensure_ascii=False))
`.trim();

  const { stdout } = await execFileAsync("python3", ["-c", pythonCode], {
    maxBuffer: 20 * 1024 * 1024,
    env: {
      ...process.env,
      GROUP_INTENT_STATUS_CONFIG: JSON.stringify({
        lastObjectId: state.lastObjectId,
        lastRequestTime: state.lastRequestTime,
        lastRunAt: state.lastRunAt,
        lastReportPath: state.lastReportPath,
        lastError: state.lastError,
        latestLimit: DEFAULTS.latestLimit,
      }),
      GROUP_INTENT_MONGO_URI: DEFAULTS.mongoUri,
      GROUP_INTENT_MONGO_DB: DEFAULTS.mongoDb,
      GROUP_INTENT_MONGO_COLLECTION: DEFAULTS.mongoCollection,
    },
  });

  console.log(JSON.stringify(JSON.parse(String(stdout || "{}")), null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
