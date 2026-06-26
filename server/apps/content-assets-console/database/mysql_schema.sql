-- TikTok Res asset database schema
-- Created at: 2026-05-19
-- Purpose:
--   Store task metadata, local file indexes, Douyin products, product catalog
--   matching runs, match candidates, manual confirmations, and deletion logs.
--
-- Large media files stay on disk. MySQL stores metadata and relationships only.

CREATE DATABASE IF NOT EXISTS `tiktok_res`
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_0900_ai_ci;

USE `tiktok_res`;

CREATE TABLE IF NOT EXISTS `asset_jobs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `job_uid` VARCHAR(64) NOT NULL COMMENT 'Frontend/backend task id',
  `job_type` VARCHAR(64) NOT NULL COMMENT 'video_download/live_record/live_products/live_record_with_products/product_match',
  `status` VARCHAR(32) NOT NULL DEFAULT 'queued' COMMENT 'queued/running/completed/failed/deleted',
  `source_url` TEXT NULL,
  `source_type` VARCHAR(32) NULL COMMENT 'video/live/product_match',
  `source_identity` VARCHAR(128) NULL COMMENT 'aweme_id or live room_id when available',
  `input_json` JSON NULL,
  `result_json` JSON NULL,
  `error_text` TEXT NULL,
  `started_at` DATETIME NULL,
  `finished_at` DATETIME NULL,
  `deleted_at` DATETIME NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_asset_jobs_job_uid` (`job_uid`),
  KEY `idx_asset_jobs_type_status` (`job_type`, `status`),
  KEY `idx_asset_jobs_source_identity` (`source_identity`),
  KEY `idx_asset_jobs_deleted_id` (`deleted_at`, `id`),
  KEY `idx_asset_jobs_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `asset_files` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `file_uid` VARCHAR(64) NOT NULL COMMENT 'Stable generated file id',
  `file_type` VARCHAR(32) NOT NULL COMMENT 'video/clip/preview/products/room/metadata',
  `storage_driver` VARCHAR(32) NOT NULL DEFAULT 'local_disk',
  `absolute_path` TEXT NOT NULL,
  `relative_path` TEXT NULL,
  `file_name` VARCHAR(512) NOT NULL,
  `extension` VARCHAR(32) NULL,
  `mime_type` VARCHAR(128) NULL,
  `size_bytes` BIGINT UNSIGNED NULL,
  `duration_seconds` DECIMAL(12,3) NULL,
  `source_identity` VARCHAR(128) NULL COMMENT 'aweme_id or live room_id when available',
  `parent_file_id` BIGINT UNSIGNED NULL COMMENT 'preview/clip source file',
  `checksum_sha256` CHAR(64) NULL,
  `metadata_json` JSON NULL,
  `deleted_at` DATETIME NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_asset_files_file_uid` (`file_uid`),
  KEY `idx_asset_files_type_deleted` (`file_type`, `deleted_at`),
  KEY `idx_asset_files_source_identity` (`source_identity`),
  KEY `idx_asset_files_parent_file_id` (`parent_file_id`),
  KEY `idx_asset_files_created_at` (`created_at`),
  CONSTRAINT `fk_asset_files_parent`
    FOREIGN KEY (`parent_file_id`) REFERENCES `asset_files` (`id`)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `asset_job_files` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `job_id` BIGINT UNSIGNED NOT NULL,
  `file_id` BIGINT UNSIGNED NOT NULL,
  `relation_type` VARCHAR(32) NOT NULL DEFAULT 'output' COMMENT 'output/preview/clip/raw/summary',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_asset_job_files` (`job_id`, `file_id`, `relation_type`),
  KEY `idx_asset_job_files_file_id` (`file_id`),
  CONSTRAINT `fk_asset_job_files_job`
    FOREIGN KEY (`job_id`) REFERENCES `asset_jobs` (`id`)
    ON DELETE CASCADE,
  CONSTRAINT `fk_asset_job_files_file`
    FOREIGN KEY (`file_id`) REFERENCES `asset_files` (`id`)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `douyin_live_rooms` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `web_rid` VARCHAR(128) NOT NULL,
  `room_id` VARCHAR(128) NULL,
  `author_id` VARCHAR(128) NULL,
  `author_name` VARCHAR(255) NULL,
  `room_title` VARCHAR(512) NULL,
  `status` INT NULL,
  `raw_json` JSON NULL,
  `last_seen_at` DATETIME NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_douyin_live_rooms_web_rid` (`web_rid`),
  KEY `idx_douyin_live_rooms_room_id` (`room_id`),
  KEY `idx_douyin_live_rooms_author_id` (`author_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `douyin_products` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `product_uid` VARCHAR(64) NOT NULL COMMENT 'Internal id for captured Douyin product',
  `job_id` BIGINT UNSIGNED NULL,
  `live_room_id` BIGINT UNSIGNED NULL,
  `source` VARCHAR(32) NOT NULL DEFAULT 'douyin',
  `source_product_id` VARCHAR(128) NULL,
  `promotion_id` VARCHAR(128) NULL,
  `title` VARCHAR(1024) NOT NULL DEFAULT '',
  `category_json` JSON NULL,
  `cover_url` TEXT NULL,
  `detail_url` TEXT NULL,
  `show_price_yuan` DECIMAL(12,2) NULL,
  `min_price_yuan` DECIMAL(12,2) NULL,
  `max_price_yuan` DECIMAL(12,2) NULL,
  `can_add_cart` TINYINT(1) NULL,
  `can_sold` TINYINT(1) NULL,
  `raw_json` JSON NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_douyin_products_product_uid` (`product_uid`),
  KEY `idx_douyin_products_source_product_id` (`source_product_id`),
  KEY `idx_douyin_products_promotion_id` (`promotion_id`),
  KEY `idx_douyin_products_job_id` (`job_id`),
  KEY `idx_douyin_products_live_room_id` (`live_room_id`),
  FULLTEXT KEY `ft_douyin_products_title` (`title`),
  CONSTRAINT `fk_douyin_products_job`
    FOREIGN KEY (`job_id`) REFERENCES `asset_jobs` (`id`)
    ON DELETE SET NULL,
  CONSTRAINT `fk_douyin_products_live_room`
    FOREIGN KEY (`live_room_id`) REFERENCES `douyin_live_rooms` (`id`)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `product_match_runs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `match_uid` VARCHAR(64) NOT NULL,
  `job_id` BIGINT UNSIGNED NULL,
  `source` VARCHAR(64) NOT NULL DEFAULT 'douyin_live',
  `status` VARCHAR(32) NOT NULL DEFAULT 'queued',
  `conditions_json` JSON NOT NULL COMMENT 'same product/similar/category/price/review strategy',
  `agent_name` VARCHAR(128) NOT NULL DEFAULT '商品匹配智能体',
  `agent_mode` VARCHAR(64) NULL,
  `catalog_tool_name` VARCHAR(128) NULL COMMENT 'Future MCP tool name',
  `product_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `matched_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `error_text` TEXT NULL,
  `started_at` DATETIME NULL,
  `finished_at` DATETIME NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_product_match_runs_match_uid` (`match_uid`),
  KEY `idx_product_match_runs_job_id` (`job_id`),
  KEY `idx_product_match_runs_status` (`status`),
  CONSTRAINT `fk_product_match_runs_job`
    FOREIGN KEY (`job_id`) REFERENCES `asset_jobs` (`id`)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `product_match_items` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `match_run_id` BIGINT UNSIGNED NOT NULL,
  `douyin_product_id` BIGINT UNSIGNED NULL,
  `source_product_json` JSON NOT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'waiting_catalog_api',
  `agent_notes_json` JSON NULL,
  `tool_calls_json` JSON NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_product_match_items_run_id` (`match_run_id`),
  KEY `idx_product_match_items_douyin_product_id` (`douyin_product_id`),
  CONSTRAINT `fk_product_match_items_run`
    FOREIGN KEY (`match_run_id`) REFERENCES `product_match_runs` (`id`)
    ON DELETE CASCADE,
  CONSTRAINT `fk_product_match_items_douyin_product`
    FOREIGN KEY (`douyin_product_id`) REFERENCES `douyin_products` (`id`)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `product_match_candidates` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `match_item_id` BIGINT UNSIGNED NOT NULL,
  `catalog_product_id` VARCHAR(128) NULL,
  `catalog_sku_id` VARCHAR(128) NULL,
  `title` VARCHAR(1024) NOT NULL DEFAULT '',
  `image_url` TEXT NULL,
  `price_yuan` DECIMAL(12,2) NULL,
  `score` DECIMAL(8,4) NOT NULL DEFAULT 0,
  `match_type` VARCHAR(32) NOT NULL DEFAULT '候选商品',
  `match_reason` TEXT NULL,
  `rank_no` INT UNSIGNED NOT NULL DEFAULT 0,
  `raw_json` JSON NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_product_match_candidates_item_rank` (`match_item_id`, `rank_no`),
  KEY `idx_product_match_candidates_catalog_product` (`catalog_product_id`),
  KEY `idx_product_match_candidates_score` (`score`),
  FULLTEXT KEY `ft_product_match_candidates_title` (`title`),
  CONSTRAINT `fk_product_match_candidates_item`
    FOREIGN KEY (`match_item_id`) REFERENCES `product_match_items` (`id`)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `product_match_confirmations` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `match_item_id` BIGINT UNSIGNED NOT NULL,
  `candidate_id` BIGINT UNSIGNED NULL,
  `decision` VARCHAR(32) NOT NULL COMMENT 'same_product/similar_product/rejected/manual_product',
  `manual_catalog_product_id` VARCHAR(128) NULL,
  `note` TEXT NULL,
  `operator` VARCHAR(128) NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_product_match_confirmations_item` (`match_item_id`),
  KEY `idx_product_match_confirmations_candidate` (`candidate_id`),
  CONSTRAINT `fk_product_match_confirmations_item`
    FOREIGN KEY (`match_item_id`) REFERENCES `product_match_items` (`id`)
    ON DELETE CASCADE,
  CONSTRAINT `fk_product_match_confirmations_candidate`
    FOREIGN KEY (`candidate_id`) REFERENCES `product_match_candidates` (`id`)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `asset_deletion_logs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `target_type` VARCHAR(32) NOT NULL COMMENT 'job/file',
  `target_uid` VARCHAR(64) NULL,
  `job_id` BIGINT UNSIGNED NULL,
  `file_id` BIGINT UNSIGNED NULL,
  `path` TEXT NULL,
  `deleted_files_json` JSON NULL,
  `operator` VARCHAR(128) NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_asset_deletion_logs_target` (`target_type`, `target_uid`),
  KEY `idx_asset_deletion_logs_job_id` (`job_id`),
  KEY `idx_asset_deletion_logs_file_id` (`file_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `agent_tool_call_logs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `job_id` BIGINT UNSIGNED NULL,
  `match_run_id` BIGINT UNSIGNED NULL,
  `agent_name` VARCHAR(128) NULL,
  `tool_name` VARCHAR(128) NOT NULL,
  `arguments_json` JSON NULL,
  `result_summary_json` JSON NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'completed',
  `error_text` TEXT NULL,
  `started_at` DATETIME NULL,
  `finished_at` DATETIME NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_agent_tool_call_logs_job_id` (`job_id`),
  KEY `idx_agent_tool_call_logs_match_run_id` (`match_run_id`),
  KEY `idx_agent_tool_call_logs_tool_name` (`tool_name`),
  CONSTRAINT `fk_agent_tool_call_logs_job`
    FOREIGN KEY (`job_id`) REFERENCES `asset_jobs` (`id`)
    ON DELETE SET NULL,
  CONSTRAINT `fk_agent_tool_call_logs_match_run`
    FOREIGN KEY (`match_run_id`) REFERENCES `product_match_runs` (`id`)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
