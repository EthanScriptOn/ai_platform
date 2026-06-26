"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { parseMysqlJson } = require("./data_utils");
const { sqlDate, sqlString } = require("./mysql_cli");
const { createPersonaProjectStore } = require("./persona_project_store");

function createStore({ mysql = false, outputs = [], projectPath = "" } = {}) {
  const calls = [];
  const store = createPersonaProjectStore({
    PERSONA_DISTILL_PROJECTS_PATH: projectPath || path.join(fs.mkdtempSync(path.join(os.tmpdir(), "persona-store-")), "projects.json"),
    ensurePersonaMysqlSchema: () => calls.push({ type: "ensure" }),
    isAiAdminMysqlEnabled: () => mysql,
    parseMysqlJson,
    runAiAdminMysql: (sql) => {
      calls.push({ type: "sql", sql });
      return outputs.shift() || "";
    },
    sqlDate,
    sqlString,
  });
  return { calls, store };
}

test("persona project store normalizes inferred public person requests", () => {
  const { store } = createStore();
  const project = store.normalizePersonaProject({ prompt: "蒸馏马斯克的说话风格", currentRound: -1 });

  assert.equal(project.name, "马斯克");
  assert.equal(project.materialMode, "public_research");
  assert.equal(project.status, "research_pending");
  assert.equal(project.depthLevel, "commercial");
  assert.equal(project.currentRound, 0);
  assert.equal(project.dimensions.length, 4);
});

test("persona project store saves, loads, and deletes file-backed projects", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "persona-store-file-"));
  const projectPath = path.join(dir, "projects.json");
  const { store } = createStore({ projectPath });
  const saved = store.savePersonaProject({ id: "p1", name: "Alice", sources: "doc one" });

  assert.equal(saved.id, "p1");
  assert.equal(store.loadPersonaProjects()[0].name, "Alice");
  assert.equal(store.loadPersonaProjects()[0].sources[0].name, "doc one");
  assert.equal(store.deletePersonaProject("p1").id, "p1");
  assert.deepEqual(store.loadPersonaProjects(), []);
});

test("persona project store emits mysql upsert SQL and maps mysql rows", () => {
  const skillMarkdown = Buffer.from("# Skill\n", "utf8").toString("base64");
  const row = [
    "p1",
    "Alice",
    "Alice人物蒸馏",
    "completed",
    "materials_ready",
    "standard",
    "3",
    "1",
    "internal",
    "88",
    "prompt",
    "purpose",
    "[\"说话风格\"]",
    "[]",
    "[]",
    "[]",
    "{\"ok\":true}",
    skillMarkdown,
    "/tmp/skill",
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
    "2026-01-02T00:00:00.000Z",
  ].join("\t");
  const { calls, store } = createStore({ mysql: true, outputs: ["0", "", `${row}\n`] });

  store.savePersonaProject({ id: "p1", name: "Alice", prompt: "prompt", purpose: "purpose" });
  const loaded = store.loadPersonaProjects()[0];

  assert.equal(loaded.id, "p1");
  assert.equal(loaded.skillMarkdown, "# Skill");
  assert.deepEqual(loaded.distillResult, { ok: true });
  assert.match(calls.find((call) => call.sql?.includes("INSERT INTO persona_distill_projects"))?.sql || "", /Alice/);
});

test("persona project store preserves not found delete behavior", () => {
  const { store } = createStore();

  assert.throws(() => store.deletePersonaProject("missing"), /persona_project_not_found/);
});
