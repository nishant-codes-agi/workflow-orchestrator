export function computeNextSleep(
  backoffBase: number,
  backoffCap: number,
  lastSleep: number,
): number {
  const prevSleep = lastSleep || backoffBase;
  const raw = Math.random() * (prevSleep * 3 - backoffBase) + backoffBase;
  return Math.floor(Math.min(backoffCap, raw));
}
