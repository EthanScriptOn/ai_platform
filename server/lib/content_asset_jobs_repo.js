"use strict";

const crypto = require("crypto");

function createContentAssetJobRepository({
  ensureContentAssetMysqlSchema,
  parseMysqlJson,
  runAiAdminMysql,
  sqlString,
  currentTimeMs = () => Date.now(),
  randomUUID = () => crypto.randomUUID(),
}) {
  function contentAssetJobSourceType(jobType = "") {
    const type = String(jobType || "");
    if (type.startsWith("live_")) return "live";
    if (type === "product_match" || type === "video_product_map") return "product_match";
    return "video";
  }
  
  function contentAssetSourceIdentityFromUrl(url = "") {
    const text = String(url || "");
    const patterns = [
      /live\.douyin\.com\/(\d+)/,
      /\/(?:follow\/)?live\/(\d+)/,
      /\/video\/(\d+)/,
      /\/note\/(\d+)/,
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return match[1];
    }
    return "";
  }
  
  function contentAssetSourceIdentityFromResult(result) {
    if (!result || typeof result !== "object") return "";
    const direct = String(result.source_identity || result.web_rid || result.room_id || "").trim();
    if (direct) return direct;
    const parsed = result.parsed && typeof result.parsed === "object" ? result.parsed : {};
    for (const key of ["room_id", "aweme_id", "note_id", "mix_id", "music_id"]) {
      const value = String(parsed[key] || "").trim();
      if (value) return value;
    }
    if (result.recording && typeof result.recording === "object") {
      const nested = contentAssetSourceIdentityFromResult(result.recording);
      if (nested) return nested;
    }
    const products = result.products && typeof result.products === "object" ? result.products : {};
    return String(products.web_rid || products.room_id || "").trim();
  }
  
  function normalizeContentAssetJob(raw = {}) {
    const now = currentTimeMs() / 1000;
    return {
      id: String(raw.id || raw.job_uid || randomUUID()).trim(),
      type: String(raw.type || raw.job_type || "download").trim(),
      status: String(raw.status || "queued").trim(),
      created_at: Number(raw.created_at || now),
      updated_at: Number(raw.updated_at || now),
      input: raw.input && typeof raw.input === "object" ? raw.input : {},
      result: raw.result && typeof raw.result === "object" ? raw.result : raw.result == null ? null : raw.result,
      error: raw.error == null ? null : String(raw.error),
    };
  }
  
  function contentAssetJobDateSql(epoch) {
    const value = Number(epoch);
    if (!Number.isFinite(value) || value <= 0) return "CURRENT_TIMESTAMP(3)";
    return sqlString(new Date(value * 1000).toISOString().replace("T", " ").replace("Z", ""));
  }
  
  function contentAssetJobFromColumns(cols) {
    return normalizeContentAssetJob({
      id: cols[0],
      type: cols[1],
      status: cols[2],
      input: parseMysqlJson(cols[3], {}),
      result: parseMysqlJson(cols[4], null),
      error: cols[5] || null,
      created_at: Number(cols[6] || 0),
      updated_at: Number(cols[7] || 0),
    });
  }
  
  function loadContentAssetJobsFromMysql({ jobId = "", limit = 500 } = {}) {
    ensureContentAssetMysqlSchema();
    const where = jobId
      ? `job_uid = ${sqlString(jobId)} AND deleted_at IS NULL`
      : "deleted_at IS NULL";
    const output = runAiAdminMysql(`
  SELECT
    job_uid,
    job_type,
    status,
    COALESCE(CAST(input_json AS CHAR), '{}'),
    COALESCE(CAST(result_json AS CHAR), ''),
    COALESCE(error_text, ''),
    COALESCE(UNIX_TIMESTAMP(created_at), 0),
    COALESCE(UNIX_TIMESTAMP(updated_at), 0)
  FROM asset_jobs
  WHERE ${where}
  ORDER BY id DESC
  LIMIT ${Math.max(1, Math.min(1000, Number(limit || 500)))};
  `);
    return output
      .split("\n")
      .filter(Boolean)
      .map((line) => contentAssetJobFromColumns(line.split("\t")));
  }
  
  function getContentAssetJobFromMysql(jobId) {
    return loadContentAssetJobsFromMysql({ jobId, limit: 1 })[0] || null;
  }
  
  function createContentAssetJobInMysql(job, clientId = "") {
    ensureContentAssetMysqlSchema();
    const normalized = normalizeContentAssetJob(job);
    const sourceUrl = String(normalized.input?.url || "");
    const sourceIdentity = contentAssetSourceIdentityFromUrl(sourceUrl);
    runAiAdminMysql(`
  INSERT INTO asset_jobs
    (job_uid, job_type, status, client_id, source_url, source_type, source_identity, input_json, created_at, updated_at)
  VALUES (
    ${sqlString(normalized.id)},
    ${sqlString(normalized.type)},
    ${sqlString(normalized.status)},
    ${sqlString(clientId)},
    ${sqlString(sourceUrl || null)},
    ${sqlString(contentAssetJobSourceType(normalized.type))},
    ${sqlString(sourceIdentity || null)},
    ${sqlString(JSON.stringify(normalized.input || {}))},
    ${contentAssetJobDateSql(normalized.created_at)},
    ${contentAssetJobDateSql(normalized.updated_at)}
  )
  ON DUPLICATE KEY UPDATE
    job_type = VALUES(job_type),
    status = VALUES(status),
    client_id = VALUES(client_id),
    source_url = VALUES(source_url),
    source_type = VALUES(source_type),
    source_identity = COALESCE(asset_jobs.source_identity, VALUES(source_identity)),
    input_json = VALUES(input_json),
    updated_at = VALUES(updated_at),
    deleted_at = NULL;
  `);
    return getContentAssetJobFromMysql(normalized.id);
  }
  
  function updateContentAssetJobInMysql(jobId, payload = {}, clientId = "") {
    ensureContentAssetMysqlSchema();
    const existing = getContentAssetJobFromMysql(jobId);
    if (!existing) throw new Error("content_asset_job_not_found");
    const job = normalizeContentAssetJob({ ...existing, ...(payload.job || {}), id: jobId });
    const nextStatus = payload.status || job.status;
    const result = payload.result !== undefined ? payload.result : job.result;
    const error = payload.error !== undefined ? payload.error : job.error;
    const updatedAt = currentTimeMs() / 1000;
    const sourceIdentity =
      contentAssetSourceIdentityFromResult(result) ||
      contentAssetSourceIdentityFromUrl(String(job.input?.url || ""));
    const startedAt = nextStatus === "running" ? contentAssetJobDateSql(updatedAt) : "NULL";
    const finishedAt = ["completed", "failed", "cancelled", "deleted"].includes(nextStatus)
      ? contentAssetJobDateSql(updatedAt)
      : "NULL";
    runAiAdminMysql(`
  UPDATE asset_jobs
  SET status = ${sqlString(nextStatus)},
      client_id = CASE WHEN ${sqlString(clientId)} <> '' THEN ${sqlString(clientId)} ELSE client_id END,
      source_identity = COALESCE(${sqlString(sourceIdentity || null)}, source_identity),
      result_json = ${result == null ? "NULL" : sqlString(JSON.stringify(result))},
      error_text = ${error == null ? "NULL" : sqlString(error)},
      started_at = CASE WHEN ${startedAt} IS NOT NULL AND started_at IS NULL THEN ${startedAt} ELSE started_at END,
      finished_at = CASE WHEN ${finishedAt} IS NOT NULL THEN ${finishedAt} ELSE finished_at END,
      updated_at = ${contentAssetJobDateSql(updatedAt)}
  WHERE job_uid = ${sqlString(jobId)} AND deleted_at IS NULL;
  `);
    return getContentAssetJobFromMysql(jobId);
  }
  
  function deleteContentAssetJobInMysql(jobId) {
    ensureContentAssetMysqlSchema();
    const existing = getContentAssetJobFromMysql(jobId);
    if (!existing) return null;
    runAiAdminMysql(`
  UPDATE asset_jobs
  SET status = 'deleted',
      deleted_at = CURRENT_TIMESTAMP(3),
      finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP(3)),
      updated_at = CURRENT_TIMESTAMP(3)
  WHERE job_uid = ${sqlString(jobId)} AND deleted_at IS NULL;
  `);
    return existing;
  }

  return {
    contentAssetJobSourceType,
    contentAssetSourceIdentityFromResult,
    contentAssetSourceIdentityFromUrl,
    createContentAssetJobInMysql,
    deleteContentAssetJobInMysql,
    getContentAssetJobFromMysql,
    loadContentAssetJobsFromMysql,
    normalizeContentAssetJob,
    updateContentAssetJobInMysql,
  };
}

module.exports = {
  createContentAssetJobRepository,
};
