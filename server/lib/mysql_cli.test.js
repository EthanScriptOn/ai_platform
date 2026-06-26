"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createMysqlCli, sqlDate, sqlString } = require("./mysql_cli");

test("sqlString escapes mysql string literal edge cases", () => {
  assert.equal(sqlString(null), "NULL");
  assert.equal(sqlString("a'b\\c\n"), "'a\\'b\\\\c\\n'");
  assert.equal(sqlString("tab\tend"), "'tab\\tend'");
});

test("sqlDate formats valid dates and falls back to current timestamp expression", () => {
  assert.equal(sqlDate("2026-01-02T03:04:05.000Z"), "'2026-01-02 03:04:05.000'");
  assert.equal(sqlDate("not-a-date"), "CURRENT_TIMESTAMP(3)");
});

test("createMysqlCli passes mysql arguments and password through spawnSync", () => {
  const calls = [];
  const cli = createMysqlCli({
    bin: "mysql-test",
    host: "db",
    port: "3307",
    database: "ai",
    user: "root",
    password: "secret",
    spawnSync: (...args) => {
      calls.push(args);
      return { status: 0, stdout: "ok\n" };
    },
  });

  assert.equal(cli.runMysql("SELECT 1;"), "ok\n");
  assert.equal(calls[0][0], "mysql-test");
  assert.deepEqual(calls[0][1].slice(0, 6), ["--protocol=TCP", "-h", "db", "-P", "3307", "-u"]);
  assert.equal(calls[0][2].input, "SELECT 1;");
  assert.equal(calls[0][2].env.MYSQL_PWD, "secret");
});

test("createMysqlCli reports missing required config before spawning", () => {
  const cli = createMysqlCli({ database: "", user: "root" });
  assert.throws(() => cli.runMysql("SELECT 1;"), /ai_admin_mysql_config_missing/);
});
