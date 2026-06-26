"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { extractJsonFromText } = require("./data_utils");

function reqSocketKeepAlive(res) {
  try {
    res.socket?.setKeepAlive?.(true);
    res.socket?.setTimeout?.(0);
  } catch {
    // Best-effort only; SSE still works without explicit socket tuning.
  }
}

function createGroupIntentAutoTrainService({
  GROUP_INTENT_AUTO_TRAIN_JOBS_PATH,
  GROUP_INTENT_DIR,
  GROUP_INTENT_DOMAIN_PRESETS,
  GROUP_INTENT_QWEN_MODEL,
  ROOT,
  callQwenChat,
  ensureGroupIntentMysqlSchema,
  isAiAdminMysqlEnabled,
  runAiAdminMysql,
  sqlDate,
  sqlString,
  trainGroupIntentFastText,
}) {
  const runningJobs = new Set();

  function loadGroupIntentAutoTrainJobs() {
    if (isAiAdminMysqlEnabled()) {
      ensureGroupIntentMysqlSchema();
      let rows = runAiAdminMysql(`
SELECT id,status,target_count,batch_size,generated_count,trained_count,IFNULL(total_samples,''),IFNULL(class_counts_json,''),IFNULL(message,''),IFNULL(error_text,''),created_at,updated_at,IFNULL(started_at,''),IFNULL(finished_at,''),IFNULL(domain_type,'mother_baby')
FROM group_intent_auto_train_jobs
ORDER BY created_at DESC
LIMIT 50;
`);
      if (!rows.trim()) {
        migrateGroupIntentFileJobsToMysql();
        rows = runAiAdminMysql(`
SELECT id,status,target_count,batch_size,generated_count,trained_count,IFNULL(total_samples,''),IFNULL(class_counts_json,''),IFNULL(message,''),IFNULL(error_text,''),created_at,updated_at,IFNULL(started_at,''),IFNULL(finished_at,''),IFNULL(domain_type,'mother_baby')
FROM group_intent_auto_train_jobs
ORDER BY created_at DESC
LIMIT 50;
`);
      }
      return rows
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const parts = line.split("\t");
          return {
            id: parts[0],
            status: parts[1],
            targetCount: Number(parts[2] || 0),
            batchSize: Number(parts[3] || 25),
            generatedCount: Number(parts[4] || 0),
            trainedCount: Number(parts[5] || 0),
            totalSamples: parts[6] === "" ? null : Number(parts[6] || 0),
            classCounts: parts[7] ? JSON.parse(parts[7]) : null,
            message: parts[8] || "",
            error: parts[9] || "",
            createdAt: parts[10] || "",
            updatedAt: parts[11] || "",
            startedAt: parts[12] || "",
            finishedAt: parts[13] || "",
            domainType: parts[14] || "mother_baby",
          };
        });
    }
    if (!fs.existsSync(GROUP_INTENT_AUTO_TRAIN_JOBS_PATH)) return [];
    try {
      const data = JSON.parse(fs.readFileSync(GROUP_INTENT_AUTO_TRAIN_JOBS_PATH, "utf-8"));
      return Array.isArray(data.jobs) ? data.jobs : [];
    } catch {
      return [];
    }
  }

  function readGroupIntentJobsFile(filePath) {
    if (!fs.existsSync(filePath)) return [];
    try {
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      return Array.isArray(data.jobs) ? data.jobs : [];
    } catch {
      return [];
    }
  }

  function migrateGroupIntentFileJobsToMysql() {
    if (!isAiAdminMysqlEnabled()) return;
    const candidates = [
      GROUP_INTENT_AUTO_TRAIN_JOBS_PATH,
      "/opt/yuebai-ai-platform/current/data/group-intent/auto_train_jobs.json",
      path.join(ROOT, "data", "group-intent", "auto_train_jobs.json"),
    ];
    const releasesDir = "/opt/yuebai-ai-platform/releases";
    if (fs.existsSync(releasesDir)) {
      for (const release of fs.readdirSync(releasesDir)) {
        candidates.push(path.join(releasesDir, release, "data", "group-intent", "auto_train_jobs.json"));
        const nestedDir = path.join(releasesDir, release);
        try {
          for (const child of fs.readdirSync(nestedDir)) {
            candidates.push(path.join(nestedDir, child, "data", "group-intent", "auto_train_jobs.json"));
          }
        } catch {
          // Ignore non-directory releases.
        }
      }
    }
    const jobs = candidates.flatMap(readGroupIntentJobsFile);
    const unique = new Map(jobs.filter((job) => job?.id).map((job) => [job.id, job]));
    for (const job of unique.values()) {
      upsertGroupIntentAutoTrainJob(job);
    }
  }

  function saveGroupIntentAutoTrainJobs(jobs = []) {
    if (isAiAdminMysqlEnabled()) {
      ensureGroupIntentMysqlSchema();
      for (const job of jobs) {
        upsertGroupIntentAutoTrainJob(job);
      }
      return;
    }
    fs.mkdirSync(GROUP_INTENT_DIR, { recursive: true });
    fs.writeFileSync(
      GROUP_INTENT_AUTO_TRAIN_JOBS_PATH,
      JSON.stringify({ jobs: jobs.slice(-50) }, null, 2),
      "utf-8"
    );
  }

  function upsertGroupIntentAutoTrainJob(job) {
    if (!isAiAdminMysqlEnabled()) return;
    ensureGroupIntentMysqlSchema();
    runAiAdminMysql(`
INSERT INTO group_intent_auto_train_jobs (
  id,status,target_count,batch_size,generated_count,trained_count,total_samples,class_counts_json,message,error_text,created_at,updated_at,started_at,finished_at,domain_type
) VALUES (
  ${sqlString(job.id)},
  ${sqlString(job.status || "queued")},
  ${Number(job.targetCount || 0)},
  ${Number(job.batchSize || 25)},
  ${Number(job.generatedCount || 0)},
  ${Number(job.trainedCount || 0)},
  ${job.totalSamples == null ? "NULL" : Number(job.totalSamples || 0)},
  ${job.classCounts ? sqlString(JSON.stringify(job.classCounts)) : "NULL"},
  ${sqlString(job.message || "")},
  ${sqlString(job.error || "")},
  ${sqlDate(job.createdAt || new Date().toISOString())},
  ${sqlDate(job.updatedAt || new Date().toISOString())},
  ${job.startedAt ? sqlDate(job.startedAt) : "NULL"},
  ${job.finishedAt ? sqlDate(job.finishedAt) : "NULL"},
  ${sqlString(job.domainType || "mother_baby")}
) ON DUPLICATE KEY UPDATE
  status=VALUES(status),
  target_count=VALUES(target_count),
  batch_size=VALUES(batch_size),
  generated_count=VALUES(generated_count),
  trained_count=VALUES(trained_count),
  total_samples=VALUES(total_samples),
  class_counts_json=VALUES(class_counts_json),
  message=VALUES(message),
  error_text=VALUES(error_text),
  updated_at=VALUES(updated_at),
  started_at=VALUES(started_at),
  finished_at=VALUES(finished_at),
  domain_type=VALUES(domain_type);
`);
  }

  function updateGroupIntentAutoTrainJob(jobId, patch) {
    const jobs = loadGroupIntentAutoTrainJobs();
    const index = jobs.findIndex((item) => item.id === jobId);
    if (index < 0) return null;
    jobs[index] = {
      ...jobs[index],
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    if (isAiAdminMysqlEnabled()) {
      upsertGroupIntentAutoTrainJob(jobs[index]);
    } else {
      saveGroupIntentAutoTrainJobs(jobs);
    }
    return jobs[index];
  }

  function normalizeGroupIntentDomainType(domainType = "") {
    const value = String(domainType || "").trim();
    if (!value) return "母婴";
    if (GROUP_INTENT_DOMAIN_PRESETS[value]) return GROUP_INTENT_DOMAIN_PRESETS[value];
    return value.slice(0, 40);
  }

  function listGroupIntentDomainTypes() {
    return Object.entries(GROUP_INTENT_DOMAIN_PRESETS).map(([value, label]) => ({
      value,
      label,
    }));
  }

  function buildGroupIntentDomainPrompt(domainType = "") {
    const normalized = normalizeGroupIntentDomainType(domainType);
    return {
      label: normalized,
      systemPrompt: `你是${normalized}群聊训练样本生成器。`,
      domainHint: [
        `领域集中在“${normalized}”相关的商品咨询、购买讨论和推荐对话。`,
        "请让 intervene 样本更多体现真实用户的购买意图，比如想买、求推荐、问链接、问价格、问适合谁用、问怎么选。",
        "请让 ignore 样本更多体现同领域闲聊、体验分享、吐槽、售后抱怨、生活聊天，但不要出现明确购买动作。",
      ].join(" "),
    };
  }

  async function generateGroupIntentSamplesWithQwen(count, offset = 0, domainType = "mother_baby") {
    const domain = buildGroupIntentDomainPrompt(domainType);
    const content = await callQwenChat({
      model: GROUP_INTENT_QWEN_MODEL,
      temperature: 0.8,
      responseFormat: { type: "json_object" },
      timeoutMs: 90000,
      messages: [
        {
          role: "system",
          content: [
            domain.systemPrompt,
            "生成真实微信群风格的单条消息样本，用于训练商品/购买介入意图识别。",
            "label 只能是 intervene 或 ignore。",
            "intervene 表示用户需要商品/购买相关介入：问买什么、选哪个、哪款好、有没有推荐、怎么选、求链接、问在哪里买、问怎么买、追问之前/刚才那款入口。",
            "ignore 表示普通闲聊、单纯分享体验、售后物流、表情寒暄、不涉及购买动作的闲聊。",
            "必须只返回 JSON 对象，格式：{\"items\":[{\"speaker\":\"...\",\"text\":\"...\",\"label\":\"intervene|ignore\",\"reason\":\"...\"}]}。",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            `请生成 ${count} 条训练样本。`,
            "要求 intervene 和 ignore 尽量均衡，文本不要重复。",
            `这是第 ${offset + 1} 条之后的批次，避免和前面样本重复。`,
            domain.domainHint,
          ].join("\n"),
        },
      ],
    });
    const parsed = extractJsonFromText(content);
    const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed.items) ? parsed.items : [];
    return items
      .map((item, index) => {
        const label = item.label === "intervene" ? "intervene" : "ignore";
        const speaker = String(item.speaker || `用户${offset + index + 1}`).trim();
        const text = String(item.text || "").trim();
        return {
          index: offset + index,
          speaker,
          text,
          raw: speaker ? `${speaker}: ${text}` : text,
          label,
          shouldIntervene: label === "intervene",
          reason: String(item.reason || "千问自动生成并标注。").trim(),
        };
      })
      .filter((item) => item.text)
      .slice(0, count);
  }

  async function buildGroupIntentSampleInputWithQwen(count = 100, domainType = "mother_baby") {
    const targetCount = Math.max(1, Math.min(300, Number(count || 100)));
    const normalizedDomainType = normalizeGroupIntentDomainType(domainType);
    const items = [];
    while (items.length < targetCount) {
      const nextCount = Math.min(10, targetCount - items.length);
      const batch = await generateGroupIntentSamplesWithQwen(nextCount, items.length, normalizedDomainType);
      if (!batch.length) break;
      items.push(...batch.map((item, index) => ({ ...item, index: items.length + index })));
    }
    return {
      model: GROUP_INTENT_QWEN_MODEL,
      count: items.length,
      domainType: normalizedDomainType,
      input: items.map((item) => item.raw || `${item.speaker}: ${item.text}`).join("\n"),
      items,
    };
  }

  async function streamGroupIntentSampleInputWithQwen(payload = {}, res) {
    const targetCount = Math.max(1, Math.min(300, Number(payload.count || 100)));
    const batchSize = Math.max(1, Math.min(10, Number(payload.batchSize || 5)));
    const concurrency = Math.max(1, Math.min(6, Number(payload.concurrency || 4)));
    const domainType = normalizeGroupIntentDomainType(payload.domainType);
    let closed = false;
    let nextOffset = 0;
    let completed = 0;
    let failed = false;

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reqSocketKeepAlive(res);
    const sendEvent = (data) => {
      if (closed || res.destroyed) return;
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    const takeBatch = () => {
      if (nextOffset >= targetCount) return null;
      const offset = nextOffset;
      const count = Math.min(batchSize, targetCount - nextOffset);
      nextOffset += count;
      return { offset, count };
    };

    res.on("close", () => {
      closed = true;
    });
    sendEvent({ type: "start", targetCount, batchSize, concurrency, domainType });

    const worker = async () => {
      while (!closed && !failed) {
        const batch = takeBatch();
        if (!batch) return;
        try {
          const items = await generateGroupIntentSamplesWithQwen(batch.count, batch.offset, domainType);
          completed += items.length;
          sendEvent({ type: "items", offset: batch.offset, count: items.length, completed, targetCount, items, domainType });
        } catch (error) {
          failed = true;
          sendEvent({ type: "error", error: error.message || String(error), completed, targetCount });
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, Math.ceil(targetCount / batchSize)) }, () => worker()));
    if (!closed) {
      sendEvent({ type: failed ? "failed" : "done", completed, targetCount });
      res.end();
    }
  }

  async function runGroupIntentAutoTrainJob(jobId) {
    if (runningJobs.has(jobId)) return;
    runningJobs.add(jobId);
    try {
      let job = updateGroupIntentAutoTrainJob(jobId, { status: "running", startedAt: new Date().toISOString() });
      if (!job) return;
      const targetCount = Math.max(1, Math.min(5000, Number(job.targetCount || 0)));
      const batchSize = Math.max(5, Math.min(10, Number(job.batchSize || 10)));
      const domainType = normalizeGroupIntentDomainType(job.domainType);
      const domainLabel = normalizeGroupIntentDomainType(job.domainType);

      while ((job.generatedCount || 0) < targetCount) {
        const remaining = targetCount - (job.generatedCount || 0);
        const nextCount = Math.min(batchSize, remaining);
        updateGroupIntentAutoTrainJob(jobId, {
          message: `${domainLabel}场景：千问生成第 ${Math.floor((job.generatedCount || 0) / batchSize) + 1} 批，${nextCount} 条。`,
        });
        const items = await generateGroupIntentSamplesWithQwen(nextCount, job.generatedCount || 0, domainType);
        if (!items.length) throw new Error("千问没有生成有效训练样本。");
        const trainResult = trainGroupIntentFastText(items);
        const generatedCount = (job.generatedCount || 0) + items.length;
        const trainedCount = (job.trainedCount || 0) + items.length;
        job = updateGroupIntentAutoTrainJob(jobId, {
          generatedCount,
          trainedCount,
          totalSamples: trainResult.totalSamples,
          classCounts: trainResult.classCounts,
          message: `${domainLabel}场景：已生成并训练 ${trainedCount}/${targetCount} 条。`,
        });
      }
      updateGroupIntentAutoTrainJob(jobId, {
        status: "completed",
        finishedAt: new Date().toISOString(),
        message: "自动训练完成。",
      });
    } catch (error) {
      updateGroupIntentAutoTrainJob(jobId, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: error.message || String(error),
        message: "自动训练失败。",
      });
    } finally {
      runningJobs.delete(jobId);
    }
  }

  function createGroupIntentAutoTrainJob(payload = {}) {
    const targetCount = Math.max(1, Math.min(5000, Number(payload.count || payload.targetCount || 0)));
    if (!targetCount) throw new Error("请输入要生成的样本数量。");
    const now = new Date().toISOString();
    const domainType = normalizeGroupIntentDomainType(payload.domainType);
    const job = {
      id: crypto.randomUUID(),
      status: "queued",
      targetCount,
      batchSize: Math.max(5, Math.min(10, Number(payload.batchSize || 10))),
      domainType,
      generatedCount: 0,
      trainedCount: 0,
      totalSamples: null,
      classCounts: null,
      message: `${domainType}场景任务已创建，等待开始。`,
      error: "",
      createdAt: now,
      updatedAt: now,
      startedAt: "",
      finishedAt: "",
    };
    const jobs = loadGroupIntentAutoTrainJobs();
    jobs.push(job);
    saveGroupIntentAutoTrainJobs(jobs);
    setTimeout(() => runGroupIntentAutoTrainJob(job.id), 0);
    return job;
  }

  function resumeGroupIntentAutoTrainJobs() {
    try {
      const jobs = loadGroupIntentAutoTrainJobs()
        .filter((job) => ["queued", "running"].includes(job.status))
        .slice(0, 5);
      for (const job of jobs) {
        setTimeout(() => runGroupIntentAutoTrainJob(job.id), 0);
      }
      if (jobs.length) {
        console.log(`[group-intent] resumed ${jobs.length} auto train job(s)`);
      }
    } catch (error) {
      console.error(`[group-intent] resume auto train jobs failed: ${error.message}`);
    }
  }

  return {
    buildGroupIntentDomainPrompt,
    buildGroupIntentSampleInputWithQwen,
    createGroupIntentAutoTrainJob,
    generateGroupIntentSamplesWithQwen,
    listGroupIntentDomainTypes,
    loadGroupIntentAutoTrainJobs,
    normalizeGroupIntentDomainType,
    resumeGroupIntentAutoTrainJobs,
    streamGroupIntentSampleInputWithQwen,
  };
}

module.exports = {
  createGroupIntentAutoTrainService,
  reqSocketKeepAlive,
};
