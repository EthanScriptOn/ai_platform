function createAgentVisionUtils({
  buildLlmReadyMessage,
  normalizeBooleanInput,
  normalizeMsgTypeKey,
  pruneEmpty,
}) {
  function agentModelLooksVisionCapable(modelName) {
    const normalized = String(modelName || "").trim().toLowerCase();
    if (!normalized) {
      return false;
    }
    return /(qwen|vl|vision|gpt-4o|gpt-4\.1|claude-3|gemini)/i.test(normalized);
  }

  function resolveAgentMediaRenderOptions(options = {}) {
    const llmModel = String(options.llmModel || options.model || "").trim();
    const supportsVision = normalizeBooleanInput(
      options.supportsVision,
      agentModelLooksVisionCapable(llmModel),
    );
    const requestedTransport = String(
      options.imageTransport || (supportsVision ? "image_url" : "none"),
    ).trim().toLowerCase();
    const imageTransport = supportsVision
      ? (requestedTransport || "image_url")
      : "none";
    const maxImages = Math.max(0, Math.min(6, Number(options.maxImages) || 3));
    return {
      llmModel,
      supportsVision: supportsVision && imageTransport !== "none" && maxImages > 0,
      imageTransport: supportsVision ? imageTransport : "none",
      maxImages,
    };
  }

  function buildAgentVisionNote(item = {}) {
    return [
      item?.content,
      item?.transcriptText,
      item?.quoteContent,
      item?.snippet,
    ].map((part) => String(part || "").replace(/\s+/g, " ").trim()).filter(Boolean).filter((part, index, list) => list.indexOf(part) === index).join(" | ");
  }

  function buildAgentVisionInput(item = {}, renderOptions = {}, source = "") {
    if (!renderOptions.supportsVision || renderOptions.imageTransport !== "image_url") {
      return null;
    }
    const mediaKind = String(item?.mediaKind || item?.media_kind || "").trim().toLowerCase();
    const mediaMimeType = String(item?.mediaMimeType || item?.media_mime_type || "").trim();
    const msgTypeName = String(item?.msgTypeName || item?.type || "").trim().toLowerCase();
    const imageUrl = String(
      item?.mediaPublicUrl
      || item?.media_public_url
      || item?.imageUrl
      || item?.image_url
      || item?.mediaLocalUrl
      || item?.media_local_url
      || "",
    ).trim();
    const looksImage = mediaKind === "image" || /^image\//i.test(mediaMimeType) || msgTypeName === "图片";
    if (!looksImage || !imageUrl) {
      return null;
    }
    return pruneEmpty({
      traceId: item?.traceId || item?.trace_id || "",
      senderName: item?.senderName || item?.sender || "",
      senderId: item?.senderId || item?.sender_id || "",
      sendTimeIso: item?.sendTimeIso || item?.time || "",
      mediaMimeType,
      imageUrl,
      note: buildAgentVisionNote(item),
      source,
    }) || null;
  }

  function collectAgentVisionInputs(items, renderOptions = {}, source = "") {
    if (!renderOptions.supportsVision || renderOptions.imageTransport !== "image_url") {
      return [];
    }
    const result = [];
    const seen = new Set();
    for (const item of Array.isArray(items) ? items : []) {
      const input = buildAgentVisionInput(item, renderOptions, source);
      if (!input?.imageUrl) {
        continue;
      }
      const key = `${input.traceId || ""}:${input.imageUrl}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.push(input);
      if (result.length >= renderOptions.maxImages) {
        break;
      }
    }
    return result;
  }

  function collectAgentVisionInputsFromContext(matches, renderOptions = {}) {
    if (!renderOptions.supportsVision || renderOptions.imageTransport !== "image_url") {
      return [];
    }
    const flattened = [];
    for (const match of Array.isArray(matches) ? matches : []) {
      flattened.push(match?.message || {});
      flattened.push(...(Array.isArray(match?.contextBefore) ? match.contextBefore : []));
      flattened.push(...(Array.isArray(match?.contextAfter) ? match.contextAfter : []));
    }
    return collectAgentVisionInputs(flattened, renderOptions, "context_search");
  }

  function buildLlmImageParts(messages, { heading = "", includeImageContent = true } = {}) {
    const parts = [];
    const images = (Array.isArray(messages) ? messages : [])
      .map((item) => buildLlmReadyMessage(item))
      .filter((item) => normalizeMsgTypeKey(item?.type) === "image")
      .map((item) => ({
        traceId: item?.trace_id || "",
        sender: item?.sender || "unknown",
        time: item?.time || "",
        imageUrl: item?.media_public_url || "",
      }))
      .filter((item) => item.imageUrl)
      .slice(0, 6);
    if (!images.length) {
      return parts;
    }
    if (heading) {
      parts.push({
        type: "text",
        text: heading,
      });
    }
    for (const image of images) {
      parts.push({
        type: "text",
        text: `图片消息 trace_id=${image.traceId} sender=${image.sender} time=${image.time} url=${image.imageUrl}`,
      });
      if (includeImageContent) {
        parts.push({
          type: "image_url",
          image_url: {
            url: image.imageUrl,
          },
        });
      }
    }
    return parts;
  }

  return {
    buildLlmImageParts,
    collectAgentVisionInputs,
    collectAgentVisionInputsFromContext,
    resolveAgentMediaRenderOptions,
  };
}

module.exports = { createAgentVisionUtils };
