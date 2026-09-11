/** 健康评估算法的输入与输出类型。与 Prisma 枚举保持一致的字面量联合。 */

export type Gender = "MALE" | "FEMALE" | "OTHER";

export type FitnessGoal = "LOSE_WEIGHT" | "MAINTAIN_WEIGHT" | "GAIN_MUSCLE";

export type ActivityLevel =
  | "SEDENTARY"
  | "LIGHT"
  | "MODERATE"
  | "VERY_ACTIVE";

export type BmiCategory =
  | "UNDERWEIGHT"
  | "NORMAL"
  | "OVERWEIGHT"
  | "OBESE";

/** 算法输入。全部为公制，英制在入口层已换算。 */
export interface AssessmentInput {
  gender: Gender;
  /** 岁 */
  age: number;
  /** 厘米 */
  heightCm: number;
  /** 公斤 */
  weightKg: number;
  /** 目标体重，公斤 */
  goalWeightKg: number;
  goal: FitnessGoal;
  activityLevel: ActivityLevel;
}

export interface MacroSplit {
  proteinG: number;
  carbsG: number;
  fatG: number;
}

/** 逐周体重预测的一个点 */
export interface ProjectionPoint {
  week: number;
  /** 该周末的预测体重，保留一位小数 */
  weightKg: number;
  /** ISO 日期，YYYY-MM-DD */
  date: string;
}

/**
 * 告警码。
 *
 * 刻意用「返回告警」而不是「抛错」来处理不健康但合法的目标：
 * 目标体重偏离健康区间是用户的选择，直接拒绝会打断漏斗；
 * 但产品也不该假装这个目标是健康的。所以照常出结果，同时标注风险。
 *
 * 真正非法的输入（负数、NaN、超出生理范围）由 zod 在入口层拦掉，
 * 根本进不到算法里。两者边界要分清。
 */
export type AssessmentWarningCode =
  | "GOAL_BMI_UNDERWEIGHT"
  | "GOAL_BMI_OBESE"
  | "AGGRESSIVE_GOAL"
  | "CALORIE_FLOOR_APPLIED"
  /**
   * 安全摄入下限与每周速率上限无法同时满足。
   *
   * 极低 TDEE 的增重场景会出现：把摄入抬到安全下限之后，
   * 实际热量盈余已经超过「每周不超过 0.5 公斤」所对应的量。
   * 取舍是下限优先 —— 吃低于安全下限是真实的健康风险，
   * 增得快一点不是 —— 但必须明说，不能闷声输出一个超速方案。
   */
  | "CALORIE_FLOOR_EXCEEDS_TARGET_RATE"
  | "GOAL_CONFLICTS_WITH_DIRECTION"
  | "CURRENT_BMI_EXTREME";

export interface AssessmentWarning {
  code: AssessmentWarningCode;
  message: string;
}

export interface AssessmentOutput {
  /** 保留两位小数 */
  bmi: number;
  bmiCategory: BmiCategory;
  /** 基础代谢率，千卡/天，取整 */
  bmr: number;
  /** 每日总消耗，千卡/天，取整 */
  tdee: number;
  /** 建议每日摄入，千卡/天，已施加安全下限 */
  recommendedCalories: number;
  macros: MacroSplit;
  /** 预计达成目标的日期，ISO YYYY-MM-DD。维持体重时为 null。 */
  targetDate: string | null;
  /** 达成目标所需周数，维持体重时为 0 */
  weeksToGoal: number;
  /** 实际生效的每周体重变化速率（公斤），已被安全上限与热量下限钳制 */
  effectiveWeeklyRateKg: number;
  /** 逐周预测曲线，受保护字段 */
  weeklyProjection: ProjectionPoint[];
  warnings: AssessmentWarning[];
  algorithmVersion: string;
}
