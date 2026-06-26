"use strict";

const fs = require("fs");

function loadConfigObjectIntoEnv(filePath, options = {}) {
  const encoding = options.encoding || "utf-8";
  if (!filePath || !fs.existsSync(filePath)) return false;
  const config = JSON.parse(fs.readFileSync(filePath, encoding));
  for (const [key, rawValue] of Object.entries(config || {})) {
    if (!key || process.env[key] !== undefined || rawValue == null) continue;
    if (Array.isArray(rawValue)) {
      process.env[key] = rawValue.join(",");
    } else if (typeof rawValue === "object") {
      process.env[key] = JSON.stringify(rawValue);
    } else {
      process.env[key] = String(rawValue);
    }
  }
  return true;
}

function loadEnvFile(filePath, options = {}) {
  const encoding = options.encoding || "utf-8";
  if (!filePath || !fs.existsSync(filePath)) return false;
  const lines = fs.readFileSync(filePath, encoding).split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIndex = line.indexOf("=");
    if (eqIndex <= 0) continue;
    const key = line.slice(0, eqIndex).trim();
    if (!key || process.env[key] !== undefined) continue;
    let value = line.slice(eqIndex + 1).trim();
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value.replace(/\\n/g, "\n");
  }
  return true;
}

module.exports = {
  loadConfigObjectIntoEnv,
  loadEnvFile,
};
