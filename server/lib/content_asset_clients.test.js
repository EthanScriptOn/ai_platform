"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createContentAssetClientManager,
  isContentAssetStatusLike,
  mergeContentAssetStatus,
} = require("./content_asset_clients");

function fixedRandomBytes() {
  return Buffer.from("0011223344556677", "hex");
}

test("content asset status merge preserves previous fields unless payload updates them", () => {
  const merged = mergeContentAssetStatus(
    { hasCookie: true, jobCount: 2, data: { previous: true }, message: "old" },
    { running_count: 1, message: "next" }
  );

  assert.equal(merged.hasCookie, true);
  assert.equal(merged.jobCount, 2);
  assert.equal(merged.runningCount, 1);
  assert.deepEqual(merged.data, { previous: true });
  assert.equal(merged.message, "next");
  assert.equal(isContentAssetStatusLike({ job_count: 1 }), true);
  assert.equal(isContentAssetStatusLike({ random: true }), false);
});

test("content asset client manager reports fresh and stale remote status", () => {
  let now = 1000;
  const manager = createContentAssetClientManager({
    now: () => now,
    randomBytes: fixedRandomBytes,
  });
  const token = manager.createContentAssetToken();

  assert.match(token, /^content_/);
  assert.equal(manager.contentAssetRemoteStatus(token).connected, false);

  manager.updateContentAssetClient(token, "client-1", { has_cookie: true, job_count: 3 });
  assert.deepEqual(
    {
      connected: manager.contentAssetRemoteStatus(token).connected,
      clientId: manager.contentAssetRemoteStatus(token).clientId,
      hasCookie: manager.contentAssetRemoteStatus(token).hasCookie,
      jobCount: manager.contentAssetRemoteStatus(token).jobCount,
    },
    { connected: true, clientId: "client-1", hasCookie: true, jobCount: 3 }
  );

  now += 16000;
  assert.equal(manager.contentAssetRemoteStatus(token).connected, false);
  assert.equal(manager.contentAssetRemoteStatus(token).installed, true);
});

test("content asset commands queue and complete through pending promises", async () => {
  let now = 2000;
  const manager = createContentAssetClientManager({
    now: () => now,
    randomBytes: fixedRandomBytes,
    commandTimeoutMs: 1000,
  });
  const token = "content-token";
  const client = manager.updateContentAssetClient(token, "client-1", { connected: true });
  const pending = manager.sendContentAssetCommandForToken(token, "/api/example", {
    method: "POST",
    body: "{\"ok\":true}",
  });

  assert.equal(client.queue.length, 1);
  assert.equal(client.queue[0].path, "/api/example");
  assert.equal(client.queue[0].options.method, "POST");

  assert.equal(manager.completeContentAssetCommand(token, client.queue[0].id, { ok: true, job_count: 4 }), true);
  assert.deepEqual(await pending, { ok: true, job_count: 4 });
  assert.equal(manager.contentAssetRemoteStatus(token).jobCount, 4);
});
