import { prisma } from "@/lib/db/prisma";
import { ok, withRoute } from "@/lib/http/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 健康检查。部署平台与监控用。
 * 真的去 ping 一次数据库，而不是无脑返回 200 ——
 * 「进程活着但连不上库」是最常见的线上故障形态。
 */
export const GET = withRoute(async () => {
  const startedAt = Date.now();
  await prisma.$queryRaw`SELECT 1`;
  return ok({
    status: "ok",
    database: "reachable",
    latencyMs: Date.now() - startedAt,
    timestamp: new Date().toISOString(),
  });
});
