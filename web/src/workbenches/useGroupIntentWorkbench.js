import { useEffect, useMemo, useState } from "react";
import { message } from "antd";
import { requestJson } from "../lib/apiClient";
import {
  buildGroupIntentSample,
  parseGroupIntentConversation,
} from "./groupIntentParser";

const GROUP_INTENT_AUTO_JOB_ID_KEY = "groupIntentAutoJobId";
const GROUP_INTENT_INPUT_DRAFT_KEY = "groupIntentInputDraft";

function inputFromSamples(items) {
  return items.map((item) => item.raw || `${item.speaker}: ${item.text}`).join("\n");
}

export function useGroupIntentWorkbench() {
  const [input, setInput] = useState(() =>
    typeof window === "undefined" ? "" : window.localStorage?.getItem(GROUP_INTENT_INPUT_DRAFT_KEY) || ""
  );
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [labeledRows, setLabeledRows] = useState([]);
  const [detectLoading, setDetectLoading] = useState(false);
  const [labelLoading, setLabelLoading] = useState(false);
  const [trainLoading, setTrainLoading] = useState(false);
  const [trainResult, setTrainResult] = useState(null);
  const [resultSource, setResultSource] = useState("");
  const [autoCount, setAutoCount] = useState(200);
  const [autoDomainType, setAutoDomainType] = useState("母婴");
  const [autoJob, setAutoJob] = useState(null);
  const [autoJobs, setAutoJobs] = useState([]);
  const [autoLoading, setAutoLoading] = useState(false);
  const [sampleLoading, setSampleLoading] = useState(false);
  const [api, contextHolder] = message.useMessage();

  const rows = useMemo(() => parseGroupIntentConversation(input), [input]);
  const trainingRows = labeledRows;
  const trainingInterveneCount = trainingRows.filter((item) => item.label === "intervene").length;
  const autoProgress = autoJob?.targetCount
    ? Math.min(100, Math.round(((autoJob.trainedCount || 0) / autoJob.targetCount) * 100))
    : 0;
  const summary = [
    { label: "消息数", value: trainingRows.length },
    { label: "需要介入", value: trainingInterveneCount },
    { label: "不介入", value: trainingRows.length - trainingInterveneCount },
  ];

  function resetResults() {
    setLabeledRows([]);
    setTrainResult(null);
    setResultSource("");
  }

  function updateInput(nextInput) {
    setInput(nextInput);
    resetResults();
  }

  function clearInput() {
    setInput("");
    setSelectedIndex(0);
    resetResults();
  }

  function updateTrainingLabel(index, label) {
    setLabeledRows((current) =>
      current.map((item) =>
        item.index === index ? { ...item, label, shouldIntervene: label === "intervene" } : item
      )
    );
  }

  async function detectIntent() {
    if (!rows.length) {
      api.warning("先输入群聊消息");
      return;
    }
    setDetectLoading(true);
    setTrainResult(null);
    try {
      const data = await requestJson("/api/group-intent/predict", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input }),
      });
      setLabeledRows(data.items || []);
      setResultSource("intent_model");
      api.success(`已完成 ${data.items?.length || 0} 条消息的意图分析`);
    } catch (error) {
      api.error(error.message || "检测失败");
    } finally {
      setDetectLoading(false);
    }
  }

  async function startQwenLabeling() {
    if (!rows.length) {
      api.warning("先输入群聊消息");
      return;
    }
    setLabelLoading(true);
    setTrainResult(null);
    try {
      const data = await requestJson("/api/group-intent/qwen-label", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input }),
      });
      setLabeledRows(data.items || []);
      setResultSource("qwen");
      api.success(`千问已打标 ${data.items?.length || 0} 条`);
    } catch (error) {
      api.error(error.message || "千问打标失败");
    } finally {
      setLabelLoading(false);
    }
  }

  async function fillQwenSamples() {
    setSampleLoading(true);
    const items = [];
    try {
      const response = await window.fetch("/api/group-intent/qwen-samples/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count: 100, batchSize: 5, concurrency: 4 }),
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `HTTP ${response.status}`);
      }
      if (!response.body) {
        throw new Error("当前浏览器不支持流式读取。");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let done = false;
      while (!done) {
        const chunk = await reader.read();
        done = chunk.done;
        buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !done });
        const events = buffer.split("\n\n");
        buffer = events.pop() || "";
        for (const eventText of events) {
          const dataLines = eventText
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim());
          if (!dataLines.length) continue;
          const event = JSON.parse(dataLines.join("\n"));
          if (event.type === "items") {
            items.push(...(event.items || []));
            setInput(inputFromSamples(items));
          } else if (event.type === "error" || event.type === "failed") {
            throw new Error(event.error || "千问生成失败");
          }
        }
      }
      setInput(inputFromSamples(items) || buildGroupIntentSample());
      setSelectedIndex(0);
      resetResults();
      api.success(`千问已生成 ${items.length || 100} 条群聊样例`);
    } catch (error) {
      const partialInput = inputFromSamples(items);
      setInput(partialInput || input.trim() || buildGroupIntentSample());
      setSelectedIndex(0);
      resetResults();
      api.error(`千问生成中断，已保留当前输入：${error.message || "请稍后重试"}`);
    } finally {
      setSampleLoading(false);
    }
  }

  async function trainIntentModel() {
    if (!trainingRows.length) {
      api.warning("没有可训练的样本");
      return;
    }
    setTrainLoading(true);
    try {
      const data = await requestJson("/api/group-intent/train", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: trainingRows }),
      });
      setTrainResult(data);
      api.success(`已参与训练，本次 ${data.trainedCount || 0} 条，总样本 ${data.totalSamples || 0} 条`);
    } catch (error) {
      api.error(error.message || "训练失败");
    } finally {
      setTrainLoading(false);
    }
  }

  async function startAutoTrain() {
    const count = Math.max(1, Math.min(5000, Number(autoCount || 0)));
    if (!count) {
      api.warning("请输入要生成的消息数量");
      return;
    }
    setAutoLoading(true);
    try {
      const data = await requestJson("/api/group-intent/auto-train-jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count, domainType: autoDomainType }),
      });
      window.localStorage?.setItem(GROUP_INTENT_AUTO_JOB_ID_KEY, data.job.id);
      setAutoJob(data.job);
      setAutoJobs((current) => [data.job, ...current.filter((item) => item.id !== data.job.id)].slice(0, 5));
      api.success("自动训练任务已开始");
    } catch (error) {
      api.error(error.message || "自动训练任务创建失败");
    } finally {
      setAutoLoading(false);
    }
  }

  async function loadAutoTrainJobs() {
    try {
      const data = await requestJson("/api/group-intent/auto-train-jobs");
      const jobs = data.jobs || [];
      const savedJobId = window.localStorage?.getItem(GROUP_INTENT_AUTO_JOB_ID_KEY);
      const restoredJob =
        jobs.find((item) => item.id === savedJobId) ||
        jobs.find((item) => ["queued", "running"].includes(item.status)) ||
        jobs[0] ||
        null;
      setAutoJobs(jobs);
      setAutoJob(restoredJob);
    } catch {
      // 首页展示不因为历史任务读取失败而打断主流程。
    }
  }

  useEffect(() => {
    if (selectedIndex >= trainingRows.length) {
      setSelectedIndex(trainingRows.length ? trainingRows.length - 1 : 0);
    }
  }, [trainingRows.length, selectedIndex]);

  useEffect(() => {
    loadAutoTrainJobs();
  }, []);

  useEffect(() => {
    if (autoJob?.id) {
      window.localStorage?.setItem(GROUP_INTENT_AUTO_JOB_ID_KEY, autoJob.id);
    }
  }, [autoJob?.id]);

  useEffect(() => {
    window.localStorage?.setItem(GROUP_INTENT_INPUT_DRAFT_KEY, input);
  }, [input]);

  useEffect(() => {
    if (!autoJob?.id || !["queued", "running"].includes(autoJob.status)) return undefined;
    const timer = window.setInterval(async () => {
      try {
        const data = await requestJson(`/api/group-intent/auto-train-jobs/${encodeURIComponent(autoJob.id)}`);
        setAutoJob(data.job);
        setAutoJobs((current) => [data.job, ...current.filter((item) => item.id !== data.job.id)].slice(0, 5));
      } catch {
        window.clearInterval(timer);
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [autoJob?.id, autoJob?.status]);

  return {
    autoCount,
    autoDomainType,
    autoJob,
    autoJobs,
    autoLoading,
    autoProgress,
    clearInput,
    contextHolder,
    detectIntent,
    detectLoading,
    fillQwenSamples,
    input,
    labelLoading,
    resultSource,
    sampleLoading,
    selectedIndex,
    setAutoCount,
    setAutoDomainType,
    setAutoJob,
    setSelectedIndex,
    startAutoTrain,
    startQwenLabeling,
    summary,
    trainIntentModel,
    trainLoading,
    trainResult,
    trainingRows,
    updateInput,
    updateTrainingLabel,
  };
}
