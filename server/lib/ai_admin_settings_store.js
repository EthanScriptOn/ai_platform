"use strict";

const childProcess = require("child_process");
const { sqlString } = require("./mysql_cli");

const RAGFLOW_SETTING_KEYS = [
  "RAGFLOW_BASE_URL",
  "RAGFLOW_CHAT_URL",
  "RAGFLOW_AGENT_ID",
  "RAGFLOW_DATASET_ID",
  "RAGFLOW_STATE_FILE",
  "RAGFLOW_SHARE_AUTH",
  "RAGFLOW_LOGIN_EMAIL",
  "RAGFLOW_LOGIN_PASSWORD",
  "RAGFLOW_LOGIN_PUBLIC_KEY",
  "QWEN_API_KEY",
  "DASHSCOPE_API_KEY",
  "QWEN_API_URL",
  "PERSONA_DISTILL_REVIEW_MODEL",
];

function isMysqlSettingsEnabled(env = process.env) {
  return String(env.AI_ADMIN_STORAGE_BACKEND || "").trim().toLowerCase() === "mysql"
    && String(env.AI_ADMIN_MYSQL_DATABASE || "").trim()
    && String(env.AI_ADMIN_MYSQL_USER || "").trim();
}

function runSettingsMysql(sql, env = process.env, { maxBuffer = 8 * 1024 * 1024 } = {}) {
  const bin = String(env.AI_ADMIN_MYSQL_BIN || "mysql").trim() || "mysql";
  const host = String(env.AI_ADMIN_MYSQL_HOST || "127.0.0.1").trim();
  const port = String(env.AI_ADMIN_MYSQL_PORT || "3306").trim();
  const database = String(env.AI_ADMIN_MYSQL_DATABASE || "").trim();
  const user = String(env.AI_ADMIN_MYSQL_USER || "").trim();
  const password = String(env.AI_ADMIN_MYSQL_PASSWORD || "");
  if (!database || !user) {
    throw new Error("ai_admin_mysql_config_missing");
  }
  const result = childProcess.spawnSync(
    bin,
    ["--protocol=TCP", "-h", host, "-P", port, "-u", user, "--batch", "--raw", "--skip-column-names", database],
    {
      input: sql,
      encoding: "utf8",
      maxBuffer,
      env: { ...env, MYSQL_PWD: password },
    },
  );
  if (result.status !== 0) {
    if (result.error) throw new Error(`ai_admin_mysql_failed:${result.error.message || result.error}`);
    throw new Error(`ai_admin_mysql_failed:${String(result.stderr || result.signal || result.status).trim()}`);
  }
  return String(result.stdout || "");
}

function ensureRuntimeSettingsSchema({ runMysql } = {}) {
  const exec = runMysql || ((sql) => runSettingsMysql(sql));
  exec(`
CREATE TABLE IF NOT EXISTS ai_admin_runtime_settings (
  setting_key VARCHAR(128) NOT NULL,
  setting_value TEXT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`);
}

function loadRuntimeSettings(keys = RAGFLOW_SETTING_KEYS, { env = process.env, runMysql } = {}) {
  if (!isMysqlSettingsEnabled(env)) return {};
  try {
    ensureRuntimeSettingsSchema({ runMysql: runMysql || ((sql) => runSettingsMysql(sql, env)) });
    const keyList = keys.map((key) => sqlString(key)).join(",");
    if (!keyList) return {};
    const output = (runMysql || ((sql) => runSettingsMysql(sql, env)))(
      `SELECT setting_key, REPLACE(TO_BASE64(setting_value), '\n', '') FROM ai_admin_runtime_settings WHERE setting_key IN (${keyList});`,
    );
    const result = {};
    for (const line of output.split("\n").filter(Boolean)) {
      const index = line.indexOf("\t");
      if (index < 0) continue;
      const encodedValue = line.slice(index + 1);
      result[line.slice(0, index)] = Buffer.from(encodedValue, "base64").toString("utf8");
    }
    return result;
  } catch {
    return {};
  }
}

function saveRuntimeSettings(settings = {}, { runMysql } = {}) {
  const entries = Object.entries(settings)
    .map(([key, value]) => [String(key || "").trim(), String(value ?? "").trim()])
    .filter(([key]) => key);
  const exec = runMysql || ((sql) => runSettingsMysql(sql));
  ensureRuntimeSettingsSchema({ runMysql: exec });
  if (!entries.length) return 0;
  const values = entries
    .map(([key, value]) => `(${sqlString(key)}, ${sqlString(value)})`)
    .join(",\n");
  exec(`
INSERT INTO ai_admin_runtime_settings (setting_key, setting_value)
VALUES ${values}
ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value);
`);
  return entries.length;
}

module.exports = {
  RAGFLOW_SETTING_KEYS,
  ensureRuntimeSettingsSchema,
  isMysqlSettingsEnabled,
  loadRuntimeSettings,
  saveRuntimeSettings,
};
