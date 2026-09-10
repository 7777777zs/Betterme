import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

/**
 * 集成测试的数据库环境。
 *
 * 跑在同一个 Supabase 实例的独立 `test` schema 里，而不是开发用的 public：
 * 测试要能随时 TRUNCATE 全表，跑在 public 上会把开发数据清空。
 *
 * 建表的方式是直接执行仓库里的迁移 SQL，而不是 `prisma db push`。
 * 好处是每次跑集成测试都顺带验证了「迁移脚本本身是能用的」——
 * 迁移写错但 schema 文件是对的，这种问题只有真正执行迁移才会暴露。
 */

export const TEST_SCHEMA = "test";

/** 迁移用的直连串。测试建表是 DDL，不能走 pgbouncer 事务池。 */
export function directUrl(): string {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DIRECT_URL;
  if (!url) {
    throw new Error("集成测试需要 TEST_DATABASE_URL 或 DIRECT_URL，请参考 .env.example");
  }
  // 去掉 schema 查询参数，search_path 由下面显式设置
  return url.replace(/([?&])schema=[^&]*/g, "$1").replace(/[?&]$/, "");
}

/** 环境是否具备跑集成测试的条件 */
export function hasTestDatabase(): boolean {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DIRECT_URL;
  return Boolean(url) && !url!.includes("<DB_PASSWORD>");
}

function migrationSqlFiles(): string[] {
  const root = join(process.cwd(), "prisma", "migrations");
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => join(root, name, "migration.sql"));
}

/**
 * 重建 test schema 并应用全部迁移。整个测试套件跑一次。
 */
export async function bootstrapTestSchema(): Promise<void> {
  const client = new Client({ connectionString: directUrl() });
  await client.connect();

  try {
    await client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
    await client.query(`CREATE SCHEMA "${TEST_SCHEMA}"`);
    await client.query(`SET search_path TO "${TEST_SCHEMA}"`);

    for (const file of migrationSqlFiles()) {
      const sql = readFileSync(file, "utf8")
        // 迁移脚本开头会 CREATE SCHEMA public，在测试 schema 里执行它没有意义，
        // 且会让后续无限定名的建表落到 public 去
        .replace(/CREATE SCHEMA IF NOT EXISTS "public";?/g, "");
      await client.query(sql);
    }
  } finally {
    await client.end();
  }
}

/** 表清空顺序无关紧要，TRUNCATE ... CASCADE 会自行处理外键 */
const TABLES = [
  "payment_events",
  "subscriptions",
  "assessment_results",
  "quiz_answer_events",
  "quiz_answers",
  "quiz_sessions",
  "users",
] as const;

/**
 * 清空所有表。每个测试用例前调用。
 *
 * 用 TRUNCATE 而不是 DELETE：前者不扫表、不写 WAL 逐行日志，
 * 在几百个用例的量级上差别很明显。RESTART IDENTITY 顺带重置自增序列，
 * 让依赖 id 的断言在每个用例里都从同一起点开始。
 */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  const list = TABLES.map((t) => `"${TEST_SCHEMA}"."${t}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

/** 连到 test schema 的 Prisma 客户端 */
export function createTestClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: directUrl() }, { schema: TEST_SCHEMA });
  return new PrismaClient({ adapter, log: ["error"] });
}
