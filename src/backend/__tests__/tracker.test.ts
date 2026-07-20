import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const feedDetection = vi.fn();
const clearRateLimit = vi.fn();
const getState = vi.fn();
const detectUsage = vi.fn().mockReturnValue(null);
const retryAfterToTimestamp = vi.fn();

vi.mock('../state-manager', () => ({
  feedDetection,
  clearRateLimit,
  getState,
}));

vi.mock('../dom-detector', () => ({
  detectUsage,
}));

vi.mock('../reset-parser', () => ({
  retryAfterToTimestamp,
}));

type Tracker = typeof import('../tracker');
let tracker: Tracker;

describe('tracker', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T12:00:00Z'));
    vi.clearAllMocks();
    vi.resetModules();
    tracker = await import('../tracker');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('handleNetworkQuota', () => {
    it('computes usagePercent from remaining and limit', () => {
      tracker.handleNetworkQuota({ remaining: 20, limit: 40 });

      expect(feedDetection).toHaveBeenCalledTimes(1);
      expect(feedDetection).toHaveBeenCalledWith(
        expect.objectContaining({
          usagePercent: 50,
          remainingMessages: 20,
          confidence: 0.95,
          source: 'network',
          hasAccurateData: true,
        }),
      );
    });

    it('correctly rounds usagePercent', () => {
      tracker.handleNetworkQuota({ remaining: 17, limit: 40 });

      expect(feedDetection).toHaveBeenCalledWith(
        expect.objectContaining({ usagePercent: 57 }),
      );
    });

    it('sets isRateLimited when remaining is 0', () => {
      tracker.handleNetworkQuota({ remaining: 0, limit: 40 });

      expect(feedDetection).toHaveBeenCalledWith(
        expect.objectContaining({
          usagePercent: 100,
          remainingMessages: 0,
          isRateLimited: true,
        }),
      );
    });

    it('handles only remaining without limit', () => {
      tracker.handleNetworkQuota({ remaining: 15 });

      expect(feedDetection).toHaveBeenCalledWith(
        expect.objectContaining({
          remainingMessages: 15,
          hasAccurateData: true,
        }),
      );
      // usagePercent should not be set when only remaining is known
      const call = feedDetection.mock.calls[0][0];
      expect(call.usagePercent).toBeUndefined();
    });

    it('sets resetTimestamp when reset is provided', () => {
      const reset = Date.now() + 3600000;
      tracker.handleNetworkQuota({ remaining: 20, limit: 40, reset });

      expect(feedDetection).toHaveBeenCalledWith(
        expect.objectContaining({
          resetTimestamp: reset,
          remainingMessages: 20,
          usagePercent: 50,
        }),
      );
    });

    it('handles retry-after by computing reset timestamp', () => {
      retryAfterToTimestamp.mockReturnValue(Date.now() + 120000);

      tracker.handleNetworkQuota({ remaining: 0, limit: 40, retryAfter: 120 });

      expect(retryAfterToTimestamp).toHaveBeenCalledWith(120);
      expect(feedDetection).toHaveBeenCalledWith(
        expect.objectContaining({
          resetTimestamp: Date.now() + 120000,
          usagePercent: 100,
          remainingMessages: 0,
          isRateLimited: true,
        }),
      );
    });

    it('passes through limitType', () => {
      tracker.handleNetworkQuota({ remaining: 0, limit: 40, limitType: 'hard' });

      expect(feedDetection).toHaveBeenCalledWith(
        expect.objectContaining({ limitType: 'hard' }),
      );
    });

    it('passes through hardLimitResetAt', () => {
      const ts = Date.now() + 7200000;
      tracker.handleNetworkQuota({ remaining: 0, limit: 40, hardLimitResetAt: ts });

      expect(feedDetection).toHaveBeenCalledWith(
        expect.objectContaining({ hardLimitResetAt: ts }),
      );
    });

    it('passes through orgId', () => {
      tracker.handleNetworkQuota({ remaining: 20, limit: 40, orgId: 'org-xyz' });

      expect(feedDetection).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: 'org-xyz' }),
      );
    });

    it('sets isRateLimited to false when remaining > 0 and no reset', () => {
      tracker.handleNetworkQuota({ remaining: 15, limit: 40 });

      expect(feedDetection).toHaveBeenCalledWith(
        expect.objectContaining({
          remainingMessages: 15,
          usagePercent: 63,
          isRateLimited: false,
        }),
      );
    });

    it('always sets hasAccurateData true', () => {
      tracker.handleNetworkQuota({ remaining: 5, limit: 10 });

      expect(feedDetection).toHaveBeenCalledWith(
        expect.objectContaining({ hasAccurateData: true }),
      );
    });

    it('caps usagePercent at 100', () => {
      tracker.handleNetworkQuota({ remaining: 0, limit: 1 });

      expect(feedDetection).toHaveBeenCalledWith(
        expect.objectContaining({ usagePercent: 100 }),
      );
    });

    it('does not set isRateLimited when remaining > 0 and reset present (since remaining > 0, isRateLimited stays undefined)', () => {
      tracker.handleNetworkQuota({ remaining: 5, limit: 10, reset: Date.now() + 3600000 });

      expect(feedDetection).toHaveBeenCalledWith(
        expect.objectContaining({
          remainingMessages: 5,
          usagePercent: 50,
          resetTimestamp: Date.now() + 3600000,
        }),
      );
      const call = feedDetection.mock.calls[0][0];
      expect(call.isRateLimited).toBeUndefined();
    });

    it('ignores retry-after of 0 or negative', () => {
      tracker.handleNetworkQuota({ remaining: 10, limit: 20, retryAfter: 0 });
      expect(retryAfterToTimestamp).not.toHaveBeenCalled();
    });
  });

  describe('runDetection', () => {
    it('calls detectUsage and feedDetection when DOM result found', () => {
      getState.mockReturnValue({ isRateLimited: false });
      detectUsage.mockReturnValue({
        source: 'banner',
        confidence: 0.5,
        usagePercent: 70,
      });

      tracker.runDetection('navigation');

      expect(detectUsage).toHaveBeenCalled();
      expect(feedDetection).toHaveBeenCalledWith(
        expect.objectContaining({ usagePercent: 70 }),
      );
    });

    it('calls clearRateLimit when no rate limit found and current source allows', () => {
      detectUsage.mockReturnValue(null);
      getState.mockReturnValue({
        isRateLimited: true,
        source: 'banner',
      });

      tracker.runDetection('navigation');

      expect(clearRateLimit).toHaveBeenCalled();
    });

    it('does not clear rate limit when source is network', () => {
      detectUsage.mockReturnValue(null);
      getState.mockReturnValue({
        isRateLimited: true,
        source: 'network',
      });

      tracker.runDetection('navigation');

      expect(clearRateLimit).not.toHaveBeenCalled();
    });
  });

  describe('estimateUsage', () => {
    it('does nothing when knownLimit is null', () => {
      tracker.estimateUsage(5, 3, null);
      expect(feedDetection).not.toHaveBeenCalled();
    });

    it('does nothing when knownLimit is 0', () => {
      tracker.estimateUsage(5, 3, 0);
      expect(feedDetection).not.toHaveBeenCalled();
    });

    it('computes usage from message counts', () => {
      tracker.estimateUsage(10, 5, 40);

      expect(feedDetection).toHaveBeenCalledWith(
        expect.objectContaining({
          usagePercent: 38,
          remainingMessages: 25,
          confidence: 0.3,
          source: 'estimated',
          isRateLimited: false,
        }),
      );
    });

    it('caps usagePercent at 100', () => {
      tracker.estimateUsage(30, 20, 40);

      expect(feedDetection).toHaveBeenCalledWith(
        expect.objectContaining({ usagePercent: 100 }),
      );
    });

    it('sets isRateLimited when total >= knownLimit', () => {
      tracker.estimateUsage(20, 20, 40);

      expect(feedDetection).toHaveBeenCalledWith(
        expect.objectContaining({
          usagePercent: 100,
          isRateLimited: true,
          remainingMessages: 0,
        }),
      );
    });

    it('estimates resetTimestamp when sessionWindowMs is provided', () => {
      tracker.estimateUsage(10, 5, 40, 18000000);

      const expectedPct = 38;
      const elapsed = Math.round((expectedPct / 100) * 18000000);
      const windowStart = Date.now() - elapsed;
      const resetTs = windowStart + 18000000;

      expect(feedDetection).toHaveBeenCalledWith(
        expect.objectContaining({ resetTimestamp: resetTs }),
      );
    });
  });

  describe('startPeriodicScan', () => {
    it('calls detectUsage at interval via startPeriodicScan', () => {
      getState.mockReturnValue({ isRateLimited: false });
      const unsubscribe = tracker.startPeriodicScan(5000);
      vi.advanceTimersByTime(10000);
      expect(detectUsage).toHaveBeenCalledTimes(2);
      unsubscribe();
    });

    it('returns unsubscribe function that stops interval', () => {
      const spy = vi.spyOn(tracker, 'runDetection');
      const unsubscribe = tracker.startPeriodicScan(5000);
      unsubscribe();
      vi.advanceTimersByTime(10000);
      expect(spy).not.toHaveBeenCalled();
    });
  });
});
