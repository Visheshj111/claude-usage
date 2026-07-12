import type { DetectedUsage, WeeklyUsage } from './types';

export function numberFromValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function timestampFromValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? value : value * 1000;
  if (typeof value === 'string' && value.trim()) {
    const ts = new Date(value).getTime();
    return Number.isFinite(ts) ? ts : null;
  }
  return null;
}

export function parseWeeklyField(obj: Record<string, unknown>): WeeklyUsage | null {
  if (typeof obj.utilization !== 'number' && typeof obj.max_messages !== 'number') return null;
  return {
    usagePercent: typeof obj.utilization === 'number' ? obj.utilization : null,
    messagesUsed: typeof obj.utilization === 'number' && typeof obj.max_messages === 'number'
      ? Math.round((obj.utilization / 100) * obj.max_messages)
      : null,
    maxMessages: typeof obj.max_messages === 'number' ? obj.max_messages : null,
    resetsAt: timestampFromValue(obj.resets_at),
  };
}

export function parseUsageWindow(windowData: Record<string, unknown>, detected: DetectedUsage): void {
  const utilization = numberFromValue(windowData.utilization);
  const maxMessages = numberFromValue(windowData.max_messages ?? windowData.message_limit ?? windowData.limit);
  const remainingMessages = numberFromValue(windowData.remaining_messages ?? windowData.messages_remaining ?? windowData.remaining);
  const messagesUsed = numberFromValue(windowData.messages_used ?? windowData.used_messages ?? windowData.used);
  const resetTimestamp = timestampFromValue(windowData.resets_at ?? windowData.reset_at ?? windowData.window_reset_at);
  const windowStart = timestampFromValue(
    windowData.window_start ?? windowData.window_started_at ?? windowData.session_start ?? windowData.started_at ?? null
  );

  if (utilization !== null) detected.usagePercent = utilization;
  if (maxMessages !== null && maxMessages > 0) detected.sessionLimit = maxMessages;

  if (remainingMessages !== null) {
    detected.remainingMessages = Math.max(0, remainingMessages);
  } else if (maxMessages !== null && utilization !== null) {
    const used = (utilization / 100) * maxMessages;
    detected.remainingMessages = Math.max(0, Math.round((maxMessages - used) * 10) / 10);
  }

  if (messagesUsed !== null) {
    detected.sessionMessagesUsed = Math.max(0, messagesUsed);
  } else if (maxMessages !== null && detected.remainingMessages !== undefined) {
    detected.sessionMessagesUsed = Math.max(0, maxMessages - detected.remainingMessages);
  } else if (maxMessages !== null && utilization !== null) {
    detected.sessionMessagesUsed = Math.max(0, (utilization / 100) * maxMessages);
  }

  if (resetTimestamp) detected.resetTimestamp = resetTimestamp;
  if (windowStart && resetTimestamp && resetTimestamp > windowStart) {
    const ms = resetTimestamp - windowStart;
    if (ms > 0 && ms < 24 * 60 * 60 * 1000) {
      detected.sessionWindowMs = ms;
      detected.sessionWindowStartTs = windowStart;
    }
  }
  if (utilization !== null && utilization >= 100) detected.isRateLimited = true;
}

export function parseUsagePayload(data: Record<string, unknown>, orgId?: string): DetectedUsage | null {
  if (!data || !data.five_hour || typeof data.five_hour !== 'object') return null;

  const fh = data.five_hour as Record<string, unknown>;
  const detected: DetectedUsage = {
    source: 'network',
    confidence: 0.95,
    hasAccurateData: true,
  };
  if (orgId) detected.orgId = orgId;

  parseUsageWindow(fh, detected);

  if (data.maxed && typeof data.maxed === 'object') {
    const mx = data.maxed as Record<string, unknown>;
    detected.limitType = 'hard';
    const hardReset = timestampFromValue(mx.resets_at ?? mx.reset_at ?? mx.window_reset_at);
    if (hardReset) {
      detected.hardLimitResetAt = hardReset;
      detected.resetTimestamp = hardReset;
    }
    if (typeof mx.messages_used === 'number') detected.sessionMessagesUsed = mx.messages_used;
    detected.isRateLimited = true;
  } else {
    detected.limitType = 'soft';
  }

  if (data.seven_day && typeof data.seven_day === 'object') {
    const w = parseWeeklyField(data.seven_day as Record<string, unknown>);
    if (w) detected.weeklyUsage = w;
  }
  if (data.seven_day_sonnet && typeof data.seven_day_sonnet === 'object') {
    const w = parseWeeklyField(data.seven_day_sonnet as Record<string, unknown>);
    if (w) detected.weeklySonnetUsage = w;
  }
  if (data.seven_day_opus && typeof data.seven_day_opus === 'object') {
    const w = parseWeeklyField(data.seven_day_opus as Record<string, unknown>);
    if (w) detected.weeklyOpusUsage = w;
  }

  return detected;
}

export default { parseUsagePayload, parseUsageWindow };
