const GROUP_INTENT_BLUEPRINT = [
  { speaker: "小雨妈", text: "宝宝6个月晚上侧漏，有没有纸尿裤推荐？" },
  { speaker: "团长", text: "我昨天买了花王妙而舒L码，活动价挺好。" },
  { speaker: "晓晓", text: "这个有链接吗？" },
  { speaker: "小雨妈", text: "那M码还是L码更合适？" },
  { speaker: "阿宁", text: "红屁屁宝宝用什么面霜比较安全？" },
  { speaker: "团长", text: "贝亲奶瓶刷我昨天买了，挺好用。" },
  { speaker: "朵朵", text: "之前那个babycare湿巾在哪里买？" },
  { speaker: "阿宁", text: "这个会不会太厚，南方夏天能用吗？" },
  { speaker: "小西", text: "哈哈我家也是，晚上完全不睡。" },
  { speaker: "糖糖", text: "刚才说的那款有链接吗？" },
  { speaker: "团长", text: "安儿乐轻如羽纸尿裤，整晚没漏过。" },
  { speaker: "朵朵", text: "那就换薄一点的吧" },
  { speaker: "阿宁", text: "预算300以内，有啥好推车？" },
  { speaker: "小西", text: "我刚入的可优比推车，收车很方便。" },
  { speaker: "糖糖", text: "刚刚那个多少钱？" },
  { speaker: "团长", text: "这个价格包邮不？" },
  { speaker: "小雨妈", text: "那款纸尿裤现在还有活动吗？" },
  { speaker: "朵朵", text: "3个月宝宝肠绞痛，晚上抱睡两小时才停，有啥缓解神器推荐？" },
  { speaker: "阿宁", text: "这个和上次那个一样不？" },
  { speaker: "团长", text: "刚入的花王纸尿裤，尺码挺正。" },
  { speaker: "小西", text: "求链接" },
  { speaker: "糖糖", text: "发码" },
  { speaker: "小雨妈", text: "宝宝7个月，辅食机选哪款？" },
  { speaker: "朵朵", text: "这个能不能分期？" },
  { speaker: "阿宁", text: "这个能发个图看看吗？" },
];

export function parseGroupIntentMessage(line = "") {
  const raw = String(line || "").trim();
  if (!raw) return null;
  const match = raw.match(/^([^:：]{1,24})[:：]\s*(.+)$/);
  if (match) return { speaker: match[1].trim(), text: match[2].trim(), raw };
  return { speaker: "", text: raw, raw };
}

export function parseGroupIntentConversation(value = "") {
  return String(value || "")
    .split(/\n+/)
    .map((line, index) => {
      const parsed = parseGroupIntentMessage(line);
      return parsed ? { ...parsed, index } : null;
    })
    .filter(Boolean);
}

export function buildGroupIntentSample() {
  const rows = [];
  for (let i = 0; i < 100; i += 1) {
    const item = GROUP_INTENT_BLUEPRINT[i % GROUP_INTENT_BLUEPRINT.length];
    const round = Math.floor(i / GROUP_INTENT_BLUEPRINT.length) + 1;
    const suffix = round > 1 && i % 8 === 0 ? `（第${round}轮）` : "";
    rows.push(`${item.speaker}${round > 1 && i % 5 === 0 ? round : ""}: ${item.text}${suffix}`);
  }
  return rows.join("\n");
}

export function groupIntentReviewKey(row) {
  return `${row.index}-${row.raw}`;
}

export function buildGroupIntentTrainingRecord(row, review) {
  const finalLabel = review?.finalLabel || row.label;
  return {
    sample_id: row.index + 1,
    turn_index: row.index + 1,
    speaker: row.speaker || "",
    text: row.text,
    context: (row.context || []).map((item) => item.text),
    model_label: row.label,
    final_label: finalLabel,
    should_intervene: Boolean(row.shouldIntervene),
    confidence: row.confidence,
    signals: row.signals || [],
    topics: row.topics || [],
    review_status: review?.status || "pending",
    reviewer_note: review?.note || "",
    reviewed_at: review?.reviewedAt || "",
    source: "group-intent-workbench",
  };
}

export function groupIntentRecordToJsonl(record) {
  return JSON.stringify(record);
}
