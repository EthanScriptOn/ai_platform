import { useCallback, useState } from "react";

const initialClipModal = {
  open: false,
  loading: false,
  exporting: false,
  path: "",
  previewPath: "",
  sourcePath: "",
  duration: 0,
  start: 0,
  end: 0,
  output: null,
};

export function useContentAssetClipper({
  api,
  contentClipperRef,
  contentClipVideoRef,
  contentClipperUrl,
  openContentPlayer,
  refreshContentLibrary,
  runContentCommand,
}) {
  const [clipModal, setClipModal] = useState(initialClipModal);

  const openContentClipper = useCallback(async (filePath) => {
    if (!filePath) return;
    const clipperUrl = contentClipperUrl(filePath);
    if (clipperUrl) {
      window.open(clipperUrl, "yuebai-douyin-clipper", "popup=yes,width=1180,height=820");
      return;
    }
    const pauseExcept = contentClipVideoRef.current;
    document.querySelectorAll("video").forEach((video) => {
      if (pauseExcept && video === pauseExcept) return;
      try {
        video.pause();
      } catch {}
    });
    setClipModal({
      ...initialClipModal,
      open: true,
      loading: true,
      path: filePath,
    });
    try {
      const data = await runContentCommand("/api/video/preview", { path: filePath });
      const duration = Number(data.duration_seconds || 0);
      const previewPath = data.preview_path || data.source_path || filePath;
      setClipModal((current) => ({
        ...current,
        loading: false,
        previewPath,
        sourcePath: data.source_path || filePath,
        duration,
        start: 0,
        end: Math.max(1, duration || 1),
      }));
      openContentPlayer(previewPath);
      window.setTimeout(() => {
        contentClipperRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 0);
    } catch (error) {
      setClipModal((current) => ({ ...current, loading: false }));
      api.error(`剪辑预览失败：${error.message}`);
    }
  }, [api, contentClipVideoRef, contentClipperRef, contentClipperUrl, openContentPlayer, runContentCommand]);

  const closeContentClipper = useCallback(() => {
    if (contentClipVideoRef.current) {
      try {
        contentClipVideoRef.current.pause();
        contentClipVideoRef.current.removeAttribute("src");
        contentClipVideoRef.current.load();
      } catch {}
    }
    setClipModal((current) => ({
      ...current,
      ...initialClipModal,
    }));
  }, [contentClipVideoRef]);

  const updateContentClipRange = useCallback((changed, value) => {
    setClipModal((current) => {
      const max = Math.max(1, Number(current.duration || 1));
      let start = Number(changed === "start" ? value : current.start || 0);
      let end = Number(changed === "end" ? value : current.end || max);
      start = Math.max(0, Math.min(max, start));
      end = Math.max(0, Math.min(max, end));
      if (changed === "start" && start >= end) start = Math.max(0, end - 0.5);
      if (changed === "end" && end <= start) end = Math.min(max, start + 0.5);
      if (contentClipVideoRef.current) {
        try {
          contentClipVideoRef.current.currentTime = changed === "start" ? start : end;
        } catch {}
      }
      return { ...current, start, end };
    });
  }, [contentClipVideoRef]);

  const exportContentClip = useCallback(async () => {
    if (!clipModal.sourcePath) {
      api.warning("先选择一个视频文件。");
      return;
    }
    const start = Number(clipModal.start || 0);
    const end = Number(clipModal.end || 0);
    if (end <= start) {
      api.warning("结束时间必须大于开始时间。");
      return;
    }
    setClipModal((current) => ({ ...current, exporting: true }));
    try {
      const data = await runContentCommand("/api/video/clip", {
        path: clipModal.sourcePath,
        start_seconds: start,
        end_seconds: end,
      });
      setClipModal((current) => ({ ...current, exporting: false, output: data }));
      api.success("片段已导出");
      await refreshContentLibrary(true);
    } catch (error) {
      setClipModal((current) => ({ ...current, exporting: false }));
      api.error(`导出失败：${error.message}`);
    }
  }, [api, clipModal.end, clipModal.sourcePath, clipModal.start, refreshContentLibrary, runContentCommand]);

  return {
    clipModal,
    closeContentClipper,
    exportContentClip,
    openContentClipper,
    updateContentClipRange,
  };
}
