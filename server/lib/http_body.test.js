"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("stream");

const { readJsonBody, readRawBody } = require("./http_body");

function requestFrom(body) {
  if (body === undefined) return Readable.from([]);
  return Readable.from([Buffer.isBuffer(body) ? body : Buffer.from(String(body))]);
}

test("readJsonBody parses JSON payloads and defaults empty bodies to an object", async () => {
  assert.deepEqual(await readJsonBody(requestFrom('{"ok":true}')), { ok: true });
  assert.deepEqual(await readJsonBody(requestFrom()), {});
});

test("readJsonBody rejects malformed JSON", async () => {
  await assert.rejects(() => readJsonBody(requestFrom("{bad json")));
});

test("readRawBody returns a buffer only when the request has content", async () => {
  assert.equal(await readRawBody(requestFrom()), undefined);
  assert.equal((await readRawBody(requestFrom("hello"))).toString("utf8"), "hello");
});
