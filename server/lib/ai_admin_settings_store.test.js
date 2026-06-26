"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadRuntimeSettings } = require("./ai_admin_settings_store");

test("loadRuntimeSettings decodes multiline values returned as base64", () => {
  const publicKey = "-----BEGIN PUBLIC KEY-----\nabc123\n-----END PUBLIC KEY-----";
  const output = `RAGFLOW_LOGIN_PUBLIC_KEY\t${Buffer.from(publicKey, "utf8").toString("base64")}\n`;
  const settings = loadRuntimeSettings(["RAGFLOW_LOGIN_PUBLIC_KEY"], {
    env: {
      AI_ADMIN_STORAGE_BACKEND: "mysql",
      AI_ADMIN_MYSQL_DATABASE: "ai_admin",
      AI_ADMIN_MYSQL_USER: "user",
    },
    runMysql: (sql) => {
      if (/SELECT setting_key, REPLACE\(TO_BASE64/.test(sql)) return output;
      return "";
    },
  });

  assert.equal(settings.RAGFLOW_LOGIN_PUBLIC_KEY, publicKey);
});
