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

const API_KEY_STORAGE_KEY = 'promptRefinerApiKey';
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
    sessionGet.mockImplementation(async (key: string) => ({ [key]: sessionValues[key] }));
    sessionSet.mockImplementation(async (values: Record<string, unknown>) => {
      Object.assign(sessionValues, values);
    });
    sessionRemove.mockImplementation(async (key: string) => {
      delete sessionValues[key];
    });
    fetchMock.mockReset();

    vi.stubGlobal('chrome', {
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
    await expect(savePromptRefinerApiKey('  sk-ant-example  ')).resolves.toEqual({ configured: true });
    expect(sessionSet).toHaveBeenCalledWith({ [API_KEY_STORAGE_KEY]: 'sk-ant-example' });
    expect(sessionValues).toEqual({ [API_KEY_STORAGE_KEY]: 'sk-ant-example' });
    await expect(getPromptRefinerStatus()).resolves.toEqual({ configured: true });

    await expect(clearPromptRefinerApiKey()).resolves.toEqual({ configured: false });
    expect(sessionRemove).toHaveBeenCalledWith(API_KEY_STORAGE_KEY);
    await expect(getPromptRefinerStatus()).resolves.toEqual({ configured: false });
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
    expect(request.credentials).toBeUndefined();
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
