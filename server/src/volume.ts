export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

export function combineFreshVolumes(
  entries: Iterable<{ level: number; ts: number }>,
  now: number,
  windowMs = 500,
): number {
  let sum = 0
  for (const { level, ts } of entries) {
    if (now - ts > windowMs) continue
    sum += clamp01(level)
  }
  return sum > 1 ? 1 : sum
}
