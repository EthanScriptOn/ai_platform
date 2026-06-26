$ErrorActionPreference = "Stop"

$BaseUrl = $env:YUEBAI_AI_PLATFORM_URL
if (-not $BaseUrl) { $BaseUrl = "http://127.0.0.1:8788" }

$InstallDir = Join-Path $env:LOCALAPPDATA "Yuebai\WechatCollector"
$Collector = Join-Path $InstallDir "yuebai-wechat-collector.exe"

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Invoke-WebRequest -Uri "$BaseUrl/install/yuebai-wechat-collector-windows-amd64.exe" -OutFile $Collector

$Action = New-ScheduledTaskAction -Execute $Collector
$Trigger = New-ScheduledTaskTrigger -AtLogOn
$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -RunLevel LeastPrivilege
Register-ScheduledTask -TaskName "YuebaiWechatCollector" -Action $Action -Trigger $Trigger -Principal $Principal -Force | Out-Null
Start-ScheduledTask -TaskName "YuebaiWechatCollector"

Write-Host "悦拜视频号采集后台包已安装并启动。"
Write-Host "状态接口：http://127.0.0.1:18765/api/status"
