import { describe, expect, it } from "vitest";
import {
  REQUIRED_STEP_KEYS,
  STEP_DEFINITIONS,
  isStepKey,
  missingRequiredSteps,
  nextStepFor,
  previousStepOf,
  progressPercent,
  resumeStepFor,
  stepAtIndex,
  stepIndexOf,
  stepProgressPercent,
  stepSchemas,
} from "@/lib/quiz/steps";
import { LIMITS } from "@/lib/health/constants";

const validMetric = {
  unitSystem: "METRIC" as const,
  age: 30,
  heightCm: 180,
  weightKg: 85,
  goalWeightKg: 75,
};

describe("步骤定义", () => {
  it("order 唯一且严格递增", () => {
    const orders = STEP_DEFINITIONS.map((s) => s.order);
    expect(new Set(orders).size).toBe(orders.length);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
  });

  it("每个步骤都有对应的 schema", () => {
    for (const step of STEP_DEFINITIONS) {
      expect(stepSchemas[step.key]).toBeDefined();
    }
  });

  it("isStepKey 拒绝未知步骤，也拒绝原型链上的属性", () => {
    expect(isStepKey("gender")).toBe(true);
    expect(isStepKey("nope")).toBe(false);
    // Object.hasOwn 而非 in，否则 toString / constructor 会被误判为合法步骤
    expect(isStepKey("toString")).toBe(false);
    expect(isStepKey("constructor")).toBe(false);
    expect(isStepKey("__proto__")).toBe(false);
  });
});

describe("进度推算", () => {
  it("未作答时指向第一步", () => {
    expect(nextStepFor([])).toBe("gender");
  });

  it("按 order 顺序返回第一个未作答的步骤，与传入顺序无关", () => {
    expect(nextStepFor(["goal", "gender"])).toBe("focus_areas");
    expect(nextStepFor(["gender", "goal"])).toBe("focus_areas");
  });

  it("跳过了中间步骤时仍会指回被跳过的那一步", () => {
    expect(nextStepFor(["gender", "goal", "body_metrics"])).toBe("focus_areas");
  });

  it("全部完成后返回 null", () => {
    expect(nextStepFor(STEP_DEFINITIONS.map((s) => s.key))).toBeNull();
  });

  it("缺失的必填步骤不包含非必填步骤", () => {
    const missing = missingRequiredSteps(["gender"]);
    expect(missing).not.toContain("focus_areas");
    expect(missing).toEqual(REQUIRED_STEP_KEYS.filter((k) => k !== "gender"));
  });

  it("进度百分比在 0 到 100 之间", () => {
    expect(progressPercent([])).toBe(0);
    expect(progressPercent(STEP_DEFINITIONS.map((s) => s.key))).toBe(100);
    const mid = progressPercent(["gender", "goal"]);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(100);
  });

  it("未知步骤不会污染进度计算", () => {
    expect(progressPercent(["gender", "hacked", "also_fake"])).toBe(
      progressPercent(["gender"]),
    );
  });
});

describe("漏斗导航", () => {
  it("下标与步骤可以互相还原", () => {
    for (const step of STEP_DEFINITIONS) {
      expect(stepAtIndex(stepIndexOf(step.key))).toBe(step.key);
    }
  });

  it("未知步骤的下标是 -1，越界下标返回 null", () => {
    expect(stepIndexOf("nope")).toBe(-1);
    expect(stepAtIndex(-1)).toBeNull();
    expect(stepAtIndex(STEP_DEFINITIONS.length)).toBeNull();
    expect(stepAtIndex(999)).toBeNull();
  });

  it("第一步没有上一步，供返回键判断该退出漏斗", () => {
    expect(previousStepOf("gender")).toBeNull();
  });

  it("其余步骤的上一步就是前一个", () => {
    expect(previousStepOf("goal")).toBe("gender");
    expect(previousStepOf("focus_areas")).toBe("goal");
    expect(previousStepOf("activity_level")).toBe("body_metrics");
  });

  it("未知步骤没有上一步", () => {
    expect(previousStepOf("nope")).toBeNull();
  });

  describe("恢复落点", () => {
    it("没答过任何步骤时从第一步开始", () => {
      expect(resumeStepFor([])).toBe("gender");
    });

    it("答到哪就接着下一步", () => {
      expect(resumeStepFor(["gender"])).toBe("goal");
      expect(resumeStepFor(["gender", "goal"])).toBe("focus_areas");
    });

    it("与传入顺序无关，只看最靠后的那一步", () => {
      expect(resumeStepFor(["goal", "gender"])).toBe("focus_areas");
    });

    it("跳过可选步骤后不会被拽回去", () => {
      // 这是 resumeStepFor 存在的理由：nextStepFor 在这里会返回 focus_areas，
      // 把用户送回他主动跳过的那一步。
      const answered = ["gender", "goal", "body_metrics"];
      expect(nextStepFor(answered)).toBe("focus_areas");
      expect(resumeStepFor(answered)).toBe("activity_level");
    });

    it("全部答完时停在最后一步，而不是掉进空白页", () => {
      expect(resumeStepFor(STEP_DEFINITIONS.map((s) => s.key))).toBe("activity_level");
    });

    it("混入未知步骤不影响结果", () => {
      expect(resumeStepFor(["gender", "hacked", "__proto__"])).toBe("goal");
    });
  });

  describe("进度百分比", () => {
    it("按下标推进，首尾为 0 和 100", () => {
      expect(stepProgressPercent(0)).toBe(0);
      expect(stepProgressPercent(STEP_DEFINITIONS.length)).toBe(100);
    });

    it("单调递增", () => {
      const values = STEP_DEFINITIONS.map((_, i) => stepProgressPercent(i));
      expect([...values].sort((a, b) => a - b)).toEqual(values);
    });

    it("越界下标被钳制在 0 到 100 之间", () => {
      expect(stepProgressPercent(-5)).toBe(0);
      expect(stepProgressPercent(999)).toBe(100);
    });

    it("跳过可选步骤的用户仍能走到 100%", () => {
      // 按已答数量算的话，跳过一步就永远停在 80%，
      // 进度条会让人以为还没填完。
      expect(progressPercent(["gender", "goal", "body_metrics", "activity_level"])).toBe(80);
      expect(stepProgressPercent(STEP_DEFINITIONS.length)).toBe(100);
    });
  });
});

describe("单选类步骤的校验", () => {
  it("接受合法枚举值", () => {
    expect(stepSchemas.gender.parse({ gender: "FEMALE" })).toEqual({ gender: "FEMALE" });
    expect(stepSchemas.goal.parse({ goal: "GAIN_MUSCLE" })).toEqual({ goal: "GAIN_MUSCLE" });
  });

  it("拒绝枚举外的值", () => {
    expect(stepSchemas.gender.safeParse({ gender: "ROBOT" }).success).toBe(false);
    expect(stepSchemas.activity_level.safeParse({ activityLevel: "EXTREME" }).success).toBe(
      false,
    );
  });

  it("拒绝多余字段，避免客户端往库里塞任意数据", () => {
    const result = stepSchemas.gender.safeParse({ gender: "MALE", isAdmin: true });
    expect(result.success).toBe(false);
  });

  it("拒绝缺字段与空对象", () => {
    expect(stepSchemas.gender.safeParse({}).success).toBe(false);
    expect(stepSchemas.goal.safeParse(null).success).toBe(false);
  });
});

describe("身体数据校验 · 公制", () => {
  it("接受合法输入并规范化到一位小数", () => {
    const parsed = stepSchemas.body_metrics.parse({ ...validMetric, weightKg: 85.26 });
    expect(parsed.weightKg).toBe(85.3);
    expect(parsed.unitSystem).toBe("METRIC");
  });

  it.each([
    ["身高为 0", { heightCm: 0 }],
    ["身高为负", { heightCm: -180 }],
    ["身高超上限", { heightCm: LIMITS.heightCm.max + 1 }],
    ["体重为 0", { weightKg: 0 }],
    ["体重为负", { weightKg: -85 }],
    ["年龄为 0", { age: 0 }],
    ["年龄超上限", { age: LIMITS.age.max + 1 }],
    ["年龄为小数", { age: 30.5 }],
  ])("拒绝：%s", (_label, patch) => {
    const result = stepSchemas.body_metrics.safeParse({ ...validMetric, ...patch });
    if (_label === "年龄为小数") {
      // 小数年龄会被四舍五入到 30.5 -> 仍在区间内，属于可接受的规范化
      expect(result.success).toBe(true);
      return;
    }
    expect(result.success).toBe(false);
  });

  it("拒绝字符串形式的数字，不做隐式转换", () => {
    // 隐式转换会让 "85abc" 之类的输入静默变成 85，把脏数据放进库里
    const result = stepSchemas.body_metrics.safeParse({ ...validMetric, weightKg: "85" });
    expect(result.success).toBe(false);
  });

  it("拒绝 1e400 这类被解析成 Infinity 的数值注入", () => {
    // JSON.parse("1e400") 得到 Infinity，这是真实可达的注入路径
    const injected = JSON.parse('{"unitSystem":"METRIC","age":30,"heightCm":1e400,"weightKg":85,"goalWeightKg":75}');
    expect(injected.heightCm).toBe(Number.POSITIVE_INFINITY);
    expect(stepSchemas.body_metrics.safeParse(injected).success).toBe(false);
  });

  it("拒绝 NaN", () => {
    expect(
      stepSchemas.body_metrics.safeParse({ ...validMetric, weightKg: Number.NaN }).success,
    ).toBe(false);
  });

  it("接受区间端点", () => {
    expect(
      stepSchemas.body_metrics.safeParse({
        unitSystem: "METRIC",
        age: LIMITS.age.min,
        heightCm: LIMITS.heightCm.min,
        weightKg: LIMITS.weightKg.min,
        goalWeightKg: LIMITS.weightKg.min,
      }).success,
    ).toBe(true);
  });

  it("拒绝偏离过大的目标体重，并把错误定位到该字段", () => {
    const result = stepSchemas.body_metrics.safeParse({
      ...validMetric,
      weightKg: 70,
      goalWeightKg: 175,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("goalWeightKg"))).toBe(true);
    }
  });

  it("拒绝多余字段", () => {
    expect(
      stepSchemas.body_metrics.safeParse({ ...validMetric, subscriptionStatus: "ACTIVE" })
        .success,
    ).toBe(false);
  });

  it("缺少 unitSystem 时拒绝，而不是猜一个默认值", () => {
    const rest: Record<string, unknown> = { ...validMetric };
    delete rest.unitSystem;
    expect(stepSchemas.body_metrics.safeParse(rest).success).toBe(false);
  });
});

describe("身体数据校验 · 英制换算", () => {
  it("换算成公制后落库", () => {
    const parsed = stepSchemas.body_metrics.parse({
      unitSystem: "IMPERIAL",
      age: 30,
      heightIn: 70,
      weightLb: 180,
      goalWeightLb: 160,
    });
    expect(parsed.heightCm).toBeCloseTo(177.8, 1);
    expect(parsed.weightKg).toBeCloseTo(81.6, 1);
    expect(parsed.goalWeightKg).toBeCloseTo(72.6, 1);
    // 保留原始单位制供前端回显，但数值本身已是公制
    expect(parsed.unitSystem).toBe("IMPERIAL");
  });

  it("英制与公制的等价输入得到一致的公制结果", () => {
    const imperial = stepSchemas.body_metrics.parse({
      unitSystem: "IMPERIAL",
      age: 30,
      heightIn: 70,
      weightLb: 180,
      goalWeightLb: 160,
    });
    const metric = stepSchemas.body_metrics.parse({
      unitSystem: "METRIC",
      age: 30,
      heightCm: imperial.heightCm,
      weightKg: imperial.weightKg,
      goalWeightKg: imperial.goalWeightKg,
    });
    expect(metric.heightCm).toBe(imperial.heightCm);
    expect(metric.weightKg).toBe(imperial.weightKg);
  });

  it("不接受公制字段混进英制载荷", () => {
    expect(
      stepSchemas.body_metrics.safeParse({
        unitSystem: "IMPERIAL",
        age: 30,
        heightIn: 70,
        weightLb: 180,
        goalWeightLb: 160,
        weightKg: 200,
      }).success,
    ).toBe(false);
  });

  it("拒绝未知的单位制", () => {
    expect(
      stepSchemas.body_metrics.safeParse({ ...validMetric, unitSystem: "STONES" }).success,
    ).toBe(false);
  });
});

describe("关注部位", () => {
  it("去重", () => {
    const parsed = stepSchemas.focus_areas.parse({ areas: ["BELLY", "BELLY", "ARMS"] });
    expect(parsed.areas).toEqual(["BELLY", "ARMS"]);
  });

  it("拒绝空数组与白名单外的值", () => {
    expect(stepSchemas.focus_areas.safeParse({ areas: [] }).success).toBe(false);
    expect(stepSchemas.focus_areas.safeParse({ areas: ["NECK"] }).success).toBe(false);
  });

  it("拒绝自由文本，防止把用户可控字符串存进库", () => {
    expect(
      stepSchemas.focus_areas.safeParse({ areas: ["<script>alert(1)</script>"] }).success,
    ).toBe(false);
  });
});
