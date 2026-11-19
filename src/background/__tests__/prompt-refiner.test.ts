// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearPromptRefinerApiKey,
  getRefinementOutputTokenLimit,
  getPromptRefinerErrorMessage,
  getPromptRefinerStatus,
  PromptRefinerError,
  refinePromptWithClaude,
  savePromptRefinerApiKey,
} from '../prompt-refiner';

vi.mock('../../backend/state-manager', () => ({
  initState: vi.fn(), startCountdownTicker: vi.fn(), onChange: vi.fn(), getState: () => null,
}));

const API_KEY_STORAGE_KEY = 'promptRefinerApiKey';
const CONFIG_STORAGE_KEY = 'promptRefinerConfig';
const permissionContains = vi.fn();
let sessionValues: Record<string, unknown>;
const sessionGet = vi.fn();
const sessionSet = vi.fn();
const sessionRemove = vi.fn();
const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('background prompt refiner', () => {
  beforeEach(() => {
    sessionValues = {};
    sessionGet.mockImplementation(async (keys: string | string[]) => Object.fromEntries(
      (Array.isArray(keys) ? keys : [keys]).map((key) => [key, sessionValues[key]]),
    ));
    sessionSet.mockImplementation(async (values: Record<string, unknown>) => {
      Object.assign(sessionValues, values);
    });
    sessionRemove.mockImplementation(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete sessionValues[key];
    });
    fetchMock.mockReset();
    permissionContains.mockReset().mockResolvedValue(true);

    vi.stubGlobal('chrome', {
      permissions: { contains: permissionContains },
      storage: {
        session: {
          get: sessionGet,
          set: sessionSet,
          remove: sessionRemove,
        },
      },
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('stores a trimmed API key in session-only storage and never returns it', async () => {
    await expect(savePromptRefinerApiKey('  sk-ant-example  ')).resolves.toMatchObject({ configured: true });
    expect(sessionValues[API_KEY_STORAGE_KEY]).toBe('sk-ant-example');
    expect(sessionValues[CONFIG_STORAGE_KEY]).toMatchObject({ provider: 'anthropic' });
    const status = await getPromptRefinerStatus();
    expect(status).toMatchObject({ configured: true, config: { provider: 'anthropic' } });
    expect(JSON.stringify(status)).not.toContain('sk-ant-example');
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(clearPromptRefinerApiKey()).resolves.toEqual({ configured: false });
    expect(sessionValues).toEqual({});
    await expect(getPromptRefinerStatus()).resolves.toEqual({ configured: false });
  });

  it('routes options messages through the worker and keeps content scripts away from credentials and configuration', async () => {
    vi.resetModules();
    let listener!: (message: unknown, sender: chrome.runtime.MessageSender, reply: (value: unknown) => void) => unknown;
    vi.stubGlobal('chrome', {
      ...chrome,
      storage: { ...chrome.storage, local: { get: vi.fn().mockResolvedValue({ settings: {} }) } },
      runtime: {
        id: 'extension', getURL: (path: string) => `chrome-extension://extension/${path}`,
        onMessage: { addListener: (handler: typeof listener) => { listener = handler; } },
      },
    });
    const { init } = await import('../init');
    await init();
    const options = { id: 'extension', url: 'chrome-extension://extension/dist/options/options.html' };
    const content = { id: 'extension', url: 'https://claude.ai/new' };
    const message = (value: unknown, sender = options) => new Promise((reply) => listener(value, sender, reply));
    const config = { provider: 'custom', model: 'test-model', baseUrl: 'https://api.example.com/v1' };
    const saved = await message({ type: 'SAVE_REFINER_API_KEY', apiKey: 'opaque-example', config });
    expect(saved).toEqual({ success: true, configured: true, config });
    expect(JSON.stringify(saved)).not.toContain('opaque-example');
    expect(await message({ type: 'GET_REFINER_STATUS' })).toEqual({ configured: true, config });
    expect(await message({ type: 'GET_REFINER_STATUS' }, content)).toEqual({ configured: true });
    expect(await message({ type: 'CLEAR_REFINER_API_KEY' }, content)).toMatchObject({ success: false });
    expect(await message({ type: 'SAVE_REFINER_API_KEY', apiKey: 'bad-key', config }, content)).toMatchObject({ success: false });
    expect(sessionValues[API_KEY_STORAGE_KEY]).toBe('opaque-example');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await message({ type: 'REFINE_PROMPT', prompt: 'Draft' }, options)).toMatchObject({ ok: false });
    fetchMock.mockResolvedValue(jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: 'Better draft' } }] }));
    const refined = await message({ type: 'REFINE_PROMPT', prompt: 'Draft', config: { baseUrl: 'https://other.example' } }, content);
    expect(refined).toMatchObject({ ok: true, result: { refined: 'Better draft', provider: 'custom' } });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/v1/chat/completions');
    const failed = await message({ type: 'SAVE_REFINER_API_KEY', apiKey: 'sk-or-v1-example', config: { provider: 'anthropic' } });
    expect(failed).toMatchObject({ success: false, error: expect.stringContaining('OpenRouter') });
    expect(JSON.stringify(failed)).not.toContain('sk-or-v1-example');
    expect(sessionValues[API_KEY_STORAGE_KEY]).toBe('opaque-example');
  });

  it('treats whitespace-only stored credentials as unconfigured', async () => {
    sessionValues[API_KEY_STORAGE_KEY] = '   ';

    await expect(getPromptRefinerStatus()).resolves.toEqual({ configured: false });
  });

  it('does not make a request for absent, blank, or oversized drafts', async () => {
    await expect(refinePromptWithClaude('')).rejects.toMatchObject({ code: 'empty-prompt' });
    await expect(refinePromptWithClaude('a'.repeat(24_001))).rejects.toMatchObject({ code: 'prompt-too-large' });
    await expect(refinePromptWithClaude('A real draft')).rejects.toMatchObject({ code: 'not-configured' });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('calls the official Messages API and returns a real refinement', async () => {
    sessionValues[API_KEY_STORAGE_KEY] = 'sk-ant-test-key';
    fetchMock.mockResolvedValue(jsonResponse({
      content: [{ type: 'text', text: 'Write a concise release note. Include the customer impact.' }],
      stop_reason: 'end_turn',
    }));

    const result = await refinePromptWithClaude('write a release note');

    expect(result).toMatchObject({
      original: 'write a release note',
      refined: 'Write a concise release note. Include the customer impact.',
      changed: true,
      method: 'claude',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(url).not.toContain('claude.ai');
    expect(request.method).toBe('POST');
    expect(request.credentials).toBe('omit');
    expect(request.redirect).toBe('error');
    expect(request.headers).toMatchObject({
      'content-type': 'application/json',
      'x-api-key': 'sk-ant-test-key',
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    });

    const body = JSON.parse(String(request.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1200,
      messages: [{ role: 'user' }],
    });
    expect(body).not.toHaveProperty('stream');
    expect(JSON.stringify(body)).toContain('write a release note');
  });

  it.each([
    ['openrouter', 'sk-or-v1-example', 'https://openrouter.ai/api/v1/chat/completions', 'openrouter/free'],
    ['openai', 'sk-proj-example', 'https://api.openai.com/v1/chat/completions', 'gpt-6-luna'],
    ['gemini', 'AIza-example', 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', 'gemini-3.8-flash'],
  ])('routes a %s key only to its selected service using a default model', async (provider, key, url, model) => {
    await savePromptRefinerApiKey(key, { provider });
    fetchMock.mockResolvedValue(jsonResponse({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'A clearer draft.' } }],
    }));
    await expect(refinePromptWithClaude('Draft')).resolves.toMatchObject({
      refined: 'A clearer draft.', provider, method: 'ai',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [actualUrl, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(actualUrl).toBe(url);
    expect(request.headers).toMatchObject({ Authorization: `Bearer ${key}` });
    expect(request.headers).not.toHaveProperty('x-api-key');
    expect(request.credentials).toBe('omit');
    expect(request.redirect).toBe('error');
    const body = JSON.parse(String(request.body));
    expect(body).toMatchObject({ model, messages: [{ role: 'system' }, { role: 'user' }] });
    expect(body.messages[1].content).toContain('Draft');
    expect(body).not.toHaveProperty('models');
    if (provider === 'openai') {
      expect(body).toMatchObject({ max_completion_tokens: 1200, reasoning_effort: 'none' });
      expect(body).not.toHaveProperty('max_tokens');
    } else {
      expect(body.max_tokens).toBe(5296);
      if (provider === 'gemini') expect(body.reasoning_effort).toBe('minimal');
      if (provider === 'openrouter') expect(body.reasoning).toEqual({ effort: 'low', exclude: true });
    }
  });

  it('recognizes an OpenRouter key saved by the previous version without sending it to Anthropic', async () => {
    sessionValues[API_KEY_STORAGE_KEY] = 'sk-or-v1-legacy';
    fetchMock.mockResolvedValue(jsonResponse({
      choices: [{ finish_reason: 'stop', message: { content: 'Better draft' } }],
    }));
    await refinePromptWithClaude('Draft');
    expect(fetchMock.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/chat/completions');
  });

  it('uses a custom HTTPS endpoint and model only with its matching host permission', async () => {
    await savePromptRefinerApiKey('provider-example', {
      provider: 'custom', baseUrl: 'https://api.example.com/v1/', model: 'my-model',
    });
    fetchMock.mockResolvedValue(jsonResponse({
      choices: [{ finish_reason: 'stop', message: { content: 'Better draft' } }],
    }));
    await refinePromptWithClaude('Draft');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/v1/chat/completions');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe('my-model');
    expect(permissionContains).toHaveBeenCalledWith({ origins: ['https://api.example.com/*'] });
  });

  it('requests a Chrome host pattern without a port while keeping the custom request port', async () => {
    await savePromptRefinerApiKey('provider-example', {
      provider: 'custom', baseUrl: 'https://api.example.com:8443/v1', model: 'my-model',
    });
    fetchMock.mockResolvedValue(jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: 'Better' } }] }));
    await refinePromptWithClaude('Draft');
    expect(permissionContains).toHaveBeenCalledWith({ origins: ['https://api.example.com/*'] });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com:8443/v1/chat/completions');
  });

  it('allows model changes without repasting a key, but never reuses it for another endpoint', async () => {
    await savePromptRefinerApiKey('provider-example', {
      provider: 'custom', baseUrl: 'https://api.example.com/v1', model: 'first',
    });
    await savePromptRefinerApiKey('', {
      provider: 'custom', baseUrl: 'https://api.example.com/v1', model: 'second',
    });
    expect(sessionValues[CONFIG_STORAGE_KEY]).toMatchObject({ model: 'second' });
    await expect(savePromptRefinerApiKey('', {
      provider: 'custom', baseUrl: 'https://other.example.com/v1', model: 'second',
    })).rejects.toThrow(/paste.*key/i);
    expect(sessionValues[CONFIG_STORAGE_KEY]).toMatchObject({ baseUrl: 'https://api.example.com/v1' });
  });

  it('does not store credentials or send drafts when permission is denied or revoked', async () => {
    permissionContains.mockResolvedValue(false);
    await expect(savePromptRefinerApiKey('sk-or-v1-example', { provider: 'openrouter' }))
      .rejects.toMatchObject({ code: 'permission-required' });
    expect(sessionValues).toEqual({});
    sessionValues[API_KEY_STORAGE_KEY] = 'sk-or-v1-example';
    await expect(refinePromptWithClaude('Draft')).rejects.toMatchObject({ code: 'permission-required' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects provider mismatch and malformed settings before storing or sending a key', async () => {
    await expect(savePromptRefinerApiKey('sk-or-v1-example', { provider: 'anthropic' })).rejects.toThrow();
    await expect(savePromptRefinerApiKey('unknown-key', { provider: 'not-real' })).rejects.toThrow();
    await expect(savePromptRefinerApiKey('unknown-key', { provider: 'custom', baseUrl: 'http://insecure.test', model: 'x' })).rejects.toThrow();
    expect(sessionValues).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [402, {}, 'insufficient-credits'],
    [429, { error: { code: 'insufficient_quota' } }, 'insufficient-credits'],
    [404, {}, 'model-unavailable'],
    [403, {}, 'access-denied'],
    [400, { error: { code: 'API_KEY_INVALID' } }, 'invalid-api-key'],
    [400, {}, 'invalid-request'],
    [503, {}, 'request-failed'],
    [200, { error: { code: 402, message: 'secret server detail' } }, 'insufficient-credits'],
  ])('maps HTTP %s to an actionable safe error (%s)', async (status, body, code) => {
    await savePromptRefinerApiKey('sk-or-v1-example', { provider: 'openrouter' });
    fetchMock.mockResolvedValue(jsonResponse(body, status));
    await expect(refinePromptWithClaude('Draft')).rejects.toMatchObject({ code });
    expect(getPromptRefinerErrorMessage(new PromptRefinerError(code as never))).not.toContain('secret server detail');
  });

  it('does not retry another provider or offer incomplete chat output', async () => {
    await savePromptRefinerApiKey('sk-or-v1-example', { provider: 'openrouter' });
    fetchMock.mockResolvedValue(jsonResponse({
      choices: [{ finish_reason: 'length', message: { content: 'Partial' } }],
    }));
    await expect(refinePromptWithClaude('Draft')).rejects.toMatchObject({ code: 'invalid-response' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('aborts a stalled provider request and never retries with a different destination', async () => {
    vi.useFakeTimers();
    try {
      await savePromptRefinerApiKey('sk-or-v1-example', { provider: 'openrouter' });
      fetchMock.mockImplementation((_url: string, request: RequestInit) => new Promise((_resolve, reject) => {
        request.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }));
      const failure = expect(refinePromptWithClaude('Draft')).rejects.toMatchObject({ code: 'request-failed' });
      await vi.advanceTimersByTimeAsync(45_000);
      await failure;
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves HTTP authentication errors even when the response is not JSON', async () => {
    await savePromptRefinerApiKey('sk-or-v1-example');
    fetchMock.mockResolvedValue(new Response('not-json', { status: 401 }));
    await expect(refinePromptWithClaude('Draft')).rejects.toMatchObject({ code: 'invalid-api-key' });
  });

  it('scales the output ceiling for a longer draft so preservation is not forced into a short rewrite', async () => {
    sessionValues[API_KEY_STORAGE_KEY] = 'sk-ant-test-key';
    fetchMock.mockResolvedValue(jsonResponse({
      content: [{ type: 'text', text: 'A refined long prompt.' }],
      stop_reason: 'end_turn',
    }));

    const longDraft = 'x'.repeat(6_000);
    expect(getRefinementOutputTokenLimit(longDraft)).toBe(2_000);
    await refinePromptWithClaude(longDraft);

    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(request.body))).toMatchObject({ max_tokens: 2_000 });
  });

  it('never accepts partial or invalid model output as a replacement', async () => {
    sessionValues[API_KEY_STORAGE_KEY] = 'sk-ant-test-key';
    fetchMock.mockResolvedValueOnce(jsonResponse({
      stop_reason: 'max_tokens',
      content: [{ type: 'text', text: 'Partial prompt' }],
    }));
    await expect(refinePromptWithClaude('Draft')).rejects.toMatchObject({ code: 'invalid-response' });

    fetchMock.mockResolvedValueOnce(jsonResponse({ content: [{ type: 'tool_use', name: 'x' }] }));
    await expect(refinePromptWithClaude('Draft')).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it('maps remote failures to safe user-facing errors without exposing an API key or response body', async () => {
    sessionValues[API_KEY_STORAGE_KEY] = 'sk-ant-secret';
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: 'secret server detail' } }, 401));
    await expect(refinePromptWithClaude('Draft')).rejects.toMatchObject({ code: 'invalid-api-key' });

    fetchMock.mockResolvedValueOnce(jsonResponse({}, 429));
    await expect(refinePromptWithClaude('Draft')).rejects.toMatchObject({ code: 'rate-limited' });

    fetchMock.mockRejectedValueOnce(new Error('network failure'));
    await expect(refinePromptWithClaude('Draft')).rejects.toMatchObject({ code: 'request-failed' });

    expect(getPromptRefinerErrorMessage(new PromptRefinerError('invalid-api-key'))).not.toContain('sk-ant-secret');
    expect(getPromptRefinerErrorMessage(new PromptRefinerError('request-failed'))).not.toContain('secret server detail');
  });
});
