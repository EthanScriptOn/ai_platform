from typing import Any, Dict

DEFAULT_CONFIG: Dict[str, Any] = {
    "path": "./Downloaded/",
    "music": True,
    "cover": True,
    "avatar": True,
    "json": True,
    "start_time": "",
    "end_time": "",
    "folderstyle": True,
    # 命名模板：渲染时可用变量见 utils/naming.py:ALLOWED_VARIABLES。默认保持
    # 与历史行为一致（`{date}_{title}_{id}`），用户可在设置中改写。
    "filename_template": "{date}_{title}_{id}",
    "folder_template": "{date}_{title}_{id}",
    # 作者目录层命名方式：
    #   "nickname"    - 作者昵称（默认，最直观，但重名会合并、改名会分裂）
    #   "sec_uid"     - 作者 sec_uid（稳定唯一，但不直观）
    #   "nickname_uid" - 昵称_sec_uid（直观 + 唯一）
    # 切换只影响后续下载，不会迁移已存在的目录。
    "author_dir": "nickname",
    "download_pinned": False,
    "mode": ["post"],
    "number": {
        "post": 0,
        "like": 0,
        "allmix": 0,
        "mix": 0,
        "music": 0,
        "collect": 0,
        "collectmix": 0,
    },
    "increase": {
        "post": False,
        "like": False,
        "allmix": False,
        "mix": False,
        "music": False,
    },
    "thread": 5,
    "retry_times": 3,
    "rate_limit": 2,
    "proxy": "",
    "database": True,
    "database_path": "dy_downloader.db",
    "progress": {
        "quiet_logs": True,
    },
    "transcript": {
        "enabled": False,
        "model": "gpt-4o-mini-transcribe",
        "output_dir": "",
        "response_formats": ["txt", "json"],
        "api_url": "https://api.openai.com/v1/audio/transcriptions",
        "api_key_env": "OPENAI_API_KEY",
        "api_key": "",
    },
    "video_product_mapping": {
        "model": "qwen3.7-plus",
        "api_url": "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
        "api_key": "",
        "input_mode": "oss_url",
        "chunk_seconds": 15,
        "overlap_seconds": 3,
        "max_chunks": 0,
        "max_candidates": 400,
        "scale_width": 640,
        "crf": 31,
        "timeout_seconds": 900,
    },
    "product_matching": {
        "provider": "multi_platform",
    },
    "union_comments_mysql": {
        "enabled": False,
        "host": "",
        "port": 3306,
        "user": "",
        "password": "",
        "database": "",
        "table_prefix": "fa_",
    },
    "douyin_buyin": {
        "server_url": "https://openapi-fxg.jinritemai.com",
        "app_key": "",
        "app_secret": "",
        "access_token": "",
        "pid": "",
        "page_size": 3,
        "search_type": 1,
        "sort_type": 1,
        "share_status": 1,
        "timeout_seconds": 20,
        "verify_ssl": True,
    },
    "jd_union": {
        "server_url": "https://api.jd.com/routerjson",
        "app_key": "",
        "app_secret": "",
        "access_token": "",
        "page_size": 3,
        "scene_id": 1,
        "timeout_seconds": 20,
        "verify_ssl": True,
        "fields": (
            "smartDocumentInfoList,comment,specInfo,videoInfo,hotWords,similar,"
            "documentInfo,skuLabelInfo,promotionLabelInfo,stockState,companyType,"
            "purchasePriceInfo,purchaseBPriceInfo,freeShippingInfo,seckillSpecialPriceInfo"
        ),
    },
    "taobao_union": {
        "gateway_url": "http://gw.api.taobao.com/router/rest",
        "app_key": "",
        "app_secret": "",
        "session_key": "",
        "pid": "",
        "site_id": "",
        "adzone_id": "",
        "account_type": "agency",
        "material_id": 80309,
        "biz_scene_id": 1,
        "sort": "match_des",
        "page_size": 3,
        "timeout_seconds": 20,
        "verify_ssl": True,
        "service_app_key": "",
        "service_app_secret": "",
    },
    "oss": {
        "access_key_id": "",
        "access_key_secret": "",
        "bucket": "",
        "endpoint": "",
        "public_host": "",
        "key_prefix": "tiktok_res/video_product_mapping",
    },
    "auto_cookie": False,
    "browser_fallback": {
        "enabled": True,
        "headless": False,
        "max_scrolls": 240,
        "idle_rounds": 8,
        "wait_timeout_seconds": 600,
    },
    # 下载完成通知（可选）。providers 支持 bark / telegram / webhook。
    "notifications": {
        "enabled": False,
        "on_success": True,
        "on_failure": True,
        "providers": [],
    },
    # 评论采集（可选）。启用后每个作品会额外生成 *_comments.json。
    "comments": {
        "enabled": False,
        "include_replies": False,
        "max_comments": 0,  # 0 = 不限
        "page_size": 20,
    },
    # 直播录制（可选）。由 live.douyin.com / /follow/live/ 链接触发。
    "live": {
        "max_duration_seconds": 0,  # 0 = 直到流结束
        "chunk_size": 65536,
        "idle_timeout_seconds": 30,
    },
    # REST API 服务模式（可选，需 fastapi + uvicorn）。
    "server": {
        "max_jobs": 500,  # 内存中保留的 job 条数上限（不含 in-flight）
        "job_ttl_seconds": 86400,  # 完成态 job 保留时间（秒）
    },
    "mysql": {
        "enabled": False,
        "host": "",
        "port": 3306,
        "user": "",
        "password": "",
        "database": "",
    },
}
