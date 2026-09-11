/**
 * Next 的服务端启动钩子。`register()` 在每个新的服务实例就绪前执行一次。
 *
 * 这里只做一件事：校验环境变量。
 *
 * 在此之前 `src/lib/env.ts` 是一段没有任何调用方的死代码 —— 文件里写着
 * 「让它尽早、响亮地失败」，实际上它从来没被执行过。读代码的人会以为
 * 启动时做了配置校验，于是不会再去确认；而真实行为是，少配一个
 * PAY_WEBHOOK_SECRET 要等到第一个支付回调打进来才暴露成一个 500。
 *
 * 一段声称会做某事却从不执行的代码，比没有这段代码更有害：
 * 它提供的是虚假的保证。要么删掉，要么接上去。这里选择接上去。
 */
export async function register(): Promise<void> {
  // Edge 运行时拿不到完整的 process.env，也不跑数据库相关的逻辑，跳过
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { getEnv } = await import("@/lib/env");

  try {
    getEnv();
  } catch (error) {
    // 直接抛出去，让服务起不来。
    // 配置错误的实例不该接受流量 —— 它只会把每个请求变成 500，
    // 而部署流程会以为一切正常。
    console.error("[启动校验] 环境变量配置不合法，拒绝启动：");
    console.error(error instanceof Error ? error.message : error);
    throw error;
  }

  console.info("[启动校验] 环境变量检查通过");
}
