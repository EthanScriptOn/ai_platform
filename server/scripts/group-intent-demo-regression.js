#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const DEFAULTS = {
  predictUrl: process.env.GROUP_INTENT_PREDICT_URL || "http://47.104.81.250/api/group-intent/predict",
  qwenLabelUrl: process.env.GROUP_INTENT_QWEN_LABEL_URL || "http://47.104.81.250/api/group-intent/qwen-label",
  batchSize: Number(process.env.GROUP_INTENT_BATCH_SIZE || 5),
  requestRetryCount: Number(process.env.GROUP_INTENT_REQUEST_RETRY_COUNT || 3),
  requestRetryDelayMs: Number(process.env.GROUP_INTENT_REQUEST_RETRY_DELAY_MS || 3000),
  requestTimeoutMs: Number(process.env.GROUP_INTENT_REQUEST_TIMEOUT_MS || 60000),
};

const DEMO_CASES = [
  { category: "explicit_consult", expected: "intervene", text: "帮宝适哪个系列呢", note: "明确询问商品选择" },
  { category: "explicit_consult", expected: "intervene", text: "求推荐一款适合新生儿的纸尿裤", note: "明确求推荐" },
  { category: "explicit_consult", expected: "intervene", text: "这个值得买吗", note: "直接询问是否值得买" },
  { category: "explicit_consult", expected: "intervene", text: "这款奶粉能买吗", note: "直接询问能不能买" },
  { category: "explicit_consult", expected: "intervene", text: "这个链接还有吗", note: "直接求链接" },
  { category: "explicit_consult", expected: "intervene", text: "@羊咩咩 这种你有没有", note: "群内找货" },

  { category: "implicit_intent", expected: "intervene", text: "我再补货板蓝根和柴胡", note: "隐式补货意图" },
  { category: "implicit_intent", expected: "intervene", text: "如果有好的价格出来 得退了才能买得了了", note: "等待好价购买" },
  { category: "implicit_intent", expected: "intervene", text: "这个价格我就冲了", note: "强购买倾向" },
  { category: "implicit_intent", expected: "intervene", text: "家里快没了 再囤点", note: "补货/囤货意图" },
  { category: "implicit_intent", expected: "intervene", text: "想给宝宝买个夏天薄一点的睡袋", note: "明确购买需求" },
  { category: "implicit_intent", expected: "intervene", text: "这款合适一岁宝宝吗", note: "购买前适配咨询" },

  { category: "coupon_price", expected: "intervene", text: "请问这个保姆鹅店铺券怎么领啊 我进去也没券", note: "求领券方式" },
  { category: "coupon_price", expected: "intervene", text: "这个券怎么抢", note: "求抢券指导" },
  { category: "coupon_price", expected: "intervene", text: "还有更好的价格吗", note: "求更优价格" },
  { category: "coupon_price", expected: "intervene", text: "这个要凑单吗", note: "下单策略咨询" },
  { category: "coupon_price", expected: "intervene", text: "这个会员价怎么买最划算", note: "求购买方案" },
  { category: "coupon_price", expected: "intervene", text: "这个今天还能买到最低价吗", note: "价格型咨询" },

  { category: "group_buy", expected: "intervene", text: "需要和我拼的提前说，转钱预留名额", note: "拼单/代拍组织" },
  { category: "group_buy", expected: "intervene", text: "要买基诺浦鞋卡的要抢下", note: "组织购买动作" },
  { category: "group_buy", expected: "intervene", text: "缺个凑单的姐妹", note: "求凑单" },
  { category: "group_buy", expected: "intervene", text: "有人一起拼吗", note: "求拼单" },
  { category: "group_buy", expected: "intervene", text: "这个我要跟一单", note: "明确跟单购买" },
  { category: "group_buy", expected: "intervene", text: "想拼一双 有人要吗", note: "共同购买意图" },

  { category: "promo_broadcast", expected: "ignore", text: "领600-80美妆加补卷", note: "单纯促销播报" },
  { category: "promo_broadcast", expected: "ignore", text: "美妆加补卷 /4Xe6g5CUaVK/ MU918/", note: "促销口令播报" },
  { category: "promo_broadcast", expected: "ignore", text: "全是瓶装香氛洗衣液 618最后一天啦", note: "纯促销信息" },
  { category: "promo_broadcast", expected: "ignore", text: "低卡饱腹强 体重管理佳 贝贝板栗南瓜5斤 7.8", note: "商品宣传文案" },
  { category: "promo_broadcast", expected: "ignore", text: "最后1天开plus年卡 错过无", note: "促销提醒" },
  { category: "promo_broadcast", expected: "ignore", text: "速囤 薇尔卫生巾组合好价", note: "喊单文案" },

  { category: "casual_chat", expected: "ignore", text: "@miku 三倍补有没有领一下", note: "活动讨论，不是购买咨询" },
  { category: "casual_chat", expected: "ignore", text: "看账号", note: "上下文依赖短句" },
  { category: "casual_chat", expected: "ignore", text: "我自己穿哈哈", note: "闲聊回应" },
  { category: "casual_chat", expected: "ignore", text: "今晚淘宝持续15分钟", note: "信息播报" },
  { category: "casual_chat", expected: "ignore", text: "最近好多生二胎的呀", note: "普通闲聊" },
  { category: "casual_chat", expected: "ignore", text: "我再发一下", note: "会话衔接语" },

  { category: "experience_sharing", expected: "ignore", text: "连续买四年了 好吃到被好多姐妹记住", note: "使用/购买体验分享" },
  { category: "experience_sharing", expected: "ignore", text: "去年买过的 直接拍两份", note: "自述购买行为" },
  { category: "experience_sharing", expected: "ignore", text: "奶粉好像没那么好消化 比较撑肚子", note: "体验反馈" },
  { category: "experience_sharing", expected: "ignore", text: "不粘腻 很好吸收 也很快成膜", note: "肤感体验" },
  { category: "experience_sharing", expected: "ignore", text: "还有帕玑防晒防紫外线测试 我都给大家录视频了", note: "经验分享" },
  { category: "experience_sharing", expected: "ignore", text: "看到榴莲就走不动路", note: "情绪表达" },
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

async function main() {
  const startedAt = new Date();
  const rows = [];

  for (const batch of chunk(DEMO_CASES, DEFAULTS.batchSize)) {
    const input = batch.map((item) => item.text).join("\n");
    const [predictPayload, qwenPayload] = await Promise.all([
      postJson(DEFAULTS.predictUrl, { input }),
      postJson(DEFAULTS.qwenLabelUrl, { input }),
    ]);
    const predictItems = predictPayload.items || [];
    const qwenItems = qwenPayload.items || [];

    for (let index = 0; index < batch.length; index += 1) {
      rows.push({
        ...batch[index],
        predicted: predictItems[index]?.label === "intervene" ? "intervene" : "ignore",
        predictedConfidence: Number(predictItems[index]?.confidence || 0),
        predictedReason: String(predictItems[index]?.reason || "").trim(),
        qwenLabel: qwenItems[index]?.label === "intervene" ? "intervene" : "ignore",
        qwenReason: String(qwenItems[index]?.reason || "").trim(),
      });
    }
  }

  const categoryNames = [...new Set(rows.map((item) => item.category))];
  const categoryScores = categoryNames.map((category) => {
    const items = rows.filter((item) => item.category === category);
    return {
      category,
      count: items.length,
      model: computeMetrics(items, "predicted"),
      qwen: computeMetrics(items, "qwenLabel"),
    };
  });

  const report = {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    config: DEFAULTS,
    summary: {
      totalCases: rows.length,
      model: computeMetrics(rows, "predicted"),
      qwen: computeMetrics(rows, "qwenLabel"),
      modelQwenAgreement: safeDivide(
        rows.filter((item) => item.predicted === item.qwenLabel).length,
        rows.length
      ),
    },
    categoryScores,
    modelMistakes: rows.filter((item) => item.predicted !== item.expected),
    qwenMistakes: rows.filter((item) => item.qwenLabel !== item.expected),
    rows,
  };

  const outputDir = path.join(process.cwd(), "runtime", "group-intent-demo-regression");
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
        qwen: {
          ...report.summary.qwen,
          accuracyPct: formatPercent(report.summary.qwen.accuracy),
          precisionPct: formatPercent(report.summary.qwen.precision),
          recallPct: formatPercent(report.summary.qwen.recall),
          f1Pct: formatPercent(report.summary.qwen.f1),
        },
        modelQwenAgreementPct: formatPercent(report.summary.modelQwenAgreement),
        modelMistakes: report.modelMistakes.map((item) => ({
          category: item.category,
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
