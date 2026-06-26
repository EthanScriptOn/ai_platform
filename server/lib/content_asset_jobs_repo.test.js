"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createContentAssetJobRepository } = require("./content_asset_jobs_repo");
const { sqlString } = require("./mysql_cli");

function parseMysqlJson(value, fallback) {
  const raw = String(value || "").trim();
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function createRepo({ outputs = [], now = () => 1000000 } = {}) {
  const calls = [];
  const repo = createContentAssetJobRepository({
    ensureContentAssetMysqlSchema: () => calls.push({ type: "ensure" }),
    parseMysqlJson,
    runAiAdminMysql: (sql) => {
      calls.push({ type: "sql", sql });
      return outputs.shift() || "";
    },
    sqlString,
    currentTimeMs: now,
    randomUUID: () => "job-fixed",
  });
  return { calls, repo };
}

test("content asset repository normalizes jobs and infers source identity", () => {
  const { repo } = createRepo();

  assert.equal(repo.contentAssetJobSourceType("live_record"), "live");
  assert.equal(repo.contentAssetJobSourceType("product_match"), "product_match");
  assert.equal(repo.contentAssetSourceIdentityFromUrl("https://live.douyin.com/123456"), "123456");
  assert.equal(repo.contentAssetSourceIdentityFromResult({ recording: { parsed: { aweme_id: "888" } } }), "888");
  assert.deepEqual(repo.normalizeContentAssetJob({ input: "bad" }), {
    id: "job-fixed",
    type: "download",
    status: "queued",
    created_at: 1000,
    updated_at: 1000,
    input: {},
    result: null,
    error: null,
  });
});

test("loadContentAssetJobsFromMysql maps mysql rows through normalizer", () => {
  const row = [
    "job-1",
    "video_download",
    "completed",
    "{\"url\":\"https://example.com\"}",
    "{\"ok\":true}",
    "",
    "100",
    "200",
  ].join("\t");
  const { repo } = createRepo({ outputs: [`${row}\n`] });

  assert.deepEqual(repo.loadContentAssetJobsFromMysql(), [
    {
      id: "job-1",
      type: "video_download",
      status: "completed",
      created_at: 100,
      updated_at: 200,
      input: { url: "https://example.com" },
      result: { ok: true },
      error: null,
    },
  ]);
});

test("createContentAssetJobInMysql inserts then reloads the job", () => {
  const row = [
    "job-1",
    "live_record",
    "queued",
    "{\"url\":\"https://live.douyin.com/123\"}",
    "",
    "",
    "100",
    "100",
  ].join("\t");
  const { calls, repo } = createRepo({ outputs: ["", `${row}\n`] });

  const result = repo.createContentAssetJobInMysql({
    id: "job-1",
    type: "live_record",
    status: "queued",
    input: { url: "https://live.douyin.com/123" },
    created_at: 100,
    updated_at: 100,
  }, "client-1");

  assert.equal(result.id, "job-1");
  assert.match(calls.find((call) => call.sql?.includes("INSERT INTO asset_jobs"))?.sql || "", /source_identity/);
  assert.match(calls.find((call) => call.sql?.includes("INSERT INTO asset_jobs"))?.sql || "", /'123'/);
});

test("update and delete content asset jobs preserve not found behavior", () => {
  const existingRow = [
    "job-1",
    "video_download",
    "running",
    "{}",
    "",
    "",
    "100",
    "100",
  ].join("\t");
  const { calls, repo } = createRepo({
    outputs: [`${existingRow}\n`, "", `${existingRow}\n`, `${existingRow}\n`, ""],
  });

  assert.equal(repo.updateContentAssetJobInMysql("job-1", { status: "completed", result: { parsed: { aweme_id: "777" } } }).id, "job-1");
  assert.equal(repo.deleteContentAssetJobInMysql("job-1").id, "job-1");
  assert.match(calls.find((call) => call.sql?.includes("UPDATE asset_jobs") && call.sql?.includes("result_json"))?.sql || "", /'777'/);
  assert.match(calls.find((call) => call.sql?.includes("status = 'deleted'"))?.sql || "", /deleted_at = CURRENT_TIMESTAMP/);

  const empty = createRepo({ outputs: [""] }).repo;
  assert.throws(() => empty.updateContentAssetJobInMysql("missing", {}), /content_asset_job_not_found/);
  assert.equal(empty.deleteContentAssetJobInMysql("missing"), null);
});
