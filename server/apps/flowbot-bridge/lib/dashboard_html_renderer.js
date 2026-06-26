"use strict";

const chunks = [
  ...require("./dashboard_html/chunk_01.js"),
  ...require("./dashboard_html/chunk_02.js"),
  ...require("./dashboard_html/chunk_03.js"),
  ...require("./dashboard_html/chunk_04.js"),
  ...require("./dashboard_html/chunk_05.js"),
  ...require("./dashboard_html/chunk_06.js"),
];

function escapeAttribute(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function createDashboardHtmlRenderer({
  AGENT_PRIMARY_WAKE_NAME,
  BATCH_ACTION_LABELS,
  CASE_STATUS_LABELS,
  CATEGORY_LABELS,
  DASHBOARD_DEFAULT_LIMIT,
  DASHBOARD_UI_VERSION,
  DEFAULT_LOGIN_REGION,
  DEFAULT_NOTIFY_URL,
  LOGIN_REGION_OPTIONS,
  MESSAGE_ROLE_LABELS,
  THREAD_TYPE_LABELS,
  escapeHtml,
}) {
  function renderDashboardHtml() {
    return chunks.join("")
      .replaceAll("__FLOWBOT_DASHBOARD_DEFAULT_LIMIT__", String(DASHBOARD_DEFAULT_LIMIT))
      .replaceAll("__FLOWBOT_DASHBOARD_UI_VERSION__", escapeHtml(DASHBOARD_UI_VERSION))
      .replaceAll("__FLOWBOT_AGENT_PRIMARY_WAKE_NAME__", escapeHtml(AGENT_PRIMARY_WAKE_NAME))
      .replaceAll("__FLOWBOT_DEFAULT_NOTIFY_URL_HTML__", escapeAttribute(DEFAULT_NOTIFY_URL))
      .replaceAll("__FLOWBOT_JSON_CATEGORY_LABELS__", JSON.stringify(CATEGORY_LABELS))
      .replaceAll("__FLOWBOT_JSON_THREAD_TYPE_LABELS__", JSON.stringify(THREAD_TYPE_LABELS))
      .replaceAll("__FLOWBOT_JSON_MESSAGE_ROLE_LABELS__", JSON.stringify(MESSAGE_ROLE_LABELS))
      .replaceAll("__FLOWBOT_JSON_BATCH_ACTION_LABELS__", JSON.stringify(BATCH_ACTION_LABELS))
      .replaceAll("__FLOWBOT_JSON_CASE_STATUS_LABELS__", JSON.stringify(CASE_STATUS_LABELS))
      .replaceAll("__FLOWBOT_JSON_LOGIN_REGION_OPTIONS__", JSON.stringify(LOGIN_REGION_OPTIONS))
      .replaceAll("__FLOWBOT_JSON_DEFAULT_LOGIN_REGION__", JSON.stringify(DEFAULT_LOGIN_REGION))
      .replaceAll("__FLOWBOT_JSON_DEFAULT_NOTIFY_URL__", JSON.stringify(DEFAULT_NOTIFY_URL));
  }

  return { renderDashboardHtml };
}

module.exports = { createDashboardHtmlRenderer };
