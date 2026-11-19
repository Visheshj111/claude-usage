/// <reference types="vite/client" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import html from '../popup.html?raw';

let sendMessage: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 11, 12));
  document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} }));
  sendMessage = vi.fn(async ({ type }) => {
    if (type === 'GET_HISTORY') return [['2026-11-11', { messagesSent: 3 }]];
    return {
      daily: { tokensSent: 300, tokensReceived: 500 },
      remaining: {},
      settings: { themeMode: 'light' },
      sessionPct: null,
    };
  });
  vi.stubGlobal('chrome', {
    runtime: { sendMessage },
    storage: { local: { get: vi.fn().mockResolvedValue({ privacyAccepted: true }) } },
  });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function boot() {
  const spy = vi.spyOn(document, 'addEventListener');
  await import('../popup');
  const callback = spy.mock.calls.find(([event]) => event === 'DOMContentLoaded')![1] as EventListener;
  document.removeEventListener('DOMContentLoaded', callback);
  callback(new Event('DOMContentLoaded'));
  await vi.advanceTimersByTimeAsync(0);
}

it('shows unknown quotas and actual estimated daily tokens without a fabricated token cap', async () => {
  await boot();
  expect(document.getElementById('gauge-text')?.textContent).toBe('—');
  expect(document.getElementById('popup-tokens')?.textContent).toBe('800');
  expect(document.getElementById('metric-remain')?.textContent).toBe('—');
});

it('loads a local seven-day sparkline without refetching history each second', async () => {
  await boot();
  expect(document.getElementById('week-total')?.textContent).toContain('3');
  expect(document.querySelector('#week-chart svg')).not.toBeNull();
  await vi.advanceTimersByTimeAsync(3000);
  expect(sendMessage.mock.calls.filter(([message]) => message.type === 'GET_HISTORY')).toHaveLength(1);
});

it('shows an actionable navigation error when Settings cannot open', async () => {
  await boot();
  sendMessage.mockRejectedValueOnce(new Error('Unavailable'));
  document.getElementById('settings-btn')?.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(document.getElementById('popup-status')?.textContent).toMatch(/could not/i);
});

it('refreshes the sparkline immediately after clearing local history', async () => {
  await boot();
  vi.stubGlobal('confirm', () => true);
  sendMessage.mockImplementation(async ({ type }) => {
    if (type === 'RESET_USAGE') return { success: true };
    if (type === 'GET_HISTORY') return [];
    return { daily: {}, settings: { themeMode: 'light' } };
  });
  document.getElementById('reset-btn')?.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(document.getElementById('week-total')?.textContent).toBe('0 messages');
  expect(document.getElementById('week-chart')?.textContent).toMatch(/no activity/i);
});

it('reports a rejected clear request without losing the displayed history', async () => {
  await boot();
  vi.stubGlobal('confirm', () => true);
  sendMessage.mockResolvedValueOnce({ success: false });
  document.getElementById('reset-btn')?.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(document.getElementById('popup-status')?.textContent).toMatch(/could not clear/i);
  expect(document.getElementById('week-total')?.textContent).toContain('3');
});

it('renders the popup with Outfit and an elevated main card at a fixed toolbar width', async () => {
  await boot();
  const sharedCss = readFileSync(resolve(__dirname, '../../shared/ui.css'), 'utf8');
  const popupCss = readFileSync(resolve(__dirname, '../popup.css'), 'utf8');
  const style = document.createElement('style');
  style.textContent = `${sharedCss}\n${popupCss}`;
  document.head.append(style);

  expect(getComputedStyle(document.documentElement).getPropertyValue('--font')).toContain('Outfit');
  expect(getComputedStyle(document.body).width).toBe('390px');
  const cardShadow = getComputedStyle(document.getElementById('main-content')!).boxShadow;
  expect(cardShadow).not.toBe('none');
  expect(cardShadow).not.toBe('');
});
