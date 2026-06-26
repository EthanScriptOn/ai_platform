"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function createPersonaProjectStore({
  PERSONA_DISTILL_PROJECTS_PATH,
  ensurePersonaMysqlSchema,
  isAiAdminMysqlEnabled,
  parseMysqlJson,
  runAiAdminMysql,
  sqlDate,
  sqlString,
}) {
  function normalizePersonaDepth(value = "commercial") {
    const depth = String(value || "commercial").trim();
    if (["quick", "standard", "commercial"].includes(depth)) return depth;
    return "commercial";
  }
  
  function personaDepthConfig(depthLevel = "commercial") {
    const depth = normalizePersonaDepth(depthLevel);
    if (depth === "quick") {
      return {
        depthLevel: "quick",
        label: "快速",
        targetRounds: 1,
        qualityGate: "draft",
        qualityBar: "适合先看方向，不建议直接商用",
      };
    }
    if (depth === "standard") {
      return {
        depthLevel: "standard",
        label: "标准",
        targetRounds: 3,
        qualityGate: "internal",
        qualityBar: "适合内部使用，需要人工确认关键判断",
      };
    }
    return {
      depthLevel: "commercial",
      label: "商用",
      targetRounds: 5,
      qualityGate: "commercial",
      qualityBar: "多轮调研、提炼、测试和人工校准后再交付",
    };
  }
  
  function defaultPersonaDimensions() {
    return [
      { key: "speech", label: "说话风格", output: "口头禅、句式、语气强弱、安抚/推进方式" },
      { key: "judgement", label: "行为逻辑", output: "遇到客户、同事、风险时的判断顺序" },
      { key: "relationship", label: "处事风格", output: "怎么协调人、怎么留余地、什么时候强硬" },
      { key: "boundary", label: "反模式与边界", output: "什么话不会说、什么事不会做、哪些场景不能代替本人" },
    ];
  }
  
  function defaultPersonaProjects() {
    return [];
  }
  
  function inferPersonaRequest(input = "") {
    const text = String(input || "").trim();
    const cleaned = text
      .replace(/^请?帮?我?/, "")
      .replace(/^(开始)?蒸馏/, "")
      .replace(/^做一个/, "")
      .replace(/的人物蒸馏$/, "")
      .trim();
    const nameCandidate = cleaned
      .split(/的|,|，|\s+/)
      .map((item) => item.trim())
      .filter(Boolean)[0];
    const nameMatch = String(nameCandidate || cleaned).match(/^([\u4e00-\u9fa5A-Za-z0-9_.-]{2,32})/);
    const name = nameMatch ? nameMatch[1] : cleaned || "未命名人物";
    const focus = [];
    if (/说话|表达|话术|口吻|语气|聊天|沟通/.test(text)) focus.push("说话风格");
    if (/行为|判断|逻辑|决策|处理/.test(text)) focus.push("行为逻辑");
    if (/处事|做人|协作|管理|团队|客户|销售|谈判/.test(text)) focus.push("处事风格");
    if (/边界|禁忌|反模式|不会/.test(text)) focus.push("决策边界");
    const nextFocus = focus.length ? Array.from(new Set(focus)) : ["说话风格", "行为逻辑", "处事风格", "决策边界"];
    const isLikelyPublic = /乔布斯|马斯克|芒格|费曼|张雪峰|张一鸣|雷军|罗永浩|俞敏洪|任正非|巴菲特|特朗普|川普|奥巴马|拜登|Naval|Musk|Jobs|Munger|Feynman|Trump|Obama|Biden/i.test(text);
    return {
      name,
      prompt: text,
      materialMode: isLikelyPublic ? "public_research" : "materials_required",
      title: `${name}人物蒸馏`,
      purpose: `蒸馏${name}的${nextFocus.join("、")}，生成可调用的人物 Skill。`,
      focus: nextFocus,
      publicReason: isLikelyPublic ? "命中本地公开人物名单" : "",
      publicSearchKeywords: isLikelyPublic ? [name, `${name} 访谈`, `${name} 演讲`, `${name} 公开言论`] : [],
    };
  }
  

  function normalizePersonaProject(raw = {}) {
    const now = new Date().toISOString();
    const inferred = raw.prompt ? inferPersonaRequest(raw.prompt) : {};
    const depth = personaDepthConfig(raw.depthLevel || raw.depth || "commercial");
    const name = String(raw.name || raw.person || inferred.name || "未命名人物").trim();
    const id =
      raw.id ||
      `persona-${crypto.createHash("sha1").update(`${name}-${now}`).digest("hex").slice(0, 10)}`;
    const focus = Array.isArray(raw.focus)
      ? raw.focus
      : String(raw.focus || (inferred.focus || []).join("\n") || "说话风格,行为逻辑,处事风格,决策边界")
          .split(/[,\n，、]+/)
          .map((item) => item.trim())
          .filter(Boolean);
    const sources = Array.isArray(raw.sources)
      ? raw.sources
      : String(raw.sources || "")
          .split(/\n+/)
          .map((item) => item.trim())
          .filter(Boolean)
          .map((item) => ({ type: "素材", name: item, status: "待导入" }));
    const materialMode =
      raw.materialMode || inferred.materialMode || (sources.length ? "materials_ready" : "materials_required");
    const status =
      raw.status ||
      (materialMode === "public_research"
        ? "research_pending"
        : sources.length
          ? "materials_ready"
          : "materials_required");
    return {
      id,
      name,
      title: String(raw.title || inferred.title || `${name}人物蒸馏`).trim(),
      status,
      materialMode,
      depthLevel: depth.depthLevel,
      depthLabel: depth.label,
      targetRounds: Number(raw.targetRounds || depth.targetRounds),
      currentRound: Math.max(0, Number(raw.currentRound || 0)),
      qualityGate: String(raw.qualityGate || depth.qualityGate).trim(),
      qualityScore: raw.qualityScore == null || raw.qualityScore === "" ? null : Number(raw.qualityScore),
      qualityBar: depth.qualityBar,
      prompt: String(raw.prompt || inferred.prompt || "").trim(),
      purpose: String(raw.purpose || inferred.purpose || "蒸馏此人的说话风格、行为逻辑和处事风格，生成可调用的人物 Skill。").trim(),
      focus,
      sources,
      dimensions: Array.isArray(raw.dimensions) && raw.dimensions.length
        ? raw.dimensions
        : defaultPersonaDimensions(),
      risks: Array.isArray(raw.risks) && raw.risks.length
        ? raw.risks
        : ["素材不足时容易变成空泛人设", "涉及个人隐私的素材需要脱敏", "产物需要标注为基于素材的模拟，不代表本人"],
      distillResult: raw.distillResult && typeof raw.distillResult === "object" ? raw.distillResult : null,
      skillMarkdown: String(raw.skillMarkdown || raw.skill_markdown || "").trim(),
      skillDir: String(raw.skillDir || raw.skill_dir || "").trim(),
      lastRunAt: raw.lastRunAt || raw.last_run_at || "",
      createdAt: raw.createdAt || now,
      updatedAt: raw.updatedAt || now,
    };
  }
  
  function personaProjectUpsertSql(project) {
    return `
  INSERT INTO persona_distill_projects
    (id, name, title, status, material_mode, depth_level, target_rounds, current_round, quality_gate, quality_score, prompt, purpose, focus_json, sources_json, dimensions_json, risks_json, distill_result_json, skill_markdown, skill_dir, last_run_at, created_at, updated_at)
  VALUES (
    ${sqlString(project.id)},
    ${sqlString(project.name)},
    ${sqlString(project.title)},
    ${sqlString(project.status)},
    ${sqlString(project.materialMode)},
    ${sqlString(project.depthLevel)},
    ${Number(project.targetRounds || 0)},
    ${Number(project.currentRound || 0)},
    ${sqlString(project.qualityGate)},
    ${project.qualityScore == null || Number.isNaN(Number(project.qualityScore)) ? "NULL" : Number(project.qualityScore)},
    ${sqlString(project.prompt)},
    ${sqlString(project.purpose)},
    ${sqlString(JSON.stringify(project.focus || []))},
    ${sqlString(JSON.stringify(project.sources || []))},
    ${sqlString(JSON.stringify(project.dimensions || []))},
    ${sqlString(JSON.stringify(project.risks || []))},
    ${project.distillResult ? sqlString(JSON.stringify(project.distillResult)) : "NULL"},
    ${sqlString(project.skillMarkdown || "")},
    ${sqlString(project.skillDir || "")},
    ${project.lastRunAt ? sqlDate(project.lastRunAt) : "NULL"},
    ${sqlDate(project.createdAt)},
    ${sqlDate(project.updatedAt)}
  )
  ON DUPLICATE KEY UPDATE
    name = VALUES(name),
    title = VALUES(title),
    status = VALUES(status),
    material_mode = VALUES(material_mode),
    depth_level = VALUES(depth_level),
    target_rounds = VALUES(target_rounds),
    current_round = VALUES(current_round),
    quality_gate = VALUES(quality_gate),
    quality_score = VALUES(quality_score),
    prompt = VALUES(prompt),
    purpose = VALUES(purpose),
    focus_json = VALUES(focus_json),
    sources_json = VALUES(sources_json),
    dimensions_json = VALUES(dimensions_json),
    risks_json = VALUES(risks_json),
    distill_result_json = VALUES(distill_result_json),
    skill_markdown = VALUES(skill_markdown),
    skill_dir = VALUES(skill_dir),
    last_run_at = VALUES(last_run_at),
    updated_at = VALUES(updated_at);
  `;
  }
  
  function loadPersonaProjectsFromMysql() {
    ensurePersonaMysqlSchema();
    const output = runAiAdminMysql(`
  SELECT
    id,
    name,
    title,
    status,
    COALESCE(material_mode, ''),
    COALESCE(depth_level, ''),
    COALESCE(target_rounds, 0),
    COALESCE(current_round, 0),
    COALESCE(quality_gate, ''),
    COALESCE(quality_score, ''),
    COALESCE(prompt, ''),
    COALESCE(purpose, ''),
    COALESCE(CAST(focus_json AS CHAR), '[]'),
    COALESCE(CAST(sources_json AS CHAR), '[]'),
    COALESCE(CAST(dimensions_json AS CHAR), '[]'),
    COALESCE(CAST(risks_json AS CHAR), '[]'),
    COALESCE(CAST(distill_result_json AS CHAR), ''),
    COALESCE(REPLACE(TO_BASE64(skill_markdown), '\\n', ''), ''),
    COALESCE(skill_dir, ''),
    COALESCE(DATE_FORMAT(last_run_at, '%Y-%m-%dT%H:%i:%s.000Z'), ''),
    DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.000Z'),
    DATE_FORMAT(updated_at, '%Y-%m-%dT%H:%i:%s.000Z')
  FROM persona_distill_projects
  ORDER BY updated_at DESC, created_at DESC;
  `);
    return output.split("\n").filter(Boolean).map((line) => {
      const cols = line.split("\t");
      return normalizePersonaProject({
        id: cols[0],
        name: cols[1],
        title: cols[2],
        status: cols[3],
        materialMode: cols[4],
        depthLevel: cols[5],
        targetRounds: Number(cols[6] || 0),
        currentRound: Number(cols[7] || 0),
        qualityGate: cols[8],
        qualityScore: cols[9],
        prompt: cols[10],
        purpose: cols[11],
        focus: parseMysqlJson(cols[12], []),
        sources: parseMysqlJson(cols[13], []),
        dimensions: parseMysqlJson(cols[14], []),
        risks: parseMysqlJson(cols[15], []),
        distillResult: parseMysqlJson(cols[16], null),
        skillMarkdown: cols[17] ? Buffer.from(cols[17], "base64").toString("utf-8") : "",
        skillDir: cols[18],
        lastRunAt: cols[19],
        createdAt: cols[20],
        updatedAt: cols[21],
      });
    });
  }
  
  function savePersonaProjectToMysql(project) {
    ensurePersonaMysqlSchema();
    runAiAdminMysql(personaProjectUpsertSql(project));
  }
  
  function seedPersonaMysqlFromFileIfEmpty() {
    ensurePersonaMysqlSchema();
    const count = Number(runAiAdminMysql("SELECT COUNT(*) FROM persona_distill_projects;").trim() || "0");
    if (count > 0) return;
    const fileProjects = fs.existsSync(PERSONA_DISTILL_PROJECTS_PATH)
      ? JSON.parse(fs.readFileSync(PERSONA_DISTILL_PROJECTS_PATH, "utf-8"))
      : defaultPersonaProjects();
    const projects = (Array.isArray(fileProjects) ? fileProjects : []).map(normalizePersonaProject);
    if (!projects.length) return;
    runAiAdminMysql(projects.map(personaProjectUpsertSql).join("\n"));
  }
  
  function loadPersonaProjects() {
    if (isAiAdminMysqlEnabled()) {
      seedPersonaMysqlFromFileIfEmpty();
      return loadPersonaProjectsFromMysql();
    }
    if (!fs.existsSync(PERSONA_DISTILL_PROJECTS_PATH)) {
      const defaults = defaultPersonaProjects();
      savePersonaProjects(defaults);
      return defaults;
    }
    const parsed = JSON.parse(fs.readFileSync(PERSONA_DISTILL_PROJECTS_PATH, "utf-8"));
    return Array.isArray(parsed) ? parsed.map(normalizePersonaProject) : [];
  }
  
  function savePersonaProjects(projects) {
    if (isAiAdminMysqlEnabled()) {
      ensurePersonaMysqlSchema();
      runAiAdminMysql("DELETE FROM persona_distill_projects;");
      if (Array.isArray(projects) && projects.length) {
        runAiAdminMysql(projects.map((project) => personaProjectUpsertSql(normalizePersonaProject(project))).join("\n"));
      }
      return;
    }
    fs.mkdirSync(path.dirname(PERSONA_DISTILL_PROJECTS_PATH), { recursive: true });
    fs.writeFileSync(PERSONA_DISTILL_PROJECTS_PATH, JSON.stringify(projects, null, 2), "utf-8");
  }
  
  function savePersonaProject(project) {
    const normalized = normalizePersonaProject(project);
    if (isAiAdminMysqlEnabled()) {
      savePersonaProjectToMysql(normalized);
      return normalized;
    }
    const projects = loadPersonaProjects();
    const nextProjects = [normalized, ...projects.filter((item) => item.id !== normalized.id)];
    savePersonaProjects(nextProjects);
    return normalized;
  }
  
  function deletePersonaProject(projectId) {
    const id = String(projectId || "").trim();
    if (!id) throw new Error("persona_project_not_found");
    const projects = loadPersonaProjects();
    const project = projects.find((item) => item.id === id);
    if (!project) throw new Error("persona_project_not_found");
    if (isAiAdminMysqlEnabled()) {
      ensurePersonaMysqlSchema();
      runAiAdminMysql(`DELETE FROM persona_distill_projects WHERE id = ${sqlString(id)};`);
    } else {
      savePersonaProjects(projects.filter((item) => item.id !== id));
    }
    return project;
  }

  return {
    defaultPersonaDimensions,
    defaultPersonaProjects,
    deletePersonaProject,
    inferPersonaRequest,
    loadPersonaProjects,
    normalizePersonaDepth,
    normalizePersonaProject,
    personaDepthConfig,
    personaProjectUpsertSql,
    savePersonaProject,
    savePersonaProjects,
  };
}

module.exports = {
  createPersonaProjectStore,
};
