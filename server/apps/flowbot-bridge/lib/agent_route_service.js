function createAgentRouteService({
  AGENT_LANE_ENABLED,
  AGENT_WAKE_NAMES,
  buildLlmReadyMessage,
  normalizeMentionIdList,
  normalizeWakeText,
}) {
  async function routeNormalizedMessage(message) {
    const llmReady = buildLlmReadyMessage(message);
    const text = [
      llmReady.content,
      llmReady.quote_content,
      llmReady.title,
      llmReady.desc,
    ].filter(Boolean).join("\n");
    const normalizedText = normalizeWakeText(text);
    const mentionIds = normalizeMentionIdList(llmReady.at_list);
    const atListText = normalizeWakeText(JSON.stringify(mentionIds));
    const receiverId = String(llmReady.receiver_id || "").trim();
    const directMentionById = Boolean(receiverId) && mentionIds.includes(receiverId);
    const matchedAgentNames = AGENT_WAKE_NAMES.filter((name) => {
      const normalizedName = normalizeWakeText(name);
      if (!normalizedName) {
        return false;
      }
      return normalizedText.includes(normalizedName) || atListText.includes(normalizedName);
    });
    const explicitMentionByName = matchedAgentNames.some((name) => {
      const normalizedName = normalizeWakeText(name);
      return normalizedText.includes(`@${normalizedName}`) || atListText.includes(normalizedName);
    });
    const explicitMention = directMentionById || explicitMentionByName;
    const namedWake = matchedAgentNames.length > 0;
    const agentTriggered = AGENT_LANE_ENABLED && (explicitMention || namedWake);
    let routeReason = "archive_only";

    if (agentTriggered && explicitMention) {
      routeReason = "explicit_mention";
    } else if (agentTriggered && namedWake) {
      routeReason = "name_detected_agent_review";
    }
    return {
      archiveTriggered: true,
      agentTriggered,
      routeMode: agentTriggered ? "dual_lane" : "archive_only",
      routeReason,
      matchedAgentNames,
      llmReadyMessage: llmReady,
    };
  }

  return { routeNormalizedMessage };
}

module.exports = { createAgentRouteService };
