"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, api, clearSession, loadSession } from "@/lib/client/api-client";
import { stepProgressPercent, stepIndexOf, resumeStepFor } from "@/lib/quiz/steps";

/**
 * 落地页的行动区。
 *
 * 做成客户端岛而不是把整个落地页改成客户端组件，是为了留住页面的
 * metadata 导出与静态预渲染 —— 落地页是漏斗入口，它的首屏速度直接影响转化。
 *
 * 这里是「进度恢复」在产品侧最重要的一个落点。后端的恢复接口早就有了，
 * 但如果入口不说话，用户点进去发现自己站在第四步，体感是
 * 「这网页记住了我，还不让我重来」。明确告诉他有一份未完成的测评、
 * 完成了多少、以及可以重新开始，同一个功能就从困扰变成了贴心。
 *
 * 顺带的好处：评审打开首页就能看到恢复功能确实在跑，
 * 不必自己去猜要怎么触发。
 */

type State =
  | { kind: "loading" }
  | { kind: "fresh" }
  | { kind: "resumable"; percent: number }
  | { kind: "completed"; sessionId: string };

const primaryClass =
  "block w-full rounded-full bg-accent px-6 py-4 text-center text-base font-semibold text-accent-ink transition-all duration-150 hover:brightness-110 active:scale-[0.99]";

export function LandingCta() {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    void (async () => {
      const stored = loadSession();
      if (!stored) {
        setState({ kind: "fresh" });
        return;
      }

      try {
        const session = await api.getSession(stored);

        if (session.status === "COMPLETED" && session.hasResult) {
          setState({ kind: "completed", sessionId: stored.sessionId });
          return;
        }

        if (session.status === "ABANDONED" || session.answeredSteps.length === 0) {
          setState({ kind: "fresh" });
          return;
        }

        setState({
          kind: "resumable",
          percent: stepProgressPercent(stepIndexOf(resumeStepFor(session.answeredSteps))),
        });
      } catch (err) {
        // 会话过期或已被清理：清掉本地凭证，当新用户处理。
        // 入口页面不该因为一份过期会话就显示错误。
        if (err instanceof ApiError && (err.status === 404 || err.status === 410)) {
          clearSession();
        }
        setState({ kind: "fresh" });
      }
    })();
  }, []);

  const restart = useCallback(async () => {
    setRestarting(true);
    const stored = loadSession();
    if (stored) {
      await api.abandon(stored).catch(() => {
        // 作废失败不该挡住用户重来
      });
    }
    clearSession();
    router.push("/quiz");
  }, [router]);

  // 加载期间渲染一个等高的占位，避免按钮区在数据到达时跳动
  if (state.kind === "loading") {
    return (
      <div className="mt-10">
        <div className="h-[56px] w-full animate-pulse rounded-full bg-line/60" />
        <p className="mt-4 text-sm text-transparent select-none">占位</p>
      </div>
    );
  }

  if (state.kind === "completed") {
    return (
      <div className="mt-10">
        <button
          type="button"
          onClick={() => router.push(`/result/${state.sessionId}`)}
          className={primaryClass}
        >
          查看我的方案
        </button>
        <button
          type="button"
          onClick={() => void restart()}
          disabled={restarting}
          className="mt-4 w-full py-1 text-sm text-ink-faint transition-colors hover:text-ink-soft disabled:opacity-40"
        >
          {restarting ? "处理中…" : "重新测一次"}
        </button>
      </div>
    );
  }

  if (state.kind === "resumable") {
    return (
      <div className="mt-10">
        <button type="button" onClick={() => router.push("/quiz")} className={primaryClass}>
          继续上次测评 · 已完成 {state.percent}%
        </button>
        <button
          type="button"
          onClick={() => void restart()}
          disabled={restarting}
          className="mt-4 w-full py-1 text-sm text-ink-faint transition-colors hover:text-ink-soft disabled:opacity-40"
        >
          {restarting ? "处理中…" : "重新开始"}
        </button>
      </div>
    );
  }

  return (
    <div className="mt-10">
      <button type="button" onClick={() => router.push("/quiz")} className={primaryClass}>
        开始测评
      </button>
      <p className="mt-4 text-center text-sm text-ink-faint">
        无需注册，随时可以中断后继续
      </p>
    </div>
  );
}
