import {
  buildRefinementResult,
  buildRefinementUserMessage,
  extractRefinedPrompt,
  PROMPT_REFINEMENT_SYSTEM_PROMPT,
  PROMPT_REFINER_MODEL,
  type RefinementResult,
} from "../refiner";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const API_KEY_STORAGE_KEY = "promptRefinerApiKey";
/**
 * A bounded input and an output budget that can preserve it are safer than
 * accepting arbitrarily large drafts and offering a truncated rewrite. This is
 * still comfortably larger than a normal chat-composer prompt.
 */
export const MAX_PROMPT_CHARACTERS = 24_000;
const MIN_OUTPUT_TOKENS = 1_200;
const MAX_OUTPUT_TOKENS = 8_000;
const REQUEST_TIMEOUT_MS = 45_000;

export type PromptRefinerErrorCode =
  | "not-configured"
  | "empty-prompt"
  | "prompt-too-large"
  | "invalid-api-key"
  | "rate-limited"
  | "request-failed"
  | "invalid-response";

export class PromptRefinerError extends Error {
  constructor(public readonly code: PromptRefinerErrorCode) {
    super(code);
    this.name = "PromptRefinerError";
  }
}

export interface PromptRefinerStatus {
  configured: boolean;
}

interface StoredApiKey {
  promptRefinerApiKey?: string;
}

/**
 * Give longer drafts enough room to preserve their structure. This is a
 * deliberately conservative character-based estimate: it is only a response
 * ceiling, not a request to pad the result. The model is still instructed to
 * return only the useful refined prompt.
 */
export function getRefinementOutputTokenLimit(prompt: string): number {
  return Math.min(
    MAX_OUTPUT_TOKENS,
    Math.max(MIN_OUTPUT_TOKENS, Math.ceil(prompt.length / 3)),
  );
}

export async function getPromptRefinerStatus(): Promise<PromptRefinerStatus> {
  const stored = await chrome.storage.session.get(API_KEY_STORAGE_KEY) as StoredApiKey;
  return {
    configured: typeof stored.promptRefinerApiKey === "string"
      && stored.promptRefinerApiKey.trim().length > 0,
  };
}

/**
 * Keep the key in session-only extension storage. It is never returned to a
 * content script, written into the normal settings object, or persisted to
 * disk by this feature.
 */
export async function savePromptRefinerApiKey(apiKey: string): Promise<PromptRefinerStatus> {
  const value = apiKey.trim();
  if (!value) {
    await clearPromptRefinerApiKey();
    return { configured: false };
  }

  await chrome.storage.session.set({ [API_KEY_STORAGE_KEY]: value });
  return { configured: true };
}

export async function clearPromptRefinerApiKey(): Promise<PromptRefinerStatus> {
  await chrome.storage.session.remove(API_KEY_STORAGE_KEY);
  return { configured: false };
}

function userFacingError(response: Response): PromptRefinerError {
  if (response.status === 401 || response.status === 403) {
    return new PromptRefinerError("invalid-api-key");
  }
  if (response.status === 429) {
    return new PromptRefinerError("rate-limited");
  }
  return new PromptRefinerError("request-failed");
}

function promptRefinerErrorMessage(error: unknown): PromptRefinerError {
  if (error instanceof PromptRefinerError) return error;
  return new PromptRefinerError("request-failed");
}

export function getPromptRefinerErrorMessage(error: unknown): string {
  switch (promptRefinerErrorMessage(error).code) {
    case "not-configured":
      return "Add an Anthropic API key in the extension settings to refine prompts.";
    case "empty-prompt":
      return "Write a prompt before refining it.";
    case "prompt-too-large":
      return "This draft is too large to refine in one request. Shorten it and try again.";
    case "invalid-api-key":
      return "Your Anthropic API key was rejected. Update it in the extension settings.";
    case "rate-limited":
      return "Anthropic is rate-limiting this key. Try again shortly.";
    case "invalid-response":
      return "Claude returned no usable refined prompt. Try again.";
    case "request-failed":
      return "Claude could not refine this prompt right now. Try again.";
  }
}

export async function refinePromptWithClaude(prompt: string): Promise<RefinementResult> {
  if (!prompt.trim()) throw new PromptRefinerError("empty-prompt");
  if (prompt.length > MAX_PROMPT_CHARACTERS) throw new PromptRefinerError("prompt-too-large");

  const stored = await chrome.storage.session.get(API_KEY_STORAGE_KEY) as StoredApiKey;
  const apiKey = stored.promptRefinerApiKey?.trim();
  if (!apiKey) throw new PromptRefinerError("not-configured");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        // Required by Anthropic for direct, user-controlled browser requests.
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: PROMPT_REFINER_MODEL,
        max_tokens: getRefinementOutputTokenLimit(prompt),
        system: PROMPT_REFINEMENT_SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildRefinementUserMessage(prompt) }],
      }),
    });

    if (!response.ok) throw userFacingError(response);

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new PromptRefinerError("invalid-response");
    }

    const refined = extractRefinedPrompt(body);
    if (!refined) throw new PromptRefinerError("invalid-response");

    return buildRefinementResult(prompt, refined);
  } catch (error) {
    throw promptRefinerErrorMessage(error);
  } finally {
    clearTimeout(timeout);
  }
}
