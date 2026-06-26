"use strict";

const fs = require("fs");
const { extractJsonFromText } = require("./data_utils");

function parseGroupIntentMessage(line = "", index = 0) {
  const raw = String(line || "").trim();
  if (!raw) return null;
  const match = raw.match(/^([^:：]{1,24})[:：]\s*(.+)$/);
  return match
    ? { index, speaker: match[1].trim(), text: match[2].trim(), raw }
    : { index, speaker: "", text: raw, raw };
}

function parseGroupIntentInput(input = "") {
  return String(input || "")
    .split(/\n+/)
    .map((line, index) => parseGroupIntentMessage(line, index))
    .filter(Boolean)
    .slice(0, 500);
}

function tokenizeGroupIntentText(text = "") {
  const compact = String(text || "")
    .toLowerCase()
    .replace(/[^\p{Script=Han}a-z0-9]+/gu, " ")
    .trim();
  const tokens = new Set();
  for (const word of compact.split(/\s+/).filter(Boolean)) {
    tokens.add(word);
    if (/^[\p{Script=Han}]+$/u.test(word)) {
      for (const char of word) tokens.add(char);
      for (let i = 0; i < word.length - 1; i += 1) tokens.add(word.slice(i, i + 2));
    }
  }
  return [...tokens];
}

function buildGroupIntentFeatureCounts(text = "") {
  const compact = String(text || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .trim();
  const counts = {};
  for (const token of tokenizeGroupIntentText(text)) {
    counts[`tok:${token}`] = (counts[`tok:${token}`] || 0) + 1;
  }
  for (let i = 0; i < compact.length; i += 1) {
    counts[`char:${compact[i]}`] = (counts[`char:${compact[i]}`] || 0) + 1;
  }
  for (let n = 2; n <= 4; n += 1) {
    for (let i = 0; i <= compact.length - n; i += 1) {
      const gram = compact.slice(i, i + n);
      counts[`gram${n}:${gram}`] = (counts[`gram${n}:${gram}`] || 0) + 1;
    }
  }
  return counts;
}

function sigmoid(value) {
  if (value >= 0) {
    const z = Math.exp(-value);
    return 1 / (1 + z);
  }
  const z = Math.exp(value);
  return z / (1 + z);
}

function createGroupIntentFastTextModel(samples, trainedAt = new Date().toISOString()) {
  const normalizedSamples = samples
    .map((sample) => ({
      ...sample,
      label: sample.label === "intervene" ? "intervene" : "ignore",
      text: String(sample.text || "").trim(),
    }))
    .filter((sample) => sample.text);
  if (!normalizedSamples.length) throw new Error("没有可训练的样本。");

  const labels = ["intervene", "ignore"];
  const classCounts = { intervene: 0, ignore: 0 };
  const featureDocCounts = { intervene: {}, ignore: {} };
  const allFeatures = new Set();
  const rows = normalizedSamples.map((sample) => {
    const featureCounts = buildGroupIntentFeatureCounts(sample.text);
    const label = sample.label === "intervene" ? "intervene" : "ignore";
    classCounts[label] += 1;
    for (const feature of Object.keys(featureCounts)) {
      allFeatures.add(feature);
      featureDocCounts[label][feature] = (featureDocCounts[label][feature] || 0) + 1;
    }
    return { label, featureCounts };
  });

  const totalSamples = rows.length;
  const sampleBalance = {
    intervene: totalSamples / (2 * Math.max(1, classCounts.intervene)),
    ignore: totalSamples / (2 * Math.max(1, classCounts.ignore)),
  };
  const weights = {};
  let bias = Math.log((classCounts.intervene + 1) / (classCounts.ignore + 1));
  const epochs = 22;
  const learningRate = 0.32;
  const l2 = 0.00006;

  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const shuffled = rows.slice().sort(() => Math.random() - 0.5);
    const epochRate = learningRate * (1 - epoch / Math.max(1, epochs));
    for (const row of shuffled) {
      const target = row.label === "intervene" ? 1 : 0;
      let score = bias;
      for (const [feature, count] of Object.entries(row.featureCounts)) {
        score += (weights[feature] || 0) * count;
      }
      const prediction = sigmoid(score);
      const error = (target - prediction) * sampleBalance[row.label];
      bias += epochRate * error;
      for (const [feature, count] of Object.entries(row.featureCounts)) {
        const current = weights[feature] || 0;
        weights[feature] = current + epochRate * ((error * count) - l2 * current);
      }
    }
  }

  const vocabulary = [...allFeatures];
  const topFeatures = labels.reduce((acc, label) => {
    const direction = label === "intervene" ? 1 : -1;
    acc[label] = vocabulary
      .map((feature) => ({
        feature,
        weight: Number((weights[feature] || 0).toFixed(6)),
        docCount: featureDocCounts[label][feature] || 0,
      }))
      .filter((item) => item.docCount > 0 && item.weight * direction > 0)
      .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
      .slice(0, 200);
    return acc;
  }, {});

  return {
    algorithm: "fasttext",
    task: "group_product_recommendation_intent",
    labels,
    updatedAt: trainedAt,
    sampleCount: normalizedSamples.length,
    classCounts,
    bias: Number(bias.toFixed(6)),
    learningRate,
    epochs,
    l2,
    vocabularySize: vocabulary.length,
    weights,
    topFeatures,
  };
}

function predictGroupIntentRow(row, model) {
  const featureCounts = buildGroupIntentFeatureCounts(row.text);
  let score = Number(model.bias || 0);
  const contributors = [];
  for (const [feature, count] of Object.entries(featureCounts)) {
    const weight = Number(model.weights?.[feature] || 0);
    if (!weight) continue;
    const impact = weight * count;
    score += impact;
    contributors.push({ feature, impact, count });
  }
  const interveneProbability = sigmoid(score);
  const label = interveneProbability >= 0.5 ? "intervene" : "ignore";
  const confidence = label === "intervene" ? interveneProbability : 1 - interveneProbability;
  const evidence = contributors
    .filter((item) => (label === "intervene" ? item.impact > 0 : item.impact < 0))
    .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact))
    .map((item) => item.feature.replace(/^(tok|char|gram\d+):/, ""))
    .filter((item) => item && item.length >= 2)
    .filter((item, index, array) => array.indexOf(item) === index)
    .slice(0, 4);

  return {
    ...row,
    label,
    shouldIntervene: label === "intervene",
    confidence,
    reason: evidence.length
      ? `依据消息中的关键词片段：${evidence.join("、")}。置信度 ${Math.round(confidence * 100)}%。`
      : `结合整条消息判断。置信度 ${Math.round(confidence * 100)}%。`,
  };
}

function createGroupIntentModelService({
  GROUP_INTENT_DIR,
  GROUP_INTENT_LEGACY_MODEL_PATH,
  GROUP_INTENT_MODEL_PATH,
  GROUP_INTENT_QWEN_MODEL,
  GROUP_INTENT_SAMPLES_PATH,
  QWEN_API_KEY,
  QWEN_API_URL,
  fetchImpl = fetch,
}) {
  async function labelGroupIntentWithQwen(input = "") {
    if (!QWEN_API_KEY) throw new Error("缺少 QWEN_API_KEY 或 DASHSCOPE_API_KEY。");
    const rows = parseGroupIntentInput(input);
    if (!rows.length) return { items: [], model: GROUP_INTENT_QWEN_MODEL };

    const messages = [
      {
        role: "system",
        content:
          "你是群聊商品意图标注员。只判断每一条消息是否需要商品/购买相关介入。用户问买什么、选哪个、哪款好、有没有推荐、怎么选、有没有链接、求链接、在哪里买、怎么买、之前/刚才那款哪里买、帮忙发入口，标 intervene。普通闲聊、单纯分享体验、售后物流、表情寒暄、不涉及购买动作的闲聊，标 ignore。必须只返回 JSON 数组。",
      },
      {
        role: "user",
        content: [
          "请标注下面群聊消息。返回 JSON 数组，每项包含 index、label、reason。",
          "label 只能是 intervene 或 ignore。",
          "消息：",
          JSON.stringify(rows.map((item) => ({ index: item.index, speaker: item.speaker, text: item.text }))),
        ].join("\n"),
      },
    ];

    const response = await fetchImpl(QWEN_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${QWEN_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROUP_INTENT_QWEN_MODEL,
        messages,
        temperature: 0,
        response_format: { type: "json_object" },
      }),
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error(payload?.error?.message || payload?.message || text || `千问 HTTP ${response.status}`);
    }
    const content = payload?.choices?.[0]?.message?.content || "";
    const parsed = extractJsonFromText(content);
    const labels = Array.isArray(parsed) ? parsed : Array.isArray(parsed.items) ? parsed.items : [];
    const byIndex = new Map(labels.map((item) => [Number(item.index), item]));

    return {
      model: GROUP_INTENT_QWEN_MODEL,
      items: rows.map((row) => {
        const labeled = byIndex.get(row.index) || {};
        const label = labeled.label === "intervene" ? "intervene" : "ignore";
        return {
          ...row,
          label,
          shouldIntervene: label === "intervene",
          reason: String(labeled.reason || "").trim(),
        };
      }),
    };
  }

  function readGroupIntentSamples() {
    if (!fs.existsSync(GROUP_INTENT_SAMPLES_PATH)) return [];
    return fs
      .readFileSync(GROUP_INTENT_SAMPLES_PATH, "utf-8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  function trainGroupIntentFastText(items = []) {
    const baseItems = items
      .map((item, index) => ({
        sampleId: String(item.sampleId || `${Date.now()}-${index}`),
        index: Number.isFinite(Number(item.index)) ? Number(item.index) : index,
        speaker: String(item.speaker || "").trim(),
        text: String(item.text || "").trim(),
        raw: String(item.raw || item.text || "").trim(),
        label: item.label === "intervene" ? "intervene" : "ignore",
        reason: String(item.reason || "").trim(),
      }))
      .filter((item) => item.text);
    if (!baseItems.length) throw new Error("没有可训练的样本。");
    const validItems = baseItems;

    fs.mkdirSync(GROUP_INTENT_DIR, { recursive: true });
    const trainedAt = new Date().toISOString();
    fs.appendFileSync(
      GROUP_INTENT_SAMPLES_PATH,
      validItems.map((item) => JSON.stringify({ ...item, trainedAt })).join("\n") + "\n",
      "utf-8"
    );
    const allSamples = readGroupIntentSamples();
    const model = createGroupIntentFastTextModel(allSamples, trainedAt);
    fs.writeFileSync(GROUP_INTENT_MODEL_PATH, JSON.stringify(model, null, 2), "utf-8");
    return {
      ok: true,
      trainedCount: validItems.length,
      totalSamples: allSamples.length,
      modelPath: GROUP_INTENT_MODEL_PATH,
      samplesPath: GROUP_INTENT_SAMPLES_PATH,
      classCounts: model.classCounts,
    };
  }

  function ensureGroupIntentModel() {
    const candidates = [GROUP_INTENT_MODEL_PATH, GROUP_INTENT_LEGACY_MODEL_PATH];
    for (const modelPath of candidates) {
      if (!fs.existsSync(modelPath)) continue;
      try {
        const model = JSON.parse(fs.readFileSync(modelPath, "utf-8"));
        if (model?.algorithm === "fasttext" && model?.weights) {
          if (modelPath !== GROUP_INTENT_MODEL_PATH) {
            fs.writeFileSync(GROUP_INTENT_MODEL_PATH, JSON.stringify(model, null, 2), "utf-8");
          }
          return model;
        }
      } catch {
        // Fall through to rebuild from samples.
      }
    }
    const samples = readGroupIntentSamples();
    if (!samples.length) {
      throw new Error("还没有可用模型，请先用人工确认后的样本参与训练。");
    }
    const rebuilt = createGroupIntentFastTextModel(samples);
    fs.mkdirSync(GROUP_INTENT_DIR, { recursive: true });
    fs.writeFileSync(GROUP_INTENT_MODEL_PATH, JSON.stringify(rebuilt, null, 2), "utf-8");
    return rebuilt;
  }

  function predictGroupIntent(input = "") {
    const rows = parseGroupIntentInput(input);
    if (!rows.length) return { items: [], model: null };
    const model = ensureGroupIntentModel();
    return {
      model: {
        algorithm: model.algorithm || "fasttext",
        updatedAt: model.updatedAt || "",
        sampleCount: model.sampleCount || 0,
      },
      items: rows.map((row) => predictGroupIntentRow(row, model)),
    };
  }

  return {
    ensureGroupIntentModel,
    labelGroupIntentWithQwen,
    predictGroupIntent,
    readGroupIntentSamples,
    trainGroupIntentFastText,
  };
}

module.exports = {
  buildGroupIntentFeatureCounts,
  createGroupIntentFastTextModel,
  createGroupIntentModelService,
  parseGroupIntentInput,
  parseGroupIntentMessage,
  predictGroupIntentRow,
  sigmoid,
  tokenizeGroupIntentText,
};
