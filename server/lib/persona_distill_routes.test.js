"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createPersonaDistillRoutes } = require("./persona_distill_routes");

function waitForPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createResponse() {
  return { body: null, status: null };
}

function route(pathname) {
  return new URL(pathname, "http://localhost");
}

function createRoutes(overrides = {}) {
  const calls = [];
  const service = createPersonaDistillRoutes({
    PERSONA_DISTILL_FAST_MODEL: "fast-model",
    PERSONA_DISTILL_MODEL: "distill-model",
    PERSONA_DISTILL_PROJECTS_PATH: "/tmp/projects.json",
    PERSONA_DISTILL_REVIEW_MODEL: "review-model",
    PERSONA_DISTILL_SKILLS_DIR: "/tmp/skills",
    appendPersonaMaterials: (projectId, materials) => ({ id: projectId, materials }),
    chatWithPersonaProject: async (projectId, message, history) => ({ reply: `${projectId}:${message}:${history.length}` }),
    createPersonaProjectFromPayload: async (payload) => ({ id: "created", ...payload }),
    deletePersonaProject: (projectId) => ({ id: projectId, deleted: true }),
    isAiAdminMysqlEnabled: () => false,
    loadPersonaProjects: () => [{ id: "p1", name: "P1" }],
    renderPersonaSkillDraft: (project) => `draft:${project.id}`,
    sendJson(res, payload, status = 200) {
      calls.push({ payload, status });
      res.status = status;
      res.body = JSON.stringify(payload);
    },
    startPersonaDistillJob: (projectId) => ({ id: projectId, status: "running" }),
    updatePersonaDepth: (projectId, depth) => ({ id: projectId, depth }),
    ...overrides,
  });
  return { calls, service };
}

test("projects list includes drafts, model config, and file storage details", () => {
  const { service } = createRoutes();
  const res = createResponse();

  const handled = service.handlePersonaDistillRoute({}, res, route("/api/persona-distill/projects"), "GET", async () => ({}));

  assert.equal(handled, true);
  assert.deepEqual(JSON.parse(res.body), {
    ok: true,
    projects: [{ id: "p1", name: "P1", skillDraft: "draft:p1" }],
    modelConfig: {
      distillModel: "distill-model",
      fastModel: "fast-model",
      reviewModel: "review-model",
    },
    storageBackend: "file",
    dataPath: "/tmp/projects.json",
    skillsDir: "/tmp/skills",
  });
});

test("materials route decodes project id and returns updated draft", async () => {
  const { service } = createRoutes();
  const res = createResponse();

  const handled = service.handlePersonaDistillRoute(
    {},
    res,
    route("/api/persona-distill/projects/person%201/materials"),
    "POST",
    async () => ({ materials: [{ text: "m1" }] })
  );
  await waitForPromises();

  assert.equal(handled, true);
  assert.deepEqual(JSON.parse(res.body), {
    ok: true,
    project: { id: "person 1", materials: [{ text: "m1" }], skillDraft: "draft:person 1" },
  });
});

test("run route returns accepted project and skills dir", () => {
  const { service } = createRoutes();
  const res = createResponse();

  const handled = service.handlePersonaDistillRoute(
    {},
    res,
    route("/api/persona-distill/projects/p1/run"),
    "POST",
    async () => ({})
  );

  assert.equal(handled, true);
  assert.deepEqual(JSON.parse(res.body), {
    ok: true,
    accepted: true,
    project: { id: "p1", status: "running", skillDraft: "draft:p1" },
    skillsDir: "/tmp/skills",
  });
});

test("chat route wraps chat service data", async () => {
  const { service } = createRoutes();
  const res = createResponse();

  const handled = service.handlePersonaDistillRoute(
    {},
    res,
    route("/api/persona-distill/chat"),
    "POST",
    async () => ({ projectId: "p1", message: "hi", history: [{}] })
  );
  await waitForPromises();

  assert.equal(handled, true);
  assert.deepEqual(JSON.parse(res.body), { ok: true, reply: "p1:hi:1" });
});

test("unmatched route is not handled", () => {
  const { service } = createRoutes();

  assert.equal(
    service.handlePersonaDistillRoute({}, createResponse(), route("/api/other"), "GET", async () => ({})),
    false
  );
});
