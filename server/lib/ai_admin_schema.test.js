"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createAiAdminSchemaManager } = require("./ai_admin_schema");

function createManager({ backend = "mysql", autoMigrate = true, columns = "" } = {}) {
  const queries = [];
  const manager = createAiAdminSchemaManager({
    AI_ADMIN_MYSQL_AUTO_MIGRATE: autoMigrate,
    AI_ADMIN_STORAGE_BACKEND: backend,
    runAiAdminMysql(query) {
      queries.push(query);
      if (/SHOW COLUMNS FROM persona_distill_projects/.test(query)) return columns;
      if (/SHOW COLUMNS FROM asset_jobs/.test(query)) return columns;
      if (/SHOW COLUMNS FROM group_intent_auto_train_jobs/.test(query)) return columns;
      if (/SHOW COLUMNS FROM ai_admin_runtime_tokens/.test(query)) return columns;
      return "";
    },
  });
  return { manager, queries };
}

test("schema manager reports mysql backend and skips non-mysql storage", () => {
  const fileBacked = createManager({ backend: "file" });
  fileBacked.manager.ensurePersonaMysqlSchema();

  assert.equal(fileBacked.manager.isAiAdminMysqlEnabled(), false);
  assert.equal(fileBacked.queries.length, 0);

  const mysqlBacked = createManager({ backend: "mysql", autoMigrate: false });
  mysqlBacked.manager.ensureContentAssetMysqlSchema();
  assert.equal(mysqlBacked.manager.isAiAdminMysqlEnabled(), true);
  assert.equal(mysqlBacked.queries.length, 0);
});

test("ensurePersonaMysqlSchema creates table, alters missing columns, and caches readiness", () => {
  const { manager, queries } = createManager({ columns: "id\tvarchar\nname\tvarchar\n" });

  manager.ensurePersonaMysqlSchema();
  manager.ensurePersonaMysqlSchema();

  assert.equal(queries.filter((query) => /CREATE TABLE IF NOT EXISTS persona_distill_projects/.test(query)).length, 1);
  assert.equal(queries.filter((query) => /SHOW COLUMNS FROM persona_distill_projects/.test(query)).length, 1);
  assert.ok(queries.some((query) => /ADD COLUMN material_mode/.test(query)));
  assert.ok(queries.some((query) => /ADD COLUMN skill_markdown/.test(query)));
});

test("ensureContentAssetMysqlSchema creates table and only alters missing asset columns", () => {
  const { manager, queries } = createManager({ columns: "id\tbigint\nclient_id\tvarchar\nsource_url\ttext\n" });

  manager.ensureContentAssetMysqlSchema();

  assert.ok(queries.some((query) => /CREATE TABLE IF NOT EXISTS asset_jobs/.test(query)));
  assert.equal(queries.some((query) => /ADD COLUMN client_id/.test(query)), false);
  assert.equal(queries.some((query) => /ADD COLUMN source_url/.test(query)), false);
  assert.ok(queries.some((query) => /ADD COLUMN result_json/.test(query)));
});

test("ensureGroupIntentMysqlSchema adds domain_type when missing", () => {
  const { manager, queries } = createManager({ columns: "id\tvarchar\nstatus\tvarchar\n" });

  manager.ensureGroupIntentMysqlSchema();

  assert.ok(queries.some((query) => /CREATE TABLE IF NOT EXISTS group_intent_auto_train_jobs/.test(query)));
  assert.ok(queries.some((query) => /ADD COLUMN domain_type/.test(query)));
});

test("ensureRuntimeTokenMysqlSchema creates token table and caches readiness", () => {
  const { manager, queries } = createManager();

  manager.ensureRuntimeTokenMysqlSchema();
  manager.ensureRuntimeTokenMysqlSchema();

  assert.equal(queries.filter((query) => /CREATE TABLE IF NOT EXISTS ai_admin_runtime_tokens/.test(query)).length, 1);
  assert.ok(queries.some((query) => /PRIMARY KEY \(token_key\)/.test(query)));
});
