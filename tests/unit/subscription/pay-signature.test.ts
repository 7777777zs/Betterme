import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/http/errors";
import { payPayloadSchema, signPayload, verifySignature } from "@/lib/subscription/pay";

const SECRET = "test-secret-key";

const body = JSON.stringify({
  sessionId: "22222222-2222-4222-8222-222222222222",
  plan: "monthly",
  idempotencyKey: "evt_test_00000001",
});

describe("回调签名", () => {
  it("对同样的原始文本产出同样的签名", () => {
    expect(signPayload(body, SECRET)).toBe(signPayload(body, SECRET));
  });

  it("签名是 64 位十六进制", () => {
    expect(signPayload(body, SECRET)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("密钥不同签名不同", () => {
    expect(signPayload(body, SECRET)).not.toBe(signPayload(body, "other-secret"));
  });

  it("正确签名通过校验", () => {
    expect(() => verifySignature(body, signPayload(body, SECRET), SECRET)).not.toThrow();
  });

  it("大写签名同样通过，不因大小写误判", () => {
    const sig = signPayload(body, SECRET).toUpperCase();
    expect(() => verifySignature(body, sig, SECRET)).not.toThrow();
  });

  it("缺少签名头时拒绝", () => {
    expect(() => verifySignature(body, null, SECRET)).toThrow(AppError);
  });

  it("签名错误时拒绝", () => {
    expect(() => verifySignature(body, "0".repeat(64), SECRET)).toThrow(/签名/);
  });

  it("报文被篡改一个字节，签名立刻失效", () => {
    const sig = signPayload(body, SECRET);
    const tampered = body.replace("monthly", "quarterly");
    expect(() => verifySignature(tampered, sig, SECRET)).toThrow(AppError);
  });

  it("键顺序改变会导致签名不匹配，这正是必须对原始字节签名的原因", () => {
    const reordered = JSON.stringify({
      plan: "monthly",
      sessionId: "22222222-2222-4222-8222-222222222222",
      idempotencyKey: "evt_test_00000001",
    });
    expect(signPayload(reordered, SECRET)).not.toBe(signPayload(body, SECRET));
  });
});

describe("回调载荷校验", () => {
  const valid = {
    sessionId: "22222222-2222-4222-8222-222222222222",
    plan: "monthly",
    idempotencyKey: "evt_test_00000001",
  };

  it("接受最小合法载荷并填充默认值", () => {
    const parsed = payPayloadSchema.parse(valid);
    expect(parsed.eventType).toBe("CHECKOUT_COMPLETED");
    expect(parsed.currency).toBe("USD");
  });

  it("拒绝非 UUID 的 sessionId", () => {
    expect(payPayloadSchema.safeParse({ ...valid, sessionId: "not-a-uuid" }).success).toBe(
      false,
    );
  });

  it("拒绝未知套餐", () => {
    expect(payPayloadSchema.safeParse({ ...valid, plan: "lifetime" }).success).toBe(false);
  });

  it("拒绝过短的幂等键，避免碰撞", () => {
    expect(payPayloadSchema.safeParse({ ...valid, idempotencyKey: "abc" }).success).toBe(
      false,
    );
  });

  it.each([
    ["负数金额", -100],
    ["零金额", 0],
    ["小数金额", 29.99],
    ["超大金额", 99_999_999],
  ])("拒绝 %s", (_label, amountCents) => {
    expect(payPayloadSchema.safeParse({ ...valid, amountCents }).success).toBe(false);
  });

  it("拒绝多余字段，防止伪造订阅状态", () => {
    expect(
      payPayloadSchema.safeParse({ ...valid, subscriptionStatus: "ACTIVE" }).success,
    ).toBe(false);
  });

  it("拒绝非三位的货币代码", () => {
    expect(payPayloadSchema.safeParse({ ...valid, currency: "DOLLAR" }).success).toBe(false);
  });
});
