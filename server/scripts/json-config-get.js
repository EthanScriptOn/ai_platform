#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

function readJson(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    console.error(`invalid_json_config:${filePath}:${error.message}`);
    process.exit(2);
  }
}

function getByPath(input, dottedKey) {
  return String(dottedKey || "")
    .split(".")
    .filter(Boolean)
    .reduce((acc, key) => (acc && typeof acc === "object" ? acc[key] : undefined), input);
}

const [, , configPathArg, keyArg, defaultValue = ""] = process.argv;
const configPath = configPathArg ? path.resolve(configPathArg) : "";
const config = readJson(configPath);
const value = getByPath(config, keyArg);

if (value == null) {
  process.stdout.write(String(defaultValue));
} else if (Array.isArray(value)) {
  process.stdout.write(value.join(","));
} else if (typeof value === "object") {
  process.stdout.write(JSON.stringify(value));
} else {
  process.stdout.write(String(value));
}
