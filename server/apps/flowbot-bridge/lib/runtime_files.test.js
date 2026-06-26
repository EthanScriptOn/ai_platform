"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createRuntimeFileStore } = require("./runtime_files");

function createMysqlStore(overrides = {}) {
  return {
    deleteJson() {},
    isEnabled: () => false,
    readJson: () => undefined,
    readJsonl: () => [],
    rewriteJsonl() {},
    writeJson() {},
    ...overrides,
  };
}

function createStore({ mysqlRuntimeStore = createMysqlStore(), onInvalidate = () => {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flowbot-runtime-files-test-"));
  return {
    dir,
    store: createRuntimeFileStore({
      DATA_DIR: dir,
      DASHBOARD_DEFAULT_LIMIT: 2,
      mysqlRuntimeStore,
      onInvalidate,
    }),
  };
}

test("json files read fallback, write formatted json, and invalidate local caches", () => {
  const invalidated = [];
  const { dir, store } = createStore({ onInvalidate: (filePath) => invalidated.push(filePath) });
  const filePath = path.join(dir, "state.json");

  assert.deepEqual(store.readJsonFile(filePath, { missing: true }), { missing: true });

  store.writeJsonFile(filePath, { ok: true });

  assert.deepEqual(store.readJsonFile(filePath, null), { ok: true });
  assert.equal(fs.readFileSync(filePath, "utf8"), "{\n  \"ok\": true\n}\n");
  assert.deepEqual(invalidated, [filePath]);
});

test("jsonl disk reader returns last items and skips malformed lines", () => {
  const { dir, store } = createStore();
  const filePath = path.join(dir, "events.jsonl");
  fs.writeFileSync(
    filePath,
    [
      JSON.stringify({ id: 1 }),
      "not-json",
      JSON.stringify({ id: 2 }),
      JSON.stringify({ id: 3 }),
      "",
    ].join("\n"),
    "utf8",
  );

  assert.deepEqual(store.readJsonlFile(filePath), [{ id: 2 }, { id: 3 }]);
  assert.equal(store.countJsonlFile(filePath), 4);
});

test("rewriteJsonlFile keeps matching entries and reports counts", () => {
  const invalidated = [];
  const { dir, store } = createStore({ onInvalidate: (filePath) => invalidated.push(filePath) });
  const filePath = path.join(dir, "events.jsonl");
  fs.writeFileSync(
    filePath,
    [{ id: 1 }, { id: 2 }, { id: 3 }].map((item) => JSON.stringify(item)).join("\n") + "\n",
    "utf8",
  );

  const result = store.rewriteJsonlFile(filePath, (item) => item.id !== 2);

  assert.deepEqual(result, { removedCount: 1, remainingCount: 2 });
  assert.deepEqual(store.readJsonlFile(filePath, Number.MAX_SAFE_INTEGER), [{ id: 1 }, { id: 3 }]);
  assert.deepEqual(invalidated, [filePath]);
});

test("mysql json reads fallback disk state and migrates it", () => {
  const calls = [];
  const mysqlRuntimeStore = createMysqlStore({
    isEnabled: () => true,
    readJson: (dataDir, filePath, fallback) => {
      calls.push({ type: "readJson", dataDir, filePath, fallback });
      return undefined;
    },
    writeJson: (dataDir, filePath, value) => calls.push({ type: "writeJson", dataDir, filePath, value }),
  });
  const { dir, store } = createStore({ mysqlRuntimeStore });
  const filePath = path.join(dir, "state.json");
  fs.writeFileSync(filePath, JSON.stringify({ migrated: true }), "utf8");

  assert.deepEqual(store.readJsonFile(filePath, null), { migrated: true });
  assert.equal(calls[0].type, "readJson");
  assert.deepEqual(calls[1], { type: "writeJson", dataDir: dir, filePath, value: { migrated: true } });
});

test("mysql jsonl reads fallback disk stream and rewrites full stream", () => {
  const calls = [];
  const mysqlRuntimeStore = createMysqlStore({
    isEnabled: () => true,
    readJsonl: (dataDir, filePath, limit) => {
      calls.push({ type: "readJsonl", dataDir, filePath, limit });
      return [];
    },
    rewriteJsonl: (dataDir, filePath, items) => calls.push({ type: "rewriteJsonl", dataDir, filePath, items }),
  });
  const { dir, store } = createStore({ mysqlRuntimeStore });
  const filePath = path.join(dir, "events.jsonl");
  fs.writeFileSync(
    filePath,
    [{ id: 1 }, { id: 2 }, { id: 3 }].map((item) => JSON.stringify(item)).join("\n") + "\n",
    "utf8",
  );

  assert.deepEqual(store.readJsonlFile(filePath, 2), [{ id: 2 }, { id: 3 }]);
  assert.deepEqual(calls[1], {
    type: "rewriteJsonl",
    dataDir: dir,
    filePath,
    items: [{ id: 1 }, { id: 2 }, { id: 3 }],
  });
});

test("unlinkIfExists delegates mysql delete and removes local file when present", () => {
  const calls = [];
  const invalidated = [];
  const mysqlRuntimeStore = createMysqlStore({
    deleteJson: (dataDir, filePath) => calls.push({ dataDir, filePath }),
    isEnabled: () => true,
  });
  const { dir, store } = createStore({
    mysqlRuntimeStore,
    onInvalidate: (filePath) => invalidated.push(filePath),
  });
  const filePath = path.join(dir, "state.json");
  fs.writeFileSync(filePath, "{}", "utf8");

  assert.equal(store.unlinkIfExists(filePath), true);
  assert.equal(fs.existsSync(filePath), false);
  assert.deepEqual(calls, [{ dataDir: dir, filePath }]);
  assert.deepEqual(invalidated, [filePath]);
});
