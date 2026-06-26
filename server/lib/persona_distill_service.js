"use strict";

const fs = require("fs");
const path = require("path");
const { extractJsonFromText } = require("./data_utils");

function personaSlug(value = "") {
  const base = String(value || "persona")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^\u4e00-\u9fa5a-z0-9.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const ascii = base.replace(/[^\x00-\x7F]/g, "");
  return (ascii || base || "persona").slice(0, 64);
}

function personaSkillName(project = {}) {
  return `${personaSlug(project.name || project.id || "persona")}-perspective`;
}

function renderPersonaSkillDraft(project) {
  if (project.skillMarkdown) return project.skillMarkdown;
  const dimensions = (project.dimensions || []).map((item) => `- ${item.label}：${item.output}`).join("\n");
  const focus = (project.focus || []).join("、");
  const sources = (project.sources || []).map((item) => `- ${item.type}：${item.name}（${item.status || "待处理"}）`).join("\n");
  const risks = (project.risks || []).map((item) => `- ${item}`).join("\n");
  return `# ${project.name} · 人物 Skill 草稿

## 蒸馏目标
${project.purpose}

## 聚焦范围
${focus}

## 蒸馏深度
- 深度档位：${project.depthLabel || project.depthLevel || "商用"}
- 目标轮次：${project.targetRounds || 5}轮
- 当前轮次：${project.currentRound || 0}轮
- 质量门槛：${project.qualityBar || "多轮调研、提炼、测试和人工校准后再交付"}

## 需要抽取的维度
${dimensions}

## 素材清单
${sources || "- 暂无素材"}

## 输出形态
- 说话风格：常用句式、语气、推进节奏、安抚方式
- 行为逻辑：遇到问题时先看什么、怎么判断轻重缓急
- 处事风格：怎么协商、怎么拒绝、怎么处理冲突
- 反模式：此人不会怎么说、不会怎么做
- 诚实边界：哪些场景不能代替本人判断

## 风险与人工审核
${risks}
`;
}

function materialDigest(project = {}) {
  return (project.sources || [])
    .filter((item) => item.contentPreview || item.name)
    .map((item, index) => [
      `### 材料 ${index + 1}: ${item.name || "未命名材料"}`,
      `- 类型：${item.type || "素材"}`,
      `- 状态：${item.status || "待处理"}`,
      item.contentPreview ? `\n${String(item.contentPreview).slice(0, 6000)}` : "\n（无文本预览）",
    ].join("\n"))
    .join("\n\n");
}

function createPersonaDistillService({
  PERSONA_DISTILL_FAST_MODEL,
  PERSONA_DISTILL_MODEL,
  PERSONA_DISTILL_SKILLS_DIR,
  PERSONA_NUWA_EXAMPLES_DIR,
  callQwenChat,
  loadPersonaProjects,
  normalizePersonaProject,
  personaDepthConfig,
  savePersonaProject,
}) {
  const runningJobs = new Map();

  async function classifyPersonaPublicityWithModel(prompt = "") {
    const text = String(prompt || "").trim();
    if (!text) return null;
    const content = await callQwenChat({
      model: PERSONA_DISTILL_FAST_MODEL || PERSONA_DISTILL_MODEL,
      temperature: 0,
      responseFormat: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "你是人物蒸馏任务的公开资料可行性判定器。",
            "判断用户想蒸馏的人物是否有足够公开资料可用于蒸馏。",
            "公开资料包括：公开访谈、演讲、书籍、播客、社交媒体、新闻报道、公开决策记录、公开字幕等。",
            "如果只是普通同事、客户、内部员工、没有公共身份的人，应判定为 false。",
            "只返回 JSON 对象。",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            `用户输入：${text}`,
            "",
            "请返回 JSON：",
            "{",
            '  "isPublic": boolean,',
            '  "confidence": 0-1,',
            '  "personName": "规范化人名",',
            '  "reason": "一句话原因",',
            '  "searchKeywords": ["用于公开资料检索的关键词，3-6个"]',
            "}",
          ].join("\n"),
        },
      ],
    });
    const parsed = extractJsonFromText(content);
    return {
      isPublic: parsed.isPublic === true,
      confidence: Number(parsed.confidence || 0),
      personName: String(parsed.personName || "").trim(),
      reason: String(parsed.reason || "").trim(),
      searchKeywords: Array.isArray(parsed.searchKeywords)
        ? parsed.searchKeywords.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 8)
        : [],
    };
  }

  async function createPersonaProjectFromPayload(payload = {}) {
    const raw = payload && typeof payload === "object" ? { ...payload } : {};
    let publicClassify = null;
    if (raw.prompt && raw.materialMode == null && raw.material_mode == null) {
      try {
        publicClassify = await classifyPersonaPublicityWithModel(raw.prompt);
        if (publicClassify?.isPublic && publicClassify.confidence >= 0.55) {
          raw.name = raw.name || publicClassify.personName || undefined;
          raw.materialMode = "public_research";
          raw.status = "research_pending";
        }
      } catch (error) {
        publicClassify = {
          isPublic: false,
          confidence: 0,
          reason: `模型公开资料判定失败，已回退本地规则：${error.message}`,
          searchKeywords: [],
        };
      }
    }
    const project = normalizePersonaProject(raw);
    if (publicClassify) {
      project.distillResult = {
        ...(project.distillResult || {}),
        publicClassify,
        publicReason: publicClassify.reason,
        publicSearchKeywords: publicClassify.searchKeywords,
      };
    }
    return savePersonaProject(project);
  }

  function appendPersonaMaterials(projectId, materials = []) {
    const projects = loadPersonaProjects();
    const project = projects.find((item) => item.id === projectId);
    if (!project) {
      throw new Error("persona_project_not_found");
    }
    const now = new Date().toISOString();
    const nextMaterials = (Array.isArray(materials) ? materials : [])
      .map((item) => ({
        type: String(item.type || "素材").trim() || "素材",
        name: String(item.name || item.fileName || "未命名材料").trim(),
        status: "已上传",
        size: Number(item.size || 0),
        contentType: String(item.contentType || "").trim(),
        uploadedAt: now,
        contentPreview: String(item.contentPreview || item.content || "").slice(0, 4000),
      }))
      .filter((item) => item.name);
    const updated = normalizePersonaProject({
      ...project,
      status: nextMaterials.length ? "materials_ready" : project.status,
      materialMode: nextMaterials.length ? "materials_ready" : project.materialMode,
      sources: [...(project.sources || []), ...nextMaterials],
      updatedAt: now,
    });
    savePersonaProject(updated);
    return updated;
  }

  function updatePersonaDepth(projectId, depthLevel) {
    const projects = loadPersonaProjects();
    const project = projects.find((item) => item.id === projectId);
    if (!project) {
      throw new Error("persona_project_not_found");
    }
    const depth = personaDepthConfig(depthLevel);
    const updated = normalizePersonaProject({
      ...project,
      depthLevel: depth.depthLevel,
      targetRounds: depth.targetRounds,
      qualityGate: depth.qualityGate,
      updatedAt: new Date().toISOString(),
    });
    savePersonaProject(updated);
    return updated;
  }

  function updatePersonaProjectStatus(projectId, patch = {}) {
    const projects = loadPersonaProjects();
    const project = projects.find((item) => item.id === projectId);
    if (!project) throw new Error("persona_project_not_found");
    const updated = normalizePersonaProject({
      ...project,
      ...patch,
      updatedAt: new Date().toISOString(),
    });
    savePersonaProject(updated);
    return updated;
  }

  function loadPersonaNuwaExample(project = {}) {
    if (!fs.existsSync(PERSONA_NUWA_EXAMPLES_DIR)) return "";
    const name = String(project.name || project.prompt || "").toLowerCase();
    const examples = [
      [/马斯克|musk|elon/, "elon-musk-perspective/SKILL.md"],
      [/芒格|munger|查理/, "munger-perspective/SKILL.md"],
      [/费曼|feynman/, "feynman-perspective/SKILL.md"],
      [/乔布斯|jobs|steve/, "steve-jobs-perspective/SKILL.md"],
      [/张一鸣/, "zhang-yiming-perspective/SKILL.md"],
      [/张雪峰/, "zhangxuefeng-perspective/SKILL.md"],
      [/naval|纳瓦尔/, "naval-perspective/SKILL.md"],
      [/taleb|塔勒布/, "taleb-perspective/SKILL.md"],
      [/paul\s*graham|保罗|pg/, "paul-graham-perspective/SKILL.md"],
      [/karpathy|卡帕西/, "andrej-karpathy-perspective/SKILL.md"],
      [/ilya|sutskever/, "ilya-sutskever-perspective/SKILL.md"],
      [/mrbeast|野兽先生/, "mrbeast-perspective/SKILL.md"],
      [/特朗普|川普|trump/, "trump-perspective/SKILL.md"],
    ];
    const matched = examples.find(([pattern]) => pattern.test(name));
    if (!matched) return "";
    const filePath = path.join(PERSONA_NUWA_EXAMPLES_DIR, matched[1]);
    if (!fs.existsSync(filePath)) return "";
    return fs.readFileSync(filePath, "utf-8").slice(0, 24000);
  }

  function normalizePersonaDistillResult(project, parsed = {}) {
    const skillMarkdown = String(parsed.skillMarkdown || parsed.skill_markdown || "").trim();
    if (!skillMarkdown) throw new Error("蒸馏模型没有返回 skillMarkdown。");
    return {
      skillMarkdown,
      summary: String(parsed.summary || "").trim(),
      mentalModels: Array.isArray(parsed.mentalModels) ? parsed.mentalModels : [],
      heuristics: Array.isArray(parsed.heuristics) ? parsed.heuristics : [],
      expressionDna: parsed.expressionDna && typeof parsed.expressionDna === "object" ? parsed.expressionDna : {},
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
      limitations: Array.isArray(parsed.limitations) ? parsed.limitations : [],
      qualityScore: parsed.qualityScore == null ? null : Number(parsed.qualityScore),
      generatedAt: new Date().toISOString(),
      model: PERSONA_DISTILL_MODEL,
      skillName: personaSkillName(project),
    };
  }

  async function distillPersonaProject(projectId) {
    const projects = loadPersonaProjects();
    const project = projects.find((item) => item.id === projectId);
    if (!project) throw new Error("persona_project_not_found");
    const materials = materialDigest(project);
    const exampleSkill = loadPersonaNuwaExample(project);
    if (!materials && project.materialMode !== "public_research" && !exampleSkill) {
      throw new Error("请先上传材料，或选择公开人物后再蒸馏。");
    }
    const depth = personaDepthConfig(project.depthLevel);
    const messages = [
      {
        role: "system",
        content: [
          "你是女娲 Skill 造人术的执行器。你的任务不是写空泛人设，而是把材料蒸馏成可运行的人物 Skill。",
          "必须输出 JSON 对象，不要输出 Markdown 围栏。字段必须包含：skillMarkdown, summary, mentalModels, heuristics, expressionDna, evidence, limitations, qualityScore。",
          "skillMarkdown 必须是完整 SKILL.md 内容，包含 frontmatter、使用说明、角色扮演规则、回答工作流、身份卡、核心心智模型、决策启发式、表达DNA、价值观与反模式、诚实边界、调研来源。",
          "如果证据不足，明确写入诚实边界，不要编造来源、事件、语录。",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `蒸馏对象：${project.name}`,
          `用户原始需求：${project.prompt || project.title}`,
          `用途：${project.purpose}`,
          `聚焦范围：${(project.focus || []).join("、")}`,
          `深度档位：${depth.label}（目标 ${depth.targetRounds} 轮，质量门槛 ${depth.qualityGate}）`,
          "",
          "需要抽取的维度：",
          JSON.stringify(project.dimensions || [], null, 2),
          "",
          "用户上传/项目材料：",
          materials || "（没有上传材料；如有下方女娲示例，仅作为公开人物结构参考）",
          "",
          exampleSkill
            ? [
                "可参考的本地女娲已蒸馏示例（仅参考结构、方法论和已公开人物内容；如果正是同一人物，可基于它生成更聚焦版本）：",
                exampleSkill,
              ].join("\n")
            : "没有匹配到本地女娲示例。",
        ].join("\n"),
      },
    ];
    const content = await callQwenChat({
      model: PERSONA_DISTILL_MODEL,
      messages,
      temperature: 0.15,
      responseFormat: { type: "json_object" },
    });
    const result = normalizePersonaDistillResult(project, extractJsonFromText(content));
    const now = new Date().toISOString();
    const skillDir = writePersonaSkillBundle(project, result);
    const updated = normalizePersonaProject({
      ...project,
      status: "completed",
      materialMode: project.materialMode === "materials_required" ? "materials_ready" : project.materialMode,
      currentRound: depth.targetRounds,
      qualityScore: result.qualityScore == null || Number.isNaN(result.qualityScore) ? 80 : result.qualityScore,
      distillResult: result,
      skillMarkdown: result.skillMarkdown,
      skillDir,
      lastRunAt: now,
      updatedAt: now,
    });
    savePersonaProject(updated);
    return updated;
  }

  function startPersonaDistillJob(projectId) {
    if (runningJobs.has(projectId)) {
      return updatePersonaProjectStatus(projectId, {
        status: "distilling",
        distillResult: {
          ...(loadPersonaProjects().find((item) => item.id === projectId)?.distillResult || {}),
          running: true,
          message: "蒸馏任务正在运行中",
        },
      });
    }
    const runningProject = updatePersonaProjectStatus(projectId, {
      status: "distilling",
      distillResult: {
        running: true,
        message: "蒸馏任务已启动，后台正在生成 Skill。",
        startedAt: new Date().toISOString(),
        model: PERSONA_DISTILL_MODEL,
      },
    });
    const job = Promise.resolve()
      .then(() => distillPersonaProject(projectId))
      .catch((error) => {
        try {
          updatePersonaProjectStatus(projectId, {
            status: "failed",
            distillResult: {
              running: false,
              error: error.message,
              failedAt: new Date().toISOString(),
              model: PERSONA_DISTILL_MODEL,
            },
          });
        } catch (updateError) {
          console.error(`[persona-distill] failed to persist failure for ${projectId}:`, updateError);
        }
        console.error(`[persona-distill] job failed for ${projectId}:`, error);
      })
      .finally(() => {
        runningJobs.delete(projectId);
      });
    runningJobs.set(projectId, job);
    return runningProject;
  }

  function writePersonaSkillBundle(project, result) {
    const skillName = result.skillName || personaSkillName(project);
    const skillDir = path.join(PERSONA_DISTILL_SKILLS_DIR, skillName);
    const researchDir = path.join(skillDir, "references", "research");
    const sourcesDir = path.join(skillDir, "references", "sources");
    fs.mkdirSync(researchDir, { recursive: true });
    fs.mkdirSync(sourcesDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), `${result.skillMarkdown.trim()}\n`, "utf-8");
    fs.writeFileSync(
      path.join(researchDir, "00-distill-summary.md"),
      [
        `# ${project.name} 蒸馏摘要`,
        "",
        `- 项目：${project.title}`,
        `- 模型：${result.model}`,
        `- 生成时间：${result.generatedAt}`,
        `- 质量分：${result.qualityScore ?? "未评分"}`,
        "",
        "## 摘要",
        result.summary || "无",
        "",
        "## 心智模型",
        ...(result.mentalModels || []).map((item) => `- ${typeof item === "string" ? item : JSON.stringify(item)}`),
        "",
        "## 证据与边界",
        ...(result.evidence || []).map((item) => `- ${typeof item === "string" ? item : JSON.stringify(item)}`),
        ...(result.limitations || []).map((item) => `- 局限：${item}`),
        "",
      ].join("\n"),
      "utf-8"
    );
    fs.writeFileSync(
      path.join(sourcesDir, "uploaded-materials.md"),
      materialDigest(project) || "# 上传材料\n\n暂无上传材料。\n",
      "utf-8"
    );
    fs.writeFileSync(
      path.join(skillDir, "manifest.json"),
      JSON.stringify(
        {
          projectId: project.id,
          name: project.name,
          title: project.title,
          skillName,
          model: result.model,
          generatedAt: result.generatedAt,
          qualityScore: result.qualityScore,
        },
        null,
        2
      ),
      "utf-8"
    );
    return skillDir;
  }

  async function chatWithPersonaProject(projectId, message, history = []) {
    const project = loadPersonaProjects().find((item) => item.id === projectId);
    if (!project) throw new Error("persona_project_not_found");
    const skillMarkdown = project.skillMarkdown || renderPersonaSkillDraft(project);
    if (!project.skillMarkdown) throw new Error("这个人物还没有蒸馏完成，请先生成完整 Skill。");
    const safeHistory = (Array.isArray(history) ? history : [])
      .slice(-12)
      .filter((item) => item && (item.role === "user" || item.role === "assistant"))
      .map((item) => ({ role: item.role, content: String(item.content || "").slice(0, 4000) }));
    const reply = await callQwenChat({
      model: PERSONA_DISTILL_FAST_MODEL || PERSONA_DISTILL_MODEL,
      temperature: 0.4,
      messages: [
        {
          role: "system",
          content: [
            "你正在运行一个由女娲蒸馏得到的人物 Skill。严格遵循下方 SKILL.md 的角色、心智模型、表达DNA和诚实边界。",
            "直接以该人物视角回答，不要解释你在扮演，也不要复述 Skill 文档。",
            "",
            skillMarkdown,
          ].join("\n"),
        },
        ...safeHistory,
        { role: "user", content: String(message || "").trim() },
      ],
    });
    return { project, reply: reply.trim(), model: PERSONA_DISTILL_FAST_MODEL || PERSONA_DISTILL_MODEL };
  }

  return {
    appendPersonaMaterials,
    chatWithPersonaProject,
    classifyPersonaPublicityWithModel,
    createPersonaProjectFromPayload,
    distillPersonaProject,
    loadPersonaNuwaExample,
    materialDigest,
    normalizePersonaDistillResult,
    renderPersonaSkillDraft,
    startPersonaDistillJob,
    updatePersonaDepth,
    updatePersonaProjectStatus,
    writePersonaSkillBundle,
  };
}

module.exports = {
  createPersonaDistillService,
  materialDigest,
  personaSkillName,
  personaSlug,
  renderPersonaSkillDraft,
};
