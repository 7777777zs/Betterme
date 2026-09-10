import { signPayload } from "@/lib/subscription/pay";

/**
 * 直接调用 route handler 的辅助工具。
 *
 * 集成测试不起 HTTP 服务器，而是构造标准 Request 交给 route handler。
 * 这样既覆盖了 HTTP 层（头部解析、状态码、错误信封），
 * 又不必承担端口占用、启动等待、并行冲突这些真起服务器才有的麻烦。
 *
 * 端到端的真实浏览器流程由 Playwright 覆盖，两者分工不重叠。
 */

const BASE = "http://localhost:3000";

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
}

async function toApiResponse<T>(response: Response): Promise<ApiResponse<T>> {
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : null) as T,
    headers: response.headers,
  };
}

export function buildRequest(
  method: string,
  path: string,
  options: { body?: unknown; token?: string; headers?: Record<string, string> } = {},
): Request {
  const headers = new Headers(options.headers);
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);

  let body: string | undefined;
  if (options.body !== undefined) {
    body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  }

  return new Request(`${BASE}${path}`, { method, headers, body });
}

export async function call<T = unknown>(
  handler: (request: Request, ctx: never) => Promise<Response>,
  request: Request,
  params?: Record<string, string>,
): Promise<ApiResponse<T>> {
  const ctx = { params: Promise.resolve(params ?? {}) } as never;
  const response = await handler(request, ctx);
  return toApiResponse<T>(response);
}

/**
 * 构造一个带合法签名的支付回调请求。
 *
 * 注意先把载荷序列化成固定的文本再签名，然后把**同一份文本**作为请求体，
 * 而不是让 fetch 重新序列化对象。签名覆盖的是字节，不是对象。
 */
export function buildSignedPayRequest(
  payload: Record<string, unknown>,
  secret = process.env.PAY_WEBHOOK_SECRET ?? "dev-only-change-me",
  overrideSignature?: string,
): Request {
  const raw = JSON.stringify(payload);
  return buildRequest("POST", "/api/v1/pay", {
    body: raw,
    headers: { "x-signature": overrideSignature ?? signPayload(raw, secret) },
  });
}

/** 错误响应的形状，测试里反复用到 */
export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: Array<{ path: string; message: string }>;
    meta?: Record<string, unknown>;
  };
}
