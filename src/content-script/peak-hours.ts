import { feedDetection } from '../backend/state-manager';
import type { DetectedUsage } from '../backend/types';
import { DEFAULT_PEAK_HOURS } from '../config';

// Peak hours per Anthropic's March 2026 capacity announcement: weekdays
// 8am-2pm ET. Hardcoding this is inherently fragile — Anthropic could change
// or remove this policy at any time with no API signal. Treat this as a
// best-effort estimate, not authoritative.
export function checkPeakHours(): void {
  const { startHourET, endHourET } = DEFAULT_PEAK_HOURS;

  const etFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    hour12: false,
    weekday: 'short',
    minute: 'numeric',
  });

  const now = new Date();
  const parts = etFormatter.formatToParts(now);
  const etHour = parseInt(parts.find((p) => p.type === 'hour')!.value, 10);
  const etMinute = parseInt(parts.find((p) => p.type === 'minute')!.value, 10);
  const etWeekday = parts.find((p) => p.type === 'weekday')!.value;
  const isWeekday = etWeekday !== 'Sat' && etWeekday !== 'Sun';
  const inPeak = isWeekday && etHour >= startHourET && etHour < endHourET;

  // Compute transition time using math instead of a minute-by-minute loop.
  // Current ET time as fractional hours since midnight:
  const etDecimalHour = etHour + etMinute / 60;
  let transitionAt = 0;

  if (isWeekday) {
    if (inPeak) {
      // Currently in peak — transition at endHourET today
      const msUntilEnd = (endHourET - etDecimalHour) * 3_600_000;
      transitionAt = now.getTime() + msUntilEnd;
    } else if (etHour < startHourET) {
      // Before peak today — transition at startHourET today
      const msUntilStart = (startHourET - etDecimalHour) * 3_600_000;
      transitionAt = now.getTime() + msUntilStart;
    } else {
      // After peak today — find startHourET on next weekday
      transitionAt = _nextWeekdayPeakStart(now, startHourET, etFormatter);
    }
  } else {
    // Weekend — find startHourET on next weekday
    transitionAt = _nextWeekdayPeakStart(now, startHourET, etFormatter);
  }

  const detected: DetectedUsage = {
    source: 'computed',
    confidence: 0.99,
    isPeakHours: inPeak,
    peakHoursTransitionAt: transitionAt || 0,
  };
  feedDetection(detected);
}

function _nextWeekdayPeakStart(
  now: Date,
  startHourET: number,
  formatter: Intl.DateTimeFormat
): number {
  // Probe up to 7 days ahead, checking each day at 23:59 to determine weekday in ET
  for (let d = 1; d <= 7; d++) {
    const probe = new Date(now.getTime() + d * 86_400_000);
    const parts = formatter.formatToParts(probe);
    const weekday = parts.find((p) => p.type === 'weekday')!.value;
    if (weekday !== 'Sat' && weekday !== 'Sun') {
      // Set probe to midnight ET of that day, then add startHourET hours
      // Approximate: use the delta from now to that day's startHour
      const etHour = parseInt(parts.find((p) => p.type === 'hour')!.value, 10);
      const etMinute = parseInt(parts.find((p) => p.type === 'minute')!.value, 10);
      const etDecimal = etHour + etMinute / 60;
      // Hours from probe's current ET time back to midnight, then to startHourET
      const hoursToMidnight = 24 - etDecimal;
      const msToStart = (hoursToMidnight + startHourET) * 3_600_000;
      return probe.getTime() + msToStart;
    }
  }
  return 0;
}
