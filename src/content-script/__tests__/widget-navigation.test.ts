import { afterEach, expect, it, vi } from 'vitest';
import { attachUIEvents, injectUI, renderUI } from '../ui-widget';

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

it('routes widget Settings through the worker and exposes failures', async () => {
  document.body.innerHTML = '<button id="cut-open-settings">Settings</button><p id="cut-action-status" hidden></p>';
  const sendMessage = vi.fn().mockResolvedValue({ success: true });
  vi.stubGlobal('chrome', { runtime: { id: 'extension', sendMessage } });
  vi.stubGlobal(
    'MutationObserver',
    class {
      observe() {}
    },
  );
  vi.stubGlobal('matchMedia', () => ({ addEventListener() {} }));
  attachUIEvents();
  document.querySelector<HTMLButtonElement>('button')!.click();
  await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: 'OPEN_SETTINGS' }));
  sendMessage.mockRejectedValueOnce(new Error('Extension context invalidated'));
  document.querySelector<HTMLButtonElement>('button')!.click();
  await vi.waitFor(() => expect(document.getElementById('cut-action-status')?.hidden).toBe(false));
  expect(document.getElementById('cut-action-status')?.textContent).toMatch(/reload/i);
});

function mountWidget() {
  vi.stubGlobal('chrome', {
    runtime: { id: 'extension' },
    storage: { local: { get: vi.fn().mockResolvedValue({ review_dismissed: true }) } },
  });
  vi.stubGlobal(
    'MutationObserver',
    class {
      observe() {}
    },
  );
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} }));
  injectUI();
}

it('leaves unknown quota blank while showing estimated daily tokens', () => {
  mountWidget();
  renderUI({ daily: { tokensSent: 200, tokensReceived: 600 }, sessionPct: null });
  expect(document.getElementById('cut-badge')?.textContent).toBe('—');
  expect(document.getElementById('cut-token-nums')?.textContent).toBe('800 est.');
});

it('moves keyboard focus into the expanded widget and back on minimize', () => {
  mountWidget();
  const badge = document.getElementById('cut-badge') as HTMLButtonElement;
  badge.focus();
  badge.click();
  expect(document.activeElement?.id).toBe('cut-force-reload');
  document.getElementById('cut-toggle-min')?.click();
  expect(document.activeElement).toBe(badge);
});
