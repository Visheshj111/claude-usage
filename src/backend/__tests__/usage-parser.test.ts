import { describe, it, expect } from 'vitest';
import { parseUsagePayload, parseUsageWindow } from '../usage-parser';
import type { DetectedUsage } from '../types';

describe('parseUsagePayload', () => {
  it('returns null for null/undefined data', () => {
    expect(parseUsagePayload(null as unknown as Record<string, unknown>)).toBeNull();
    expect(parseUsagePayload(undefined as unknown as Record<string, unknown>)).toBeNull();
  });

  it('returns null when five_hour is missing', () => {
    expect(parseUsagePayload({})).toBeNull();
  });

  it('returns null when five_hour is not an object', () => {
    expect(parseUsagePayload({ five_hour: 'string' })).toBeNull();
    expect(parseUsagePayload({ five_hour: 42 })).toBeNull();
  });

  it('parses valid payload with utilization and limit', () => {
    const result = parseUsagePayload({
      five_hour: {
        utilization: 60,
        max_messages: 40,
        remaining_messages: 16,
      },
    });
    expect(result).not.toBeNull();
    expect(result!.source).toBe('network');
    expect(result!.confidence).toBe(0.95);
    expect(result!.hasAccurateData).toBe(true);
    expect(result!.usagePercent).toBe(60);
    expect(result!.sessionLimit).toBe(40);
    expect(result!.remainingMessages).toBe(16);
    expect(result!.limitType).toBe('soft');
    expect(result!.isRateLimited).toBeUndefined();
  });

  it('handles rate limited (100% utilization)', () => {
    const result = parseUsagePayload({
      five_hour: {
        utilization: 100,
        max_messages: 40,
        remaining_messages: 0,
      },
    });
    expect(result!.isRateLimited).toBe(true);
    expect(result!.usagePercent).toBe(100);
    expect(result!.limitType).toBe('soft');
  });

  it('handles maxed (hard limit) with reset timestamp', () => {
    const resetDate = '2024-01-02T12:00:00Z';
    const result = parseUsagePayload({
      five_hour: {
        utilization: 100,
        max_messages: 40,
        remaining_messages: 0,
      },
      maxed: {
        resets_at: resetDate,
        messages_used: 40,
      },
    });
    expect(result!.limitType).toBe('hard');
    expect(result!.isRateLimited).toBe(true);
    expect(result!.hardLimitResetAt).toBe(new Date(resetDate).getTime());
    expect(result!.resetTimestamp).toBe(new Date(resetDate).getTime());
    expect(result!.sessionMessagesUsed).toBe(40);
  });

  it('passes orgId to result', () => {
    const result = parseUsagePayload({
      five_hour: { utilization: 50, max_messages: 40 },
    }, 'org-123');
    expect(result!.orgId).toBe('org-123');
  });

  it('does not set orgId when not provided', () => {
    const result = parseUsagePayload({
      five_hour: { utilization: 50, max_messages: 40 },
    });
    expect(result!.orgId).toBeUndefined();
  });

  it('parses weekly usage (seven_day)', () => {
    const result = parseUsagePayload({
      five_hour: { utilization: 30, max_messages: 40 },
      seven_day: { utilization: 75, max_messages: 100, resets_at: '2024-01-07T00:00:00Z' },
    });
    expect(result!.weeklyUsage).not.toBeNull();
    expect(result!.weeklyUsage!.usagePercent).toBe(75);
    expect(result!.weeklyUsage!.maxMessages).toBe(100);
    expect(result!.weeklyUsage!.resetsAt).toBe(new Date('2024-01-07T00:00:00Z').getTime());
  });

  it('computes messagesUsed from weekly data', () => {
    const result = parseUsagePayload({
      five_hour: { utilization: 30, max_messages: 40 },
      seven_day: { utilization: 75, max_messages: 100 },
    });
    expect(result!.weeklyUsage!.messagesUsed).toBe(75);
  });

  it('returns null messagesUsed when max_messages is missing from weekly data', () => {
    const result = parseUsagePayload({
      five_hour: { utilization: 30, max_messages: 40 },
      seven_day: { utilization: 75 },
    });
    expect(result!.weeklyUsage!.messagesUsed).toBeNull();
  });

  it('parses sonnet and opus weekly usage', () => {
    const result = parseUsagePayload({
      five_hour: { utilization: 20, max_messages: 40 },
      seven_day_sonnet: { utilization: 50, max_messages: 60 },
      seven_day_opus: { utilization: 10, max_messages: 20 },
    });
    expect(result!.weeklySonnetUsage).not.toBeNull();
    expect(result!.weeklySonnetUsage!.usagePercent).toBe(50);
    expect(result!.weeklySonnetUsage!.maxMessages).toBe(60);

    expect(result!.weeklyOpusUsage).not.toBeNull();
    expect(result!.weeklyOpusUsage!.usagePercent).toBe(10);
    expect(result!.weeklyOpusUsage!.maxMessages).toBe(20);
  });

  it('skips weekly fields when data is not an object', () => {
    const result = parseUsagePayload({
      five_hour: { utilization: 20, max_messages: 40 },
      seven_day: 'not-an-object' as unknown as Record<string, unknown>,
      seven_day_sonnet: 42 as unknown as Record<string, unknown>,
    });
    expect(result!.weeklyUsage).toBeUndefined();
    expect(result!.weeklySonnetUsage).toBeUndefined();
  });

  it('handles reset timestamp via window data', () => {
    const resetTs = new Date('2024-01-01T17:00:00Z').getTime();
    const windowStart = resetTs - 5 * 60 * 60 * 1000;
    const result = parseUsagePayload({
      five_hour: {
        utilization: 50,
        max_messages: 40,
        resets_at: resetTs,
        window_start: windowStart,
      },
    });
    expect(result!.resetTimestamp).toBe(resetTs);
    expect(result!.sessionWindowStartTs).toBe(windowStart);
    expect(result!.sessionWindowMs).toBe(5 * 60 * 60 * 1000);
  });

  it('sets isRateLimited when utilization >= 100 even without maxed', () => {
    const result = parseUsagePayload({
      five_hour: {
        utilization: 100,
        max_messages: 40,
      },
    });
    expect(result!.isRateLimited).toBe(true);
  });

  it('builds sessionMessagesUsed when only utilization and max_messages provided', () => {
    const result = parseUsagePayload({
      five_hour: {
        utilization: 60,
        max_messages: 50,
      },
    });
    expect(result!.sessionMessagesUsed).toBe(30);
    expect(result!.remainingMessages).toBe(20);
  });
});

describe('parseUsageWindow', () => {
  it('sets usagePercent from utilization', () => {
    const detected: DetectedUsage = { source: 'network', confidence: 1 };
    parseUsageWindow({ utilization: 75, max_messages: 100 }, detected);
    expect(detected.usagePercent).toBe(75);
  });

  it('handles alternative field names for maxMessages', () => {
    const detected: DetectedUsage = { source: 'network', confidence: 1 };
    parseUsageWindow({ utilization: 30, message_limit: 50, remaining_messages: 35 }, detected);
    expect(detected.sessionLimit).toBe(50);
    expect(detected.remainingMessages).toBe(35);
  });

  it('handles all field name aliases for limit', () => {
    const detected: DetectedUsage = { source: 'network', confidence: 1 };
    parseUsageWindow({ utilization: 30, limit: 50, remaining_messages: 35 }, detected);
    expect(detected.sessionLimit).toBe(50);
  });

  it('handles all field name aliases for remaining', () => {
    const detected: DetectedUsage = { source: 'network', confidence: 1 };
    parseUsageWindow({ utilization: 30, max_messages: 50, messages_remaining: 35 }, detected);
    expect(detected.remainingMessages).toBe(35);
  });

  it('handles remaining field name alias remaining', () => {
    const detected: DetectedUsage = { source: 'network', confidence: 1 };
    parseUsageWindow({ utilization: 30, max_messages: 50, remaining: 35 }, detected);
    expect(detected.remainingMessages).toBe(35);
  });

  it('handles used field name aliases', () => {
    const detected: DetectedUsage = { source: 'network', confidence: 1 };
    parseUsageWindow({ utilization: 30, max_messages: 50, used_messages: 15 }, detected);
    expect(detected.sessionMessagesUsed).toBe(15);
  });

  it('handles used field alias used', () => {
    const detected: DetectedUsage = { source: 'network', confidence: 1 };
    parseUsageWindow({ utilization: 30, max_messages: 50, used: 15 }, detected);
    expect(detected.sessionMessagesUsed).toBe(15);
  });

  it('computes remaining messages from utilization when not provided', () => {
    const detected: DetectedUsage = { source: 'network', confidence: 1 };
    parseUsageWindow({ utilization: 60, max_messages: 50 }, detected);
    expect(detected.remainingMessages).toBe(20);
  });

  it('computes sessionMessagesUsed from maxMessages and remainingMessages', () => {
    const detected: DetectedUsage = { source: 'network', confidence: 1 };
    parseUsageWindow({ utilization: 40, max_messages: 100, remaining_messages: 60 }, detected);
    expect(detected.sessionMessagesUsed).toBe(40);
  });

  it('computes sessionMessagesUsed from utilization and maxMessages', () => {
    const detected: DetectedUsage = { source: 'network', confidence: 1 };
    parseUsageWindow({ utilization: 40, max_messages: 100 }, detected);
    expect(detected.sessionMessagesUsed).toBe(40);
  });

  it('computes sessionWindowMs from reset and window start', () => {
    const now = Date.now();
    const reset = now + 5 * 60 * 60 * 1000;
    const windowStart = now;
    const detected: DetectedUsage = { source: 'network', confidence: 1 };
    parseUsageWindow({
      utilization: 30,
      max_messages: 100,
      resets_at: reset,
      window_start: windowStart,
    }, detected);
    expect(detected.resetTimestamp).toBe(reset);
    expect(detected.sessionWindowMs).toBe(5 * 60 * 60 * 1000);
    expect(detected.sessionWindowStartTs).toBe(windowStart);
  });

  it('does not set window duration if reset is before window start', () => {
    const now = Date.now();
    const detected: DetectedUsage = { source: 'network', confidence: 1 };
    parseUsageWindow({
      utilization: 30,
      max_messages: 100,
      resets_at: now - 3600000,
      window_start: now,
    }, detected);
    expect(detected.sessionWindowMs).toBeUndefined();
  });

  it('does not set window duration if > 24 hours', () => {
    const now = Date.now();
    const farReset = now + 48 * 60 * 60 * 1000;
    const detected: DetectedUsage = { source: 'network', confidence: 1 };
    parseUsageWindow({
      utilization: 30,
      max_messages: 100,
      resets_at: farReset,
      window_start: now,
    }, detected);
    expect(detected.sessionWindowMs).toBeUndefined();
  });

  it('ensures non-negative remaining messages', () => {
    const detected: DetectedUsage = { source: 'network', confidence: 1 };
    parseUsageWindow({ utilization: 50, max_messages: 10, remaining_messages: -5 }, detected);
    expect(detected.remainingMessages).toBe(0);
  });

  it('retains decimal precision on computed remaining messages', () => {
    const detected: DetectedUsage = { source: 'network', confidence: 1 };
    parseUsageWindow({ utilization: 33, max_messages: 100 }, detected);
    expect(detected.remainingMessages).toBe(67);
  });

  it('ensures non-negative sessionMessagesUsed', () => {
    const detected: DetectedUsage = { source: 'network', confidence: 1 };
    parseUsageWindow({ utilization: 30, max_messages: 50, used_messages: -10 }, detected);
    expect(detected.sessionMessagesUsed).toBe(0);
  });

  it('handles empty window data gracefully', () => {
    const detected: DetectedUsage = { source: 'network', confidence: 1 };
    parseUsageWindow({}, detected);
    expect(detected.usagePercent).toBeUndefined();
    expect(detected.remainingMessages).toBeUndefined();
  });

  it('handles null window values gracefully', () => {
    const detected: DetectedUsage = { source: 'network', confidence: 1 };
    parseUsageWindow({
      utilization: null as unknown as number,
      max_messages: null as unknown as number,
      remaining_messages: null as unknown as number,
    }, detected);
    expect(detected.usagePercent).toBeUndefined();
    expect(detected.remainingMessages).toBeUndefined();
  });

  it('uses alternative reset timestamp field names', () => {
    const detected: DetectedUsage = { source: 'network', confidence: 1 };
    const now = Date.now();
    parseUsageWindow({ utilization: 30, max_messages: 100, window_reset_at: now + 3600000 }, detected);
    expect(detected.resetTimestamp).toBe(now + 3600000);
  });

  it('uses alternative window start field names', () => {
    const detected: DetectedUsage = { source: 'network', confidence: 1 };
    const now = Date.now();
    parseUsageWindow({
      utilization: 30,
      max_messages: 100,
      resets_at: now + 3600000,
      session_start: now,
    }, detected);
    expect(detected.sessionWindowStartTs).toBe(now);
  });

  it('uses window_started_at field name', () => {
    const detected: DetectedUsage = { source: 'network', confidence: 1 };
    const now = Date.now();
    parseUsageWindow({
      utilization: 30,
      max_messages: 100,
      resets_at: now + 3600000,
      window_started_at: now,
    }, detected);
    expect(detected.sessionWindowStartTs).toBe(now);
  });
});
