import { prisma } from "@/lib/db/prisma";
import { errors } from "@/lib/http/errors";
import { ok, withRoute, zodToDetails } from "@/lib/http/respond";
import { payPayloadSchema, processPayment, verifySignature } from "@/lib/subscription/pay";
import { ZodError } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/pay
 *
 * 模拟支付网关回调。
 *
 * 注意读取顺序：先拿原始文本算签名，再 JSON.parse。
 * 反过来做（先 parse 再 stringify 回去算签名）会因为键顺序、
 * 空白、数字格式的差异导致签名永远对不上。
 *
 * 这个接口不需要 Bearer token —— 它模拟的是网关到服务端的机器调用，
 * 身份由 HMAC 签名证明，而不是由用户凭证证明。
 */
export const POST = withRoute(async (request: Request) => {
  const secret = process.env.PAY_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[pay] PAY_WEBHOOK_SECRET 未配置，拒绝处理回调");
    throw errors.internal("支付回调未正确配置");
  }

  const rawBody = await request.text();
  verifySignature(rawBody, request.headers.get("x-signature"), secret);

  let parsedJson: unknown;
  try {
    parsedJson = rawBody.trim() === "" ? {} : JSON.parse(rawBody);
  } catch {
    throw errors.malformedJson();
  }

  let payload;
  try {
    payload = payPayloadSchema.parse(parsedJson);
  } catch (error) {
    if (error instanceof ZodError) throw errors.validation(zodToDetails(error));
    throw error;
  }

  const result = await processPayment(prisma, payload, parsedJson);

  return ok(result);
});
