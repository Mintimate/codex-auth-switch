export type GuideOutcome = "skipped" | "completed";

const sessionOutcomes = new Map<string, GuideOutcome>();

export const guideStorageKey = (page: string, variant: string) =>
  `codex-auth-switch-guide-v1:${page}:${variant}`;

export function readGuideOutcome(key: string): GuideOutcome | null {
  // 本次运行中的选择优先，避免存储已满时读回旧的持久化结果。
  const current = sessionOutcomes.get(key);
  if (current) return current;
  try {
    const value = window.localStorage.getItem(key);
    if (value === "skipped" || value === "completed") return value;
  } catch {
    // 无法持久化时仍在本次运行内记住选择。
  }
  return null;
}

export function saveGuideOutcome(key: string, outcome: GuideOutcome) {
  sessionOutcomes.set(key, outcome);
  try {
    window.localStorage.setItem(key, outcome);
  } catch {
    // 指引不依赖可写存储，关闭和完成始终有效。
  }
}
