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

  // 先解析 JSON 再判断状态码，是个隐蔽但代价很高的顺序错误。
  //
  // 我们的应用层错误一定是 JSON，但请求未必能走到应用层：CDN 的 412、
  // 网关的 502、边缘节点的限流页面，返回的都是 HTML 或纯文本。
  // 一旦先 JSON.parse，这些响应会在解析阶段抛出一个语法错误，
  // 于是所有中间层故障都被压平成一句「网络似乎不太稳定」，
  // 状态码和真正的错误内容全部丢失 —— 排查时几乎没有线索。
  //
  // 所以：先看状态码，再尝试解析，解析失败也要把状态码和原文带出去。
  let parsed: unknown = null;
  let parseFailed = false;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parseFailed = true;
    }
  }

  if (!response.ok) {
    if (parseFailed) {
      throw new ApiError(
        response.status,
        "NON_JSON_RESPONSE",
        `服务返回了非预期的响应（HTTP ${response.status}）。这通常来自 CDN 或网关，而不是应用本身。`,
        [{ path: "body", message: text.slice(0, 200) }],
      );
    }

    const err = parsed as {
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

  if (parseFailed) {
    throw new ApiError(
      response.status,
      "NON_JSON_RESPONSE",
      "服务返回了无法解析的响应",
      [{ path: "body", message: text.slice(0, 200) }],
    );
  }

  return { data: parsed as T, headers: response.headers };
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
    // 自定义头而不是标准的 If-Match：CDN 会接管标准条件请求头，
    // 在请求到达应用之前就返回 412。详见 route handler 里的注释。
    if (expectedVersion !== undefined) {
      headers["X-Session-Version"] = String(expectedVersion);
    }

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
