#!/usr/bin/env node
/**
 * 打印一条可直接粘贴执行的 /api/v1/pay cURL 命令，签名已算好。
 *
 * 为什么需要这个脚本：回调签名覆盖的是请求体的**原始字节**，
 * 手工拼 cURL 时任何一个空格或键顺序的差异都会让签名对不上。
 * 与其让人对着文档小心翼翼地拼，不如让机器生成。
 *
 * 用法：
 *   node scripts/pay-curl.mjs <sessionId> [plan] [baseUrl]
 *   npm run pay:curl -- 22222222-2222-4222-8222-222222222222 monthly https://xxx.vercel.app
 */
import "dotenv/config";
import { createHmac, randomUUID } from "node:crypto";

const [sessionId, plan = "monthly", baseUrl = "http://localhost:3000"] =
  process.argv.slice(2);

if (!sessionId) {
  console.error("用法: node scripts/pay-curl.mjs <sessionId> [plan] [baseUrl]");
  console.error("plan 可选: weekly | monthly | quarterly");
  process.exit(1);
}

const secret = process.env.PAY_WEBHOOK_SECRET;
if (!secret) {
  console.error("PAY_WEBHOOK_SECRET 未配置，无法生成签名。");
  process.exit(1);
}

// 幂等键每次不同，方便重复演示；想验证幂等就把同一条命令跑两次
const payload = {
  sessionId,
  plan,
  idempotencyKey: `evt_${randomUUID()}`,
};

const raw = JSON.stringify(payload);
const signature = createHmac("sha256", secret).update(raw, "utf8").digest("hex");

console.log(`curl -X POST '${baseUrl}/api/v1/pay' \\
  -H 'Content-Type: application/json' \\
  -H 'X-Signature: ${signature}' \\
  -d '${raw}'`);
console.log("");
console.log("提示：把同一条命令再执行一次，响应里的 applied 会变成 false，");
console.log("      订阅周期不会被延长 —— 这就是回调幂等生效的样子。");
