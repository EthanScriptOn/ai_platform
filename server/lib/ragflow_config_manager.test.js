"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createRagflowConfigManager } = require("./ragflow_config_manager");

test("ragflow config manager saves config, token and dataset id into stores", () => {
  let savedSettings = {};
  let savedToken = "";
  const manager = createRagflowConfigManager({
    loadRagflowSettings: () => savedSettings,
    loadRagflowToken: () => savedToken,
    saveRagflowSettings: (settings) => {
      savedSettings = { ...savedSettings, ...settings };
      return true;
    },
    saveRagflowToken: (token) => {
      savedToken = token;
      return true;
    },
  });

  const result = manager.saveConfig({
    baseUrl: "http://ragflow.test/",
    chatUrl: "http://ragflow.test/yuebai-workbench/",
    agentId: "agent-1",
    datasetId: "dataset-1",
    apiToken: "token-secret",
    loginEmail: "user@example.test",
    loginPassword: "pass-secret",
  });

  assert.equal(savedSettings.RAGFLOW_BASE_URL, "http://ragflow.test");
  assert.equal(savedSettings.RAGFLOW_AGENT_ID, "agent-1");
  assert.equal(savedSettings.RAGFLOW_DATASET_ID, "dataset-1");
  assert.equal(savedSettings.RAGFLOW_LOGIN_PASSWORD, "pass-secret");
  assert.equal(savedToken, "token-secret");
  assert.equal(result.config.tokenConfigured, true);
  assert.equal(result.config.loginPasswordConfigured, true);
});

test("ragflow config manager reads and writes api token through token store", () => {
  const savedTokens = [];
  const manager = createRagflowConfigManager({
    loadRagflowToken: () => savedTokens.at(-1) || "",
    saveRagflowSettings: () => true,
    saveRagflowToken: (token) => {
      savedTokens.push(token);
      return true;
    },
  });

  const result = manager.saveConfig({
    baseUrl: "http://ragflow.test",
    apiToken: "token-in-db",
  });

  assert.deepEqual(savedTokens, ["token-in-db"]);
  assert.equal(result.config.tokenConfigured, true);
  assert.equal(result.config.tokenMasked, "toke****n-db");
});
