import {
  ACTIVITY_FACTORS,
  ALGORITHM_VERSION,
  BMI_NORMAL_MAX,
  BMI_OVERWEIGHT_MAX,
  BMI_UNDERWEIGHT_MAX,
  BMR_GENDER_CONSTANT,
  CALORIE_FLOOR,
  FAT_CALORIE_RATIO,
  KCAL_PER_G_CARB,
  KCAL_PER_G_FAT,
  KCAL_PER_G_PROTEIN,
  KCAL_PER_KG_FAT,
  LIMITS,
  MAX_GOAL_DEVIATION_RATIO,
  MAX_PROJECTION_WEEKS,
  MAX_WEEKLY_GAIN_KG,
  MAX_WEEKLY_LOSS_KG,
  MAX_WEEKLY_LOSS_RATIO,
  PROTEIN_G_PER_KG,
} from "./constants";
import type {
  AssessmentInput,
  AssessmentOutput,
  AssessmentWarning,
  BmiCategory,
  Gender,
  MacroSplit,
  ProjectionPoint,
} from "./types";

/**
 * 算法层的输入非法错误。
 *
 * 与 zod 的入口校验是两道独立防线：zod 挡住来自 HTTP 的脏数据，
 * 这里挡住来自内部调用方（种子脚本、后台任务、未来的批处理）的脏数据。
 * 纯函数不该在拿到 NaN 时安静地返回 NaN。
 */
export class InvalidAssessmentInputError extends Error {
  constructor(
    readonly field: string,
    readonly reason: string,
  ) {
    super(`健康评估输入非法：${field} ${reason}`);
    this.name = "InvalidAssessmentInputError";
  }
}

const round = (value: number, digits: number): number => {
  const factor = 10 ** digits;
  // 先加一个极小量再取整，规避 0.5 这类值在二进制浮点下向下取整的意外
  return Math.round((value + Number.EPSILON) * factor) / factor;
};

const round1 = (value: number) => round(value, 1);
const round2 = (value: number) => round(value, 2);

function assertNumberInRange(
  field: string,
  value: unknown,
  min: number,
  max: number,
): asserts value is number {
  if (typeof value !== "number") {
    throw new InvalidAssessmentInputError(field, `必须是数字，收到 ${typeof value}`);
  }
  if (!Number.isFinite(value)) {
    throw new InvalidAssessmentInputError(field, "必须是有限数字");
  }
  if (value < min || value > max) {
    throw new InvalidAssessmentInputError(field, `必须在 ${min} 到 ${max} 之间，收到 ${value}`);
  }
}

/**
 * 算法层的输入校验。
 *
 * 只拦真正算不出来或明显是脏数据的输入。
 * 「目标不健康但算得出来」不在这里拦，那是告警的职责。
 */
export function validateAssessmentInput(input: AssessmentInput): void {
  assertNumberInRange("age", input.age, LIMITS.age.min, LIMITS.age.max);
  assertNumberInRange("heightCm", input.heightCm, LIMITS.heightCm.min, LIMITS.heightCm.max);
  assertNumberInRange("weightKg", input.weightKg, LIMITS.weightKg.min, LIMITS.weightKg.max);
  assertNumberInRange(
    "goalWeightKg",
    input.goalWeightKg,
    LIMITS.goalWeightKg.min,
    LIMITS.goalWeightKg.max,
  );

  if (!(input.gender in BMR_GENDER_CONSTANT)) {
    throw new InvalidAssessmentInputError("gender", `不支持的取值 ${String(input.gender)}`);
  }
  if (!(input.activityLevel in ACTIVITY_FACTORS)) {
    throw new InvalidAssessmentInputError(
      "activityLevel",
      `不支持的取值 ${String(input.activityLevel)}`,
    );
  }

  // 目标体重偏离当前体重超过一半，视为误输入而非激进目标。
  // 例：70kg 的人填 200kg，多半是把身高填进了体重栏。
  const deviation = Math.abs(input.goalWeightKg - input.weightKg) / input.weightKg;
  if (deviation > MAX_GOAL_DEVIATION_RATIO) {
    throw new InvalidAssessmentInputError(
      "goalWeightKg",
      `相对当前体重偏离 ${Math.round(deviation * 100)}%，超出允许的 ${
        MAX_GOAL_DEVIATION_RATIO * 100
      }%`,
    );
  }
}

export function calculateBmi(weightKg: number, heightCm: number): number {
  const heightM = heightCm / 100;
  return round2(weightKg / (heightM * heightM));
}

export function classifyBmi(bmi: number): BmiCategory {
  if (bmi < BMI_UNDERWEIGHT_MAX) return "UNDERWEIGHT";
  if (bmi < BMI_NORMAL_MAX) return "NORMAL";
  if (bmi < BMI_OVERWEIGHT_MAX) return "OVERWEIGHT";
  return "OBESE";
}

/** Mifflin-St Jeor 基础代谢率 */
export function calculateBmr(input: {
  gender: Gender;
  weightKg: number;
  heightCm: number;
  age: number;
}): number {
  const base = 10 * input.weightKg + 6.25 * input.heightCm - 5 * input.age;
  return Math.round(base + BMR_GENDER_CONSTANT[input.gender]);
}

export function calculateTdee(bmr: number, activityLevel: AssessmentInput["activityLevel"]): number {
  return Math.round(bmr * ACTIVITY_FACTORS[activityLevel]);
}

function calculateMacros(calories: number, goal: AssessmentInput["goal"], goalWeightKg: number): MacroSplit {
  const proteinG = Math.round(PROTEIN_G_PER_KG[goal] * goalWeightKg);
  const fatG = Math.round((calories * FAT_CALORIE_RATIO) / KCAL_PER_G_FAT);

  const remaining = calories - proteinG * KCAL_PER_G_PROTEIN - fatG * KCAL_PER_G_FAT;
  // 极低热量叠加高蛋白目标时，碳水配额可能被挤成负数。
  // 这时钳到 0 而不是返回负克数，负的宏量营养素没有物理意义。
  const carbsG = Math.max(0, Math.round(remaining / KCAL_PER_G_CARB));

  return { proteinG, carbsG, fatG };
}

function addDaysUtc(from: Date, days: number): Date {
  // 全程用 UTC 做日期加减：本地时区参与运算会让测试在不同机器上给出不同结果，
  // 夏令时切换当天还会多出或少掉一小时。
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * 健康评估主函数。纯函数：同样的输入 + 同样的 now，永远得到同样的输出。
 *
 * `now` 做成显式参数而不是内部调用 new Date()，
 * 是为了让「目标日期」这类依赖当前时间的输出可被确定性地断言。
 */
export function computeAssessment(
  input: AssessmentInput,
  now: Date = new Date(),
): AssessmentOutput {
  validateAssessmentInput(input);

  const warnings: AssessmentWarning[] = [];
  const pushWarning = (code: AssessmentWarning["code"], message: string) =>
    warnings.push({ code, message });

  const bmi = calculateBmi(input.weightKg, input.heightCm);
  const bmiCategory = classifyBmi(bmi);
  const bmr = calculateBmr(input);
  const tdee = calculateTdee(bmr, input.activityLevel);

  const deltaKg = round2(input.goalWeightKg - input.weightKg);
  const direction: -1 | 0 | 1 = deltaKg === 0 ? 0 : deltaKg > 0 ? 1 : -1;

  // 用户勾选的目标与实际数值方向不一致时，以数值为准并告警。
  // 例如勾了「减重」却把目标体重填得比当前更高。
  if (direction === 1 && input.goal === "LOSE_WEIGHT") {
    pushWarning(
      "GOAL_CONFLICTS_WITH_DIRECTION",
      "你选择了减重，但目标体重高于当前体重。已按目标体重的实际方向计算。",
    );
  }
  if (direction === -1 && input.goal === "GAIN_MUSCLE") {
    pushWarning(
      "GOAL_CONFLICTS_WITH_DIRECTION",
      "你选择了增肌，但目标体重低于当前体重。已按目标体重的实际方向计算。",
    );
  }

  const goalBmi = calculateBmi(input.goalWeightKg, input.heightCm);
  if (goalBmi < BMI_UNDERWEIGHT_MAX) {
    pushWarning(
      "GOAL_BMI_UNDERWEIGHT",
      `目标体重对应的 BMI 为 ${goalBmi}，低于健康区间下限 ${BMI_UNDERWEIGHT_MAX}。建议上调目标。`,
    );
  }
  if (goalBmi >= BMI_OVERWEIGHT_MAX) {
    pushWarning(
      "GOAL_BMI_OBESE",
      `目标体重对应的 BMI 为 ${goalBmi}，已达肥胖区间。建议下调目标。`,
    );
  }
  if (bmi < 15 || bmi >= 40) {
    pushWarning(
      "CURRENT_BMI_EXTREME",
      `当前 BMI 为 ${bmi}，处于极端区间。本结果仅供参考，请咨询专业医师。`,
    );
  }

  // --- 速率与热量，两者互相钳制 ---

  const floor = CALORIE_FLOOR[input.gender];

  // 期望速率：先按安全上限取值
  let desiredWeeklyRate: number;
  if (direction === -1) {
    desiredWeeklyRate = Math.min(input.weightKg * MAX_WEEKLY_LOSS_RATIO, MAX_WEEKLY_LOSS_KG);
  } else if (direction === 1) {
    desiredWeeklyRate = MAX_WEEKLY_GAIN_KG;
  } else {
    desiredWeeklyRate = 0;
  }

  const desiredDailyDelta = (desiredWeeklyRate * KCAL_PER_KG_FAT) / 7;

  /**
   * 摄入与速率必须一起定，三个方向走同一条路径。
   *
   * 这里曾经有个 bug：减重分支检查了下限，维持分支取了 max，
   * 增重分支却什么都没做 —— 它隐含假设「加上盈余之后一定高于下限」。
   * 当 TDEE 本身极低时（高龄、矮小、低体重、久坐叠加），这个假设不成立，
   * 算出来的建议摄入会低于项目自己规定的安全下限。
   *
   * 更要紧的是：光把最终数字取 max 并不能算修好。摄入一旦被抬高，
   * 实际热量差就变了，速率和目标日期必须跟着重算，
   * 否则页面上写着「按这个方案吃」，日期却是按另一套参数算的。
   */
  const desiredCalories =
    direction === -1
      ? tdee - desiredDailyDelta
      : direction === 1
        ? tdee + desiredDailyDelta
        : tdee;

  const floorApplied = desiredCalories < floor;
  const recommendedCalories = floorApplied ? floor : Math.round(desiredCalories);

  // 按最终摄入与 TDEE 的真实差额反推速率，而不是沿用期望速率
  const actualDailyDelta = recommendedCalories - tdee;
  let effectiveWeeklyRateKg =
    direction === 0
      ? 0
      : round2((Math.abs(actualDailyDelta) * 7) / KCAL_PER_KG_FAT);

  // 被抬到下限之后，热量差的方向可能与目标方向相反
  // （例如想减重，但 TDEE 已低于安全下限，再怎么吃也制造不出缺口）
  if (direction === -1 && actualDailyDelta >= 0) {
    effectiveWeeklyRateKg = 0;
  }

  if (floorApplied) {
    pushWarning(
      "CALORIE_FLOOR_APPLIED",
      direction === 1
        ? `为保证安全，每日摄入不低于 ${floor} 千卡，实际增重速度会快于建议节奏。`
        : direction === 0
          ? `你的每日总消耗低于安全摄入下限 ${floor} 千卡。按此方案摄入，体重会缓慢上升而非维持。`
          : `为保证安全，每日摄入不低于 ${floor} 千卡，达成目标所需时间相应延长。`,
    );
  }

  // 下限与速率上限无法同时满足时，明确说出来，而不是闷声输出一个超速方案
  if (direction === 1 && effectiveWeeklyRateKg > MAX_WEEKLY_GAIN_KG) {
    pushWarning(
      "CALORIE_FLOOR_EXCEEDS_TARGET_RATE",
      `安全摄入下限对应的每周增重约 ${effectiveWeeklyRateKg} 公斤，超过建议的 ${MAX_WEEKLY_GAIN_KG} 公斤。建议在专业人士指导下执行。`,
    );
  }

  // TDEE 本身已低于安全下限（高龄、极低体重、久坐叠加），
  // 靠饮食制造缺口不再可行，速率归零并明确告知。
  if (direction === -1 && effectiveWeeklyRateKg === 0) {
    pushWarning(
      "AGGRESSIVE_GOAL",
      "你的每日总消耗已接近安全摄入下限，无法通过继续减少摄入来达成目标。建议增加运动量或咨询专业人士。",
    );
  }

  const absDelta = Math.abs(deltaKg);
  const weeksToGoal =
    direction === 0 || effectiveWeeklyRateKg === 0
      ? 0
      : Math.ceil(absDelta / effectiveWeeklyRateKg);

  const targetDate =
    weeksToGoal > 0 ? toIsoDate(addDaysUtc(now, weeksToGoal * 7)) : null;

  // --- 逐周预测曲线 ---

  const projectionWeeks =
    direction === 0
      ? 12 // 维持体重也给一条 12 周的平线，结果页需要有可视化内容
      : Math.min(weeksToGoal, MAX_PROJECTION_WEEKS);

  const weeklyProjection: ProjectionPoint[] = [];
  for (let week = 1; week <= projectionWeeks; week += 1) {
    const raw = input.weightKg + direction * effectiveWeeklyRateKg * week;
    // 最后一周可能因为向上取整而越过目标，钳到目标值，
    // 否则曲线末端会出现「比目标还轻」的不实数字。
    const clamped =
      direction === -1
        ? Math.max(raw, input.goalWeightKg)
        : direction === 1
          ? Math.min(raw, input.goalWeightKg)
          : raw;
    weeklyProjection.push({
      week,
      weightKg: round1(clamped),
      date: toIsoDate(addDaysUtc(now, week * 7)),
    });
  }

  return {
    bmi,
    bmiCategory,
    bmr,
    tdee,
    recommendedCalories,
    macros: calculateMacros(recommendedCalories, input.goal, input.goalWeightKg),
    targetDate,
    weeksToGoal,
    effectiveWeeklyRateKg,
    weeklyProjection,
    warnings,
    algorithmVersion: ALGORITHM_VERSION,
  };
}
