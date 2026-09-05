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

/**
 * Convert a new-format limit entry ({ percent, resets_at }) into a WeeklyUsage.
 */
function weeklyFromLimitEntry(entry: Record<string, unknown>): WeeklyUsage | null {
  const pct = typeof entry.percent === 'number' ? entry.percent : null;
  if (pct === null) return null;
  return {
    usagePercent: pct,
    messagesUsed: null,   // new format doesn't provide absolute counts
    maxMessages: null,
    resetsAt: timestampFromValue(entry.resets_at),
  };
}

/**
 * Parse the new `limits` array format returned by Claude's /usage endpoint.
 *
 * Each entry has: { kind, percent, resets_at, scope? }
 *   kind = "session" | "weekly_all" | "weekly_scoped"
 *   scope.model.display_name = "Sonnet" | "Opus" | "Fable" (for weekly_scoped)
 */
function parseNewLimitsArray(
  limits: Array<Record<string, unknown>>,
  detected: DetectedUsage
): void {
  const scopedKeyMap: Record<string, 'weeklySonnetUsage' | 'weeklyOpusUsage' | 'weeklyFableUsage'> = {
    sonnet: 'weeklySonnetUsage',
    opus: 'weeklyOpusUsage',
    fable: 'weeklyFableUsage',
  };

  for (const entry of limits) {
    const kind = String(entry.kind || '').toLowerCase();
    const pct = typeof entry.percent === 'number' ? entry.percent : null;
    const resetTs = timestampFromValue(entry.resets_at);

    if (kind === 'session') {
      if (pct !== null) {
        detected.usagePercent = pct;
        if (pct >= 100) detected.isRateLimited = true;
      }
      if (resetTs) detected.resetTimestamp = resetTs;
      detected.limitType = 'soft';
    } else if (kind === 'weekly_all') {
      const w = weeklyFromLimitEntry(entry);
      if (w) detected.weeklyUsage = w;
    } else if (kind === 'weekly_scoped') {
      const scope = entry.scope as Record<string, unknown> | undefined;
      const model = scope?.model as Record<string, unknown> | undefined;
      const displayName = String(model?.display_name || '').toLowerCase();
      const fieldKey = scopedKeyMap[displayName];
      if (fieldKey) {
        const w = weeklyFromLimitEntry(entry);
        if (w) detected[fieldKey] = w;
      }
    }
  }
}

export function parseUsagePayload(data: Record<string, unknown>, orgId?: string): DetectedUsage | null {
  if (!data || typeof data !== 'object') return null;

  const hasNewLimits = Array.isArray(data.limits) && (data.limits as unknown[]).length > 0;
  const hasFiveHour = data.five_hour && typeof data.five_hour === 'object';
  const hasMaxed = data.maxed && typeof data.maxed === 'object';

  // Must have at least one recognised format
  if (!hasNewLimits && !hasFiveHour && !hasMaxed) {
    console.debug('[CUT] parseUsagePayload: no recognised keys. Top-level keys:', Object.keys(data));
    return null;
  }

  const detected: DetectedUsage = {
    source: 'network',
    confidence: 0.95,
    hasAccurateData: true,
  };
  if (orgId) detected.orgId = orgId;

  // ── New format: `limits` array (preferred when present) ──
  if (hasNewLimits) {
    console.debug('[CUT] parseUsagePayload: limits array =', JSON.stringify(data.limits));
    parseNewLimitsArray(data.limits as Array<Record<string, unknown>>, detected);
    console.debug('[CUT] parseUsagePayload: after limits parse — usagePercent:', detected.usagePercent, 'resetTimestamp:', detected.resetTimestamp);
  }


  // ── Old format: top-level `five_hour` / `maxed` fields ──
  // Applied as fallback or supplement (if the new format didn't provide session data)
  if (hasFiveHour && detected.usagePercent === undefined) {
    parseUsageWindow(data.five_hour as Record<string, unknown>, detected);
  }

  if (hasMaxed) {
    const mx = data.maxed as Record<string, unknown>;
    detected.limitType = 'hard';
    const hardReset = timestampFromValue(mx.resets_at ?? mx.reset_at ?? mx.window_reset_at);
    if (hardReset) {
      detected.hardLimitResetAt = hardReset;
      detected.resetTimestamp = hardReset;
    }
    if (typeof mx.messages_used === 'number') detected.sessionMessagesUsed = mx.messages_used;
    detected.isRateLimited = true;
    detected.usagePercent = 100;
    if (detected.remainingMessages === undefined) detected.remainingMessages = 0;
  } else if ((hasFiveHour || hasNewLimits) && detected.limitType === undefined) {
    detected.limitType = 'soft';
  }

  // ── Old-format weekly fields (fallback when new format didn't provide them) ──
  if (!detected.weeklyUsage && data.seven_day && typeof data.seven_day === 'object') {
    const w = parseWeeklyField(data.seven_day as Record<string, unknown>);
    if (w) detected.weeklyUsage = w;
  }
  if (!detected.weeklySonnetUsage && data.seven_day_sonnet && typeof data.seven_day_sonnet === 'object') {
    const w = parseWeeklyField(data.seven_day_sonnet as Record<string, unknown>);
    if (w) detected.weeklySonnetUsage = w;
  }
  if (!detected.weeklyOpusUsage && data.seven_day_opus && typeof data.seven_day_opus === 'object') {
    const w = parseWeeklyField(data.seven_day_opus as Record<string, unknown>);
    if (w) detected.weeklyOpusUsage = w;
  }

  return detected;
}

export default { parseUsagePayload, parseUsageWindow };
