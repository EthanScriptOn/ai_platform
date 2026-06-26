"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  createWechatCollectorClientManager,
  mergeCollectorStatus,
  safeWechatCollectorStatus,
  wechatTokenFromRequest,
} = require("./wechat_collector_clients");

function fixedRandomBytes() {
  return Buffer.from("0011223344556677", "hex");
}

test("wechat collector status merge preserves previous fields and caps captures", () => {
  const captures = Array.from({ length: 250 }, (_, index) => ({ id: index }));
  const merged = mergeCollectorStatus(
    { listening: false, selectedType: "video", captures: [{ id: "old" }], message: "old" },
    { certificateTrusted: true, captures, message: "next" }
  );

  assert.equal(merged.listening, false);
  assert.equal(merged.selectedType, "video");
  assert.equal(merged.certificateTrusted, true);
  assert.equal(merged.captures.length, 250);
  assert.equal(safeWechatCollectorStatus(merged).captures.length, 200);
});

test("wechat collector manager persists and reloads clients", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-clients-test-"));
  const statePath = path.join(dir, "clients.json");
  let now = 1000;
  const isoNow = () => new Date(now).toISOString();
  const manager = createWechatCollectorClientManager({
    statePath,
    now: () => now,
    isoNow,
    randomBytes: fixedRandomBytes,
  });
  const token = manager.createWechatCollectorToken();
  manager.updateWechatCollectorClient(token, "client-1", { listening: true, captures: [{ id: 1 }] });

  const restored = createWechatCollectorClientManager({
    statePath,
    now: () => now,
    isoNow,
    randomBytes: fixedRandomBytes,
  });
  restored.loadWechatCollectorClients();

  assert.equal(restored.wechatCollectorStatusForToken(token).connected, true);
  assert.equal(restored.wechatCollectorStatusForToken(token).clientId, "client-1");
  assert.equal(restored.wechatCollectorStatusForToken(token).captures.length, 1);

  now += 21000;
  assert.equal(restored.wechatCollectorStatusForToken(token).connected, false);
});

test("wechat collector commands queue and complete through pending promises", async () => {
  let now = 2000;
  const manager = createWechatCollectorClientManager({
    now: () => now,
    isoNow: () => new Date(now).toISOString(),
    randomBytes: fixedRandomBytes,
    commandTimeoutMs: 1000,
  });
  const client = manager.updateWechatCollectorClient("token-1", "client-1", { listening: true });
  const pending = manager.sendWechatCollectorCommand("token-1", "/api/status", { method: "POST" });

  assert.equal(client.queue.length, 1);
  assert.equal(client.queue[0].path, "/api/status");
  assert.equal(client.queue[0].options.method, "POST");

  assert.equal(manager.completeWechatCollectorCommand("token-1", client.queue[0].id, { ok: true, captures: [] }), true);
  assert.deepEqual(await pending, { ok: true, captures: [] });
});

test("wechatTokenFromRequest prefers authorization header over payload and query", () => {
  const token = wechatTokenFromRequest(
    { headers: { authorization: "Bearer from-header" } },
    { token: "from-body" },
    new URL("http://localhost/?token=from-query")
  );

  assert.equal(token, "from-header");
});
