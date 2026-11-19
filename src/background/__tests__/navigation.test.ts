import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../backend/state-manager', () => ({
  initState: vi.fn(),
  startCountdownTicker: vi.fn(),
  onChange: vi.fn(),
  getState: () => null,
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('extension navigation', () => {
  it('opens Settings in the worker and reports success, rejection, and unauthorized senders', async () => {
    let listener: (message: unknown, sender: chrome.runtime.MessageSender, reply: (value: unknown) => void) => unknown;
    const openOptionsPage = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('chrome', {
      storage: { local: { get: vi.fn().mockResolvedValue({ settings: {} }) } },
      runtime: {
        id: 'extension',
        openOptionsPage,
        onMessage: {
          addListener: (handler: typeof listener) => {
            listener = handler;
          },
        },
      },
    });
    const { init } = await import('../init');
    await init();
    const reply = vi.fn();
    expect(listener!({ type: 'OPEN_SETTINGS' }, { id: 'extension', url: 'https://claude.ai/new' }, reply)).toBe(true);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ success: true }));
    expect(openOptionsPage).toHaveBeenCalledOnce();
    openOptionsPage.mockRejectedValueOnce(new Error('Unavailable'));
    reply.mockClear();
    listener!({ type: 'OPEN_SETTINGS' }, { id: 'extension' }, reply);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ success: false }));
    reply.mockClear();
    listener!({ type: 'OPEN_SETTINGS' }, { id: 'other' }, reply);
    expect(reply).toHaveBeenCalledWith({ success: false });
    expect(openOptionsPage).toHaveBeenCalledTimes(2);
  });
});
