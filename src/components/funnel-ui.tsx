"use client";

import type { ReactNode } from "react";

/**
 * 漏斗共用的几个原子组件。
 *
 * 设计取向：可信感来自克制。大留白、单一强调色、大字号，
 * 选项做成整块可点的卡片而不是小圆点 —— 移动端拇指够得到，
 * 是这类问卷能不能填完的关键。
 */

export function ProgressBar({ percent }: { percent: number }) {
  return (
    <div className="w-full">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-500 ease-out"
          style={{ width: `${Math.max(2, percent)}%` }}
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </div>
    </div>
  );
}

export function StepHeading({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="mb-8 text-center">
      <h1 className="text-balance text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
        {title}
      </h1>
      {subtitle ? (
        <p className="mx-auto mt-3 max-w-md text-pretty text-base leading-relaxed text-ink-soft">
          {subtitle}
        </p>
      ) : null}
    </div>
  );
}

export function OptionCard({
  label,
  hint,
  selected,
  onClick,
}: {
  label: string;
  hint?: string;
  selected?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`group flex w-full items-center justify-between rounded-2xl border px-5 py-4 text-left transition-all duration-150 active:scale-[0.99] ${
        selected
          ? "border-accent bg-accent-soft shadow-sm"
          : "border-line bg-surface hover:border-accent/40 hover:shadow-sm"
      }`}
    >
      <span className="min-w-0">
        <span className="block text-lg font-medium text-ink">{label}</span>
        {hint ? <span className="mt-0.5 block text-sm text-ink-faint">{hint}</span> : null}
      </span>
      <span
        aria-hidden
        className={`ml-4 flex size-6 shrink-0 items-center justify-center rounded-full border transition-colors ${
          selected ? "border-accent bg-accent" : "border-line group-hover:border-accent/40"
        }`}
      >
        {selected ? (
          <svg viewBox="0 0 20 20" className="size-4 fill-none stroke-white stroke-[2.5]">
            <path d="M5 10.5l3.5 3.5L15 7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : null}
      </span>
    </button>
  );
}

export function PrimaryButton({
  children,
  disabled,
  loading,
  onClick,
  type = "button",
}: {
  children: ReactNode;
  disabled?: boolean;
  loading?: boolean;
  onClick?: () => void;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || loading}
      className="w-full rounded-full bg-accent px-6 py-4 text-base font-semibold text-accent-ink transition-all duration-150 hover:brightness-110 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
    >
      {loading ? "处理中…" : children}
    </button>
  );
}

export function NumberField({
  label,
  suffix,
  value,
  onChange,
  error,
  placeholder,
  inputMode = "decimal",
}: {
  label: string;
  suffix: string;
  value: string;
  onChange: (next: string) => void;
  error?: string;
  placeholder?: string;
  inputMode?: "numeric" | "decimal";
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-ink-soft">{label}</span>
      <span
        className={`flex items-center gap-2 rounded-xl border bg-surface px-4 py-3 transition-colors focus-within:border-accent ${
          error ? "border-warn" : "border-line"
        }`}
      >
        <input
          // type=text + inputMode 而不是 type=number：
          // number 输入框在移动端会带上下箭头、滚轮会误改数值，
          // 而且空字符串与非法输入的行为在各浏览器间不一致。
          type="text"
          inputMode={inputMode}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          className="w-full bg-transparent text-lg text-ink outline-none placeholder:text-ink-faint"
        />
        <span className="shrink-0 text-sm text-ink-faint">{suffix}</span>
      </span>
      {error ? <span className="mt-1.5 block text-sm text-warn">{error}</span> : null}
    </label>
  );
}

/** 社会证明。漏斗类产品里这类文案对完成率的影响是实打实的 */
export function TrustNote({ children }: { children: ReactNode }) {
  return (
    <p className="mt-6 flex items-center justify-center gap-2 text-center text-sm text-ink-faint">
      <svg viewBox="0 0 20 20" aria-hidden className="size-4 fill-accent/70">
        <path d="M10 1l2.4 5.3 5.6.6-4.2 3.9 1.2 5.6L10 13.6 5 16.4l1.2-5.6L2 6.9l5.6-.6z" />
      </svg>
      {children}
    </p>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="mb-4 rounded-xl border border-warn/30 bg-warn-soft px-4 py-3 text-sm text-warn"
    >
      {message}
    </div>
  );
}
