import type { ActivityLevel, Gender } from "./types";

/**
 * 算法版本号。任何会改变输出数值的修改都必须递增它。
 *
 * 存进 assessment_results 后，历史结果能被追溯到具体算法版本：
 * 算法迭代之后，老用户的结果不会被误判成 bug，也支持按版本做 A/B 对比。
 */
export const ALGORITHM_VERSION = "1.1.0";

/**
 * 每公斤脂肪组织约含 7700 千卡。
 * 这是营养学界的通用近似值（Wishnofsky 系数），
 * 真实代谢会随体重下降而适应，这里不做动态修正，属于已知简化。
 */
export const KCAL_PER_KG_FAT = 7700;

/**
 * TDEE 活动系数。取自 Harris-Benedict / Mifflin 体系的通用档位。
 */
export const ACTIVITY_FACTORS: Record<ActivityLevel, number> = {
  SEDENTARY: 1.2,
  LIGHT: 1.375,
  MODERATE: 1.55,
  VERY_ACTIVE: 1.725,
};

/**
 * Mifflin-St Jeor 公式的性别常数项。
 *
 * 选 Mifflin-St Jeor 而不是更老的 Harris-Benedict：
 * 前者在现代人群上的实测误差更小，是目前营养学界的默认推荐。
 *
 * OTHER 取男女常数的中点。这不是医学结论，只是在缺少更细分依据时
 * 一个不偏向任何一侧的工程折中，README 里会明确标注这一点。
 */
export const BMR_GENDER_CONSTANT: Record<Gender, number> = {
  MALE: 5,
  FEMALE: -161,
  OTHER: -78,
};

/**
 * 每日摄入的安全下限，千卡。
 *
 * 低于此值的极端节食有明确健康风险，算法宁可拉长达成周期也不给出这种建议。
 * 触发钳制时会返回 CALORIE_FLOOR_APPLIED 告警，并据此重算目标日期，
 * 而不是嘴上说着 1200 千卡、日期却还按未钳制的缺口算。
 */
export const CALORIE_FLOOR: Record<Gender, number> = {
  MALE: 1500,
  FEMALE: 1200,
  OTHER: 1200,
};

/** 每周减重不超过当前体重的 1%，且绝对值不超过 1.0 公斤 */
export const MAX_WEEKLY_LOSS_RATIO = 0.01;
export const MAX_WEEKLY_LOSS_KG = 1.0;

/** 增肌速率上限更低：超过这个速度增加的主要是脂肪而非肌肉 */
export const MAX_WEEKLY_GAIN_KG = 0.5;

/** 健康 BMI 区间，WHO 标准 */
export const BMI_UNDERWEIGHT_MAX = 18.5;
export const BMI_NORMAL_MAX = 25;
export const BMI_OVERWEIGHT_MAX = 30;

/** 逐周预测曲线最多输出的周数，避免极端目标产出上千个点 */
export const MAX_PROJECTION_WEEKS = 104;

/** 蛋白质摄入，克/公斤目标体重 */
export const PROTEIN_G_PER_KG = {
  LOSE_WEIGHT: 1.8,
  MAINTAIN_WEIGHT: 1.6,
  GAIN_MUSCLE: 2.0,
} as const;

/** 脂肪占总热量的比例 */
export const FAT_CALORIE_RATIO = 0.25;

export const KCAL_PER_G_PROTEIN = 4;
export const KCAL_PER_G_CARB = 4;
export const KCAL_PER_G_FAT = 9;

/**
 * 生理合法区间。zod 校验层与算法共用同一组常量，
 * 避免「校验放过了但算法算不了」的裂缝。
 */
export const LIMITS = {
  age: { min: 13, max: 100 },
  heightCm: { min: 90, max: 250 },
  weightKg: { min: 30, max: 300 },
  goalWeightKg: { min: 30, max: 300 },
} as const;

/** 目标体重相对当前体重的最大偏离比例，超出视为非法输入 */
export const MAX_GOAL_DEVIATION_RATIO = 0.5;
