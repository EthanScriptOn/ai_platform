"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createRagflowTokenStore, RAGFLOW_API_TOKEN_KEY } = require("./ragflow_token_store");

test("ragflow token store loads and saves token in mysql runtime table", () => {
  const queries = [];
  let ensured = 0;
  const store = createRagflowTokenStore({
    ensureRuntimeTokenMysqlSchema: () => {
      ensured += 1;
    },
    isAiAdminMysqlEnabled: () => true,
    runAiAdminMysql: (query) => {
      queries.push(query);
      if (/SELECT token_value/.test(query)) return "token-from-db\n";
      return "";
    },
    sqlString: (value) => `'${String(value).replace(/'/g, "\\'")}'`,
  });

  assert.equal(store.loadRagflowToken(), "token-from-db");
  assert.equal(store.saveRagflowToken(" token-new "), true);
  assert.equal(ensured, 2);
  assert.ok(queries[0].includes(RAGFLOW_API_TOKEN_KEY));
  assert.ok(queries[1].includes("ON DUPLICATE KEY UPDATE"));
  assert.ok(queries[1].includes("token-new"));
});

test("ragflow token store is disabled outside mysql backend", () => {
  const store = createRagflowTokenStore({
    isAiAdminMysqlEnabled: () => false,
    runAiAdminMysql: () => {
      throw new Error("mysql should not be called");
    },
    sqlString: (value) => String(value),
  });

  assert.equal(store.loadRagflowToken(), "");
  assert.equal(store.saveRagflowToken("token"), false);
});
