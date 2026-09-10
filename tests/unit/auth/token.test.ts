import { describe, expect, it } from "vitest";
import {
  extractBearerToken,
  generateToken,
  hashToken,
  safeCompareHex,
} from "@/lib/auth/token";

describe("匿名访问凭证", () => {
  it("每次生成的 token 都不同", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateToken()));
    expect(tokens.size).toBe(200);
  });

  it("token 是 URL 安全的，可直接放进头部与查询串", () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generateToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("摘要是定长 64 位十六进制，与 schema 的 Char(64) 对齐", () => {
    expect(hashToken(generateToken())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("同样的 token 得到同样的摘要", () => {
    const token = generateToken();
    expect(hashToken(token)).toBe(hashToken(token));
  });

  it("不同 token 得到不同摘要", () => {
    expect(hashToken("a")).not.toBe(hashToken("b"));
  });

  it("摘要不可反推出明文", () => {
    const token = generateToken();
    expect(hashToken(token)).not.toContain(token);
  });
});

describe("常量时间比较", () => {
  it("相同摘要返回 true", () => {
    const h = hashToken("x");
    expect(safeCompareHex(h, h)).toBe(true);
  });

  it("不同摘要返回 false", () => {
    expect(safeCompareHex(hashToken("x"), hashToken("y"))).toBe(false);
  });

  it("长度不同直接返回 false，不抛异常", () => {
    expect(safeCompareHex("abcd", hashToken("x"))).toBe(false);
  });

  it("非十六进制输入返回 false 而不是崩溃", () => {
    expect(safeCompareHex("zz", "zz")).toBe(false);
  });

  it("空字符串不会被判为相等通过", () => {
    expect(safeCompareHex("", hashToken("x"))).toBe(false);
  });
});

describe("Authorization 头解析", () => {
  it("解析标准 Bearer 格式", () => {
    expect(extractBearerToken("Bearer abc123")).toBe("abc123");
  });

  it("方案名大小写不敏感", () => {
    expect(extractBearerToken("bearer abc")).toBe("abc");
    expect(extractBearerToken("BEARER abc")).toBe("abc");
  });

  it("容忍首尾空白与多个空格", () => {
    expect(extractBearerToken("  Bearer   abc  ")).toBe("abc");
  });

  it.each([
    ["null", null],
    ["空串", ""],
    ["只有方案名", "Bearer"],
    ["方案名后无值", "Bearer   "],
    ["Basic 认证", "Basic dXNlcjpwYXNz"],
    ["裸 token", "abc123"],
  ])("拒绝：%s", (_label, header) => {
    expect(extractBearerToken(header)).toBeNull();
  });
});
