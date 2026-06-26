export const GROUP_INTENT_LABELS = [
  "ignore",
  "remember_product",
  "ask_link",
  "ask_recommend",
  "follow_up",
  "clarify_needed",
];

export const GROUP_INTENT_LABEL_TEXT = {
  ignore: "不介入",
  remember_product: "记住商品",
  ask_link: "要链接",
  ask_recommend: "要推荐",
  follow_up: "继续追问",
  clarify_needed: "需要澄清",
};

export const GROUP_INTENT_LABEL_OPTIONS = GROUP_INTENT_LABELS.map((value) => ({
  value,
  label: GROUP_INTENT_LABEL_TEXT[value] || value,
}));

const GROUP_INTENT_PRODUCT_HINTS = [
  "纸尿裤",
  "湿巾",
  "奶瓶",
  "奶嘴",
  "辅食",
  "辅食机",
  "推车",
  "安全座椅",
  "面霜",
  "奶粉",
  "吸奶器",
  "吸鼻器",
  "吸管杯",
  "学饮杯",
  "防晒霜",
  "护臀膏",
  "花王",
  "贝亲",
  "帮宝适",
  "好奇",
  "世喜",
  "可优比",
  "英氏",
  "子初",
  "艾维诺",
  "小白熊",
  "兔头妈妈",
  "全棉时代",
  "润本",
  "可心柔",
  "好孩子",
  "新安怡",
];

const GROUP_INTENT_RECOMMEND_HINTS = ["推荐", "求推荐", "哪款", "哪种", "哪个牌子", "怎么选", "选哪", "有啥", "靠谱", "值不值"];
const GROUP_INTENT_LINK_HINTS = ["链接", "发个", "哪里买", "多少钱", "价格", "购买", "下单", "有货", "活动"];
const GROUP_INTENT_FOLLOW_HINTS = ["刚才", "刚刚", "那个", "这款", "那款", "上回", "继续", "再来", "换成", "换个", "还行吗"];
const GROUP_INTENT_CLARIFY_HINTS = ["这个", "那个", "这款", "那款", "刚才", "之前", "上回"];
const GROUP_INTENT_REMEMBER_HINTS = ["买了", "囤了", "刚入", "用着", "挺好", "好用", "不错", "秒杀", "活动价", "先记一下"];
const AMBIGUOUS_REFERENCE_HINTS = ["这个", "那个", "这款", "那款", "刚才", "之前", "上回"];

export function normalizeGroupIntentText(text = "") {
  return String(text || "").trim().replace(/^[^:：]{1,24}[:：]\s*/, "");
}

function getGroupIntentHits(text, hints) {
  return hints.filter((hint) => text.includes(hint));
}

export function classifyGroupIntentTurn(text, context = []) {
  const clean = normalizeGroupIntentText(text);
  const compact = clean.replace(/\s+/g, "");
  const contextText = context.map((item) => normalizeGroupIntentText(item.text)).join(" ");
  const currentTopics = GROUP_INTENT_PRODUCT_HINTS.filter((hint) => compact.includes(hint));
  const recentTopics = GROUP_INTENT_PRODUCT_HINTS.filter((hint) => contextText.includes(hint));
  const topics = Array.from(new Set([...currentTopics, ...recentTopics]));
  const recommendHits = getGroupIntentHits(compact, GROUP_INTENT_RECOMMEND_HINTS);
  const linkHits = getGroupIntentHits(compact, GROUP_INTENT_LINK_HINTS);
  const followHits = getGroupIntentHits(compact, GROUP_INTENT_FOLLOW_HINTS);
  const clarifyHits = getGroupIntentHits(compact, GROUP_INTENT_CLARIFY_HINTS);
  const rememberHits = getGroupIntentHits(compact, GROUP_INTENT_REMEMBER_HINTS);

  const hasCommerceSignal =
    topics.length > 0 ||
    recommendHits.length > 0 ||
    linkHits.length > 0 ||
    followHits.length > 0 ||
    rememberHits.length > 0;

  const ambiguousOnly =
    clarifyHits.some((hint) => AMBIGUOUS_REFERENCE_HINTS.includes(hint)) &&
    !currentTopics.length;

  if (!hasCommerceSignal) {
    return {
      label: "ignore",
      shouldIntervene: false,
      action: "不介入",
      confidence: 0.96,
      reason: "没有明显的购物、推荐、链接或追问信号。",
      signals: [],
      topics: [],
    };
  }

  if (recommendHits.length > 0 && !linkHits.length) {
    return {
      label: "ask_recommend",
      shouldIntervene: true,
      action: "给出 2-3 个可选推荐，并说明差异",
      confidence: 0.93,
      reason: `命中推荐诉求：${recommendHits.join("、")}。`,
      signals: recommendHits,
      topics,
    };
  }

  if (linkHits.length > 0) {
    if (ambiguousOnly) {
      return {
        label: "clarify_needed",
        shouldIntervene: true,
        action: "先确认指代对象，再给链接",
        confidence: 0.91,
        reason: `命中链接诉求：${linkHits.join("、")}，但当前指代不清。`,
        signals: linkHits,
        topics,
      };
    }
    return {
      label: "ask_link",
      shouldIntervene: true,
      action: "直接回复购买链接或入口",
      confidence: 0.94,
      reason: `命中链接/购买诉求：${linkHits.join("、")}。`,
      signals: linkHits,
      topics,
    };
  }

  if (followHits.length > 0) {
    return {
      label: "follow_up",
      shouldIntervene: true,
      action: "沿着上文继续追问或补充条件",
      confidence: 0.9,
      reason: `命中追问/规格/改动信号：${followHits.join("、")}。`,
      signals: followHits,
      topics,
    };
  }

  if (rememberHits.length > 0) {
    return {
      label: "remember_product",
      shouldIntervene: false,
      action: "不介入，仅记录商品/体验",
      confidence: 0.89,
      reason: `命中商品记忆信号：${rememberHits.join("、")}。`,
      signals: rememberHits,
      topics,
    };
  }

  if (clarifyHits.length > 0) {
    return {
      label: "clarify_needed",
      shouldIntervene: true,
      action: "先澄清具体商品或指代对象",
      confidence: 0.87,
      reason: `命中模糊指代：${clarifyHits.join("、")}。`,
      signals: clarifyHits,
      topics,
    };
  }

  return {
    label: "ignore",
    shouldIntervene: false,
    action: "不介入",
    confidence: 0.78,
    reason: "虽然有商品上下文，但没有足够的介入信号。",
    signals: [],
    topics,
  };
}
