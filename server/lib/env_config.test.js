"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { loadConfigObjectIntoEnv, loadEnvFile } = require("./env_config");

function withTempEnv(keys, fn) {
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of keys) {
        const value = previous.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

test("loadConfigObjectIntoEnv maps JSON values without overwriting existing env", async () => {
  await withTempEnv(["ENV_CONFIG_TEXT", "ENV_CONFIG_LIST", "ENV_CONFIG_OBJECT"], () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-config-test-"));
    const filePath = path.join(dir, "config.json");
    process.env.ENV_CONFIG_TEXT = "existing";
    fs.writeFileSync(filePath, JSON.stringify({
      ENV_CONFIG_TEXT: "next",
      ENV_CONFIG_LIST: ["a", "b"],
      ENV_CONFIG_OBJECT: { ok: true },
    }), "utf8");

    assert.equal(loadConfigObjectIntoEnv(filePath), true);
    assert.equal(process.env.ENV_CONFIG_TEXT, "existing");
    assert.equal(process.env.ENV_CONFIG_LIST, "a,b");
    assert.equal(process.env.ENV_CONFIG_OBJECT, JSON.stringify({ ok: true }));
  });
});

test("loadEnvFile supports quoted values and escaped newlines", async () => {
  await withTempEnv(["ENV_FILE_TOKEN", "ENV_FILE_MULTILINE"], () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-file-test-"));
    const filePath = path.join(dir, "local.env");
    fs.writeFileSync(filePath, [
      "# comment",
      "ENV_FILE_TOKEN='abc'",
      "ENV_FILE_MULTILINE=\"line1\\nline2\"",
    ].join("\n"), "utf8");

    assert.equal(loadEnvFile(filePath), true);
    assert.equal(process.env.ENV_FILE_TOKEN, "abc");
    assert.equal(process.env.ENV_FILE_MULTILINE, "line1\nline2");
  });
});
