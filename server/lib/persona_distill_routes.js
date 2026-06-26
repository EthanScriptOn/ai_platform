"use strict";

function createPersonaDistillRoutes({
  PERSONA_DISTILL_FAST_MODEL,
  PERSONA_DISTILL_MODEL,
  PERSONA_DISTILL_PROJECTS_PATH,
  PERSONA_DISTILL_REVIEW_MODEL,
  PERSONA_DISTILL_SKILLS_DIR,
  appendPersonaMaterials,
  chatWithPersonaProject,
  createPersonaProjectFromPayload,
  deletePersonaProject,
  isAiAdminMysqlEnabled,
  loadPersonaProjects,
  renderPersonaSkillDraft,
  sendJson,
  startPersonaDistillJob,
  updatePersonaDepth,
}) {
  function withSkillDraft(project) {
    return { ...project, skillDraft: renderPersonaSkillDraft(project) };
  }

  function handlePersonaDistillRoute(req, res, url, method, readPayload) {
    if (method === "GET" && url.pathname === "/api/persona-distill/projects") {
      const projects = loadPersonaProjects();
      sendJson(res, {
        ok: true,
        projects: projects.map(withSkillDraft),
        modelConfig: {
          distillModel: PERSONA_DISTILL_MODEL,
          fastModel: PERSONA_DISTILL_FAST_MODEL,
          reviewModel: PERSONA_DISTILL_REVIEW_MODEL,
        },
        storageBackend: isAiAdminMysqlEnabled() ? "mysql" : "file",
        dataPath: isAiAdminMysqlEnabled() ? "" : PERSONA_DISTILL_PROJECTS_PATH,
        skillsDir: PERSONA_DISTILL_SKILLS_DIR,
      });
      return true;
    }
    if (method === "POST" && url.pathname === "/api/persona-distill/projects") {
      readPayload()
        .then((payload) => createPersonaProjectFromPayload(payload || {}))
        .then((saved) => sendJson(res, { ok: true, project: withSkillDraft(saved) }))
        .catch((error) => sendJson(res, { ok: false, error: error.message }, 500));
      return true;
    }
    if (method === "POST" && /^\/api\/persona-distill\/projects\/[^/]+\/materials$/.test(url.pathname)) {
      const projectId = decodeURIComponent(url.pathname.split("/")[4] || "");
      readPayload()
        .then((payload) => {
          const project = appendPersonaMaterials(projectId, payload.materials || []);
          sendJson(res, { ok: true, project: withSkillDraft(project) });
        })
        .catch((error) => sendJson(res, { ok: false, error: error.message }, 500));
      return true;
    }
    if (method === "POST" && /^\/api\/persona-distill\/projects\/[^/]+\/depth$/.test(url.pathname)) {
      const projectId = decodeURIComponent(url.pathname.split("/")[4] || "");
      readPayload()
        .then((payload) => {
          const project = updatePersonaDepth(projectId, payload.depthLevel || payload.depth);
          sendJson(res, { ok: true, project: withSkillDraft(project) });
        })
        .catch((error) => sendJson(res, { ok: false, error: error.message }, 500));
      return true;
    }
    if (method === "DELETE" && /^\/api\/persona-distill\/projects\/[^/]+$/.test(url.pathname)) {
      const projectId = decodeURIComponent(url.pathname.split("/")[4] || "");
      try {
        const project = deletePersonaProject(projectId);
        sendJson(res, { ok: true, project });
      } catch (error) {
        sendJson(res, { ok: false, error: error.message }, 500);
      }
      return true;
    }
    if (method === "POST" && /^\/api\/persona-distill\/projects\/[^/]+\/run$/.test(url.pathname)) {
      const projectId = decodeURIComponent(url.pathname.split("/")[4] || "");
      try {
        const project = startPersonaDistillJob(projectId);
        sendJson(res, {
          ok: true,
          accepted: true,
          project: withSkillDraft(project),
          skillsDir: PERSONA_DISTILL_SKILLS_DIR,
        });
      } catch (error) {
        sendJson(res, { ok: false, error: error.message }, 500);
      }
      return true;
    }
    if (method === "POST" && url.pathname === "/api/persona-distill/chat") {
      readPayload()
        .then((payload) => chatWithPersonaProject(payload.projectId || "", payload.message || "", payload.history || []))
        .then((data) => sendJson(res, { ok: true, ...data }))
        .catch((error) => sendJson(res, { ok: false, error: error.message }, 500));
      return true;
    }
    return false;
  }

  return { handlePersonaDistillRoute };
}

module.exports = { createPersonaDistillRoutes };
