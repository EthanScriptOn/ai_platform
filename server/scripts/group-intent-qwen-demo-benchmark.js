#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const DEFAULTS = {
  qwenSamplesUrl: process.env.GROUP_INTENT_QWEN_SAMPLES_URL || "http://47.104.81.250/api/group-intent/qwen-samples",
  qwenLabelUrl: process.env.GROUP_INTENT_QWEN_LABEL_URL || "http://47.104.81.250/api/group-intent/qwen-label",
  predictUrl: process.env.GROUP_INTENT_PREDICT_URL || "http://47.104.81.250/api/group-intent/predict",
  batchSize: Number(process.env.GROUP_INTENT_BATCH_SIZE || 5),
  requestRetryCount: Number(process.env.GROUP_INTENT_REQUEST_RETRY_COUNT || 3),
  requestRetryDelayMs: Number(process.env.GROUP_INTENT_REQUEST_RETRY_DELAY_MS || 3000),
  requestTimeoutMs: Number(process.env.GROUP_INTENT_REQUEST_TIMEOUT_MS || 60000),
  scenarioCount: Number(process.env.GROUP_INTENT_QWEN_DEMO_SCENARIO_COUNT || 12),
};

const SCENARIOS = [
  {
    name: "implicit_intent",
    domainType: "母婴群隐式购买意图、补货、想买、值不值得买",
  },
  {
    name: "coupon_price",
    domainType: "母婴群领券问价、最低价、凑单、怎么买更划算",
  },
  {
    name: "group_buy",
    domainType: "母婴群拼单、跟单、缺凑单、一起买",
  },
  {
    name: "promo_vs_chat",
    domainType: "母婴群促销播报、体验分享、普通闲聊，对照购买咨询",
  },
];

function timestampLabel(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function chunk(items = [], size = 10) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(url, payload) {
  let lastError = null;
  for (let attempt = 1; attempt <= Math.max(1, DEFAULTS.requestRetryCount); attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1000, DEFAULTS.requestTimeoutMs));
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify(payload),
      });
      const text = await response.text();
      if (!response.ok) {
        const error = new Error(`${url} -> HTTP ${response.status}: ${text}`);
        error.status = response.status;
        throw error;
      }
      return text ? JSON.parse(text) : {};
    } catch (error) {
      if (error?.name === "AbortError") {
        lastError = new Error(`${url} -> request timeout after ${DEFAULTS.requestTimeoutMs}ms`);
        lastError.code = "REQUEST_TIMEOUT";
      } else {
        lastError = error;
      }
      const shouldRetry =
        attempt < DEFAULTS.requestRetryCount &&
        (!lastError.status ||
          lastError.code === "REQUEST_TIMEOUT" ||
          [502, 503, 504].includes(Number(lastError.status)));
      if (!shouldRetry) throw lastError;
      await sleep(DEFAULTS.requestRetryDelayMs * attempt);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

function safeDivide(a, b) {
  return b ? a / b : 0;
}

function computeMetrics(rows = [], labelKey = "predicted") {
  let tp = 0;
  let tn = 0;
  let fp = 0;
  let fn = 0;

  for (const row of rows) {
    const expected = row.expected;
    const predicted = row[labelKey];
    if (expected === "intervene" && predicted === "intervene") tp += 1;
    if (expected === "ignore" && predicted === "ignore") tn += 1;
    if (expected === "ignore" && predicted === "intervene") fp += 1;
    if (expected === "intervene" && predicted === "ignore") fn += 1;
  }

  const total = rows.length;
  const accuracy = safeDivide(tp + tn, total);
  const precision = safeDivide(tp, tp + fp);
  const recall = safeDivide(tp, tp + fn);
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;

  return { total, tp, tn, fp, fn, accuracy, precision, recall, f1 };
}

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

async function generateScenarioSamples(scenario) {
  const payload = {
    count: Math.max(1, DEFAULTS.scenarioCount),
    domainType: scenario.domainType,
  };
  const result = await postJson(DEFAULTS.qwenSamplesUrl, payload);
  const items = Array.isArray(result.items) ? result.items : [];
  return items.map((item, index) => ({
    scenario: scenario.name,
    scenarioPrompt: scenario.domainType,
    index,
    text: String(item.text || "").trim(),
    raw: String(item.raw || "").trim(),
    expected: item.label === "intervene" ? "intervene" : "ignore",
    reason: String(item.reason || "").trim(),
    speaker: String(item.speaker || "").trim(),
  }));
}

async function main() {
  const startedAt = new Date();
  const generatedRows = [];

  for (const scenario of SCENARIOS) {
    const items = await generateScenarioSamples(scenario);
    generatedRows.push(...items);
  }

  const dedupedRows = [];
  const seenTexts = new Set();
  for (const row of generatedRows) {
    if (!row.text || seenTexts.has(row.text)) continue;
    seenTexts.add(row.text);
    dedupedRows.push(row);
  }

  for (const batch of chunk(dedupedRows, DEFAULTS.batchSize)) {
    const input = batch.map((item) => item.text).join("\n");
    const [predictPayload, qwenLabelPayload] = await Promise.all([
      postJson(DEFAULTS.predictUrl, { input }),
      postJson(DEFAULTS.qwenLabelUrl, { input }),
    ]);
    const predictItems = predictPayload.items || [];
    const qwenItems = qwenLabelPayload.items || [];

    for (let index = 0; index < batch.length; index += 1) {
      batch[index].predicted = predictItems[index]?.label === "intervene" ? "intervene" : "ignore";
      batch[index].predictedConfidence = Number(predictItems[index]?.confidence || 0);
      batch[index].predictedReason = String(predictItems[index]?.reason || "").trim();
      batch[index].qwenReviewLabel = qwenItems[index]?.label === "intervene" ? "intervene" : "ignore";
      batch[index].qwenReviewReason = String(qwenItems[index]?.reason || "").trim();
    }
  }

  const scenarioScores = SCENARIOS.map((scenario) => {
    const rows = dedupedRows.filter((item) => item.scenario === scenario.name);
    return {
      scenario: scenario.name,
      prompt: scenario.domainType,
      count: rows.length,
      model: computeMetrics(rows, "predicted"),
      qwenReview: computeMetrics(rows, "qwenReviewLabel"),
    };
  });

  const report = {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    config: DEFAULTS,
    summary: {
      totalCases: dedupedRows.length,
      model: computeMetrics(dedupedRows, "predicted"),
      qwenReview: computeMetrics(dedupedRows, "qwenReviewLabel"),
      modelQwenReviewAgreement: safeDivide(
        dedupedRows.filter((item) => item.predicted === item.qwenReviewLabel).length,
        dedupedRows.length
      ),
    },
    scenarioScores,
    modelMistakes: dedupedRows.filter((item) => item.predicted !== item.expected),
    qwenReviewMistakes: dedupedRows.filter((item) => item.qwenReviewLabel !== item.expected),
    rows: dedupedRows,
  };

  const outputDir = path.join(process.cwd(), "runtime", "group-intent-qwen-demo-benchmark");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `report-${timestampLabel(startedAt)}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf-8");

  console.log(
    JSON.stringify(
      {
        outputPath,
        totalCases: report.summary.totalCases,
        model: {
          ...report.summary.model,
          accuracyPct: formatPercent(report.summary.model.accuracy),
          precisionPct: formatPercent(report.summary.model.precision),
          recallPct: formatPercent(report.summary.model.recall),
          f1Pct: formatPercent(report.summary.model.f1),
        },
        qwenReview: {
          ...report.summary.qwenReview,
          accuracyPct: formatPercent(report.summary.qwenReview.accuracy),
          precisionPct: formatPercent(report.summary.qwenReview.precision),
          recallPct: formatPercent(report.summary.qwenReview.recall),
          f1Pct: formatPercent(report.summary.qwenReview.f1),
        },
        modelQwenReviewAgreementPct: formatPercent(report.summary.modelQwenReviewAgreement),
        scenarioScores: scenarioScores.map((item) => ({
          scenario: item.scenario,
          count: item.count,
          modelF1Pct: formatPercent(item.model.f1),
          modelRecallPct: formatPercent(item.model.recall),
        })),
        modelMistakes: report.modelMistakes.slice(0, 20).map((item) => ({
          scenario: item.scenario,
          expected: item.expected,
          predicted: item.predicted,
          confidence: item.predictedConfidence,
          text: item.text,
        })),
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
