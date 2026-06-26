import { describe, expect, it } from "vitest";
import {
  GROUP_INTENT_LABEL_OPTIONS,
  classifyGroupIntentTurn,
  normalizeGroupIntentText,
} from "./groupIntentRules";

describe("groupIntentRules", () => {
  it("normalizes speaker prefixes", () => {
    expect(normalizeGroupIntentText("小雨妈: 求纸尿裤推荐")).toBe("求纸尿裤推荐");
    expect(normalizeGroupIntentText("团长：发个链接")).toBe("发个链接");
  });

  it("classifies recommendation requests", () => {
    const result = classifyGroupIntentTurn("宝宝6个月晚上侧漏，有没有纸尿裤推荐？");
    expect(result).toMatchObject({
      label: "ask_recommend",
      shouldIntervene: true,
    });
    expect(result.topics).toContain("纸尿裤");
    expect(result.signals).toContain("推荐");
  });

  it("classifies direct link requests when the topic is explicit", () => {
    const result = classifyGroupIntentTurn("花王纸尿裤有链接吗？");
    expect(result).toMatchObject({
      label: "ask_link",
      shouldIntervene: true,
    });
  });

  it("asks for clarification when a link request only references prior context", () => {
    const result = classifyGroupIntentTurn("这个有链接吗？", [
      { text: "团长刚说花王纸尿裤活动价挺好" },
    ]);
    expect(result).toMatchObject({
      label: "clarify_needed",
      shouldIntervene: true,
    });
    expect(result.topics).toContain("纸尿裤");
  });

  it("classifies product memory signals without intervention", () => {
    const result = classifyGroupIntentTurn("我刚入的可优比推车，收车很方便。");
    expect(result).toMatchObject({
      label: "remember_product",
      shouldIntervene: false,
    });
    expect(result.topics).toContain("推车");
  });

  it("ignores unrelated chatter", () => {
    const result = classifyGroupIntentTurn("哈哈我家也是，晚上完全不睡。");
    expect(result).toMatchObject({
      label: "ignore",
      shouldIntervene: false,
    });
  });

  it("exposes label options for UI controls", () => {
    expect(GROUP_INTENT_LABEL_OPTIONS.map((item) => item.value)).toEqual([
      "ignore",
      "remember_product",
      "ask_link",
      "ask_recommend",
      "follow_up",
      "clarify_needed",
    ]);
  });
});
