from __future__ import annotations

import asyncio
import json
import os
from html import escape
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import quote

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from tiktok_res_app.product_matching import MatchRequest, ProductMatchAgent
from tiktok_res_app.platform_agent import run_platform_agent
from tiktok_res_app.union_comments import query_union_comments
from tiktok_res_app.video_product_mapping import VideoProductMapper, video_product_mapping_status
from tiktok_res_app.services import (
    CONFIG_PATH,
    DEFAULT_LOGIN_URL,
    JobStore,
    autosave_login_session,
    cancel_login_session,
    clip_video,
    cookie_status,
    delete_job_output_files,
    delete_output_file,
    fetch_live_products,
    logout_saved_cookies,
    load_config,
    looks_like_live_url,
    prepare_video_preview,
    read_json_output_file,
    resolve_output_path,
    run_downloader,
    save_login_session,
    scan_library,
    start_login_session,
    sync_login_session_once,
)
from utils.asyncio_compat import to_thread


ROOT = Path(__file__).resolve().parents[1]
STATIC_DIR = ROOT / "tiktok_res_app" / "static"


class UrlRequest(BaseModel):
    url: str = Field(..., min_length=5)


class LiveRecordRequest(UrlRequest):
    duration_seconds: int = Field(0, ge=0, description="0 means record until stream ends")


class ProductRequest(UrlRequest):
    offset: int = Field(0, ge=0)
    limit: int = Field(20, ge=1, le=100)
    all_products: bool = False


class RecordWithProductsRequest(LiveRecordRequest):
    offset: int = Field(0, ge=0)
    limit: int = Field(20, ge=1, le=100)
    all_products: bool = False


class LoginStartRequest(BaseModel):
    url: str = Field(DEFAULT_LOGIN_URL, min_length=5)
    fresh: bool = False


class MediaPathRequest(BaseModel):
    path: str = Field(..., min_length=1)


class ClipRequest(MediaPathRequest):
    start_seconds: float = Field(..., ge=0)
    end_seconds: float = Field(..., gt=0)


class VideoProductMapRequest(BaseModel):
    video_path: str = Field(..., min_length=1)
    products_path: str = Field(..., min_length=1)


class ProductCommentRequest(BaseModel):
    platform: str = ""
    product_id: str = ""
    sku_id: str = ""
    item_id: str = ""
    detail_url: str = ""
    raw: Dict[str, Any] = Field(default_factory=dict)
    limit: int = Field(8, ge=1, le=30)
    offset: int = Field(0, ge=0)


app = FastAPI(title="TikTok Res Local Console", version="1.0.0")
jobs = JobStore(config_path=str(CONFIG_PATH))
running_tasks: Dict[str, asyncio.Task[Any]] = {}
platform_agent_task: Optional[asyncio.Task[Any]] = None


@app.middleware("http")
async def allow_platform_media_access(request: Request, call_next: Any) -> Response:
    if request.method == "OPTIONS":
        response = Response(status_code=204)
    else:
        response = await call_next(request)
    origin = request.headers.get("origin") or "*"
    requested_headers = request.headers.get("access-control-request-headers")
    response.headers["Access-Control-Allow-Origin"] = origin
    response.headers["Access-Control-Allow-Methods"] = "GET,HEAD,POST,OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = requested_headers or "Content-Type, Range, Accept, Origin"
    response.headers["Access-Control-Allow-Private-Network"] = "true"
    response.headers.setdefault("Access-Control-Expose-Headers", "Content-Length,Content-Range,Accept-Ranges")
    if origin != "*":
        response.headers["Access-Control-Allow-Credentials"] = "true"
        response.headers["Vary"] = "Origin, Access-Control-Request-Headers, Access-Control-Request-Private-Network"
    return response


class PartialJobFailure(RuntimeError):
    """Raised after a job has persisted partial result data."""


@app.on_event("startup")
async def start_platform_agent() -> None:
    global platform_agent_task
    if os.getenv("CONTENT_ASSET_DISABLE_PLATFORM_AGENT") == "1":
        return
    if platform_agent_task is None:
        platform_agent_task = asyncio.create_task(run_platform_agent(str(CONFIG_PATH)))


@app.on_event("shutdown")
async def stop_platform_agent() -> None:
    if platform_agent_task is not None:
        platform_agent_task.cancel()


async def run_job(job_id: str, coro: Any) -> None:
    await jobs.update(job_id, status="running")
    try:
        result = await coro
    except asyncio.CancelledError:
        await jobs.update(job_id, status="cancelled", error="任务已暂停")
        raise
    except Exception as exc:
        current = await jobs.get(job_id)
        if current and current.get("status") == "cancelled":
            return
        await jobs.update(job_id, status="failed", error=str(exc))
    else:
        current = await jobs.get(job_id)
        if current and current.get("status") == "cancelled":
            return
        await jobs.update(job_id, status="completed", result=result)
    finally:
        running_tasks.pop(job_id, None)


def schedule_job(job_id: str, coro: Any) -> asyncio.Task[Any]:
    task = asyncio.create_task(run_job(job_id, coro))
    running_tasks[job_id] = task
    return task


async def cancel_running_job(job_id: str) -> Dict[str, Any]:
    job = await jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    if job.get("status") not in {"queued", "running"}:
        return job
    task = running_tasks.get(job_id)
    if task and not task.done():
        task.cancel()
        try:
            await asyncio.wait_for(task, timeout=2)
        except asyncio.CancelledError:
            pass
        except asyncio.TimeoutError:
            pass
    await jobs.update(job_id, status="cancelled", error="任务已暂停")
    return await jobs.get(job_id) or job


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(
        STATIC_DIR / "index.html",
        headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"},
    )


@app.get("/bridge.html")
async def bridge() -> HTMLResponse:
    body = """<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Yuebai Content Assets Bridge</title>
  </head>
  <body>
    <script>
      const params = new URLSearchParams(location.search);
      const parentOrigin = params.get("origin") || "*";

      async function requestLocal(message) {
        const request = message && message.request ? message.request : {};
        const apiPath = request.path || "/api/health";
        const options = request.options || {};
        const response = await fetch(apiPath, options);
        const contentType = response.headers.get("content-type") || "";
        const data = contentType.includes("application/json")
          ? await response.json()
          : { ok: response.ok, body: await response.text() };
        if (!response.ok) {
          throw new Error(data.error || data.detail || data.message || ("HTTP " + response.status));
        }
        return data;
      }

      window.addEventListener("message", async (event) => {
        if (parentOrigin !== "*" && event.origin !== parentOrigin) return;
        const message = event.data || {};
        if (message.source !== "yuebai-platform" || !message.id) return;
        try {
          const data = await requestLocal(message);
          event.source.postMessage({
            source: "yuebai-collector-bridge",
            id: message.id,
            ok: true,
            data,
          }, event.origin);
        } catch (error) {
          event.source.postMessage({
            source: "yuebai-collector-bridge",
            id: message.id,
            ok: false,
            error: error && error.message ? error.message : "请求失败",
          }, event.origin);
        }
      });

      window.parent.postMessage({ source: "yuebai-collector-bridge", ready: true }, parentOrigin);
    </script>
  </body>
</html>"""
    return HTMLResponse(
        body,
        headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"},
    )


@app.get("/api/health")
async def health() -> Dict[str, Any]:
    status = video_product_mapping_status(load_config())
    return {
        "ok": True,
        "status": "ok",
        "bridge_ready": True,
        "video_product_mapping_ready": status["ready"],
        "video_product_mapping_message": status["message"],
        "video_product_mapping_input_mode": status["input_mode"],
    }


@app.get("/api/auth/status")
async def auth_status() -> Dict[str, Any]:
    return await sync_login_session_once()


@app.post("/api/auth/login/start")
async def auth_login_start(request: LoginStartRequest) -> Dict[str, Any]:
    try:
        return await start_login_session(request.url, fresh=request.fresh)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/auth/login/save")
async def auth_login_save() -> Dict[str, Any]:
    try:
        return await save_login_session()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/auth/login/autosave")
async def auth_login_autosave() -> Dict[str, Any]:
    try:
        return await autosave_login_session()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/auth/login/cancel")
async def auth_login_cancel() -> Dict[str, Any]:
    try:
        return await cancel_login_session()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/auth/logout")
async def auth_logout() -> Dict[str, Any]:
    try:
        return await logout_saved_cookies()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/jobs")
async def list_jobs() -> Dict[str, Any]:
    return {"jobs": await jobs.list()}


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str) -> Dict[str, Any]:
    job = await jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    return job


@app.delete("/api/jobs/{job_id}")
async def delete_job(job_id: str) -> Dict[str, Any]:
    job = await jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    if job.get("status") in {"queued", "running"}:
        job = await cancel_running_job(job_id)
    try:
        delete_result = delete_job_output_files(job)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    deleted_job = await jobs.delete(job_id)
    return {
        "deleted_job": bool(deleted_job),
        "deleted_files": delete_result["deleted"],
    }


@app.post("/api/jobs/{job_id}/cancel")
async def cancel_job(job_id: str) -> Dict[str, Any]:
    return {"job": await cancel_running_job(job_id)}


@app.get("/api/library")
async def library() -> Dict[str, Any]:
    status = video_product_mapping_status(load_config())
    return {
        "items": scan_library(),
        "video_product_mapping_ready": status["ready"],
        "video_product_mapping_message": status["message"],
        "video_product_mapping_input_mode": status["input_mode"],
    }


@app.post("/api/library/delete")
async def delete_library_file(request: MediaPathRequest) -> Dict[str, Any]:
    try:
        return delete_output_file(request.path, include_associated=False)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/library/preview")
async def preview_library_file(request: MediaPathRequest) -> Dict[str, Any]:
    try:
        return read_json_output_file(request.path)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/media")
async def media(path: str) -> FileResponse:
    try:
        file_path = resolve_output_path(path)
    except Exception as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return FileResponse(file_path)


@app.head("/api/media")
async def media_head(path: str) -> Response:
    try:
        file_path = resolve_output_path(path)
        stat = file_path.stat()
    except Exception as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return Response(
        status_code=200,
        headers={
            "Accept-Ranges": "bytes",
            "Content-Length": str(stat.st_size),
            "Content-Type": "application/octet-stream",
        },
    )


@app.get("/player.html")
async def media_player(path: str) -> HTMLResponse:
    try:
        file_path = resolve_output_path(path)
    except Exception as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    encoded_path = quote(str(file_path), safe="")
    title = escape(file_path.name)
    return HTMLResponse(f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{title}</title>
  <style>
    html, body {{ margin: 0; width: 100%; height: 100%; background: #070707; color: #f7f3ea; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }}
    .wrap {{ min-height: 100%; display: grid; grid-template-rows: 1fr auto; }}
    video {{ width: 100%; height: 100%; max-height: calc(100vh - 48px); background: #000; object-fit: contain; }}
    .bar {{ display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; font-size: 13px; background: rgba(255,255,255,.06); }}
    .name {{ overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }}
    a {{ color: #f6c96f; text-decoration: none; }}
  </style>
</head>
<body>
  <div class="wrap">
    <video controls autoplay preload="metadata" src="/api/media?path={encoded_path}"></video>
    <div class="bar">
      <div class="name">{title}</div>
      <a href="/api/media?path={encoded_path}" download>下载</a>
    </div>
  </div>
</body>
</html>""")


@app.get("/clipper.html")
async def media_clipper(path: str) -> HTMLResponse:
    try:
        file_path = resolve_output_path(path)
    except Exception as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    initial_path = json.dumps(str(file_path))
    title = escape(file_path.name)
    return HTMLResponse(f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>剪辑 - {title}</title>
  <style>
    :root {{ color-scheme: dark; --bg: #080806; --panel: #17140f; --line: rgba(255,255,255,.12); --text: #f7f1e3; --muted: #b8ad99; --gold: #f4bf63; }}
    * {{ box-sizing: border-box; }}
    body {{ margin: 0; min-height: 100vh; background: radial-gradient(circle at 20% 0%, #332414, transparent 36%), var(--bg); color: var(--text); font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }}
    .shell {{ width: min(1180px, calc(100vw - 28px)); margin: 0 auto; padding: 20px 0 28px; }}
    .head {{ display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 14px; }}
    h1 {{ margin: 0; font-size: 20px; }}
    .path {{ margin-top: 6px; color: var(--muted); font-size: 12px; word-break: break-all; }}
    .grid {{ display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 16px; }}
    .card {{ border: 1px solid var(--line); border-radius: 16px; background: rgba(23,20,15,.86); box-shadow: 0 20px 80px rgba(0,0,0,.28); overflow: hidden; }}
    video {{ display: block; width: 100%; max-height: 68vh; background: #000; }}
    .controls {{ padding: 16px; display: grid; gap: 14px; }}
    .row {{ display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }}
    label {{ display: grid; gap: 6px; color: var(--muted); font-size: 12px; }}
    input[type="number"] {{ width: 100%; border: 1px solid var(--line); border-radius: 10px; background: #0d0c09; color: var(--text); padding: 10px; }}
    input[type="range"] {{ width: 100%; accent-color: var(--gold); }}
    button, a.button {{ border: 0; border-radius: 999px; padding: 10px 14px; background: var(--gold); color: #1e1609; font-weight: 700; cursor: pointer; text-decoration: none; text-align: center; }}
    button.secondary {{ background: rgba(255,255,255,.1); color: var(--text); }}
    button:disabled {{ opacity: .55; cursor: not-allowed; }}
    .status {{ color: var(--muted); font-size: 13px; line-height: 1.6; }}
    .actions {{ display: flex; flex-wrap: wrap; gap: 10px; }}
    .output {{ display: none; padding: 16px; border-top: 1px solid var(--line); }}
    .output.show {{ display: grid; gap: 12px; }}
    @media (max-width: 880px) {{ .grid {{ grid-template-columns: 1fr; }} }}
  </style>
</head>
<body>
  <main class="shell">
    <div class="head">
      <div>
        <h1>本机剪辑台</h1>
        <div class="path" id="sourcePath">{title}</div>
      </div>
      <button class="secondary" onclick="window.close()">关闭</button>
    </div>
    <div class="grid">
      <section class="card">
        <video id="video" controls preload="metadata"></video>
      </section>
      <aside class="card controls">
        <div class="status" id="status">正在准备可播放预览...</div>
        <div>
          <label>片段开始 <strong id="startLabel">00:00.0</strong></label>
          <input id="startRange" type="range" min="0" max="1" step="0.1" value="0" />
        </div>
        <div>
          <label>片段结束 <strong id="endLabel">00:01.0</strong></label>
          <input id="endRange" type="range" min="0" max="1" step="0.1" value="1" />
        </div>
        <div class="row">
          <label>开始秒数<input id="startInput" type="number" min="0" step="0.1" value="0" /></label>
          <label>结束秒数<input id="endInput" type="number" min="0" step="0.1" value="1" /></label>
        </div>
        <div class="actions">
          <button class="secondary" id="jumpStart">跳到开始</button>
          <button class="secondary" id="jumpEnd">跳到结束</button>
          <button id="exportBtn">导出片段</button>
        </div>
        <div class="status">导出会保存在原视频目录的 <code>clips</code> 文件夹里。</div>
      </aside>
    </div>
    <section class="card output" id="output">
      <div class="status" id="outputText"></div>
      <video id="outputVideo" controls preload="metadata"></video>
      <div class="actions"><a class="button" id="downloadLink" href="#" download>下载片段</a></div>
    </section>
  </main>
  <script>
    const initialPath = {initial_path};
    let sourcePath = initialPath;
    let previewPath = "";
    let duration = 1;
    const $ = (id) => document.getElementById(id);
    const mediaUrl = (path) => "/api/media?path=" + encodeURIComponent(path || "");
    const fmt = (value) => {{
      const total = Math.max(0, Number(value || 0));
      const m = Math.floor(total / 60);
      const s = (total - m * 60).toFixed(1).padStart(4, "0");
      return String(m).padStart(2, "0") + ":" + s;
    }};
    const setStatus = (text) => $("status").textContent = text;
    const sync = (changed, raw) => {{
      let start = Number(changed === "start" ? raw : $("startInput").value || 0);
      let end = Number(changed === "end" ? raw : $("endInput").value || duration);
      start = Math.max(0, Math.min(duration, start));
      end = Math.max(0, Math.min(duration, end));
      if (start >= end) {{
        if (changed === "start") start = Math.max(0, end - 0.5);
        else end = Math.min(duration, start + 0.5);
      }}
      $("startRange").value = start;
      $("endRange").value = end;
      $("startInput").value = start.toFixed(1);
      $("endInput").value = end.toFixed(1);
      $("startLabel").textContent = fmt(start);
      $("endLabel").textContent = fmt(end);
    }};
    async function postJson(url, body) {{
      const res = await fetch(url, {{ method: "POST", headers: {{ "Content-Type": "application/json" }}, body: JSON.stringify(body) }});
      const data = await res.json().catch(() => ({{}}));
      if (!res.ok) throw new Error(data.detail || data.error || data.message || "请求失败");
      return data;
    }}
    async function boot() {{
      try {{
        const data = await postJson("/api/video/preview", {{ path: initialPath }});
        sourcePath = data.source_path || initialPath;
        previewPath = data.preview_path || sourcePath;
        duration = Math.max(1, Number(data.duration_seconds || 1));
        $("sourcePath").textContent = sourcePath;
        $("video").src = mediaUrl(previewPath);
        ["startRange", "endRange"].forEach((id) => {{ $(id).max = duration; }});
        $("endRange").value = duration;
        $("endInput").value = duration.toFixed(1);
        sync("end", duration);
        setStatus("预览已准备好，可以拖动时间轴选择片段。总时长 " + fmt(duration));
      }} catch (error) {{
        setStatus("预览失败：" + error.message);
        $("exportBtn").disabled = true;
      }}
    }}
    ["startRange", "startInput"].forEach((id) => $(id).addEventListener("input", (event) => sync("start", event.target.value)));
    ["endRange", "endInput"].forEach((id) => $(id).addEventListener("input", (event) => sync("end", event.target.value)));
    $("jumpStart").onclick = () => $("video").currentTime = Number($("startInput").value || 0);
    $("jumpEnd").onclick = () => $("video").currentTime = Number($("endInput").value || 0);
    $("exportBtn").onclick = async () => {{
      $("exportBtn").disabled = true;
      setStatus("正在导出片段...");
      try {{
        const data = await postJson("/api/video/clip", {{
          path: sourcePath,
          start_seconds: Number($("startInput").value || 0),
          end_seconds: Number($("endInput").value || duration),
        }});
        $("output").classList.add("show");
        $("outputText").textContent = "片段已导出：" + data.clip_path;
        $("outputVideo").src = mediaUrl(data.clip_path);
        $("downloadLink").href = mediaUrl(data.clip_path);
        setStatus("导出完成。");
      }} catch (error) {{
        setStatus("导出失败：" + error.message);
      }} finally {{
        $("exportBtn").disabled = false;
      }}
    }};
    boot();
  </script>
</body>
</html>""")


@app.post("/api/video/preview")
async def video_preview(request: MediaPathRequest) -> Dict[str, Any]:
    try:
        return await prepare_video_preview(request.path)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/video/clip")
async def video_clip(request: ClipRequest) -> Dict[str, Any]:
    try:
        return await clip_video(
            request.path,
            start_seconds=request.start_seconds,
            end_seconds=request.end_seconds,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/video/download")
async def download_video(request: UrlRequest) -> Dict[str, Any]:
    if looks_like_live_url(request.url):
        raise HTTPException(status_code=400, detail="这是直播链接，请切换到“处理直播”后选择录制、抓商品或录制+商品。")
    job = await jobs.create("video_download", request.model_dump())
    schedule_job(job.id, run_downloader(request.url))
    return {"job_id": job.id, "status": job.status}


@app.post("/api/live/record")
async def record_live(request: LiveRecordRequest) -> Dict[str, Any]:
    job = await jobs.create("live_record", request.model_dump())
    schedule_job(
        job.id,
        run_downloader(request.url, live_duration_seconds=request.duration_seconds),
    )
    return {"job_id": job.id, "status": job.status}


@app.post("/api/live/products")
async def live_products(request: ProductRequest) -> Dict[str, Any]:
    job = await jobs.create("live_products", request.model_dump())
    schedule_job(
        job.id,
        fetch_live_products(
            request.url,
            offset=request.offset,
            limit=request.limit,
            all_products=request.all_products,
        ),
    )
    return {"job_id": job.id, "status": job.status}


@app.post("/api/live/record-with-products")
async def record_with_products(request: RecordWithProductsRequest) -> Dict[str, Any]:
    job = await jobs.create("live_record_with_products", request.model_dump())

    async def work() -> Dict[str, Any]:
        result: Dict[str, Any] = {}
        errors: Dict[str, str] = {}
        try:
            result["products"] = await fetch_live_products(
                request.url,
                offset=request.offset,
                limit=request.limit,
                all_products=request.all_products,
            )
        except Exception as exc:
            errors["products"] = str(exc)
        try:
            result["recording"] = await run_downloader(
                request.url,
                live_duration_seconds=request.duration_seconds,
            )
        except Exception as exc:
            errors["recording"] = str(exc)
        if errors:
            result["errors"] = errors
            await jobs.update(job.id, status="failed", result=result, error="；".join(errors.values()))
            raise PartialJobFailure("；".join(errors.values()))
        return result

    schedule_job(job.id, work())
    return {"job_id": job.id, "status": job.status}


@app.post("/api/products/match")
async def match_products(request: MatchRequest) -> Dict[str, Any]:
    job = await jobs.create("product_match", request.model_dump())
    agent = ProductMatchAgent(config=load_config())
    schedule_job(job.id, agent.run(request))
    return {"job_id": job.id, "status": job.status}


@app.post("/api/products/comments")
async def product_comments(request: ProductCommentRequest) -> Dict[str, Any]:
    try:
        return await to_thread(
            query_union_comments,
            load_config(),
            request.model_dump(),
            limit=request.limit,
            offset=request.offset,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/video/products/map")
async def map_video_products(request: VideoProductMapRequest) -> Dict[str, Any]:
    job = await jobs.create("video_product_map", request.model_dump())

    async def work() -> Dict[str, Any]:
        await jobs.update(
            job.id,
            status="running",
            result={
                "video_path": request.video_path,
                "products_path": request.products_path,
                "matched_products": [],
                "chunks": [],
                "pipeline": {
                    "status": "preparing",
                    "summary": "正在读取视频和商品数据",
                    "counts": {},
                },
            },
        )

        async def on_progress(progress: Dict[str, Any]) -> None:
            await jobs.update(job.id, status="running", result=progress)

        mapper = VideoProductMapper(load_config(), progress_callback=on_progress)
        return await mapper.run(request.video_path, request.products_path)

    schedule_job(job.id, work())
    return {"job_id": job.id, "status": job.status}


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
