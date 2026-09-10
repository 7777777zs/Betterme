"use client";

import type { StepKey } from "@/lib/quiz/steps";

/**
 * 前端 API 客户端。
 *
 * 两件事值得说明：
 *
 * 1. sessionId 与 token 存在 localStorage。用户关掉标签页再回来，
 *    前端凭这两个值调进度恢复接口，把表单还原到离开时的样子。
 *    这就是「进度恢复」在产品侧的落点。
 *
 * 2. 每次写入都带上服务端回传的版本号做 If-Match。
 *    同一个用户在两个标签页里填同一份问卷是真实会发生的，
 *    带上版本号后，落后的那个标签页会拿到 409 而不是静默覆盖。
 */

const STORAGE_KEY = "betterme.session";

export interface StoredSession {
  sessionId: string;
  token: string;
}

export function loadSession(): StoredSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (!parsed.sessionId || !parsed.token) return null;
    return { sessionId: parsed.sessionId, token: parsed.token };
  } catch {
    // 隐私模式、被清空的站点数据、损坏的 JSON 都走这里。
    // 读不到就当新用户，不该因为存储不可用而让整个漏斗打不开。
    return null;
  }
}

export function saveSession(session: StoredSession): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // 存不下就算了，用户这一程仍然能走完，只是刷新后要重来
  }
}

export function clearSession(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* 同上 */
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Array<{ path: string; message: string }>,
    readonly meta?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<{ data: T; headers: Headers }> {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(path, { ...init, headers });
  const text = await response.text();
  const body: unknown = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const err = body as {
      error?: { code?: string; message?: string; details?: never; meta?: never };
    } | null;
    throw new ApiError(
      response.status,
      err?.error?.code ?? "UNKNOWN",
      err?.error?.message ?? "请求失败",
      err?.error?.details,
      err?.error?.meta,
    );
  }

  return { data: body as T, headers: response.headers };
}

export interface StepDefinitionDto {
  key: StepKey;
  order: number;
  required: boolean;
  title: string;
}

export interface CreateSessionResponse {
  sessionId: string;
  token: string;
  version: number;
  currentStep: StepKey | null;
  expiresAt: string;
  steps: StepDefinitionDto[];
}

export interface SessionStateResponse {
  sessionId: string;
  status: "IN_PROGRESS" | "COMPLETED" | "ABANDONED";
  version: number;
  currentStep: StepKey | null;
  progressPercent: number;
  answeredSteps: StepKey[];
  missingRequiredSteps: StepKey[];
  answers: Record<string, unknown>;
  hasResult: boolean;
}

export interface SaveAnswerResponse {
  stepKey: StepKey;
  revision: number;
  version: number;
  currentStep: StepKey | null;
  progressPercent: number;
  answeredSteps: StepKey[];
}

export interface ProjectionPointDto {
  week: number;
  weightKg: number;
  date: string;
}

export interface ResultResponse {
  sessionId: string;
  access: "FREE" | "PREMIUM";
  bmi: number;
  bmiCategory: "UNDERWEIGHT" | "NORMAL" | "OVERWEIGHT" | "OBESE";
  bmr: number;
  tdee: number;
  recommendedCalories: number;
  macros: { proteinG: number; carbsG: number; fatG: number };
  warnings: Array<{ code: string; message: string }>;
  algorithmVersion: string;
  computedAt: string;
  /* 以下字段仅在 access 为 PREMIUM 时存在 */
  targetDate?: string | null;
  weeksToGoal?: number;
  effectiveWeeklyRateKg?: number;
  weeklyProjection?: ProjectionPointDto[];
  /* 以下字段仅在 access 为 FREE 时存在 */
  locked?: string[];
  paywall?: { title: string; description: string };
}

export const api = {
  async createSession(): Promise<CreateSessionResponse> {
    const { data } = await request<CreateSessionResponse>("/api/v1/sessions", {
      method: "POST",
    });
    return data;
  },

  async getSession(session: StoredSession): Promise<SessionStateResponse> {
    const { data } = await request<SessionStateResponse>(
      `/api/v1/sessions/${session.sessionId}`,
      { token: session.token },
    );
    return data;
  },

  async saveAnswer(
    session: StoredSession,
    stepKey: StepKey,
    value: unknown,
    expectedVersion?: number,
  ): Promise<SaveAnswerResponse> {
    const headers: Record<string, string> = {};
    if (expectedVersion !== undefined) headers["If-Match"] = String(expectedVersion);

    const { data } = await request<SaveAnswerResponse>(
      `/api/v1/sessions/${session.sessionId}/answers/${stepKey}`,
      { method: "PATCH", token: session.token, headers, body: JSON.stringify(value) },
    );
    return data;
  },

  async submit(session: StoredSession): Promise<{ resultId: string }> {
    const { data } = await request<{ resultId: string }>(
      `/api/v1/sessions/${session.sessionId}/submit`,
      { method: "POST", token: session.token },
    );
    return data;
  },

  async getResult(session: StoredSession): Promise<ResultResponse> {
    const { data } = await request<ResultResponse>(
      `/api/v1/sessions/${session.sessionId}/result`,
      { token: session.token, cache: "no-store" },
    );
    return data;
  },

  /**
   * 演示用的「购买」。
   *
   * 真实产品里这里会跳转到支付网关，由网关在服务端回调 /api/v1/pay。
   * 本项目没有真实网关，所以由服务端的 checkout 接口代为签名并回调自己 ——
   * 但签名逻辑与校验路径和真实回调完全一致，没有为了演示开后门。
   */
  async checkout(session: StoredSession, plan: string): Promise<{ ok: boolean }> {
    const { data } = await request<{ ok: boolean }>("/api/v1/checkout", {
      method: "POST",
      token: session.token,
      body: JSON.stringify({ sessionId: session.sessionId, plan }),
    });
    return data;
  },
};
