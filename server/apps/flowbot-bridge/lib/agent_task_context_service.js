function createAgentTaskContextService({
  AGENT_RUNTIME_ID,
  AGENT_SESSION_KEY_STRATEGY,
  buildCaseProgressPayload,
  findCaseById,
  listRoomMessages,
  readAgentTaskState,
  searchCases,
  searchLocalKnowledgeDocuments,
  summarizeAgentTaskStatus,
}) {
  function findAgentTaskById(taskId) {
    const target = String(taskId || "").trim();
    if (!target) {
      return null;
    }
    const state = readAgentTaskState();
    return state.tasks?.[target] || null;
  }

  function buildTaskAgentState(task = {}) {
    const agentId = String(task.agentId || AGENT_RUNTIME_ID).trim();
    const sessionKey = String(task.agentSessionKey || "").trim();
    const sessionStrategy = String(task.agentSessionStrategy || AGENT_SESSION_KEY_STRATEGY).trim();
    const sessionBinding = task.agentSessionBinding || null;
    return {
      agentId,
      sessionKey,
      sessionStrategy,
      sessionBinding,
    };
  }

  function buildAgentTaskContext(taskId, options = {}) {
    const task = findAgentTaskById(taskId);
    if (!task) {
      return null;
    }
    const lean = String(options.lean || "").trim() === "1";
    const roomId = String(task.roomId || "").trim();
    const messageLimit = Math.max(1, Math.min(50, Number(options.messageLimit) || 12));
    const caseLimit = Math.max(1, Math.min(20, Number(options.caseLimit) || 8));
    const query = String(options.query || task.contentPreview || "").trim();
    const agentState = buildTaskAgentState(task);
    const context = {
      task: {
        ...task,
        statusLabel: summarizeAgentTaskStatus(task.status),
      },
      agent: agentState,
    };
    if (lean) {
      return context;
    }
    const roomMessages = roomId ? listRoomMessages(roomId, messageLimit) : [];
    const relatedCases = searchCases({
      roomId,
      query,
      limit: caseLimit,
    }).map((item) => ({
      ...item,
      progress: buildCaseProgressPayload(findCaseById(item.caseId)),
    }));
    const knowledge = searchLocalKnowledgeDocuments(query, 5);
    return {
      ...context,
      roomMessages,
      relatedCases,
      knowledge,
    };
  }

  return {
    buildAgentTaskContext,
    buildTaskAgentState,
    findAgentTaskById,
  };
}

module.exports = { createAgentTaskContextService };
