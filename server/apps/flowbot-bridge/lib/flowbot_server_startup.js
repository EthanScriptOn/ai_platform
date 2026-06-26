function startFlowbotServer({
  AGENT_RUNTIME_ID,
  AGENT_SESSION_KEY_STRATEGY,
  AGENT_TASK_STATE_PATH,
  AGENT_LANE_ENABLED,
  AGENT_WAKE_NAMES,
  ARCHIVE_ENABLED,
  ARCHIVE_LOG_PATH,
  BATCH_LOG_PATH,
  BATCH_MODE_ENABLED,
  BATCH_SCAN_INTERVAL_MS,
  FILTER_LOG_PATH,
  KNOWLEDGE_CANDIDATES_PATH,
  KNOWLEDGE_DIR,
  KNOWLEDGE_HARVEST_ENABLED,
  KNOWLEDGE_HARVEST_SCAN_INTERVAL_MS,
  KNOWLEDGE_HARVEST_STATE_PATH,
  LOG_PATH,
  MESSAGE_POOL_STATE_PATH,
  MESSAGE_SEARCH_INDEX_PATH,
  NORMALIZED_LOG_PATH,
  PORT,
  ROUTING_LOG_PATH,
  TARGET_ROOM_IDS,
  requeueStaleProcessingMessages,
  runKnowledgeHarvestProcessor,
  runPendingBatchProcessor,
  server,
}) {
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[flowbot-bridge] listening on http://127.0.0.1:${PORT}`);
    console.log(`[flowbot-bridge] callback endpoint: http://127.0.0.1:${PORT}/flowbot/callback`);
    console.log(`[flowbot-bridge] log file: ${LOG_PATH}`);
    console.log(`[flowbot-bridge] normalized log file: ${NORMALIZED_LOG_PATH}`);
    console.log(`[flowbot-bridge] knowledge dir: ${KNOWLEDGE_DIR}`);
    console.log(`[flowbot-bridge] message search index file: ${MESSAGE_SEARCH_INDEX_PATH}`);
    console.log(`[flowbot-bridge] filter log file: ${FILTER_LOG_PATH}`);
    console.log(`[flowbot-bridge] archive log file: ${ARCHIVE_LOG_PATH}`);
    console.log(`[flowbot-bridge] routing log file: ${ROUTING_LOG_PATH}`);
    console.log(`[flowbot-bridge] batch log file: ${BATCH_LOG_PATH}`);
    console.log(`[flowbot-bridge] message pool state file: ${MESSAGE_POOL_STATE_PATH}`);
    console.log(`[flowbot-bridge] agent task state file: ${AGENT_TASK_STATE_PATH}`);
    console.log(`[flowbot-bridge] knowledge candidates file: ${KNOWLEDGE_CANDIDATES_PATH}`);
    console.log(`[flowbot-bridge] knowledge harvest state file: ${KNOWLEDGE_HARVEST_STATE_PATH}`);
    console.log(`[flowbot-bridge] archive enabled: ${ARCHIVE_ENABLED ? "yes" : "no"}`);
    console.log(`[flowbot-bridge] batch mode enabled: ${BATCH_MODE_ENABLED ? "yes" : "no"}`);
    console.log(`[flowbot-bridge] knowledge harvest enabled: ${KNOWLEDGE_HARVEST_ENABLED ? "yes" : "no"}`);
    console.log(`[flowbot-bridge] agent lane enabled: ${AGENT_LANE_ENABLED ? "yes" : "no"}`);
    console.log(`[flowbot-bridge] agent wake names: ${AGENT_WAKE_NAMES.join(", ") || "(empty)"}`);
    console.log(`[flowbot-bridge] agent id: ${AGENT_RUNTIME_ID}`);
    console.log(`[flowbot-bridge] agent session key strategy: ${AGENT_SESSION_KEY_STRATEGY}`);
    console.log(`[flowbot-bridge] room whitelist filter: ${TARGET_ROOM_IDS.size ? "enabled" : "disabled"}`);
    console.log(`[flowbot-bridge] configured room ids: ${Array.from(TARGET_ROOM_IDS).join(", ") || "(empty)"}`);
  });

  if (BATCH_MODE_ENABLED) {
    const staleRecovery = requeueStaleProcessingMessages({ staleAfterMs: 0 });
    if (staleRecovery.changed) {
      console.warn(`[flowbot-bridge] startup requeued ${staleRecovery.requeuedCount} stale processing message(s)`);
    }
    setInterval(() => {
      runPendingBatchProcessor().catch((error) => {
        console.error(`[flowbot-bridge] batch processor failed: ${String(error?.message || error)}`);
      });
    }, Math.max(5000, BATCH_SCAN_INTERVAL_MS));
  }

  if (KNOWLEDGE_HARVEST_ENABLED) {
    setInterval(() => {
      runKnowledgeHarvestProcessor().catch((error) => {
        console.error(`[flowbot-bridge] knowledge harvest failed: ${String(error?.message || error)}`);
      });
    }, KNOWLEDGE_HARVEST_SCAN_INTERVAL_MS);
  }
}

module.exports = {
  startFlowbotServer,
};
