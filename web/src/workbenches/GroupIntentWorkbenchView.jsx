import React from "react";
import { Button, Input, Progress, Select, Space, Typography } from "antd";

const { Text, Title } = Typography;
const { TextArea } = Input;

function autoJobStatusText(status) {
  if (status === "completed") return "已完成";
  if (status === "failed") return "失败";
  return "进行中";
}

export function GroupIntentWorkbenchView({
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
}) {
  return (
    <div className="group-intent-workbench">
      {contextHolder}
      <section className="group-intent-panel group-intent-editor">
        <div className="group-intent-explain">
          <strong>识别群聊里哪些消息是在咨询商品或需要推荐。判断错了可以改，改完点“参与训练”。</strong>
        </div>

        <div className="group-intent-head">
          <div>
            <Title level={5}>群聊输入</Title>
            <Text>每一行是一条消息，支持“昵称: 消息”格式。</Text>
          </div>
          <Space wrap>
            <Button type="primary" size="small" loading={detectLoading} onClick={detectIntent}>
              检测
            </Button>
            <Button size="small" loading={labelLoading} onClick={startQwenLabeling}>
              开始训练
            </Button>
            <Button size="small" loading={sampleLoading} onClick={fillQwenSamples}>
              填入 100 条示例
            </Button>
            <Button size="small" onClick={clearInput}>
              清空
            </Button>
          </Space>
        </div>

        <TextArea
          className="group-intent-input"
          value={input}
          onChange={(event) => updateInput(event.target.value)}
          autoSize={{ minRows: 6, maxRows: 12 }}
          placeholder="例如：\n小雨妈: 宝宝6个月晚上侧漏，有没有纸尿裤推荐？\n团长: 我昨天买了花王妙而舒L码，活动价挺好。"
        />

        <div className="group-intent-controls">
          <div className="group-intent-summary">
            {summary.map((item) => (
              <div key={item.label}>
                <strong>{item.label}</strong>
                <span>{item.value}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="group-intent-auto-train">
          <div>
            <strong>自动生成训练样本</strong>
            <span>让千问按指定场景生成群聊消息并自动训练意图模型，不需要人工审核。</span>
          </div>
          <Space.Compact className="group-intent-auto-controls">
            <Input
              value={autoDomainType}
              onChange={(event) => setAutoDomainType(event.target.value)}
              placeholder="场景类型，如母婴/购物/宠物/女装"
              style={{ width: 220 }}
            />
            <Input
              type="number"
              min={1}
              max={5000}
              value={autoCount}
              onChange={(event) => setAutoCount(event.target.value)}
            />
            <Button type="primary" loading={autoLoading} onClick={startAutoTrain}>
              自动训练
            </Button>
          </Space.Compact>
          {autoJob ? (
            <div className="group-intent-auto-status">
              <div className="group-intent-auto-status-head">
                <span>{autoJobStatusText(autoJob.status)}</span>
                <strong>{autoProgress}%</strong>
              </div>
              <small>场景：{autoJob.domainType || "母婴"}</small>
              <Progress
                percent={autoProgress}
                size="small"
                status={autoJob.status === "failed" ? "exception" : autoJob.status === "completed" ? "success" : "active"}
              />
              <small>{autoJob.message || "任务进行中..."}</small>
              {autoJob.error ? <small className="group-intent-auto-error">{autoJob.error}</small> : null}
            </div>
          ) : null}
          {autoJobs.length > 1 ? (
            <div className="group-intent-auto-history">
              {autoJobs
                .filter((job) => job.id !== autoJob?.id)
                .slice(0, 4)
                .map((job) => (
                  <button key={job.id} type="button" onClick={() => setAutoJob(job)}>
                    <span>{`${job.domainType || "母婴"} · ${autoJobStatusText(job.status)}`}</span>
                    <strong>{job.trainedCount || 0}/{job.targetCount || 0}</strong>
                  </button>
                ))}
            </div>
          ) : null}
        </div>
      </section>

      <section className="group-intent-panel group-intent-timeline">
        <div className="group-intent-head">
          <div>
            <Title level={5}>训练样本确认</Title>
            <Text>
              {resultSource === "qwen"
                ? "千问已打标，可以人工确认后参与训练。"
                : resultSource === "intent_model"
                  ? "意图分析结果已生成，可以人工修正后参与训练。"
                  : "先点“检测”查看当前模型判断，或点“开始训练”让千问打标。"}
            </Text>
          </div>
          <Button type="primary" loading={trainLoading} disabled={!trainingRows.length} onClick={trainIntentModel}>
            参与训练
          </Button>
        </div>
        <div className="group-intent-list">
          {trainingRows.length ? (
            trainingRows.map((item, index) => (
              <button
                key={`${item.raw}-${index}`}
                type="button"
                className={`group-intent-row ${selectedIndex === index ? "active" : ""} ${item.label === "intervene" ? "alert" : ""}`}
                onClick={() => setSelectedIndex(index)}
              >
                <div className="group-intent-row-top">
                  <strong>{item.speaker || `消息 ${index + 1}`}</strong>
                  <Space size={6} wrap>
                    <Select
                      size="small"
                      value={item.label}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(value) => updateTrainingLabel(item.index, value)}
                      options={[
                        { value: "intervene", label: "需要介入" },
                        { value: "ignore", label: "不介入" },
                      ]}
                    />
                  </Space>
                </div>
                <span>{item.text}</span>
                {item.reason ? <small>{item.reason}</small> : null}
              </button>
            ))
          ) : (
            <div className="empty-state">先填入群聊消息，再点击“检测”或“开始训练”。</div>
          )}
        </div>
        {trainResult ? (
          <div className="group-intent-train-result">
            本次参与训练 {trainResult.trainedCount} 条，累计样本 {trainResult.totalSamples} 条。
          </div>
        ) : null}
      </section>
    </div>
  );
}
