"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  extractJsonFromText,
  paginateItems,
  paginationMeta,
  parseMysqlJson,
  parsePagination,
  readJsonl,
  stableId,
} = require("./data_utils");

test("readJsonl returns parsed non-empty lines and tolerates missing files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "data-utils-test-"));
  const filePath = path.join(dir, "items.jsonl");
  fs.writeFileSync(filePath, '{"id":1}\n\n{"id":2}\n', "utf8");

  assert.deepEqual(readJsonl(filePath), [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(readJsonl(path.join(dir, "missing.jsonl")), []);
});

test("pagination helpers clamp invalid input and expose metadata", () => {
  const params = new URLSearchParams("page=-8&pageSize=999");
  const pagination = parsePagination(params, { defaultPageSize: 10, maxPageSize: 25 });
  const pageData = paginateItems([1, 2, 3, 4, 5], pagination);

  assert.deepEqual(pagination, { page: 1, pageSize: 25 });
  assert.deepEqual(pageData.items, [1, 2, 3, 4, 5]);
  assert.deepEqual(paginationMeta(pageData), {
    page: 1,
    pageSize: 25,
    total: 5,
    totalPages: 1,
  });
});

test("stableId is deterministic for the same governed unit", () => {
  const unit = {
    title: "退款规则",
    source_evidence: ["A", "B"],
  };

  assert.equal(stableId("客服手册", unit), stableId("客服手册", unit));
  assert.notEqual(stableId("客服手册", unit), stableId("客服手册", { ...unit, title: "发货规则" }));
});

test("parseMysqlJson returns fallback for blank or invalid JSON", () => {
  assert.deepEqual(parseMysqlJson('{"ok":true}', {}), { ok: true });
  assert.deepEqual(parseMysqlJson("", { fallback: true }), { fallback: true });
  assert.deepEqual(parseMysqlJson("{bad", []), []);
});

test("extractJsonFromText parses raw, fenced, and embedded JSON", () => {
  assert.deepEqual(extractJsonFromText('{"ok":true}'), { ok: true });
  assert.deepEqual(extractJsonFromText('```json\n{"items":[1]}\n```'), { items: [1] });
  assert.deepEqual(extractJsonFromText("前缀 [1,2] 后缀"), [1, 2]);
  assert.throws(() => extractJsonFromText("not json"), /合法 JSON/);
});
