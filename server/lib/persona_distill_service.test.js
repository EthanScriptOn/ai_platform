"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createPersonaProjectStore } = require("./persona_project_store");
const {
  createPersonaDistillService,
  materialDigest,
  personaSkillName,
  renderPersonaSkillDraft,
} = require("./persona_distill_service");

function createHarness(callQwenChat) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "persona-distill-service-test-"));
  const store = createPersonaProjectStore({
    PERSONA_DISTILL_PROJECTS_PATH: path.join(dir, "projects.json"),
    ensurePersonaMysqlSchema() {},
    isAiAdminMysqlEnabled: () => false,
    parseMysqlJson: (value, fallback) => {
      try {
        return value ? JSON.parse(value) : fallback;
      } catch {
        return fallback;
      }
    },
    runAiAdminMysql() {
      throw new Error("mysql should not be called");
    },
    sqlDate: (value) => `'${value}'`,
    sqlString: (value) => `'${value}'`,
  });
  const service = createPersonaDistillService({
    PERSONA_DISTILL_FAST_MODEL: "fast-model",
    PERSONA_DISTILL_MODEL: "distill-model",
    PERSONA_DISTILL_SKILLS_DIR: path.join(dir, "skills"),
    PERSONA_NUWA_EXAMPLES_DIR: path.join(dir, "examples"),
    callQwenChat,
    loadPersonaProjects: store.loadPersonaProjects,
    normalizePersonaProject: store.normalizePersonaProject,
    personaDepthConfig: store.personaDepthConfig,
    savePersonaProject: store.savePersonaProject,
  });
  return { dir, service, store };
}

test("render helpers produce stable skill names and material digests", () => {
  const project = {
    id: "p1",
    name: "Steve Jobs",
    purpose: "测试目的",
    focus: ["说话风格"],
    dimensions: [{ label: "表达", output: "短句" }],
    sources: [{ type: "访谈", name: "材料", status: "已上传", contentPreview: "内容" }],
    risks: ["风险"],
  };

  assert.equal(personaSkillName(project), "steve-jobs-perspective");
  assert.match(renderPersonaSkillDraft(project), /人物 Skill 草稿/);
  assert.match(materialDigest(project), /### 材料 1: 材料/);
});

test("createPersonaProjectFromPayload attaches public classification metadata", async () => {
  const calls = [];
  const { service } = createHarness(async (request) => {
    calls.push(request);
    return JSON.stringify({
      isPublic: true,
      confidence: 0.9,
      personName: "乔布斯",
      reason: "公开资料充足",
      searchKeywords: ["乔布斯 访谈"],
    });
  });

  const project = await service.createPersonaProjectFromPayload({ prompt: "蒸馏乔布斯" });

  assert.equal(project.name, "乔布斯");
  assert.equal(project.materialMode, "public_research");
  assert.equal(project.status, "research_pending");
  assert.equal(project.distillResult.publicClassify.isPublic, true);
  assert.equal(calls[0].model, "fast-model");
});

test("appendPersonaMaterials and updatePersonaDepth persist normalized project changes", async () => {
  const { service } = createHarness(async () => "{}");
  const project = await service.createPersonaProjectFromPayload({ name: "内部专家", materialMode: "materials_required" });

  const withMaterial = service.appendPersonaMaterials(project.id, [
    { fileName: "访谈.txt", content: "这是一段材料", size: 12 },
  ]);
  const updatedDepth = service.updatePersonaDepth(project.id, "quick");

  assert.equal(withMaterial.status, "materials_ready");
  assert.equal(withMaterial.sources[0].name, "访谈.txt");
  assert.equal(updatedDepth.depthLevel, "quick");
  assert.equal(updatedDepth.targetRounds, 1);
});

test("distillPersonaProject writes skill bundle and updates project", async () => {
  const { dir, service } = createHarness(async (request) => {
    assert.equal(request.model, "distill-model");
    return JSON.stringify({
      skillMarkdown: "# Test Skill\n\nUse carefully.",
      summary: "摘要",
      mentalModels: ["模型"],
      evidence: ["证据"],
      limitations: ["边界"],
      qualityScore: 91,
    });
  });
  const project = await service.createPersonaProjectFromPayload({ name: "专家", sources: "访谈材料" });
  service.appendPersonaMaterials(project.id, [{ name: "访谈", content: "说话材料" }]);

  const updated = await service.distillPersonaProject(project.id);

  assert.equal(updated.status, "completed");
  assert.equal(updated.qualityScore, 91);
  assert.ok(fs.existsSync(path.join(updated.skillDir, "SKILL.md")));
  assert.ok(fs.existsSync(path.join(updated.skillDir, "manifest.json")));
  assert.equal(updated.skillDir.startsWith(path.join(dir, "skills")), true);
});

test("chatWithPersonaProject trims history and requires completed skill", async () => {
  const calls = [];
  const { service, store } = createHarness(async (request) => {
    calls.push(request);
    return " persona reply ";
  });
  const draft = store.savePersonaProject(store.normalizePersonaProject({ name: "未完成" }));
  await assert.rejects(
    () => service.chatWithPersonaProject(draft.id, "hi"),
    /还没有蒸馏完成/
  );
  const completed = store.savePersonaProject(store.normalizePersonaProject({
    name: "已完成",
    skillMarkdown: "# Skill",
  }));

  const result = await service.chatWithPersonaProject(
    completed.id,
    "你好",
    Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `m${index}` }))
  );

  assert.equal(result.reply, "persona reply");
  assert.equal(result.model, "fast-model");
  assert.equal(calls[0].temperature, 0.4);
  assert.equal(calls[0].messages.length, 14);
});
