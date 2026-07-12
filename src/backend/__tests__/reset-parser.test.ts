import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { UsageState } from '../types';
import {
  computeCountdown,
  retryAfterToTimestamp,
  formatCountdown,
  isResetPending,
  updateCountdown,
} from '../reset-parser';

function makeState(overrides: Partial<UsageState> = {}): UsageState {
  return {
    usagePercent: null,
    remainingMessages: null,
    sessionLimit: null,
    sessionMessagesUsed: null,
    sessionWindowStartTs: null,
    sessionWindowMs: 0,
    isRateLimited: false,
    resetTimestamp: null,
    countdownMs: null,
    source: 'unknown',
    confidence: 0,
    apiConnected: false,
    apiErrorStatus: null,
    limitType: 'unknown',
    hardLimitResetAt: null,
    orgId: null,
    hasAccurateData: false,
    planTier: 'unknown',
    weeklyUsage: null,
    weeklySonnetUsage: null,
    weeklyOpusUsage: null,
    isPeakHours: false,
    peakHoursTransitionAt: null,
    ...overrides,
  };
}

describe('computeCountdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns ms difference for future timestamp', () => {
    expect(computeCountdown(Date.now() + 5000)).toBe(5000);
  });

  it('returns ms for large future timestamp', () => {
    expect(computeCountdown(Date.now() + 3600000)).toBe(3600000);
  });

  it('returns 0 for past timestamp', () => {
    expect(computeCountdown(Date.now() - 1000)).toBe(0);
  });

  it('returns 0 for exact present timestamp', () => {
    expect(computeCountdown(Date.now())).toBe(0);
  });

  it('returns null for null input', () => {
    expect(computeCountdown(null)).toBeNull();
  });

  it('returns null for zero input', () => {
    expect(computeCountdown(0)).toBeNull();
  });

  it('returns null for negative input', () => {
    expect(computeCountdown(-100)).toBeNull();
  });
});

describe('retryAfterToTimestamp', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns future timestamp for positive seconds', () => {
    expect(retryAfterToTimestamp(120)).toBe(Date.now() + 120000);
  });

  it('handles large values', () => {
    expect(retryAfterToTimestamp(3600)).toBe(Date.now() + 3600000);
  });

  it('returns null for zero', () => {
    expect(retryAfterToTimestamp(0)).toBeNull();
  });

  it('returns null for negative value', () => {
    expect(retryAfterToTimestamp(-10)).toBeNull();
  });
});

describe('formatCountdown', () => {
  it('returns 00:00:00 for null', () => {
    expect(formatCountdown(null)).toBe('00:00:00');
  });

  it('returns 00:00:00 for zero', () => {
    expect(formatCountdown(0)).toBe('00:00:00');
  });

  it('returns 00:00:00 for negative ms', () => {
    expect(formatCountdown(-1000)).toBe('00:00:00');
  });

  it('formats 1 second', () => {
    expect(formatCountdown(1000)).toBe('00:00:01');
  });

  it('formats 1 minute 1 second', () => {
    expect(formatCountdown(61000)).toBe('00:01:01');
  });

  it('formats 1 hour 1 minute 1 second', () => {
    expect(formatCountdown(3661000)).toBe('01:01:01');
  });

  it('formats exactly 1 hour', () => {
    expect(formatCountdown(3600000)).toBe('01:00:00');
  });

  it('formats 23:59:59', () => {
    expect(formatCountdown(86399000)).toBe('23:59:59');
  });

  it('rounds down fractional seconds', () => {
    expect(formatCountdown(1500)).toBe('00:00:01');
  });

  it('handles large values beyond 24 hours', () => {
    expect(formatCountdown(360000000)).toBe('100:00:00');
  });
});

describe('isResetPending', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns true for future timestamp', () => {
    expect(isResetPending(Date.now() + 60000)).toBe(true);
  });

  it('returns false for past timestamp', () => {
    expect(isResetPending(Date.now() - 60000)).toBe(false);
  });

  it('returns false for exact present', () => {
    expect(isResetPending(Date.now())).toBe(false);
  });

  it('returns false for null', () => {
    expect(isResetPending(null)).toBe(false);
  });
});

describe('updateCountdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sets countdownMs for future reset (in-place mutation)', () => {
    const state = makeState({ resetTimestamp: Date.now() + 10000, countdownMs: null });
    updateCountdown(state);
    expect(state.countdownMs).toBe(10000);
  });

  it('sets countdownMs to null for past reset', () => {
    const state = makeState({ resetTimestamp: Date.now() - 10000, countdownMs: 5000 });
    updateCountdown(state);
    expect(state.countdownMs).toBeNull();
  });

  it('sets countdownMs to null when resetTimestamp is null', () => {
    const state = makeState({ resetTimestamp: null, countdownMs: 5000 });
    updateCountdown(state);
    expect(state.countdownMs).toBeNull();
  });

  it('sets countdownMs to null when resetTimestamp equals now', () => {
    const state = makeState({ resetTimestamp: Date.now(), countdownMs: 5000 });
    updateCountdown(state);
    expect(state.countdownMs).toBeNull();
  });

  it('updates countdownMs to a smaller value over time', () => {
    const state = makeState({ resetTimestamp: Date.now() + 30000, countdownMs: 30000 });
    vi.advanceTimersByTime(5000);
    updateCountdown(state);
    expect(state.countdownMs).toBe(25000);
  });

  it('does not modify other state fields', () => {
    const state = makeState({
      usagePercent: 50,
      isRateLimited: true,
      resetTimestamp: Date.now() + 10000,
      countdownMs: null,
    });
    updateCountdown(state);
    expect(state.usagePercent).toBe(50);
    expect(state.isRateLimited).toBe(true);
    expect(state.countdownMs).toBe(10000);
  });
});
