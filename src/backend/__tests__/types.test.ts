import { describe, it, expect } from 'vitest';
import {
  emptyUsage,
  cloneUsage,
  isSameState,
  computeUsagePercent,
  colorForPct,
  fillClassForPct,
} from '../types';

describe('emptyUsage', () => {
  it('returns default state with all null/zero/false fields', () => {
    const state = emptyUsage();
    expect(state.usagePercent).toBeNull();
    expect(state.remainingMessages).toBeNull();
    expect(state.sessionLimit).toBeNull();
    expect(state.sessionMessagesUsed).toBeNull();
    expect(state.sessionWindowStartTs).toBeNull();
    expect(state.sessionWindowMs).toBe(0);
    expect(state.isRateLimited).toBe(false);
    expect(state.resetTimestamp).toBeNull();
    expect(state.countdownMs).toBeNull();
    expect(state.source).toBe('unknown');
    expect(state.confidence).toBe(0);
    expect(state.apiConnected).toBe(false);
    expect(state.apiErrorStatus).toBeNull();
    expect(state.limitType).toBe('unknown');
    expect(state.hardLimitResetAt).toBeNull();
    expect(state.orgId).toBeNull();
    expect(state.hasAccurateData).toBe(false);
    expect(state.planTier).toBe('unknown');
    expect(state.weeklyUsage).toBeNull();
    expect(state.weeklySonnetUsage).toBeNull();
    expect(state.weeklyOpusUsage).toBeNull();
    expect(state.isPeakHours).toBe(false);
    expect(state.peakHoursTransitionAt).toBeNull();
  });

  it('sets provided source', () => {
    expect(emptyUsage('network').source).toBe('network');
    expect(emptyUsage('banner').source).toBe('banner');
  });
});

describe('cloneUsage', () => {
  it('creates a shallow copy', () => {
    const state = emptyUsage('network');
    state.usagePercent = 45;
    state.isRateLimited = true;
    const clone = cloneUsage(state);
    expect(clone).toEqual(state);
    expect(clone).not.toBe(state);
  });

  it('clone is independent from original', () => {
    const state = emptyUsage();
    state.usagePercent = 50;
    const clone = cloneUsage(state);
    clone.usagePercent = 75;
    expect(state.usagePercent).toBe(50);
  });
});

describe('isSameState', () => {
  it('returns true for identical states', () => {
    const a = emptyUsage('network');
    const b = emptyUsage('network');
    expect(isSameState(a, b)).toBe(true);
  });

  it('returns false when usagePercent differs', () => {
    const a = emptyUsage();
    const b = emptyUsage();
    a.usagePercent = 50;
    b.usagePercent = 60;
    expect(isSameState(a, b)).toBe(false);
  });

  it('returns false when isRateLimited differs', () => {
    const a = emptyUsage();
    const b = emptyUsage();
    a.isRateLimited = true;
    expect(isSameState(a, b)).toBe(false);
  });

  it('returns false when resetTimestamp differs', () => {
    const a = emptyUsage();
    const b = emptyUsage();
    a.resetTimestamp = 1000;
    b.resetTimestamp = 2000;
    expect(isSameState(a, b)).toBe(false);
  });

  it('returns false when remainingMessages differs', () => {
    const a = emptyUsage();
    const b = emptyUsage();
    a.remainingMessages = 10;
    expect(isSameState(a, b)).toBe(false);
  });

  it('returns false when sessionLimit differs', () => {
    const a = emptyUsage();
    const b = emptyUsage();
    a.sessionLimit = 50;
    expect(isSameState(a, b)).toBe(false);
  });

  it('returns false when sessionMessagesUsed differs', () => {
    const a = emptyUsage();
    const b = emptyUsage();
    a.sessionMessagesUsed = 20;
    expect(isSameState(a, b)).toBe(false);
  });

  it('returns false when source differs', () => {
    const a = emptyUsage('network');
    const b = emptyUsage('banner');
    expect(isSameState(a, b)).toBe(false);
  });

  it('returns false when apiConnected differs', () => {
    const a = emptyUsage();
    const b = emptyUsage();
    a.apiConnected = true;
    expect(isSameState(a, b)).toBe(false);
  });

  it('returns false when limitType differs', () => {
    const a = emptyUsage();
    const b = emptyUsage();
    a.limitType = 'hard';
    expect(isSameState(a, b)).toBe(false);
  });

  it('returns false when orgId differs', () => {
    const a = emptyUsage();
    const b = emptyUsage();
    a.orgId = 'org-1';
    expect(isSameState(a, b)).toBe(false);
  });

  it('returns false when weekly usage percent differs', () => {
    const a = emptyUsage();
    const b = emptyUsage();
    a.weeklyUsage = { usagePercent: 50, messagesUsed: null, maxMessages: null, resetsAt: null };
    b.weeklyUsage = { usagePercent: 60, messagesUsed: null, maxMessages: null, resetsAt: null };
    expect(isSameState(a, b)).toBe(false);
  });

  it('returns true when both weeklyUsage are null', () => {
    const a = emptyUsage();
    const b = emptyUsage();
    expect(isSameState(a, b)).toBe(true);
  });

  it('returns false when weekly maxMessages differs', () => {
    const a = emptyUsage();
    const b = emptyUsage();
    a.weeklyUsage = { usagePercent: 50, messagesUsed: null, maxMessages: 100, resetsAt: null };
    b.weeklyUsage = { usagePercent: 50, messagesUsed: null, maxMessages: 200, resetsAt: null };
    expect(isSameState(a, b)).toBe(false);
  });
});

describe('computeUsagePercent', () => {
  it('computes from remaining messages and session limit', () => {
    const state = emptyUsage();
    state.remainingMessages = 10;
    state.sessionLimit = 40;
    expect(computeUsagePercent(state)).toBe(75);
  });

  it('caps at 100', () => {
    const state = emptyUsage();
    state.remainingMessages = 0;
    state.sessionLimit = 40;
    expect(computeUsagePercent(state)).toBe(100);
  });

  it('rounds to nearest integer', () => {
    const state = emptyUsage();
    state.remainingMessages = 7;
    state.sessionLimit = 40;
    expect(computeUsagePercent(state)).toBe(83);
  });

  it('computes from sessionMessagesUsed and sessionLimit', () => {
    const state = emptyUsage();
    state.remainingMessages = null;
    state.sessionMessagesUsed = 30;
    state.sessionLimit = 40;
    expect(computeUsagePercent(state)).toBe(75);
  });

  it('falls back to usagePercent when nothing else available', () => {
    const state = emptyUsage();
    state.usagePercent = 50;
    expect(computeUsagePercent(state)).toBe(50);
  });

  it('returns null when no data available', () => {
    expect(computeUsagePercent(emptyUsage())).toBeNull();
  });

  it('returns null when sessionLimit is 0', () => {
    const state = emptyUsage();
    state.remainingMessages = 10;
    state.sessionLimit = 0;
    expect(computeUsagePercent(state)).toBeNull();
  });

  it('returns usagePercent when sessionLimit is null but usagePercent is set', () => {
    const state = emptyUsage();
    state.remainingMessages = 10;
    state.usagePercent = 55;
    expect(computeUsagePercent(state)).toBe(55);
  });
});

describe('colorForPct', () => {
  it('returns danger for >= 90', () => {
    expect(colorForPct(90)).toBe('var(--danger)');
    expect(colorForPct(95)).toBe('var(--danger)');
    expect(colorForPct(100)).toBe('var(--danger)');
  });

  it('returns warn for 60-89', () => {
    expect(colorForPct(60)).toBe('var(--warn)');
    expect(colorForPct(75)).toBe('var(--warn)');
    expect(colorForPct(89)).toBe('var(--warn)');
  });

  it('returns safe for < 60', () => {
    expect(colorForPct(0)).toBe('var(--safe)');
    expect(colorForPct(30)).toBe('var(--safe)');
    expect(colorForPct(59)).toBe('var(--safe)');
  });
});

describe('fillClassForPct', () => {
  it('returns danger for >= 90', () => {
    expect(fillClassForPct(90)).toBe('danger');
    expect(fillClassForPct(95)).toBe('danger');
    expect(fillClassForPct(100)).toBe('danger');
  });

  it('returns warn for 60-89', () => {
    expect(fillClassForPct(60)).toBe('warn');
    expect(fillClassForPct(75)).toBe('warn');
    expect(fillClassForPct(89)).toBe('warn');
  });

  it('returns safe for < 60', () => {
    expect(fillClassForPct(0)).toBe('safe');
    expect(fillClassForPct(30)).toBe('safe');
    expect(fillClassForPct(59)).toBe('safe');
  });
});
