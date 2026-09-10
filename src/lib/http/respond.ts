import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AppError, ERROR_CODES, type ErrorDetail, errors } from "./errors";
import { InvalidAssessmentInputError } from "@/lib/health/algorithm";

/**
 * 统一响应信封。
 *
 * 成功与失败用两种互斥的形状，而不是「总是返回 200 + success 布尔」：
 * HTTP 状态码本身就是契约的一部分，把它退化成永远 200 会让
 * 网关重试、监控告警、客户端拦截器全部失去判断依据。
 */

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: ErrorDetail[];
    meta?: Record<string, unknown>;
  };
}

export function ok<T>(data: T, init?: { status?: number; headers?: HeadersInit }) {
  return NextResponse.json(data, {
    status: init?.status ?? 200,
    headers: init?.headers,
  });
}

export function created<T>(data: T, headers?: HeadersInit) {
  return NextResponse.json(data, { status: 201, headers });
}

export function fail(error: AppError) {
  const body: ErrorBody = {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
      ...(error.meta ? { meta: error.meta } : {}),
    },
  };
  return NextResponse.json(body, { status: error.status });
}

/** 把 ZodError 展平成接口契约里的 details 数组 */
export function zodToDetails(error: ZodError): ErrorDetail[] {
  return error.issues.map((issue) => ({
    path: issue.path.join(".") || "(root)",
    message: issue.message,
  }));
}

/**
 * 路由包装器：统一异常处理。
 *
 * 每个 route handler 都套一层，好处是各处理函数里可以直接 throw 领域错误，
 * 不必层层 return 错误响应，业务主干读起来是一条直线。
 *
 * 非 AppError 的异常一律脱敏成 500：内部错误信息可能包含
 * 连接串、SQL 片段、文件路径，绝不能原样吐给客户端。
 */
export function withRoute<Args extends unknown[]>(
  handler: (...args: Args) => Promise<NextResponse>,
) {
  return async (...args: Args): Promise<NextResponse> => {
    try {
      return await handler(...args);
    } catch (error) {
      if (error instanceof AppError) {
        return fail(error);
      }

      if (error instanceof ZodError) {
        return fail(errors.validation(zodToDetails(error)));
      }

      // 算法层的输入错误说明校验层漏了一种情况。
      // 对外按 422 返回，同时在服务端日志里留痕以便补校验规则。
      if (error instanceof InvalidAssessmentInputError) {
        console.error("[algorithm] 输入越过了校验层：", error.message);
        return fail(
          new AppError(ERROR_CODES.VALIDATION_FAILED, 422, error.message, [
            { path: error.field, message: error.reason },
          ]),
        );
      }

      console.error("[unhandled]", error);
      return fail(errors.internal());
    }
  };
}

/**
 * 安全地解析 JSON 请求体。
 * 空体和畸形 JSON 都归为 400，而不是让 await request.json() 抛出裸异常。
 */
export async function parseJsonBody(request: Request): Promise<unknown> {
  const raw = await request.text();
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw errors.malformedJson();
  }
}
