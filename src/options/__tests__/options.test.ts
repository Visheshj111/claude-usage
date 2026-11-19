/// <reference types="vite/client" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import html from '../options.html?raw';

let sendMessage: ReturnType<typeof vi.fn>;
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} }));
  sendMessage = vi.fn().mockResolvedValue({ configured: false });
  vi.stubGlobal('chrome', {
    runtime: { sendMessage },
    storage: { local: { get: vi.fn().mockResolvedValue({ settings: { themeMode: 'light' } }) } },
  });
  const listener = vi.spyOn(document, 'addEventListener');
  await import('../options');
  const callback = listener.mock.calls.find(([event]) => event === 'DOMContentLoaded')![1] as EventListener;
  document.removeEventListener('DOMContentLoaded', callback);
  await callback(new Event('DOMContentLoaded'));
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('reports rejected saves without claiming success and permits retry', async () => {
  sendMessage.mockResolvedValueOnce({ success: false });
  el<HTMLSelectElement>('theme-mode').value = 'dark';
  el<HTMLButtonElement>('save-btn').click();
  await vi.advanceTimersByTimeAsync(0);
  expect(el('save-status').textContent).toMatch(/could not save/i);
  expect(el<HTMLButtonElement>('save-btn').disabled).toBe(false);
  expect(document.documentElement.classList.contains('dark')).toBe(false);
});

it('disables duplicate saves until confirmation and applies the confirmed theme', async () => {
  let resolve!: (value: unknown) => void;
  sendMessage.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  el<HTMLSelectElement>('theme-mode').value = 'dark';
  el<HTMLButtonElement>('save-btn').click();
  await vi.advanceTimersByTimeAsync(0);
  expect(el<HTMLButtonElement>('save-btn').disabled).toBe(true);
  resolve({ success: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(el('save-status').textContent).toMatch(/settings saved/i);
  expect(el<HTMLButtonElement>('save-btn').disabled).toBe(false);
  expect(document.documentElement.classList.contains('dark')).toBe(true);
});

it('does not claim data was deleted if the background rejects the request', async () => {
  vi.stubGlobal('confirm', () => true);
  sendMessage.mockResolvedValueOnce({ success: false });
  el<HTMLButtonElement>('reset-all-btn').click();
  await vi.advanceTimersByTimeAsync(0);
  expect(el('save-status').textContent).toMatch(/could not delete/i);
});

it('labels each settings select and provides a live save status', () => {
  for (const id of ['reset-period', 'token-method', 'theme-mode']) {
    expect(el<HTMLSelectElement>(id).labels?.length).toBeGreaterThan(0);
  }
  expect(el('save-status').getAttribute('role')).toBe('status');
});

it('spreads settings across the page with Outfit and professional cards', () => {
  const sharedCss = readFileSync(resolve(__dirname, '../../shared/ui.css'), 'utf8');
  const optionsCss = readFileSync(resolve(__dirname, '../options.css'), 'utf8');
  const style = document.createElement('style');
  style.textContent = `${sharedCss}\n${optionsCss}`;
  document.head.append(style);

  const appStyle = getComputedStyle(el('app'));
  expect(appStyle.width).toBe('100%');
  expect(appStyle.maxWidth).toBe('none');
  expect(getComputedStyle(document.documentElement).getPropertyValue('--font')).toContain('Outfit');
  const cardShadow = getComputedStyle(document.querySelector('section')!).boxShadow;
  expect(cardShadow).not.toBe('none');
  expect(cardShadow).not.toBe('');
});
