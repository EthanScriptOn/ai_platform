"use strict";

const childProcess = require("child_process");

function sqlString(value) {
  if (value == null) return "NULL";
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
  const timestamp = Date.parse(String(value || ""));
  if (!Number.isFinite(timestamp)) return "CURRENT_TIMESTAMP(3)";
  return sqlString(new Date(timestamp).toISOString().replace("T", " ").replace("Z", ""));
}

function createMysqlCli({
  bin = "mysql",
  host = "127.0.0.1",
  port = "3306",
  database = "",
  user = "",
  password = "",
  spawnSync = childProcess.spawnSync,
} = {}) {
  function runMysql(sql, { maxBuffer = 64 * 1024 * 1024 } = {}) {
    if (!database || !user) {
      throw new Error("ai_admin_mysql_config_missing");
    }
    const result = spawnSync(
      bin,
      [
        "--protocol=TCP",
        "-h",
        host,
        "-P",
        port,
        "-u",
        user,
        "--batch",
        "--raw",
        "--skip-column-names",
        database,
      ],
      {
        input: sql,
        encoding: "utf8",
        maxBuffer,
        env: {
          ...process.env,
          MYSQL_PWD: password,
        },
      }
    );
    if (result.status !== 0) {
      if (result.error) throw new Error(`ai_admin_mysql_failed:${result.error.message || result.error}`);
      throw new Error(`ai_admin_mysql_failed:${String(result.stderr || result.signal || result.status).trim()}`);
    }
    return String(result.stdout || "");
  }

  return { runMysql };
}

module.exports = {
  createMysqlCli,
  sqlDate,
  sqlString,
};
