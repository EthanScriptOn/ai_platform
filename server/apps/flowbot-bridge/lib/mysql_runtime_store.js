const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const DEFAULT_LIMIT = 500;
const MAX_SQL_BYTES = 512 * 1024;

function isEnabled() {
  return String(process.env.FLOWBOT_STORAGE_BACKEND || "").trim().toLowerCase() === "mysql";
}

function getConfig() {
  return {
    host: String(process.env.FLOWBOT_MYSQL_HOST || "127.0.0.1").trim(),
    port: String(process.env.FLOWBOT_MYSQL_PORT || "3306").trim(),
    database: String(process.env.FLOWBOT_MYSQL_DATABASE || "").trim(),
    user: String(process.env.FLOWBOT_MYSQL_USER || "").trim(),
    password: String(process.env.FLOWBOT_MYSQL_PASSWORD || "").trim(),
    mysqlBin: String(process.env.FLOWBOT_MYSQL_BIN || "mysql").trim() || "mysql",
  };
}

function assertConfig(config = getConfig()) {
  if (!config.database || !config.user) {
    throw new Error("mysql_storage_config_missing");
  }
}

function sqlString(value) {
  if (value == null) {
    return "NULL";
  }
  return `'${String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\0/g, "\\0")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/\x1a/g, "\\Z")
    .replace(/'/g, "\\'")}'`;
}

function sqlDate(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "CURRENT_TIMESTAMP(3)";
  }
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) {
    return "CURRENT_TIMESTAMP(3)";
  }
  return sqlString(new Date(ts).toISOString().replace("T", " ").replace("Z", ""));
}

function runMysql(sql, { maxBuffer = 128 * 1024 * 1024 } = {}) {
  const config = getConfig();
  assertConfig(config);
  const result = spawnSync(
    config.mysqlBin,
    [
      "--protocol=TCP",
      "-h",
      config.host,
      "-P",
      config.port,
      "-u",
      config.user,
      "--batch",
      "--raw",
      "--skip-column-names",
      config.database,
    ],
    {
      input: sql,
      encoding: "utf8",
      maxBuffer,
      env: {
        ...process.env,
        MYSQL_PWD: config.password,
      },
    },
  );
  if (result.status !== 0) {
    if (result.error) {
      throw new Error(`mysql_storage_failed:${result.error.message || result.error}`);
    }
    const stderr = String(result.stderr || "").trim();
    throw new Error(`mysql_storage_failed:${stderr || result.signal || result.status}`);
  }
  return String(result.stdout || "");
}

let schemaReady = false;
const RUNTIME_SETTINGS_KEY = "flowbot_runtime_settings";

function ensureSchema() {
  if (!isEnabled() || schemaReady || String(process.env.FLOWBOT_MYSQL_AUTO_MIGRATE || "1") === "0") {
    return;
  }
  runMysql(`
CREATE TABLE IF NOT EXISTS flowbot_schema_migrations (
  version VARCHAR(64) NOT NULL,
  description VARCHAR(255) NOT NULL DEFAULT '',
  applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS flowbot_jsonl_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  stream_key VARCHAR(191) NOT NULL,
  event_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  trace_id VARCHAR(191) NOT NULL DEFAULT '',
  room_id VARCHAR(128) NOT NULL DEFAULT '',
  raw_json JSON NOT NULL,
  PRIMARY KEY (id),
  KEY idx_flowbot_jsonl_events_stream_id (stream_key, id),
  KEY idx_flowbot_jsonl_events_room_time (stream_key, room_id, event_time),
  KEY idx_flowbot_jsonl_events_trace (stream_key, trace_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE IF NOT EXISTS flowbot_kv_state (
  state_key VARCHAR(128) NOT NULL,
  state_value JSON DEFAULT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (state_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
INSERT INTO flowbot_schema_migrations (version, description)
VALUES ('20260520_002_jsonl_runtime_store', 'JSONL runtime stream storage')
ON DUPLICATE KEY UPDATE applied_at = applied_at;
`);
  schemaReady = true;
}

function makeRelativeKey(dataDir, filePath) {
  const root = path.resolve(dataDir);
  const target = path.resolve(filePath);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return path.basename(target);
  }
  return relative.split(path.sep).join("/");
}

function getEventTime(item = {}) {
  return item.eventTime
    || item.receivedAt
    || item.processedAt
    || item.updatedAt
    || item.createdAt
    || item.sendTimeIso
    || item.time
    || "";
}

function buildCallbackTraceId(payload = {}) {
  const data = payload?.data || {};
  return [
    payload?.guid || "no-guid",
    payload?.notify_type || "no-type",
    data?.roomid || "no-room",
    data?.seq || "no-seq",
    data?.id || "no-id",
  ].map((part) => String(part || "")).join(":");
}

function eventInsertSql(streamKey, item) {
  const rawJson = JSON.stringify(item == null ? null : item);
  const traceId = String(
    item?.traceId
    || item?.trace_id
    || item?.jsonBody?.traceId
    || (item?.jsonBody ? buildCallbackTraceId(item.jsonBody) : "")
    || "",
  ).trim();
  const roomId = String(
    item?.roomId
    || item?.room_id
    || item?.chat_id
    || item?.jsonBody?.data?.roomid
    || item?.jsonBody?.event?.message?.chat_id
    || "",
  ).trim();
  return `(${sqlString(streamKey)}, ${sqlDate(getEventTime(item))}, ${sqlString(traceId)}, ${sqlString(roomId)}, ${sqlString(rawJson)})`;
}

function appendJsonl(dataDir, filePath, item) {
  ensureSchema();
  const streamKey = makeRelativeKey(dataDir, filePath);
  runMysql(`
INSERT INTO flowbot_jsonl_events (stream_key, event_time, trace_id, room_id, raw_json)
VALUES ${eventInsertSql(streamKey, item)};
`);
}

function readJsonl(dataDir, filePath, limit = DEFAULT_LIMIT) {
  ensureSchema();
  const streamKey = makeRelativeKey(dataDir, filePath);
  const numericLimit = Number(limit);
  const finiteLimit = Number.isFinite(numericLimit) && numericLimit > 0 && numericLimit < Number.MAX_SAFE_INTEGER;
  const sql = finiteLimit
    ? `SELECT CAST(raw_json AS CHAR) FROM (
         SELECT id, raw_json FROM flowbot_jsonl_events
         WHERE stream_key = ${sqlString(streamKey)}
         ORDER BY id DESC
         LIMIT ${Math.max(1, Math.floor(numericLimit))}
       ) recent ORDER BY id ASC;`
    : `SELECT CAST(raw_json AS CHAR) FROM flowbot_jsonl_events
       WHERE stream_key = ${sqlString(streamKey)}
       ORDER BY id ASC;`;
  const output = runMysql(sql);
  return output.split("\n").filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter((item) => item != null);
}

function rewriteJsonl(dataDir, filePath, items) {
  ensureSchema();
  const streamKey = makeRelativeKey(dataDir, filePath);
  runMysql(`DELETE FROM flowbot_jsonl_events WHERE stream_key = ${sqlString(streamKey)};`);
  if (!items.length) {
    return;
  }
  let batch = [];
  let batchBytes = 0;
  const flush = () => {
    if (!batch.length) {
      return;
    }
    runMysql(`
INSERT INTO flowbot_jsonl_events (stream_key, event_time, trace_id, room_id, raw_json)
VALUES ${batch.join(",\n")};
`);
    batch = [];
    batchBytes = 0;
  };
  for (const item of items) {
    const row = eventInsertSql(streamKey, item);
    batch.push(row);
    batchBytes += Buffer.byteLength(row);
    if (batchBytes >= MAX_SQL_BYTES) {
      flush();
    }
  }
  flush();
}

function readJson(dataDir, filePath, fallback) {
  ensureSchema();
  const stateKey = makeRelativeKey(dataDir, filePath);
  const output = runMysql(
    `SELECT CAST(state_value AS CHAR) FROM flowbot_kv_state WHERE state_key = ${sqlString(stateKey)} LIMIT 1;`,
  ).trim();
  if (!output) {
    return fallback;
  }
  try {
    return JSON.parse(output);
  } catch {
    return fallback;
  }
}

function writeJson(dataDir, filePath, value) {
  ensureSchema();
  const stateKey = makeRelativeKey(dataDir, filePath);
  writeJsonKey(stateKey, value);
}

function writeJsonKey(stateKey, value) {
  ensureSchema();
  const rawJson = JSON.stringify(value == null ? null : value);
  runMysql(`
INSERT INTO flowbot_kv_state (state_key, state_value)
VALUES (${sqlString(stateKey)}, ${sqlString(rawJson)})
ON DUPLICATE KEY UPDATE state_value = VALUES(state_value);
`);
}

function deleteJson(dataDir, filePath) {
  ensureSchema();
  const stateKey = makeRelativeKey(dataDir, filePath);
  runMysql(`DELETE FROM flowbot_kv_state WHERE state_key = ${sqlString(stateKey)};`);
}

function readJsonKey(stateKey, fallback) {
  ensureSchema();
  if (!isEnabled()) return fallback;
  const output = runMysql(
    `SELECT CAST(state_value AS CHAR) FROM flowbot_kv_state WHERE state_key = ${sqlString(stateKey)} LIMIT 1;`,
  ).trim();
  if (!output) return fallback;
  try {
    return JSON.parse(output);
  } catch {
    return fallback;
  }
}

function readRuntimeSettings() {
  if (!isEnabled()) return {};
  try {
    return readJsonKey(RUNTIME_SETTINGS_KEY, {}) || {};
  } catch {
    return {};
  }
}

function writeRuntimeSettings(settings = {}) {
  if (!isEnabled()) {
    throw new Error("mysql_storage_disabled");
  }
  writeJsonKey(RUNTIME_SETTINGS_KEY, settings || {});
  return true;
}

function deleteJsonKey(stateKey) {
  ensureSchema();
  runMysql(`DELETE FROM flowbot_kv_state WHERE state_key = ${sqlString(stateKey)};`);
}

function listFiles(root, predicate) {
  const result = [];
  if (!fs.existsSync(root)) {
    return result;
  }
  const walk = (current) => {
    for (const name of fs.readdirSync(current)) {
      const target = path.join(current, name);
      const stat = fs.statSync(target);
      if (stat.isDirectory()) {
        if (name === "media") {
          continue;
        }
        walk(target);
      } else if (predicate(target)) {
        result.push(target);
      }
    }
  };
  walk(root);
  return result;
}

function replacePathPrefix(value, fromRoot, toRoot) {
  if (!fromRoot || !toRoot) {
    return value;
  }
  const from = path.resolve(fromRoot);
  const to = path.resolve(toRoot);
  if (typeof value === "string") {
    const normalized = path.resolve(value);
    if (normalized === from || normalized.startsWith(`${from}${path.sep}`)) {
      return path.join(to, path.relative(from, normalized));
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => replacePathPrefix(item, fromRoot, toRoot));
  }
  if (value && typeof value === "object") {
    const next = {};
    for (const [key, item] of Object.entries(value)) {
      next[key] = replacePathPrefix(item, fromRoot, toRoot);
    }
    return next;
  }
  return value;
}

function readArchiveJsonStates() {
  ensureSchema();
  const output = runMysql(`
SELECT state_key, CAST(state_value AS CHAR)
FROM flowbot_kv_state
WHERE state_key IN ('index.json', 'thread_index.json')
   OR state_key LIKE 'cases/%.json'
   OR state_key LIKE 'conversations/%.json'
   OR state_key LIKE 'threads/%.json'
ORDER BY state_key ASC;
`);
  const rows = [];
  for (const line of output.split("\n").filter(Boolean)) {
    const tabIndex = line.indexOf("\t");
    if (tabIndex < 0) {
      continue;
    }
    const stateKey = line.slice(0, tabIndex);
    const rawJson = line.slice(tabIndex + 1);
    try {
      rows.push({ stateKey, value: JSON.parse(rawJson) });
    } catch {}
  }
  return rows;
}

function exportArchiveArtifacts(dataDir, targetRoot) {
  ensureSchema();
  let exported = 0;
  for (const row of readArchiveJsonStates()) {
    const target = path.join(targetRoot, row.stateKey);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(replacePathPrefix(row.value, dataDir, targetRoot), null, 2)}\n`, "utf8");
    exported += 1;
  }
  return exported;
}

function importArchiveArtifacts(sourceRoot, dataDir) {
  ensureSchema();
  let imported = 0;
  for (const name of ["raw-messages.jsonl", "thread-events.jsonl", "issues.jsonl"]) {
    const target = path.join(sourceRoot, name);
    if (!fs.existsSync(target)) {
      continue;
    }
    const items = [];
    for (const line of fs.readFileSync(target, "utf8").split("\n").filter(Boolean)) {
      try {
        items.push(replacePathPrefix(JSON.parse(line), sourceRoot, dataDir));
      } catch {}
    }
    if (items.length) {
      for (const item of items) {
        appendJsonl(dataDir, path.join(dataDir, name), item);
      }
      imported += items.length;
    }
  }
  for (const name of ["index.json", "thread_index.json"]) {
    const target = path.join(sourceRoot, name);
    if (!fs.existsSync(target)) {
      continue;
    }
    try {
      writeJsonKey(name, replacePathPrefix(JSON.parse(fs.readFileSync(target, "utf8")), sourceRoot, dataDir));
      imported += 1;
    } catch {}
  }
  for (const dirName of ["cases", "conversations", "threads"]) {
    const dir = path.join(sourceRoot, dirName);
    for (const filePath of listFiles(dir, (target) => /\.json$/i.test(target))) {
      try {
        const stateKey = path.relative(sourceRoot, filePath).split(path.sep).join("/");
        writeJsonKey(stateKey, replacePathPrefix(JSON.parse(fs.readFileSync(filePath, "utf8")), sourceRoot, dataDir));
        imported += 1;
      } catch {}
    }
  }
  return imported;
}

function importDataDir(dataDir) {
  ensureSchema();
  const jsonlFiles = listFiles(dataDir, (filePath) => /\.jsonl$/i.test(filePath));
  const jsonFiles = listFiles(dataDir, (filePath) => /\.json$/i.test(filePath));
  let jsonlRows = 0;
  let jsonRows = 0;
  for (const filePath of jsonlFiles) {
    const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
    const items = [];
    for (const line of lines) {
      try {
        items.push(JSON.parse(line));
      } catch {}
    }
    rewriteJsonl(dataDir, filePath, items);
    jsonlRows += items.length;
  }
  for (const filePath of jsonFiles) {
    try {
      writeJson(dataDir, filePath, JSON.parse(fs.readFileSync(filePath, "utf8")));
      jsonRows += 1;
    } catch {}
  }
  return {
    jsonlFiles: jsonlFiles.length,
    jsonlRows,
    jsonFiles: jsonFiles.length,
    jsonRows,
  };
}

function syncJsonArtifacts(dataDir, relativeNames = []) {
  ensureSchema();
  let synced = 0;
  for (const name of relativeNames) {
    const target = path.join(dataDir, name);
    if (!fs.existsSync(target)) {
      continue;
    }
    try {
      writeJson(dataDir, target, JSON.parse(fs.readFileSync(target, "utf8")));
      synced += 1;
    } catch {}
  }
  for (const dirName of ["cases", "conversations", "threads"]) {
    const dir = path.join(dataDir, dirName);
    for (const filePath of listFiles(dir, (target) => /\.json$/i.test(target))) {
      try {
        writeJson(dataDir, filePath, JSON.parse(fs.readFileSync(filePath, "utf8")));
        synced += 1;
      } catch {}
    }
  }
  return synced;
}

module.exports = {
  isEnabled,
  ensureSchema,
  appendJsonl,
  readJsonl,
  rewriteJsonl,
  readJson,
  readJsonKey,
  readRuntimeSettings,
  writeJson,
  writeJsonKey,
  writeRuntimeSettings,
  deleteJson,
  deleteJsonKey,
  replacePathPrefix,
  exportArchiveArtifacts,
  importArchiveArtifacts,
  importDataDir,
  syncJsonArtifacts,
};
