/**
 * 应用级错误体系。
 *
 * 设计要点：错误码是接口契约的一部分，客户端按 code 分支，不按 message 分支。
 * message 面向人类，可以随时改写和本地化；code 一旦发布就不能随意变更。
 */

export const ERROR_CODES = {
  /** 请求体或参数未通过 zod 校验 */
  VALIDATION_FAILED: "VALIDATION_FAILED",
  /** 缺少或格式错误的 Authorization 头 */
  UNAUTHORIZED: "UNAUTHORIZED",
  /** 会话不存在，或存在但不属于当前 token 的持有者 */
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  /** 会话已过期，不再接受写入 */
  SESSION_EXPIRED: "SESSION_EXPIRED",
  /** 会话已完成，不允许再修改作答 */
  SESSION_ALREADY_COMPLETED: "SESSION_ALREADY_COMPLETED",
  /** 会话已被用户主动作废，不再接受任何写入 */
  SESSION_ABANDONED: "SESSION_ABANDONED",
  /** 乐观锁版本不匹配，存在并发写入 */
  VERSION_CONFLICT: "VERSION_CONFLICT",
  /** 未知的测评步骤标识 */
  UNKNOWN_STEP: "UNKNOWN_STEP",
  /** 提交时仍有必填步骤缺失 */
  INCOMPLETE_SUBMISSION: "INCOMPLETE_SUBMISSION",
  /** 结果尚未生成，需要先调用 submit */
  RESULT_NOT_READY: "RESULT_NOT_READY",
  /** 支付回调签名校验失败 */
  INVALID_SIGNATURE: "INVALID_SIGNATURE",
  /** 请求体不是合法 JSON */
  MALFORMED_JSON: "MALFORMED_JSON",
  /** 兜底 */
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface ErrorDetail {
  path: string;
  message: string;
}

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: number,
    message: string,
    readonly details?: ErrorDetail[],
    /** 附加给客户端的上下文，例如版本冲突时的当前版本号 */
    readonly meta?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const errors = {
  validation: (details: ErrorDetail[]) =>
    new AppError(ERROR_CODES.VALIDATION_FAILED, 422, "请求参数校验未通过", details),

  malformedJson: () =>
    new AppError(ERROR_CODES.MALFORMED_JSON, 400, "请求体不是合法的 JSON"),

  unauthorized: (message = "缺少或无效的访问凭证") =>
    new AppError(ERROR_CODES.UNAUTHORIZED, 401, message),

  /**
   * 会话不存在与无权访问统一返回 404。
   *
   * 如果无权访问返回 403，攻击者就能通过枚举 sessionId 区分
   * 「这个 id 不存在」和「这个 id 存在但不是你的」，从而探测出有效 id 空间。
   * 对外表现成同一种结果，不泄漏资源是否存在。
   */
  sessionNotFound: () =>
    new AppError(ERROR_CODES.SESSION_NOT_FOUND, 404, "会话不存在或无权访问"),

  sessionExpired: () =>
    new AppError(ERROR_CODES.SESSION_EXPIRED, 410, "会话已过期，请重新开始测评"),

  sessionAlreadyCompleted: () =>
    new AppError(
      ERROR_CODES.SESSION_ALREADY_COMPLETED,
      409,
      "该测评已完成，如需修改请重新开始",
    ),

  /**
   * 作废的会话不接受写入。
   *
   * 与版本冲突分开报是有意的：版本冲突的正确应对是「拿最新版本重试」，
   * 作废的正确应对是「开一个新会话」。混成同一个码，客户端会拿着
   * 当前版本号去无意义地重试，而那个会话永远不会再接受写入。
   */
  sessionAbandoned: () =>
    new AppError(
      ERROR_CODES.SESSION_ABANDONED,
      409,
      "该测评已被放弃，请开始一次新的测评",
    ),

  versionConflict: (currentVersion: number) =>
    new AppError(
      ERROR_CODES.VERSION_CONFLICT,
      409,
      "会话已被其他请求修改，请基于最新版本重试",
      undefined,
      { currentVersion },
    ),

  unknownStep: (stepKey: string, knownSteps: readonly string[]) =>
    new AppError(ERROR_CODES.UNKNOWN_STEP, 404, `未知的测评步骤：${stepKey}`, undefined, {
      knownSteps,
    }),

  incompleteSubmission: (missingSteps: string[]) =>
    new AppError(
      ERROR_CODES.INCOMPLETE_SUBMISSION,
      422,
      "仍有必填步骤未完成，无法提交",
      missingSteps.map((step) => ({ path: step, message: "该步骤尚未作答" })),
      { missingSteps },
    ),

  resultNotReady: () =>
    new AppError(ERROR_CODES.RESULT_NOT_READY, 409, "评估结果尚未生成，请先提交测评"),

  invalidSignature: () =>
    new AppError(ERROR_CODES.INVALID_SIGNATURE, 401, "支付回调签名校验失败"),

  internal: (message = "服务器内部错误") =>
    new AppError(ERROR_CODES.INTERNAL_ERROR, 500, message),
};
