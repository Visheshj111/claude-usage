/// <reference types="vite/client" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import html from '../dashboard.html?raw';
let sendMessage: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 11, 12));
  document.documentElement.className = '';
  document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
  sendMessage = vi.fn(async ({ type }) => {
    if (type === 'GET_ALL_DATA')
      return {
        daily: { tokensSent: 250, tokensReceived: 500 },
        sessionPct: null,
        remaining: {},
        settings: { themeMode: 'light' },
      };
    if (type === 'GET_HISTORY')
      return [
        ['2026-11-01', { messagesSent: 8 }],
        ['2026-11-11', { messagesSent: 2, tokensSent: 250 }],
      ];
    if (type === 'GET_HOURLY_USAGE') return { '2026-11-11': [0, 2] };
    return { success: true };
  });
  vi.stubGlobal('chrome', {
    runtime: { sendMessage },
    storage: { local: { get: vi.fn().mockResolvedValue({ settings: {} }) }, onChanged: { addListener: vi.fn() } },
  });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} }));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function boot() {
  const spy = vi.spyOn(document, 'addEventListener');
  await import('../dashboard');
  const handler = spy.mock.calls.find(([event]) => event === 'DOMContentLoaded')?.[1] as EventListener;
  handler(new Event('DOMContentLoaded'));
  await vi.advanceTimersByTimeAsync(0);
}

it('filters calendar history and chart totals when the range changes', async () => {
  await boot();
  expect(document.getElementById('summary-messages')?.textContent).toBe('10');
  document.querySelector<HTMLButtonElement>('[data-range="7"]')?.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(document.getElementById('summary-messages')?.textContent).toBe('2');
  expect(document.querySelector('[data-range="7"]')?.getAttribute('aria-pressed')).toBe('true');
  expect(document.getElementById('history-body')?.textContent).not.toContain('Nov 1,');
  expect(sendMessage.mock.calls.filter(([message]) => message.type === 'GET_HISTORY')).toHaveLength(1);
});

it('displays unknown quota as unknown and labels tokens as estimates', async () => {
  await boot();
  expect(document.getElementById('quota-percent')?.textContent).toBe('—');
  expect(document.getElementById('today-tokens')?.textContent).toBe('750');
  expect(document.getElementById('quota-note')?.textContent).toMatch(/not available/i);
  expect(document.body.textContent).toContain('Estimated tokens');
});

it('reports refresh failure and always re-enables refresh', async () => {
  await boot();
  sendMessage.mockRejectedValueOnce(new Error('Worker unavailable'));
  document.getElementById('db-force-reload')?.click();
  await vi.advanceTimersByTimeAsync(0);
  expect((document.getElementById('db-force-reload') as HTMLButtonElement).disabled).toBe(false);
  expect(document.getElementById('page-status')?.textContent).toMatch(/could not/i);
  expect(document.getElementById('summary-messages')?.textContent).toBe('10');
});

it('uses the full dashboard width with Outfit and elevated cards', () => {
  const sharedCss = readFileSync(resolve(__dirname, '../../shared/ui.css'), 'utf8');
  const dashboardCss = readFileSync(resolve(__dirname, '../dashboard.css'), 'utf8');
  const style = document.createElement('style');
  style.textContent = `${sharedCss}\n${dashboardCss}`;
  document.head.append(style);

  const mainStyle = getComputedStyle(document.querySelector('main')!);
  expect(mainStyle.maxWidth).toBe('none');
  expect(mainStyle.marginLeft).not.toBe('auto');
  expect(getComputedStyle(document.documentElement).getPropertyValue('--font')).toContain('Outfit');
  const cardShadow = getComputedStyle(document.querySelector('.card')!).boxShadow;
  expect(cardShadow).not.toBe('none');
  expect(cardShadow).not.toBe('');
});
