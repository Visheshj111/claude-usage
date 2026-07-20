import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../storage', () => ({
  persistUsage: vi.fn(),
  loadPersisted: vi.fn(() => ({
    lastKnownUsage: {
      usagePercent: null,
      remainingMessages: null,
      sessionLimit: null,
      sessionMessagesUsed: null,
      sessionWindowStartTs: null,
      sessionWindowMs: 0,
      isRateLimited: false,
      resetTimestamp: null,
      countdownMs: null,
      source: 'unknown' as const,
      confidence: 0,
      apiConnected: false,
      apiErrorStatus: null,
      limitType: 'unknown' as const,
      hardLimitResetAt: null,
      orgId: null,
      hasAccurateData: false,
      planTier: 'unknown' as const,
      weeklyUsage: null,
      weeklySonnetUsage: null,
      weeklyOpusUsage: null,
      isPeakHours: false,
      peakHoursTransitionAt: null,
    },
    lastUpdated: 0,
    lastUrl: '',
    estimatedCount: { messagesSent: 0, messagesReceived: 0 },
  })),
}));

import {
  initState,
  getState,
  feedDetection,
  clearRateLimit,
  setApiConnected,
  setApiError,
  resetState,
  onChange,
  offChange,
  startCountdownTicker,
  stopCountdownTicker,
} from '../state-manager';

describe('state-manager', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T12:00:00Z'));
    await initState();
  });

  afterEach(() => {
    stopCountdownTicker();
    vi.useRealTimers();
  });

  describe('initState', () => {
    it('loads persisted state into current state', async () => {
      expect(getState().usagePercent).toBeNull();
      expect(getState().source).toBe('unknown');
    });
  });

  describe('getState', () => {
    it('returns current state', () => {
      const state = getState();
      expect(state).toBeDefined();
      expect(typeof state).toBe('object');
    });

    it('updates countdown when resetTimestamp is set', () => {
      feedDetection({
        source: 'network',
        confidence: 0.95,
        resetTimestamp: Date.now() + 50000,
        usagePercent: 50,
        sessionLimit: 40,
        remainingMessages: 20,
      });
      vi.advanceTimersByTime(10000);
      const state = getState();
      expect(state.countdownMs).toBe(40000);
    });
  });

  describe('feedDetection', () => {
    it('merges basic fields into state', () => {
      const result = feedDetection({
        source: 'network',
        confidence: 0.95,
        usagePercent: 75,
        sessionLimit: 40,
        remainingMessages: 10,
      });
      expect(result.usagePercent).toBe(75);
      expect(result.sessionLimit).toBe(40);
      expect(result.remainingMessages).toBe(10);
      expect(result.source).toBe('network');
      expect(result.confidence).toBe(0.95);
    });

    it('applies weighted merge for estimated source usagePercent', () => {
      feedDetection({ source: 'network', confidence: 0.9, usagePercent: 50 });
      const result = feedDetection({
        source: 'estimated',
        confidence: 0.3,
        usagePercent: 80,
      });
      expect(result.usagePercent).toBe(50);
    });

    it('overwrites usagePercent for non-estimated sources', () => {
      feedDetection({ source: 'network', confidence: 0.5, usagePercent: 50 });
      const result = feedDetection({
        source: 'banner',
        confidence: 0.7,
        usagePercent: 80,
      });
      expect(result.usagePercent).toBe(80);
    });

    it('respects source priority: does not downgrade from higher-priority source when confidence is lower', () => {
      feedDetection({ source: 'network', confidence: 0.9, usagePercent: 75 });
      const result = feedDetection({
        source: 'estimated',
        confidence: 0.3,
        usagePercent: 20,
      });
      expect(result.usagePercent).toBe(75);
    });

    it('allows update when same-priority source provides higher confidence', () => {
      feedDetection({ source: 'banner', confidence: 0.5, usagePercent: 40 });
      const result = feedDetection({
        source: 'banner',
        confidence: 0.7,
        usagePercent: 60,
      });
      expect(result.usagePercent).toBe(60);
    });

    it('does not apply cooldown for network source', () => {
      feedDetection({ source: 'network', confidence: 0.9, usagePercent: 75 });
      vi.advanceTimersByTime(1000);
      const result = feedDetection({
        source: 'network',
        confidence: 0.5,
        usagePercent: 50,
      });
      expect(result.usagePercent).toBe(50);
    });

    it('applies cooldown for low-confidence non-network sources', () => {
      feedDetection({ source: 'banner', confidence: 0.9, usagePercent: 80 });
      vi.advanceTimersByTime(1000);
      const result = feedDetection({
        source: 'banner',
        confidence: 0.3,
        usagePercent: 20,
      });
      expect(result.usagePercent).toBe(80);
    });

    it('allows update after cooldown period expires', () => {
      feedDetection({ source: 'banner', confidence: 0.9, usagePercent: 80 });
      vi.advanceTimersByTime(6000);
      const result = feedDetection({
        source: 'banner',
        confidence: 0.3,
        usagePercent: 20,
      });
      expect(result.usagePercent).toBe(20);
    });

    it('sets rate limited flag', () => {
      const result = feedDetection({
        source: 'network',
        confidence: 0.95,
        isRateLimited: true,
      });
      expect(result.isRateLimited).toBe(true);
    });

    it('sets limitType', () => {
      const result = feedDetection({
        source: 'network',
        confidence: 0.95,
        limitType: 'hard',
      });
      expect(result.limitType).toBe('hard');
    });

    it('sets hardLimitResetAt', () => {
      const ts = Date.now() + 3600000;
      const result = feedDetection({
        source: 'network',
        confidence: 0.95,
        hardLimitResetAt: ts,
      });
      expect(result.hardLimitResetAt).toBe(ts);
    });

    it('sets orgId', () => {
      const result = feedDetection({
        source: 'network',
        confidence: 0.95,
        orgId: 'org-abc',
      });
      expect(result.orgId).toBe('org-abc');
    });

    it('sets hasAccurateData', () => {
      const result = feedDetection({
        source: 'network',
        confidence: 0.95,
        hasAccurateData: true,
      });
      expect(result.hasAccurateData).toBe(true);
    });

    it('sets planTier', () => {
      const result = feedDetection({
        source: 'network',
        confidence: 0.95,
        planTier: 'pro',
      });
      expect(result.planTier).toBe('pro');
    });

    it('sets weekly usage fields', () => {
      const weeklyUsage = {
        usagePercent: 60,
        messagesUsed: 60,
        maxMessages: 100,
        resetsAt: Date.now() + 7 * 86400000,
      };
      const result = feedDetection({
        source: 'network',
        confidence: 0.95,
        weeklyUsage,
      });
      expect(result.weeklyUsage).toEqual(weeklyUsage);
    });

    it('sets weeklySonnetUsage', () => {
      const usage = {
        usagePercent: 40,
        messagesUsed: 20,
        maxMessages: 50,
        resetsAt: null,
      };
      const result = feedDetection({
        source: 'network',
        confidence: 0.95,
        weeklySonnetUsage: usage,
      });
      expect(result.weeklySonnetUsage).toEqual(usage);
    });

    it('sets weeklyOpusUsage', () => {
      const usage = {
        usagePercent: 10,
        messagesUsed: 2,
        maxMessages: 20,
        resetsAt: null,
      };
      const result = feedDetection({
        source: 'network',
        confidence: 0.95,
        weeklyOpusUsage: usage,
      });
      expect(result.weeklyOpusUsage).toEqual(usage);
    });

    it('sets isPeakHours', () => {
      const result = feedDetection({
        source: 'network',
        confidence: 0.95,
        isPeakHours: true,
      });
      expect(result.isPeakHours).toBe(true);
    });

    it('sets peakHoursTransitionAt', () => {
      const ts = Date.now() + 3600000;
      const result = feedDetection({
        source: 'network',
        confidence: 0.95,
        peakHoursTransitionAt: ts,
      });
      expect(result.peakHoursTransitionAt).toBe(ts);
    });

    it('sets resetTimestamp and updates countdown', () => {
      const reset = Date.now() + 60000;
      const result = feedDetection({
        source: 'network',
        confidence: 0.95,
        resetTimestamp: reset,
      });
      expect(result.resetTimestamp).toBe(reset);
      expect(result.countdownMs).toBe(60000);
    });

    it('derives sessionWindowStartTs from resetTimestamp and sessionWindowMs', () => {
      const reset = Date.now() + 60000;
      const result = feedDetection({
        source: 'network',
        confidence: 0.95,
        resetTimestamp: reset,
        sessionWindowMs: 5 * 60 * 60 * 1000,
      });
      expect(result.sessionWindowStartTs).toBe(reset - 5 * 60 * 60 * 1000);
    });

    it('uses explicit sessionWindowStartTs when provided', () => {
      const reset = Date.now() + 60000;
      const windowStart = Date.now() - 10000;
      const result = feedDetection({
        source: 'network',
        confidence: 0.95,
        resetTimestamp: reset,
        sessionWindowStartTs: windowStart,
        sessionWindowMs: 5 * 60 * 60 * 1000,
      });
      expect(result.sessionWindowStartTs).toBe(windowStart);
    });

    it('applies weight for estimated remaining messages', () => {
      feedDetection({ source: 'network', confidence: 0.9, remainingMessages: 30 });
      const result = feedDetection({
        source: 'estimated',
        confidence: 0.3,
        remainingMessages: 10,
      });
      expect(result.remainingMessages).toBe(30);
    });

    it('sets sessionMessagesUsed from detected value', () => {
      const result = feedDetection({
        source: 'network',
        confidence: 0.95,
        sessionMessagesUsed: 25,
      });
      expect(result.sessionMessagesUsed).toBe(25);
    });

    it('derives sessionMessagesUsed from usagePercent and sessionLimit', () => {
      const result = feedDetection({
        source: 'network',
        confidence: 0.95,
        usagePercent: 50,
        sessionLimit: 40,
      });
      expect(result.sessionMessagesUsed).toBe(20);
    });

    it('recalculates sessionMessagesUsed when both sessionLimit and remainingMessages exist', () => {
      const result = feedDetection({
        source: 'network',
        confidence: 0.95,
        sessionLimit: 40,
        remainingMessages: 10,
      });
      expect(result.sessionMessagesUsed).toBe(30);
    });

    it('handles retireAfterSeconds', () => {
      const result = feedDetection({
        source: 'network',
        confidence: 0.95,
        retireAfterSeconds: 120,
      });
      expect(result.resetTimestamp).toBe(Date.now() + 120000);
      expect(result.countdownMs).toBe(120000);
    });

    it('emits change when state differs', () => {
      const listener = vi.fn();
      onChange(listener);
      feedDetection({ source: 'network', confidence: 0.95, usagePercent: 50 });
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('does not emit change when state is unchanged (rate-limited false -> false)', () => {
      feedDetection({ source: 'network', confidence: 0.95, isRateLimited: false });
      const listener = vi.fn();
      onChange(listener);
      feedDetection({ source: 'network', confidence: 0.95, isRateLimited: false });
      expect(listener).not.toHaveBeenCalled();
    });

    it('does not overwrite source for computed source', () => {
      feedDetection({ source: 'network', confidence: 0.95, usagePercent: 50 });
      const result = feedDetection({ source: 'computed', confidence: 0.5 });
      expect(result.source).toBe('network');
    });

    it('adds sessionWindowMs detected value (only when resetTimestamp is also provided)', () => {
      const result = feedDetection({
        source: 'network',
        confidence: 0.95,
        sessionWindowMs: 18000000,
        resetTimestamp: Date.now() + 3600000,
      });
      expect(result.sessionWindowMs).toBe(18000000);
    });

    it('clears rate limited when detected with false', () => {
      feedDetection({ source: 'network', confidence: 0.95, isRateLimited: true });
      const result = feedDetection({ source: 'network', confidence: 0.95, isRateLimited: false });
      expect(result.isRateLimited).toBe(false);
    });
  });

  describe('clearRateLimit', () => {
    it('sets isRateLimited to false', () => {
      feedDetection({ source: 'network', confidence: 0.95, isRateLimited: true });
      expect(getState().isRateLimited).toBe(true);
      clearRateLimit();
      expect(getState().isRateLimited).toBe(false);
    });

    it('does nothing if already not rate limited', () => {
      const listener = vi.fn();
      onChange(listener);
      clearRateLimit();
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('setApiConnected', () => {
    it('sets apiConnected to true and clears error', () => {
      setApiError(401);
      setApiConnected(true);
      const state = getState();
      expect(state.apiConnected).toBe(true);
      expect(state.apiErrorStatus).toBeNull();
    });

    it('does nothing if already set', () => {
      setApiConnected(true);
      const listener = vi.fn();
      onChange(listener);
      setApiConnected(true);
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('setApiError', () => {
    it('sets apiConnected to false and records status', () => {
      setApiConnected(true);
      setApiError(429);
      const state = getState();
      expect(state.apiConnected).toBe(false);
      expect(state.apiErrorStatus).toBe(429);
    });

    it('does nothing if already set', () => {
      setApiError(500);
      const listener = vi.fn();
      onChange(listener);
      setApiError(500);
      expect(listener).not.toHaveBeenCalled();
    });

    it('updates when different status', () => {
      setApiError(500);
      setApiError(503);
      expect(getState().apiErrorStatus).toBe(503);
    });
  });

  describe('resetState', () => {
    it('resets to empty state', async () => {
      feedDetection({ source: 'network', confidence: 0.95, usagePercent: 80, isRateLimited: true });
      await resetState();
      const state = getState();
      expect(state.usagePercent).toBeNull();
      expect(state.isRateLimited).toBe(false);
      expect(state.source).toBe('unknown');
      expect(state.confidence).toBe(0);
    });
  });

  describe('onChange / offChange', () => {
    it('calls registered listener on state change', () => {
      const listener = vi.fn();
      onChange(listener);
      feedDetection({ source: 'network', confidence: 0.95, usagePercent: 50 });
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('provides new and old state to listener', () => {
      const listener = vi.fn();
      onChange(listener);
      feedDetection({ source: 'network', confidence: 0.95, usagePercent: 50 });
      const [newState, oldState] = listener.mock.calls[0];
      expect(newState.usagePercent).toBe(50);
      expect(oldState.usagePercent).toBeNull();
    });

    it('removes listener via offChange', () => {
      const listener = vi.fn();
      onChange(listener);
      offChange(listener);
      feedDetection({ source: 'network', confidence: 0.95, usagePercent: 50 });
      expect(listener).not.toHaveBeenCalled();
    });

    it('supports multiple listeners', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      onChange(listener1);
      onChange(listener2);
      feedDetection({ source: 'network', confidence: 0.95, usagePercent: 50 });
      expect(listener1).toHaveBeenCalledTimes(1);
      expect(listener2).toHaveBeenCalledTimes(1);
    });
  });

  describe('startCountdownTicker / stopCountdownTicker', () => {
    it('updates countdownMs every second', () => {
      feedDetection({
        source: 'network',
        confidence: 0.95,
        resetTimestamp: Date.now() + 10000,
      });
      const unsubscribe = startCountdownTicker();
      vi.advanceTimersByTime(3000);
      const state = getState();
      expect(state.countdownMs).toBe(7000);
      unsubscribe();
    });

    it('second start returns a no-op unsubscribe (no duplicate tickers)', () => {
      feedDetection({
        source: 'network',
        confidence: 0.95,
        resetTimestamp: Date.now() + 10000,
      });
      const listener = vi.fn();
      onChange(listener);
      const unsub1 = startCountdownTicker();
      const unsub2 = startCountdownTicker();
      // advance time - only one ticker should be running
      vi.advanceTimersByTime(2000);
      expect(listener).toHaveBeenCalled();
      unsub1();
      unsub2();
    });
  });
});
