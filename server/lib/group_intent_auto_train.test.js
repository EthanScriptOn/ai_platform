"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { setTimeout: delay } = require("node:timers/promises");

const { createGroupIntentAutoTrainService } = require("./group_intent_auto_train");

async function waitForJobStatus(service, jobId, status, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const job = service.loadGroupIntentAutoTrainJobs().find((item) => item.id === jobId);
    if (job?.status === status) {
      return job;
    }
    await delay(5);
  }
  throw new Error(`job_status_timeout:${jobId}:${status}`);
}

function createService(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "group-intent-auto-train-test-"));
  const qwenCalls = [];
  const trainCalls = [];
  const service = createGroupIntentAutoTrainService({
    GROUP_INTENT_AUTO_TRAIN_JOBS_PATH: path.join(dir, "jobs.json"),
    GROUP_INTENT_DIR: dir,
    GROUP_INTENT_DOMAIN_PRESETS: {
      mother_baby: "母婴",
      shopping: "购物",
    },
    GROUP_INTENT_QWEN_MODEL: "qwen-test",
    ROOT: dir,
    async callQwenChat(request) {
      qwenCalls.push(request);
      const count = Number(String(request.messages?.[1]?.content || "").match(/生成 (\d+) 条/)?.[1] || 1);
      return JSON.stringify({
        items: Array.from({ length: count }, (_, index) => ({
          speaker: `用户${index + 1}`,
          text: index % 2 === 0 ? "这款怎么买" : "今天聊聊天",
          label: index % 2 === 0 ? "intervene" : "ignore",
          reason: "测试样本",
        })),
      });
    },
    ensureGroupIntentMysqlSchema() {},
    isAiAdminMysqlEnabled: () => false,
    runAiAdminMysql() {
      throw new Error("mysql should not be called in file-backed tests");
    },
    sqlDate: (value) => `'${value}'`,
    sqlString: (value) => `'${value}'`,
    trainGroupIntentFastText(items) {
      trainCalls.push(items);
      return {
        totalSamples: trainCalls.flat().length,
        classCounts: { intervene: items.filter((item) => item.label === "intervene").length, ignore: 0 },
      };
    },
    ...overrides,
  });
  return { dir, qwenCalls, service, trainCalls };
}

test("domain helpers preserve preset labels and custom domains", () => {
  const { service } = createService();

  assert.deepEqual(service.listGroupIntentDomainTypes(), [
    { value: "mother_baby", label: "母婴" },
    { value: "shopping", label: "购物" },
  ]);
  assert.equal(service.normalizeGroupIntentDomainType("shopping"), "购物");
  assert.equal(service.normalizeGroupIntentDomainType("自定义很长很长很长很长很长很长很长很长很长很长"), "自定义很长很长很长很长很长很长很长很长很长很长".slice(0, 40));
  assert.match(service.buildGroupIntentDomainPrompt("shopping").systemPrompt, /购物/);
});

test("buildGroupIntentSampleInputWithQwen returns generated rows and raw input", async () => {
  const { qwenCalls, service } = createService();

  const result = await service.buildGroupIntentSampleInputWithQwen(3, "shopping");

  assert.equal(result.model, "qwen-test");
  assert.equal(result.count, 3);
  assert.equal(result.domainType, "购物");
  assert.equal(result.items.length, 3);
  assert.match(result.input, /用户1: 这款怎么买/);
  assert.equal(qwenCalls.length, 1);
  assert.equal(qwenCalls[0].temperature, 0.8);
});

test("file-backed auto train job runs through generated samples", async () => {
  const { dir, service, trainCalls } = createService();

  const job = service.createGroupIntentAutoTrainJob({ count: 1, batchSize: 5, domainType: "shopping" });
  const saved = await waitForJobStatus(service, job.id, "completed");

  assert.equal(job.status, "queued");
  assert.equal(saved.id, job.id);
  assert.equal(saved.status, "completed");
  assert.equal(saved.generatedCount, 1);
  assert.equal(saved.trainedCount, 1);
  assert.equal(trainCalls.length, 1);
  assert.ok(fs.existsSync(path.join(dir, "jobs.json")));
});
