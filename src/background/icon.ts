const CANVAS_SIZE = 32;

export function updateIcon(sessionPct: number, weeklyPct: number | null): void {
  const canvas = new OffscreenCanvas(CANVAS_SIZE, CANVAS_SIZE);
  const ctx = canvas.getContext("2d")!;
  const cx = CANVAS_SIZE / 2;
  const cy = CANVAS_SIZE / 2;
  const startAngle = -Math.PI / 2;

  const colorForPct = (pct: number): string => {
    if (pct >= 90) return "#ef4444";
    if (pct >= 70) return "#f59e0b";
    return "#22c55e";
  };

  const clampPct = (pct: number): number => Math.max(0, Math.min(100, pct));

  const drawRing = (
    radius: number,
    lineWidth: number,
    pct: number | null,
    neutralWhenMissing = false
  ): void => {
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.strokeStyle = neutralWhenMissing && pct == null
      ? "rgba(128,128,128,0.16)"
      : "rgba(128,128,128,0.25)";
    ctx.lineWidth = lineWidth;
    ctx.lineCap = "round";
    ctx.stroke();

    if (pct == null) return;

    const clamped = clampPct(pct);
    const endAngle = startAngle + (Math.PI * 2 * clamped) / 100;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, startAngle, endAngle);
    ctx.strokeStyle = colorForPct(clamped);
    ctx.lineWidth = lineWidth;
    ctx.lineCap = "round";
    ctx.stroke();
  };

  drawRing(13, 3, sessionPct);
  drawRing(8, 2.5, weeklyPct, true);

  const imageData = ctx.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  chrome.action.setIcon({ imageData }).catch(() => {});
}

export function formatBgDuration(ms: number): string {
  if (ms <= 0 || !Number.isFinite(ms)) return "00:00:00";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
