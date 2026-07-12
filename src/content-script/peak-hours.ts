import { feedDetection } from "../backend/state-manager";
import type { DetectedUsage } from "../backend/types";

// Peak hours per Anthropic's March 2026 capacity announcement: weekdays
// 8am-2pm ET. Hardcoding this is inherently fragile — Anthropic could change
// or remove this policy at any time with no API signal. Treat this as a
// best-effort estimate, not authoritative.
export function checkPeakHours(): void {
  const PEAK_START_HOUR_ET = 8;
  const PEAK_END_HOUR_ET = 14;
  const etFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    hour12: false,
    weekday: "short",
  });

  const now = new Date();
  const parts = etFormatter.formatToParts(now);
  const etHour = parseInt(parts.find(p => p.type === "hour")!.value, 10);
  const etWeekday = parts.find(p => p.type === "weekday")!.value;
  const isWeekday = etWeekday !== "Sat" && etWeekday !== "Sun";
  const inPeak = isWeekday && etHour >= PEAK_START_HOUR_ET && etHour < PEAK_END_HOUR_ET;

  let transitionAt = 0;
  const probe = new Date(now);
  let prevInPeak = inPeak;
  for (let i = 0; i < 8 * 24 * 60; i++) {
    probe.setTime(probe.getTime() + 60_000);
    const probeParts = etFormatter.formatToParts(probe);
    const probeHour = parseInt(probeParts.find(p => p.type === "hour")!.value, 10);
    const probeWeekday = probeParts.find(p => p.type === "weekday")!.value;
    const probeIsWeekday = probeWeekday !== "Sat" && probeWeekday !== "Sun";
    const probeInPeak = probeIsWeekday && probeHour >= PEAK_START_HOUR_ET && probeHour < PEAK_END_HOUR_ET;
    if (probeInPeak !== prevInPeak) {
      transitionAt = probe.getTime();
      break;
    }
    prevInPeak = probeInPeak;
  }

  const detected: DetectedUsage = {
    source: "computed",
    confidence: 0.99,
    isPeakHours: inPeak,
    peakHoursTransitionAt: transitionAt || 0,
  };
  feedDetection(detected);
}
