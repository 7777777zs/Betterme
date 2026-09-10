#!/usr/bin/env node
/**
 * 交互式填入 Supabase 数据库密码。
 *
 * 为什么要专门写个脚本，而不是让人手动改 .env：
 *
 * 1. 密码里的特殊字符必须做 URL 编码。Supabase 自动生成的密码常含
 *    @ # ? & / 这些字符，直接粘进连接串会把 URL 解析得面目全非 ——
 *    表现是「密码明明是对的却连不上」，是这套流程里最容易踩的坑。
 * 2. 输入不回显，也不会进入 shell 历史。
 * 3. 三处连接串一次填好，不会漏掉测试库那一处。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const ENV_PATH = ".env";
const PLACEHOLDER = "<DB_PASSWORD>";

if (!existsSync(ENV_PATH)) {
  console.error("找不到 .env，请先执行：cp .env.example .env");
  process.exit(1);
}

const original = readFileSync(ENV_PATH, "utf8");

if (!original.includes(PLACEHOLDER)) {
  console.log("✓ .env 里已经没有占位符了，无需处理。");
  process.exit(0);
}

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    // 逐字符重绘提示行，让输入不回显
    const onData = () => {
      process.stdout.clearLine?.(0);
      process.stdout.cursorTo?.(0);
      process.stdout.write(question);
    };

    process.stdin.on("data", onData);
    rl.question(question, (answer) => {
      process.stdin.removeListener("data", onData);
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

const password = (await promptHidden("Supabase 数据库密码（输入不回显）: ")).trim();

if (password.length === 0) {
  console.error("密码为空，未做任何修改。");
  process.exit(1);
}

// 只对连接串里的密码段做编码，不动 .env 的其他部分
const encoded = encodeURIComponent(password);

const updated = original
  .split("\n")
  .map((line) => {
    // 注释行里的占位符换成一句说明，避免看起来还没填
    if (line.trimStart().startsWith("#")) {
      return line.replace(PLACEHOLDER, "数据库密码");
    }
    return line.replaceAll(PLACEHOLDER, encoded);
  })
  .join("\n");

writeFileSync(ENV_PATH, updated, "utf8");

const remaining = (updated.match(/<DB_PASSWORD>/g) ?? []).length;
console.log(`✓ 已写入 .env，剩余占位符 ${remaining} 处。`);
if (encoded !== password) {
  console.log("  密码含特殊字符，已按 URL 编码写入连接串。");
}
console.log("  下一步：npm run db:deploy");
