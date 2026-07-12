import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseBannerText, extractTimeFromText } from '../dom-detector';

describe('parseBannerText', () => {
  it('detects "rate limit" pattern', () => {
    const result = parseBannerText('You have hit the rate limit. Try again later.');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('rate-limited');
    expect(result!.limitType).toBe('soft');
  });

  it('detects "usage limit reached" pattern', () => {
    const result = parseBannerText('Usage limit reached. Available again at 3:45 PM');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('rate-limited');
    expect(result!.value).toBeGreaterThan(0);
  });

  it('detects "message limit reached" pattern', () => {
    const result = parseBannerText('Message limit reached. You are in cooldown.');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('rate-limited');
    expect(result!.limitType).toBe('hard');
  });

  it('detects "usage limit exceeded" pattern', () => {
    const result = parseBannerText('Usage limit exceeded. Please wait.');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('rate-limited');
  });

  it('detects "try again later" pattern', () => {
    const result = parseBannerText('Sorry, try again later.');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('rate-limited');
    expect(result!.limitType).toBe('soft');
  });

  it('detects "try again much later" with cooldown as hard limit', () => {
    const result = parseBannerText('Try again much later. Rate limited.');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('rate-limited');
    expect(result!.limitType).toBe('hard');
  });

  it('detects "too many requests" pattern', () => {
    const result = parseBannerText('Too many requests. Try again later.');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('rate-limited');
  });

  it('detects "you have been rate limited" pattern', () => {
    const result = parseBannerText('You have been rate limited. Cooldown active.');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('rate-limited');
    expect(result!.limitType).toBe('hard');
  });

  it('detects "you\'ve reached" limit pattern', () => {
    const result = parseBannerText("You've reached your usage limit for this window.");
    expect(result).not.toBeNull();
    expect(result!.type).toBe('rate-limited');
  });

  it('detects "you\'ve hit" limit pattern', () => {
    const result = parseBannerText("You've hit the message limit for today.");
    expect(result).not.toBeNull();
    expect(result!.type).toBe('rate-limited');
  });

  it('detects "available again" pattern with cooldown as hard', () => {
    const result = parseBannerText('Available again at 5:00 PM. Cooldown in progress.');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('reset-time');
    expect(result!.limitType).toBe('hard');
    expect(result!.hardLimitResetAt).toBeGreaterThan(0);
  });

  it('detects "available again" without cooldown', () => {
    const result = parseBannerText('Available again at 1:30 PM');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('reset-time');
    expect(result!.limitType).toBeUndefined();
    expect(result!.hardLimitResetAt).toBeUndefined();
  });

  it('detects usage percent in text', () => {
    const result = parseBannerText('75% used of your 5-hour window');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('usage-percent');
    expect(result!.value).toBe(75);
  });

  it('detects usage percent with "complete" keyword', () => {
    const result = parseBannerText('90% complete for this period');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('usage-percent');
    expect(result!.value).toBe(90);
  });

  it('detects usage percent with "full" keyword', () => {
    const result = parseBannerText('50% full');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('usage-percent');
    expect(result!.value).toBe(50);
  });

  it('detects remaining messages with "remaining" keyword', () => {
    const result = parseBannerText('15 messages remaining in this window');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('remaining');
    expect(result!.value).toBe(15);
  });

  it('detects remaining messages with "left" keyword', () => {
    const result = parseBannerText('8 messages left today');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('remaining');
    expect(result!.value).toBe(8);
  });

  it('detects singular "message"', () => {
    const result = parseBannerText('1 message remaining');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('remaining');
    expect(result!.value).toBe(1);
  });

  it('returns null for unrelated text', () => {
    expect(parseBannerText('Hello, how are you today?')).toBeNull();
    expect(parseBannerText('This is a normal conversation about programming.')).toBeNull();
    expect(parseBannerText('')).toBeNull();
  });

  it('returns null for generic text without match', () => {
    expect(parseBannerText('The weather is nice today.')).toBeNull();
  });

  it('truncates text field to 200 chars', () => {
    const long = 'x'.repeat(300) + ' rate limit';
    const result = parseBannerText(long);
    expect(result!.text.length).toBeLessThanOrEqual(200);
  });

  it('case insensitive matching', () => {
    const result = parseBannerText('RATE LIMIT REACHED');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('rate-limited');
  });
});

describe('extractTimeFromText', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('parses "available again in X hours Y minutes"', () => {
    const result = extractTimeFromText('Available again in 3 hours 12 minutes');
    expect(result).toBe(Date.now() + 3 * 3600000 + 12 * 60000);
  });

  it('parses "in X minutes"', () => {
    const result = extractTimeFromText('Try again in 30 minutes');
    expect(result).toBe(Date.now() + 30 * 60000);
  });

  it('parses "in X hours"', () => {
    const result = extractTimeFromText('Available again in 2 hours');
    expect(result).toBe(Date.now() + 2 * 3600000);
  });

  it('parses "in X seconds"', () => {
    const result = extractTimeFromText('Try again in 45 seconds');
    expect(result).toBe(Date.now() + 45 * 1000);
  });

  it('parses "available again at" with absolute time', () => {
    const result = extractTimeFromText('Available again at 2:30 PM');
    expect(result).not.toBeNull();
    expect(result).toBeGreaterThan(Date.now());
  });

  it('parses ISO timestamp', () => {
    const result = extractTimeFromText('Reset at 2024-01-02T00:00:00Z');
    const isoMatch = '2024-01-02T00:00:00Z'.match(/([\d]{4}-[\d]{2}-[\d]{2}[T ][\d]{2}:[\d]{2})/);
    expect(result).toBe(new Date(isoMatch![1]).getTime());
  });

  it('returns null for text without time info', () => {
    expect(extractTimeFromText('Just some random text')).toBeNull();
  });

  it('returns null for empty text', () => {
    expect(extractTimeFromText('')).toBeNull();
  });
});
