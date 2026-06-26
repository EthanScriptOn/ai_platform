"use strict";

function createAiAdminSchemaManager({
  AI_ADMIN_MYSQL_AUTO_MIGRATE,
  AI_ADMIN_STORAGE_BACKEND,
  runAiAdminMysql,
}) {
  let personaMysqlSchemaReady = false;
  let contentAssetMysqlSchemaReady = false;
  let groupIntentMysqlSchemaReady = false;
  let runtimeTokenMysqlSchemaReady = false;
  let runtimeSettingsMysqlSchemaReady = false;

  function isAiAdminMysqlEnabled() {
    return AI_ADMIN_STORAGE_BACKEND === "mysql";
  }

  function ensurePersonaMysqlSchema() {
    if (!isAiAdminMysqlEnabled() || personaMysqlSchemaReady || !AI_ADMIN_MYSQL_AUTO_MIGRATE) return;
    runAiAdminMysql(`
CREATE TABLE IF NOT EXISTS persona_distill_projects (
  id VARCHAR(64) NOT NULL,
  name VARCHAR(191) NOT NULL DEFAULT '',
  title VARCHAR(255) NOT NULL DEFAULT '',
  status VARCHAR(64) NOT NULL DEFAULT 'draft',
  material_mode VARCHAR(64) NOT NULL DEFAULT 'materials_required',
  depth_level VARCHAR(64) NOT NULL DEFAULT 'commercial',
  target_rounds INT NOT NULL DEFAULT 5,
  current_round INT NOT NULL DEFAULT 0,
  quality_gate VARCHAR(64) NOT NULL DEFAULT 'commercial',
  quality_score DECIMAL(5,2) DEFAULT NULL,
  prompt TEXT,
  purpose TEXT,
  focus_json JSON DEFAULT NULL,
  sources_json JSON DEFAULT NULL,
  dimensions_json JSON DEFAULT NULL,
  risks_json JSON DEFAULT NULL,
  distill_result_json JSON DEFAULT NULL,
  skill_markdown LONGTEXT,
  skill_dir VARCHAR(1024) NOT NULL DEFAULT '',
  last_run_at DATETIME(3) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_persona_distill_status_updated (status, updated_at),
  KEY idx_persona_distill_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
`);
    const columns = new Set(
      runAiAdminMysql("SHOW COLUMNS FROM persona_distill_projects;")
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split("\t")[0])
    );
    if (!columns.has("material_mode")) {
      runAiAdminMysql("ALTER TABLE persona_distill_projects ADD COLUMN material_mode VARCHAR(64) NOT NULL DEFAULT 'materials_required' AFTER status;");
    }
    if (!columns.has("prompt")) {
      runAiAdminMysql("ALTER TABLE persona_distill_projects ADD COLUMN prompt TEXT AFTER material_mode;");
    }
    if (!columns.has("depth_level")) {
      runAiAdminMysql("ALTER TABLE persona_distill_projects ADD COLUMN depth_level VARCHAR(64) NOT NULL DEFAULT 'commercial' AFTER material_mode;");
    }
    if (!columns.has("target_rounds")) {
      runAiAdminMysql("ALTER TABLE persona_distill_projects ADD COLUMN target_rounds INT NOT NULL DEFAULT 5 AFTER depth_level;");
    }
    if (!columns.has("current_round")) {
      runAiAdminMysql("ALTER TABLE persona_distill_projects ADD COLUMN current_round INT NOT NULL DEFAULT 0 AFTER target_rounds;");
    }
    if (!columns.has("quality_gate")) {
      runAiAdminMysql("ALTER TABLE persona_distill_projects ADD COLUMN quality_gate VARCHAR(64) NOT NULL DEFAULT 'commercial' AFTER current_round;");
    }
    if (!columns.has("quality_score")) {
      runAiAdminMysql("ALTER TABLE persona_distill_projects ADD COLUMN quality_score DECIMAL(5,2) DEFAULT NULL AFTER quality_gate;");
    }
    if (!columns.has("distill_result_json")) {
      runAiAdminMysql("ALTER TABLE persona_distill_projects ADD COLUMN distill_result_json JSON DEFAULT NULL AFTER risks_json;");
    }
    if (!columns.has("skill_markdown")) {
      runAiAdminMysql("ALTER TABLE persona_distill_projects ADD COLUMN skill_markdown LONGTEXT AFTER distill_result_json;");
    }
    if (!columns.has("skill_dir")) {
      runAiAdminMysql("ALTER TABLE persona_distill_projects ADD COLUMN skill_dir VARCHAR(1024) NOT NULL DEFAULT '' AFTER skill_markdown;");
    }
    if (!columns.has("last_run_at")) {
      runAiAdminMysql("ALTER TABLE persona_distill_projects ADD COLUMN last_run_at DATETIME(3) DEFAULT NULL AFTER skill_dir;");
    }
    personaMysqlSchemaReady = true;
  }

  function ensureContentAssetMysqlSchema() {
    if (!isAiAdminMysqlEnabled() || contentAssetMysqlSchemaReady || !AI_ADMIN_MYSQL_AUTO_MIGRATE) return;
    runAiAdminMysql(`
CREATE TABLE IF NOT EXISTS asset_jobs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  job_uid VARCHAR(64) NOT NULL,
  job_type VARCHAR(64) NOT NULL DEFAULT '',
  status VARCHAR(64) NOT NULL DEFAULT 'queued',
  client_id VARCHAR(191) NOT NULL DEFAULT '',
  source_url TEXT,
  source_type VARCHAR(64) DEFAULT NULL,
  source_identity VARCHAR(191) DEFAULT NULL,
  input_json JSON DEFAULT NULL,
  result_json JSON DEFAULT NULL,
  error_text TEXT,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  started_at DATETIME(3) DEFAULT NULL,
  finished_at DATETIME(3) DEFAULT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3) DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_asset_jobs_uid (job_uid),
  KEY idx_asset_jobs_status_updated (status, updated_at),
  KEY idx_asset_jobs_client_updated (client_id, updated_at),
  KEY idx_asset_jobs_source (source_type, source_identity)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`);
    const columns = new Set(
      runAiAdminMysql("SHOW COLUMNS FROM asset_jobs;")
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split("\t")[0])
    );
    if (!columns.has("client_id")) {
      runAiAdminMysql("ALTER TABLE asset_jobs ADD COLUMN client_id VARCHAR(191) NOT NULL DEFAULT '' AFTER status;");
    }
    if (!columns.has("source_url")) {
      runAiAdminMysql("ALTER TABLE asset_jobs ADD COLUMN source_url TEXT AFTER client_id;");
    }
    if (!columns.has("source_type")) {
      runAiAdminMysql("ALTER TABLE asset_jobs ADD COLUMN source_type VARCHAR(64) DEFAULT NULL AFTER source_url;");
    }
    if (!columns.has("source_identity")) {
      runAiAdminMysql("ALTER TABLE asset_jobs ADD COLUMN source_identity VARCHAR(191) DEFAULT NULL AFTER source_type;");
    }
    if (!columns.has("input_json")) {
      runAiAdminMysql("ALTER TABLE asset_jobs ADD COLUMN input_json JSON DEFAULT NULL AFTER source_identity;");
    }
    if (!columns.has("result_json")) {
      runAiAdminMysql("ALTER TABLE asset_jobs ADD COLUMN result_json JSON DEFAULT NULL AFTER input_json;");
    }
    if (!columns.has("error_text")) {
      runAiAdminMysql("ALTER TABLE asset_jobs ADD COLUMN error_text TEXT AFTER result_json;");
    }
    if (!columns.has("started_at")) {
      runAiAdminMysql("ALTER TABLE asset_jobs ADD COLUMN started_at DATETIME(3) DEFAULT NULL AFTER created_at;");
    }
    if (!columns.has("finished_at")) {
      runAiAdminMysql("ALTER TABLE asset_jobs ADD COLUMN finished_at DATETIME(3) DEFAULT NULL AFTER started_at;");
    }
    if (!columns.has("deleted_at")) {
      runAiAdminMysql("ALTER TABLE asset_jobs ADD COLUMN deleted_at DATETIME(3) DEFAULT NULL AFTER updated_at;");
    }
    contentAssetMysqlSchemaReady = true;
  }

  function ensureGroupIntentMysqlSchema() {
    if (!isAiAdminMysqlEnabled() || groupIntentMysqlSchemaReady || !AI_ADMIN_MYSQL_AUTO_MIGRATE) return;
    runAiAdminMysql(`
CREATE TABLE IF NOT EXISTS group_intent_auto_train_jobs (
  id VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'queued',
  target_count INT NOT NULL DEFAULT 0,
  batch_size INT NOT NULL DEFAULT 25,
  generated_count INT NOT NULL DEFAULT 0,
  trained_count INT NOT NULL DEFAULT 0,
  total_samples INT DEFAULT NULL,
  class_counts_json JSON DEFAULT NULL,
  message TEXT,
  error_text TEXT,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  started_at DATETIME(3) DEFAULT NULL,
  finished_at DATETIME(3) DEFAULT NULL,
  domain_type VARCHAR(64) NOT NULL DEFAULT 'mother_baby',
  PRIMARY KEY (id),
  KEY idx_group_intent_jobs_status_updated (status, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`);
    const columns = new Set(
      runAiAdminMysql("SHOW COLUMNS FROM group_intent_auto_train_jobs;")
        .split("\n")
        .map((line) => line.split("\t")[0])
        .filter(Boolean)
    );
    if (!columns.has("domain_type")) {
      runAiAdminMysql(
        "ALTER TABLE group_intent_auto_train_jobs ADD COLUMN domain_type VARCHAR(64) NOT NULL DEFAULT 'mother_baby' AFTER finished_at;"
      );
    }
    groupIntentMysqlSchemaReady = true;
  }

  function ensureRuntimeTokenMysqlSchema() {
    if (!isAiAdminMysqlEnabled() || runtimeTokenMysqlSchemaReady || !AI_ADMIN_MYSQL_AUTO_MIGRATE) return;
    runAiAdminMysql(`
CREATE TABLE IF NOT EXISTS ai_admin_runtime_tokens (
  token_key VARCHAR(128) NOT NULL,
  token_value TEXT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (token_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`);
    runtimeTokenMysqlSchemaReady = true;
  }

  function ensureRuntimeSettingsMysqlSchema() {
    if (!isAiAdminMysqlEnabled() || runtimeSettingsMysqlSchemaReady || !AI_ADMIN_MYSQL_AUTO_MIGRATE) return;
    runAiAdminMysql(`
CREATE TABLE IF NOT EXISTS ai_admin_runtime_settings (
  setting_key VARCHAR(128) NOT NULL,
  setting_value TEXT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`);
    runtimeSettingsMysqlSchemaReady = true;
  }

  return {
    ensureContentAssetMysqlSchema,
    ensureGroupIntentMysqlSchema,
    ensurePersonaMysqlSchema,
    ensureRuntimeSettingsMysqlSchema,
    ensureRuntimeTokenMysqlSchema,
    isAiAdminMysqlEnabled,
  };
}

module.exports = {
  createAiAdminSchemaManager,
};
