function createMediaEnrichmentService({
  CDN_DOWNLOAD_ENDPOINT,
  MEDIA_DIR,
  MEDIA_DOWNLOAD_TIMEOUT_MS,
  MEDIA_DOWNLOAD_TYPES,
  MEDIA_INDEX_PATH,
  IMAGE_SUMMARY_ENABLED,
  IMAGE_SUMMARY_MAX_BYTES,
  IMAGE_SUMMARY_MODEL,
  IMAGE_SUMMARY_TIMEOUT_MS,
  LLM_API_KEY,
  LLM_API_URL,
  TRANSCRIBE_ENABLED,
  TRANSCRIBE_LANGUAGE,
  TRANSCRIBE_MODEL,
  TRANSCRIBE_PYTHON,
  TRANSCRIBE_SCRIPT_PATH,
  TRANSCRIBE_TIMEOUT_MS,
  applyTranscriptRecord,
  buildMediaPublicUrl,
  buildPublicMediaUrl,
  chooseStoredMimeType,
  downloadBinary,
  downloadBinaryWithHeaders,
  extractLlmResponseText,
  fs,
  getFeishuAppAccessToken,
  hashText,
  inferExtension,
  inferMimeFromExtension,
  path,
  readJsonFile,
  requestJson,
  requestJsonWithHeaders,
  sanitizeFileSegment,
  spawnSync,
  writeJsonFile,
}) {
  function runAudioTranscription(localPath) {
    const result = spawnSync(TRANSCRIBE_PYTHON, [TRANSCRIBE_SCRIPT_PATH, localPath], {
      encoding: "utf8",
      timeout: TRANSCRIBE_TIMEOUT_MS,
      env: {
        ...process.env,
        FLOWBOT_TRANSCRIBE_MODEL: TRANSCRIBE_MODEL,
        FLOWBOT_TRANSCRIBE_LANGUAGE: TRANSCRIBE_LANGUAGE,
      },
    });
    const stdout = String(result.stdout || "").trim();
    const stderr = String(result.stderr || "").trim();
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(stderr || stdout || `transcribe_failed:${result.status}`);
    }
    let parsed = null;
    try {
      parsed = JSON.parse(stdout || "{}");
    } catch (error) {
      throw new Error(`transcribe_invalid_json:${error.message}`);
    }
    if (!parsed?.ok) {
      throw new Error(String(parsed?.error || "transcribe_failed"));
    }
    return {
      transcriptStatus: "success",
      transcriptText: String(parsed.text || "").trim(),
      transcriptLanguage: String(parsed.language || "").trim(),
      transcriptDurationSeconds: Number(parsed.duration_seconds ?? 0) || null,
      transcriptProvider: "local:faster-whisper",
      transcriptModel: String(parsed.model || TRANSCRIBE_MODEL),
      transcriptError: "",
    };
  }

  function enrichTranscriptForMessage(message, mediaKey, mediaIndex) {
    if (!TRANSCRIBE_ENABLED || message.mediaKind !== "audio" || !message.mediaLocalPath) {
      return message;
    }
    const existing = mediaIndex[mediaKey] || {};
    if (existing.transcriptStatus === "success" && String(existing.transcriptText || "").trim()) {
      return applyTranscriptRecord(message, existing);
    }

    try {
      const transcriptRecord = runAudioTranscription(message.mediaLocalPath);
      mediaIndex[mediaKey] = {
        ...existing,
        ...transcriptRecord,
        transcriptUpdatedAt: new Date().toISOString(),
      };
      writeJsonFile(MEDIA_INDEX_PATH, mediaIndex);
      return applyTranscriptRecord(message, transcriptRecord);
    } catch (error) {
      const failedRecord = {
        transcriptStatus: "failed",
        transcriptText: "",
        transcriptLanguage: "",
        transcriptDurationSeconds: null,
        transcriptProvider: "local:faster-whisper",
        transcriptModel: TRANSCRIBE_MODEL,
        transcriptError: String(error?.message || error),
        transcriptUpdatedAt: new Date().toISOString(),
      };
      mediaIndex[mediaKey] = {
        ...existing,
        ...failedRecord,
      };
      writeJsonFile(MEDIA_INDEX_PATH, mediaIndex);
      return applyTranscriptRecord(message, failedRecord);
    }
  }

  function buildImageSummarySource(message) {
    const publicUrl = buildPublicMediaUrl(message.mediaLocalUrl, message);
    if (publicUrl) {
      return publicUrl;
    }
    const localPath = String(message.mediaLocalPath || "").trim();
    if (!localPath || !fs.existsSync(localPath)) {
      return "";
    }
    const stat = fs.statSync(localPath);
    if (stat.size > IMAGE_SUMMARY_MAX_BYTES) {
      throw new Error(`image_too_large:${stat.size}`);
    }
    const mimeType = message.mediaMimeType || chooseStoredMimeType("", path.extname(localPath).replace(/^\./, ""));
    const base64 = fs.readFileSync(localPath).toString("base64");
    return `data:${mimeType || "image/jpeg"};base64,${base64}`;
  }

  async function runImageSummary(message) {
    if (!LLM_API_KEY || !LLM_API_URL || !IMAGE_SUMMARY_MODEL) {
      throw new Error("image_summary_config_missing");
    }
    const imageSource = buildImageSummarySource(message);
    if (!imageSource) {
      throw new Error("image_summary_source_missing");
    }
    const endpoint = LLM_API_URL.replace(/\/$/, "") + "/chat/completions";
    const response = await requestJsonWithHeaders(
      "POST",
      endpoint,
      {
        model: IMAGE_SUMMARY_MODEL,
        temperature: 0,
        enable_thinking: false,
        messages: [
          {
            role: "system",
            content: [
              {
                type: "text",
                text: "你是客服群截图理解助手。只用中文输出一句到三句话，说明图片里和故障、报错、页面状态、账号、线路有关的信息；看不清就说看不清，不要编造。",
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "请提取这张图片对客服 Case 归档有用的信息。",
              },
              {
                type: "image_url",
                image_url: {
                  url: imageSource,
                },
              },
            ],
          },
        ],
      },
      {
        Authorization: `Bearer ${LLM_API_KEY}`,
      },
      IMAGE_SUMMARY_TIMEOUT_MS,
    );
    const summary = String(extractLlmResponseText(response) || "").replace(/\s+/g, " ").trim();
    if (!summary) {
      throw new Error("image_summary_empty");
    }
    return {
      transcriptStatus: "success",
      transcriptText: summary.slice(0, 1000),
      transcriptLanguage: "zh",
      transcriptDurationSeconds: null,
      transcriptProvider: "llm:image-summary",
      transcriptModel: IMAGE_SUMMARY_MODEL,
      transcriptError: "",
    };
  }

  async function enrichImageSummaryForMessage(message, mediaKey, mediaIndex) {
    if (!IMAGE_SUMMARY_ENABLED || message.mediaKind !== "image" || !message.mediaLocalPath) {
      return message;
    }
    const existing = mediaIndex[mediaKey] || {};
    if (existing.transcriptStatus === "success" && String(existing.transcriptText || "").trim()) {
      return applyTranscriptRecord(message, existing);
    }
    try {
      const transcriptRecord = await runImageSummary(message);
      mediaIndex[mediaKey] = {
        ...existing,
        ...transcriptRecord,
        transcriptUpdatedAt: new Date().toISOString(),
      };
      writeJsonFile(MEDIA_INDEX_PATH, mediaIndex);
      return applyTranscriptRecord(message, transcriptRecord);
    } catch (error) {
      const failedRecord = {
        transcriptStatus: "failed",
        transcriptText: "",
        transcriptLanguage: "",
        transcriptDurationSeconds: null,
        transcriptProvider: "llm:image-summary",
        transcriptModel: IMAGE_SUMMARY_MODEL,
        transcriptError: String(error?.message || error),
        transcriptUpdatedAt: new Date().toISOString(),
      };
      mediaIndex[mediaKey] = {
        ...existing,
        ...failedRecord,
      };
      writeJsonFile(MEDIA_INDEX_PATH, mediaIndex);
      return applyTranscriptRecord(message, failedRecord);
    }
  }

  async function enrichTextForMediaMessage(message, mediaKey, mediaIndex) {
    const withImageSummary = await enrichImageSummaryForMessage(message, mediaKey, mediaIndex);
    return enrichTranscriptForMessage(withImageSummary, mediaKey, mediaIndex);
  }

  function resolveMediaSpec(message) {
    const source = String(message?.rawData?.source || "").trim().toLowerCase();
    if (source === "feishu") {
      const resourceKey = String(message.mediaRemoteUrl || message.imageUrl || message.url || "").trim();
      if (!resourceKey) {
        return null;
      }
      switch (Number(message.msgType || 0)) {
        case 5:
          return { kind: "image", resourceKey, resourceType: "image", fallbackExt: "jpg" };
        case 7:
          return { kind: "video", resourceKey, resourceType: "file", fallbackExt: "mp4" };
        case 6:
          return { kind: "audio", resourceKey, resourceType: "file", fallbackExt: "mp3" };
        case 8:
          return { kind: "file", resourceKey, resourceType: "file", fallbackExt: "bin" };
        default:
          return null;
      }
    }
    const cdn = message?.rawData?.cdn || {};
    if (!cdn.file_id || !cdn.aes_key) {
      return null;
    }
    switch (Number(message.msgType || 0)) {
      case 5:
        return {
          kind: "image",
          fileTypes: [
            MEDIA_DOWNLOAD_TYPES.image_original,
            MEDIA_DOWNLOAD_TYPES.image_medium,
            MEDIA_DOWNLOAD_TYPES.image_thumb,
          ],
          fallbackExt: "jpg",
        };
      case 7:
        return { kind: "video", fileTypes: [MEDIA_DOWNLOAD_TYPES.video], fallbackExt: "mp4" };
      case 6:
        return { kind: "audio", fileTypes: [MEDIA_DOWNLOAD_TYPES.file_bundle], fallbackExt: "mp3", toMp3: true };
      case 8:
        return { kind: "file", fileTypes: [MEDIA_DOWNLOAD_TYPES.file_bundle], fallbackExt: "bin" };
      case 10:
        return { kind: "file", fileTypes: [MEDIA_DOWNLOAD_TYPES.file_bundle], fallbackExt: "gif" };
      default:
        return null;
    }
  }

  async function downloadFeishuMessageResource(message, spec) {
    if (!getFeishuAppAccessToken || !downloadBinaryWithHeaders) {
      throw new Error("feishu_media_download_config_missing");
    }
    const messageId = String(message.id || message.seq || "").trim();
    const resourceKey = String(spec.resourceKey || "").trim();
    if (!messageId || !resourceKey) {
      throw new Error("feishu_media_resource_missing");
    }
    const token = await getFeishuAppAccessToken();
    const target = `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(resourceKey)}?type=${encodeURIComponent(spec.resourceType || "file")}`;
    return downloadBinaryWithHeaders(
      target,
      { Authorization: `Bearer ${token.token}` },
      MEDIA_DOWNLOAD_TIMEOUT_MS,
    );
  }

  async function downloadMediaBinary(message, spec) {
    const source = String(message?.rawData?.source || "").trim().toLowerCase();
    if (source === "feishu") {
      return {
        downloaded: await downloadFeishuMessageResource(message, spec),
        selectedFileType: spec.resourceType || spec.kind,
        remoteUrl: String(spec.resourceKey || ""),
      };
    }

    const cdn = message.rawData?.cdn || {};
    let selectedFileType = null;
    let remoteUrl = "";
    let lastDownloadError = "";
    for (const fileType of spec.fileTypes || []) {
      const downloadResponse = await requestJson("POST", CDN_DOWNLOAD_ENDPOINT, {
        guid: message.guid,
        file_type: fileType,
        file_id: cdn.file_id,
        aes_key: cdn.aes_key,
        file_size: Number(cdn.size || 0),
        file_name: message.fileName || "",
        to_mp3: Boolean(spec.toMp3),
      });
      remoteUrl = downloadResponse?.data?.url || "";
      if (Number(downloadResponse?.error_code || 0) === 0 && remoteUrl) {
        selectedFileType = fileType;
        break;
      }
      lastDownloadError = `cdn_download_failed:${fileType}:${downloadResponse?.error_code ?? "unknown"}:${downloadResponse?.error_message || "no_url"}`;
    }
    if (!remoteUrl || selectedFileType == null) {
      throw new Error(lastDownloadError || "cdn_download_failed:no_available_variant");
    }
    return {
      downloaded: await downloadBinary(remoteUrl, MEDIA_DOWNLOAD_TIMEOUT_MS),
      selectedFileType,
      remoteUrl,
    };
  }

  async function enrichMediaForMessage(message) {
    const spec = resolveMediaSpec(message);
    if (!spec) {
      return message;
    }

    const cdn = message.rawData?.cdn || {};
    const mediaKey = String(cdn.md5 || cdn.file_id || spec.resourceKey || hashText(message.traceId));
    const mediaIndex = readJsonFile(MEDIA_INDEX_PATH, {});
    const existing = mediaIndex[mediaKey];
    const shouldBypassExistingAudioCache = spec.kind === "audio"
      && existing?.localPath
      && path.extname(existing.localPath).toLowerCase() !== ".mp3";
    if (existing?.localPath && fs.existsSync(existing.localPath) && !shouldBypassExistingAudioCache) {
      return enrichTextForMediaMessage({
        ...message,
        mediaKind: existing.mediaKind || spec.kind,
        mediaFileType: existing.mediaFileType ?? spec.fileTypes?.[0] ?? null,
        mediaDownloadStatus: "cached",
        mediaLocalPath: existing.localPath,
        mediaLocalUrl: existing.localUrl,
        mediaRemoteUrl: existing.remoteUrl || "",
        mediaMimeType: existing.mediaMimeType || inferMimeFromExtension(path.extname(existing.localPath).replace(/^\./, "")),
        mediaSizeBytes: existing.mediaSizeBytes || Number(cdn.size || 0),
        mediaWidth: existing.mediaWidth ?? cdn.image_width ?? null,
        mediaHeight: existing.mediaHeight ?? cdn.image_height ?? null,
        mediaDownloadError: "",
      }, mediaKey, mediaIndex);
    }

    try {
      const { downloaded, selectedFileType, remoteUrl } = await downloadMediaBinary(message, spec);
      const extension = inferExtension({
        contentType: downloaded.contentType,
        sourceUrl: remoteUrl,
        fileName: message.fileName,
        buffer: downloaded.buffer,
        fallback: spec.fallbackExt,
      });
      const baseName = sanitizeFileSegment(cdn.md5 || path.basename(message.fileName || "") || spec.resourceKey || hashText(cdn.file_id || message.traceId).slice(0, 24)) || hashText(message.traceId).slice(0, 24);
      const fileName = `${baseName}.${extension}`;
      const localPath = path.join(MEDIA_DIR, fileName);
      fs.writeFileSync(localPath, downloaded.buffer);

      const mediaRecord = {
        mediaKind: spec.kind,
        mediaFileType: selectedFileType,
        localPath,
        localUrl: buildMediaPublicUrl(fileName),
        remoteUrl,
        mediaMimeType: chooseStoredMimeType(downloaded.contentType, extension),
        mediaSizeBytes: downloaded.buffer.length,
        mediaWidth: cdn.image_width ?? null,
        mediaHeight: cdn.image_height ?? null,
        updatedAt: new Date().toISOString(),
      };
      mediaIndex[mediaKey] = mediaRecord;
      writeJsonFile(MEDIA_INDEX_PATH, mediaIndex);

      return enrichTextForMediaMessage({
        ...message,
        mediaKind: mediaRecord.mediaKind,
        mediaFileType: mediaRecord.mediaFileType,
        mediaDownloadStatus: "downloaded",
        mediaLocalPath: mediaRecord.localPath,
        mediaLocalUrl: mediaRecord.localUrl,
        mediaRemoteUrl: mediaRecord.remoteUrl,
        mediaMimeType: mediaRecord.mediaMimeType,
        mediaSizeBytes: mediaRecord.mediaSizeBytes,
        mediaWidth: mediaRecord.mediaWidth,
        mediaHeight: mediaRecord.mediaHeight,
        mediaDownloadError: "",
      }, mediaKey, mediaIndex);
    } catch (error) {
      return {
        ...message,
        mediaKind: spec.kind,
        mediaFileType: spec.fileTypes?.[0] ?? null,
        mediaDownloadStatus: "failed",
        mediaLocalPath: "",
        mediaLocalUrl: "",
        mediaRemoteUrl: spec.resourceKey || "",
        mediaMimeType: "",
        mediaSizeBytes: Number(cdn.size || 0) || null,
        mediaWidth: cdn.image_width ?? null,
        mediaHeight: cdn.image_height ?? null,
        mediaDownloadError: String(error?.message || error),
      };
    }
  }

  function getMediaContentType(filePath) {
    const ext = path.extname(filePath).replace(/^\./, "");
    return inferMimeFromExtension(ext);
  }

  return {
    enrichMediaForMessage,
    getMediaContentType,
  };
}

module.exports = { createMediaEnrichmentService };
