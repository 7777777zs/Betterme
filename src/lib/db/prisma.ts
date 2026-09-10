import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

/**
 * PrismaClient 单例。
 *
 * 两个必须解决的问题：
 *
 * 1. 开发模式下 Next.js 的热更新会反复重新求值模块，每次都 new 一个 PrismaClient
 *    就会把数据库连接数吃干净。挂到 globalThis 上复用是官方推荐解法。
 *
 * 2. Serverless（Vercel）下每个函数实例各自持有连接，实例数一多就会打爆 Postgres
 *    的 max_connections。所以运行时连接串走 Supabase 的 transaction pooler（6543）
 *    并带 pgbouncer=true&connection_limit=1，见 .env.example 里的说明。
 */

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

function createPrismaClient(connectionString?: string): PrismaClient {
  const url = connectionString ?? process.env.DATABASE_URL;

  if (!url) {
    throw new Error("DATABASE_URL 未配置，无法建立数据库连接");
  }

  const adapter = new PrismaPg({ connectionString: url });

  return new PrismaClient({
    adapter,
    log:
      process.env.NODE_ENV === "development"
        ? ["warn", "error"]
        : ["error"],
  });
}

export const prisma: PrismaClient =
  globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

/**
 * 供集成测试使用：连到独立的 test schema，与开发数据隔离。
 * 每个测试文件自己持有一个，用完显式 $disconnect。
 */
export function createTestPrismaClient(): PrismaClient {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL 未配置。集成测试需要独立的数据库 schema，" +
        "以免污染开发数据。请参考 .env.example。",
    );
  }
  return createPrismaClient(url);
}
