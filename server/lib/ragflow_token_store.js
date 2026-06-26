"use strict";

const RAGFLOW_API_TOKEN_KEY = "ragflow_api_authorization";

function createRagflowTokenStore({
  ensureRuntimeTokenMysqlSchema,
  isAiAdminMysqlEnabled,
  runAiAdminMysql,
  sqlString,
} = {}) {
  function isEnabled() {
    return Boolean(isAiAdminMysqlEnabled?.());
  }

  function loadRagflowToken() {
    if (!isEnabled()) return "";
    ensureRuntimeTokenMysqlSchema?.();
    const output = runAiAdminMysql(
      `SELECT token_value FROM ai_admin_runtime_tokens WHERE token_key = ${sqlString(RAGFLOW_API_TOKEN_KEY)} LIMIT 1;`
    );
    return String(output || "").split("\n")[0]?.trim() || "";
  }

  function saveRagflowToken(token) {
    const normalized = String(token || "").trim();
    if (!normalized || !isEnabled()) return false;
    ensureRuntimeTokenMysqlSchema?.();
    runAiAdminMysql(`
INSERT INTO ai_admin_runtime_tokens (token_key, token_value)
VALUES (${sqlString(RAGFLOW_API_TOKEN_KEY)}, ${sqlString(normalized)})
ON DUPLICATE KEY UPDATE token_value = VALUES(token_value);
`);
    return true;
  }

  return {
    loadRagflowToken,
    saveRagflowToken,
  };
}

module.exports = {
  RAGFLOW_API_TOKEN_KEY,
  createRagflowTokenStore,
};
