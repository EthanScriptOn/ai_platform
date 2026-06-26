"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  buildGroupIntentFeatureCounts,
  createGroupIntentFastTextModel,
  createGroupIntentModelService,
  parseGroupIntentInput,
  parseGroupIntentMessage,
  predictGroupIntentRow,
} = require("./group_intent_model");

function createTempService(fetchImpl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "group-intent-model-test-"));
  return {
    dir,
    service: createGroupIntentModelService({
      GROUP_INTENT_DIR: dir,
      GROUP_INTENT_LEGACY_MODEL_PATH: path.join(dir, "legacy.json"),
      GROUP_INTENT_MODEL_PATH: path.join(dir, "model.json"),
      GROUP_INTENT_QWEN_MODEL: "qwen-test",
      GROUP_INTENT_SAMPLES_PATH: path.join(dir, "samples.jsonl"),
      QWEN_API_KEY: "test-key",
      QWEN_API_URL: "https://example.test/chat",
      fetchImpl,
    }),
  };
}

test("parseGroupIntentInput keeps speakers and drops blank lines", () => {
  assert.deepEqual(parseGroupIntentMessage("小月：这个怎么买", 3), {
    index: 3,
    speaker: "小月",
    text: "这个怎么买",
    raw: "小月：这个怎么买",
  });
  assert.deepEqual(parseGroupIntentInput("小月：这个怎么买\n\n普通一句话"), [
    { index: 0, speaker: "小月", text: "这个怎么买", raw: "小月：这个怎么买" },
    { index: 1, speaker: "", text: "普通一句话", raw: "普通一句话" },
  ]);
});

test("buildGroupIntentFeatureCounts emits token, char, and gram features", () => {
  const counts = buildGroupIntentFeatureCounts("求推荐奶瓶");

  assert.equal(counts["tok:求推荐奶瓶"], 1);
  assert.equal(counts["char:求"], 1);
  assert.equal(counts["gram2:推荐"], 1);
});

test("createGroupIntentFastTextModel and predictGroupIntentRow return prediction shape", () => {
  const model = createGroupIntentFastTextModel(
    [
      { text: "这个奶瓶在哪里买 求链接", label: "intervene" },
      { text: "宝宝今天睡得很好", label: "ignore" },
    ],
    "2026-01-01T00:00:00.000Z"
  );
  const prediction = predictGroupIntentRow({ index: 0, speaker: "", text: "求链接", raw: "求链接" }, model);

  assert.equal(model.algorithm, "fasttext");
  assert.equal(model.sampleCount, 2);
  assert.ok(["intervene", "ignore"].includes(prediction.label));
  assert.equal(typeof prediction.confidence, "number");
  assert.equal(prediction.shouldIntervene, prediction.label === "intervene");
});

test("service trains to temp files and predicts from persisted model", () => {
  const { dir, service } = createTempService();
  const result = service.trainGroupIntentFastText([
    { text: "这款尿不湿怎么买", label: "intervene" },
    { text: "今天太阳不错", label: "ignore" },
  ]);
  const prediction = service.predictGroupIntent("妈妈：这款怎么买");

  assert.equal(result.ok, true);
  assert.equal(result.totalSamples, 2);
  assert.ok(fs.existsSync(path.join(dir, "samples.jsonl")));
  assert.ok(fs.existsSync(path.join(dir, "model.json")));
  assert.equal(prediction.items.length, 1);
  assert.equal(prediction.model.algorithm, "fasttext");
});

test("labelGroupIntentWithQwen maps model labels back to parsed rows", async () => {
  const requests = [];
  const { service } = createTempService(async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      async text() {
        return JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  items: [{ index: 0, label: "intervene", reason: "求购买入口" }],
                }),
              },
            },
          ],
        });
      },
    };
  });

  const result = await service.labelGroupIntentWithQwen("小月：求链接");

  assert.equal(requests.length, 1);
  assert.equal(result.model, "qwen-test");
  assert.deepEqual(result.items, [
    {
      index: 0,
      speaker: "小月",
      text: "求链接",
      raw: "小月：求链接",
      label: "intervene",
      shouldIntervene: true,
      reason: "求购买入口",
    },
  ]);
});
