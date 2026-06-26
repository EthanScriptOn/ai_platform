#!/usr/bin/env node

const path = require("path");
const mysqlRuntimeStore = require("../lib/mysql_runtime_store");

const dataDir = path.resolve(
  process.argv[2]
  || process.env.FLOWBOT_DATA_DIR
  || path.resolve(__dirname, "..", "..", "customer-bot-data"),
);

if (!mysqlRuntimeStore.isEnabled()) {
  console.error("FLOWBOT_STORAGE_BACKEND=mysql is required");
  process.exit(2);
}

try {
  const startedAt = Date.now();
  const result = mysqlRuntimeStore.importDataDir(dataDir);
  console.log(JSON.stringify({
    ok: true,
    dataDir,
    elapsedMs: Date.now() - startedAt,
    ...result,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    dataDir,
    error: String(error?.message || error),
  }, null, 2));
  process.exit(1);
}
