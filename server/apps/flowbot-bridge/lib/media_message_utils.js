const path = require("path");

function createMediaMessageUtils({
  MSG_TYPE_KEY_ALIASES,
  MSG_TYPE_NAMES,
  MSG_TYPE_NAME_ALIASES,
}) {
  function sanitizeFileSegment(value) {
    return String(value || "")
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80);
  }

  function inferExtensionFromMime(contentType) {
    const type = String(contentType || "").split(";")[0].trim().toLowerCase();
    const map = {
      "image/jpeg": "jpg",
      "image/jpg": "jpg",
      "image/png": "png",
      "image/gif": "gif",
      "image/webp": "webp",
      "image/heic": "heic",
      "video/mp4": "mp4",
      "video/quicktime": "mov",
      "audio/mpeg": "mp3",
      "audio/mp3": "mp3",
      "audio/amr": "amr",
      "audio/wav": "wav",
      "audio/x-wav": "wav",
      "audio/ogg": "ogg",
      "audio/mp4": "m4a",
      "application/pdf": "pdf",
      "application/zip": "zip",
    };
    return map[type] || "";
  }

  function inferMimeFromExtension(extension) {
    const map = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      gif: "image/gif",
      webp: "image/webp",
      heic: "image/heic",
      mp4: "video/mp4",
      mov: "video/quicktime",
      mp3: "audio/mpeg",
      amr: "audio/amr",
      wav: "audio/wav",
      ogg: "audio/ogg",
      m4a: "audio/mp4",
      pdf: "application/pdf",
      zip: "application/zip",
      txt: "text/plain; charset=utf-8",
    };
    return map[String(extension || "").toLowerCase()] || "application/octet-stream";
  }

  function chooseStoredMimeType(contentType, extension) {
    const normalized = String(contentType || "").split(";")[0].trim().toLowerCase();
    if (!normalized || normalized === "application/octet-stream") {
      return inferMimeFromExtension(extension);
    }
    return contentType;
  }

  function inferExtensionFromBuffer(buffer, fallback = "bin") {
    if (!Buffer.isBuffer(buffer) || !buffer.length) {
      return fallback;
    }
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return "jpg";
    }
    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return "png";
    }
    if (buffer.length >= 6 && (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a")) {
      return "gif";
    }
    if (buffer.length >= 12 && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
      return "webp";
    }
    if (buffer.length >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp") {
      return "mp4";
    }
    if (buffer.length >= 4 && buffer.subarray(0, 4).toString("ascii") === "RIFF") {
      return "wav";
    }
    if (buffer.length >= 3 && buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) {
      return "mp3";
    }
    if (buffer.length >= 4 && buffer.subarray(0, 4).toString("ascii") === "OggS") {
      return "ogg";
    }
    if (buffer.length >= 5 && buffer.subarray(0, 5).toString("ascii") === "%PDF-") {
      return "pdf";
    }
    return fallback;
  }

  function inferExtension({ contentType, sourceUrl, fileName, buffer, fallback = "bin" }) {
    const fromMime = inferExtensionFromMime(contentType);
    if (fromMime) {
      return fromMime;
    }
    for (const candidate of [fileName, sourceUrl]) {
      const ext = path.extname(String(candidate || "")).replace(/^\./, "").trim().toLowerCase();
      if (ext) {
        return ext;
      }
    }
    return inferExtensionFromBuffer(buffer, fallback);
  }

  function buildMediaPublicUrl(fileName) {
    return `/flowbot/media/${encodeURIComponent(fileName)}`;
  }

  function normalizeMsgTypeLabel(label, msgType = null) {
    const raw = String(label || "").trim();
    if (raw && MSG_TYPE_NAME_ALIASES[raw]) {
      return MSG_TYPE_NAME_ALIASES[raw];
    }
    if (msgType != null && MSG_TYPE_NAMES[Number(msgType)]) {
      return MSG_TYPE_NAMES[Number(msgType)];
    }
    return raw || "未知类型";
  }

  function normalizeMsgTypeKey(label, msgType = null) {
    const raw = String(label || "").trim();
    if (raw && MSG_TYPE_KEY_ALIASES[raw]) {
      return MSG_TYPE_KEY_ALIASES[raw];
    }
    if (msgType != null) {
      const labelFromType = MSG_TYPE_NAMES[Number(msgType)] || "";
      if (labelFromType && MSG_TYPE_KEY_ALIASES[labelFromType]) {
        return MSG_TYPE_KEY_ALIASES[labelFromType];
      }
    }
    return raw || "unknown";
  }

  function dedupeMessageEventsByTraceId(items, { prefer = "last" } = {}) {
    const byTraceId = new Map();
    for (const item of items) {
      const key = String(item?.traceId || "");
      if (!key) {
        continue;
      }
      if (prefer === "first") {
        if (!byTraceId.has(key)) {
          byTraceId.set(key, item);
        }
        continue;
      }
      byTraceId.set(key, item);
    }
    return Array.from(byTraceId.values());
  }

  function applyTranscriptRecord(message, record) {
    const transcriptText = String(record?.transcriptText || "").trim();
    const transcriptStatus = String(record?.transcriptStatus || "").trim();
    return {
      ...message,
      transcriptStatus,
      transcriptText,
      transcriptLanguage: String(record?.transcriptLanguage || "").trim(),
      transcriptDurationSeconds: Number(record?.transcriptDurationSeconds ?? 0) || null,
      transcriptProvider: String(record?.transcriptProvider || "").trim(),
      transcriptModel: String(record?.transcriptModel || "").trim(),
      transcriptError: String(record?.transcriptError || "").trim(),
      content: transcriptText || message.content || "",
    };
  }

  return {
    applyTranscriptRecord,
    buildMediaPublicUrl,
    chooseStoredMimeType,
    dedupeMessageEventsByTraceId,
    inferExtension,
    inferExtensionFromBuffer,
    inferExtensionFromMime,
    inferMimeFromExtension,
    normalizeMsgTypeKey,
    normalizeMsgTypeLabel,
    sanitizeFileSegment,
  };
}

module.exports = { createMediaMessageUtils };
