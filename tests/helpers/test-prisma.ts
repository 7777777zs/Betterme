import type { PrismaClient } from "@/generated/prisma/client";
import { createTestClient } from "./db";

/**
 * 集成测试共用的 Prisma 客户端，连到 test schema。
 *
 * 懒初始化：模块被加载的时机早于环境变量检查，
 * 在顶层直接建连接会让「没配数据库」变成一个模块加载错误，
 * 连带把本可以正常跳过的用例一起拖垮。
 */
let client: PrismaClient | null = null;

export function testPrisma(): PrismaClient {
  client ??= createTestClient();
  return client;
}

export async function disconnectTestPrisma(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = null;
  }
}

/**
 * 供 vi.mock 使用的模块替身。
 * 让 route handler 里 import 的 prisma 指向 test schema 的客户端。
 */
export const prismaModuleMock = {
  get prisma() {
    return testPrisma();
  },
  createTestPrismaClient: testPrisma,
};
