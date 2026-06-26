# TikTok Res 本地控制台

本项目固化了三件事：

- 下载抖音视频/图集/主页等原 `douyin-downloader` 能力
- 录制抖音直播流并保存到 `Downloaded/`
- 抓取直播间商品列表，导出原始 JSON 和摘要 JSON

## 启动

```bash
cd "/Users/yuebuy/PhpstormProjects/tiktok_res"
chmod +x start.sh
./start.sh
```

打开：

```text
http://127.0.0.1:8765
```

## Cookie

如果视频下载或直播商品接口提示未登录，重新抓 cookie：

```bash
cd "/Users/yuebuy/PhpstormProjects/tiktok_res"
.venv/bin/python -m tools.cookie_fetcher \
  --config config.yml \
  --url "https://live.douyin.com/80017709309" \
  --include-all
```

浏览器中确认直播页已经登录后，回终端按 Enter。看到 `Saved ... cookie(s)` 后再使用前端。

## API

```bash
curl -X POST http://127.0.0.1:8765/api/video/download \
  -H 'Content-Type: application/json' \
  -d '{"url":"抖音视频分享链接"}'

curl -X POST http://127.0.0.1:8765/api/live/record \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://live.douyin.com/80017709309","duration_seconds":30}'

curl -X POST http://127.0.0.1:8765/api/live/products \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://live.douyin.com/80017709309","limit":20}'

curl -X POST http://127.0.0.1:8765/api/live/record-with-products \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://live.douyin.com/80017709309","duration_seconds":30,"limit":20}'
```

查询任务：

```bash
curl http://127.0.0.1:8765/api/jobs
```

## 输出

- 视频和直播录制：`Downloaded/`
- 商品原始响应：`Downloaded/live_products_{web_rid}_raw.json`
- 商品摘要：`Downloaded/live_products_{web_rid}_summary.json`

直播间页面号 `web_rid` 不等于每次开播真实 `room_id`。本项目会先打开直播页，捕获当前场次的 `/webcast/room/web/enter/` 响应，再用最新 `room_id` 抓商品列表。
