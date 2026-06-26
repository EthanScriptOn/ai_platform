"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createFlowbotLogWriters } = require("./log_writers");

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8").trim().split(/\n/g).filter(Boolean).map((line) => JSON.parse(line));
}

function createWriters(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flowbot-log-writers-test-"));
  const calls = [];
  const paths = {
    ARCHIVE_LOG_PATH: path.join(dir, "archive.jsonl"),
    BATCH_LOG_PATH: path.join(dir, "batch.jsonl"),
    DATA_DIR: dir,
    FILTER_LOG_PATH: path.join(dir, "filter.jsonl"),
    KNOWLEDGE_PUBLISH_LOG_PATH: path.join(dir, "publish.jsonl"),
    LOG_PATH: path.join(dir, "events.jsonl"),
    MESSAGE_SEARCH_INDEX_PATH: path.join(dir, "search.jsonl"),
    NORMALIZED_LOG_PATH: path.join(dir, "normalized.jsonl"),
    ROUTING_LOG_PATH: path.join(dir, "routing.jsonl"),
  };
  const writers = createFlowbotLogWriters({
    ...paths,
    buildPublicMediaUrl: (mediaLocalUrl) => mediaLocalUrl ? `public:${mediaLocalUrl}` : "",
    enqueueKnowledgeHarvestMessage: (event) => calls.push({ type: "harvest", event }),
    mysqlRuntimeStore: {
      isEnabled: () => false,
      appendJsonl() {
        throw new Error("mysql should not be called");
      },
    },
    tokenizeSearchText: (text) => text.split(/\s+/g).filter(Boolean),
    ...overrides,
  });
  return { calls, dir, paths, writers };
}

test("buildMessageSearchRecord normalizes searchable message fields", () => {
  const { writers } = createWriters();

  const record = writers.buildMessageSearchRecord({
    traceId: "t1",
    roomId: "r1",
    senderName: "Alice",
    content: "hello world",
    mediaKind: "image",
    mediaLocalUrl: "/media/a.jpg",
    msgType: 5,
  });

  assert.equal(record.traceId, "t1");
  assert.equal(record.roomName, "r1");
  assert.equal(record.mediaPublicUrl, "public:/media/a.jpg");
  assert.deepEqual(record.searchTokens, ["hello", "world", "Alice", "image", "5"]);
});

test("appendNormalizedEvent writes normalized and search logs and queues harvest", () => {
  const { calls, paths, writers } = createWriters();

  writers.appendNormalizedEvent({ traceId: "t1", content: "hello", roomId: "r1" });

  assert.equal(readJsonl(paths.NORMALIZED_LOG_PATH).length, 1);
  assert.equal(readJsonl(paths.MESSAGE_SEARCH_INDEX_PATH)[0].traceId, "t1");
  assert.equal(calls[0].type, "harvest");
});

test("append decision helpers write expected JSONL files", () => {
  const { paths, writers } = createWriters();

  writers.appendEvent({ id: "event" });
  writers.appendFilterDecision({ id: "filter" });
  writers.appendArchiveDecision({ id: "archive" });
  writers.appendRoutingDecision({ id: "routing" });
  writers.appendBatchDecision({ id: "batch" });
  writers.appendKnowledgePublishResult({ id: "publish" });

  assert.equal(readJsonl(paths.LOG_PATH)[0].id, "event");
  assert.equal(readJsonl(paths.FILTER_LOG_PATH)[0].id, "filter");
  assert.equal(readJsonl(paths.ARCHIVE_LOG_PATH)[0].id, "archive");
  assert.equal(readJsonl(paths.ROUTING_LOG_PATH)[0].id, "routing");
  assert.equal(readJsonl(paths.BATCH_LOG_PATH)[0].id, "batch");
  assert.equal(readJsonl(paths.KNOWLEDGE_PUBLISH_LOG_PATH)[0].id, "publish");
});

test("mysql-backed writer delegates to runtime store", () => {
  const calls = [];
  const { writers } = createWriters({
    DATA_DIR: "/data",
    LOG_PATH: "/data/events.jsonl",
    mysqlRuntimeStore: {
      isEnabled: () => true,
      appendJsonl(dataDir, filePath, event) {
        calls.push({ dataDir, filePath, event });
      },
    },
  });

  writers.appendEvent({ id: "event" });

  assert.deepEqual(calls, [{ dataDir: "/data", filePath: "/data/events.jsonl", event: { id: "event" } }]);
});
