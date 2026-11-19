import {
  buildRefinementResult,
  buildRefinementUserMessage,
  extractRefinedPrompt,
  PROMPT_REFINEMENT_SYSTEM_PROMPT,
  REFINER_PROVIDERS,
  RefinerConfigError,
  refinerHostPermission,
  resolveRefinerConfig,
  type RefinerConfig,
  type RefinementResult,
} from "../refiner";

const API_KEY_STORAGE_KEY = "promptRefinerApiKey";
const CONFIG_STORAGE_KEY = "promptRefinerConfig";
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
  | "permission-required"
  | "insufficient-credits"
  | "access-denied"
  | "model-unavailable"
  | "invalid-request"
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
  config?: RefinerConfig;
}

interface StoredApiKey {
  promptRefinerApiKey?: string;
  promptRefinerConfig?: unknown;
}

async function readStoredKey(): Promise<StoredApiKey> {
  return await chrome.storage.session.get([API_KEY_STORAGE_KEY, CONFIG_STORAGE_KEY]) as StoredApiKey;
}

async function requireProviderPermission(config: RefinerConfig): Promise<void> {
  if (!await chrome.permissions.contains({ origins: [refinerHostPermission(config)] })) {
    throw new PromptRefinerError("permission-required");
  }
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
  const stored = await readStoredKey();
  const key = stored.promptRefinerApiKey?.trim();
  if (!key) return { configured: false };
  return { configured: true, config: resolveRefinerConfig(key, stored.promptRefinerConfig) };
}

/**
 * Keep the key in session-only extension storage. It is never returned to a
 * content script, written into the normal settings object, or persisted to
 * disk by this feature.
 */
export async function savePromptRefinerApiKey(apiKey: string, input?: unknown): Promise<PromptRefinerStatus> {
  let value = apiKey.trim();
  if (!value && input === undefined) return clearPromptRefinerApiKey();
  let previous: RefinerConfig | undefined;
  if (!value) {
    const stored = await readStoredKey();
    value = stored.promptRefinerApiKey?.trim() || "";
    if (!value) throw new RefinerConfigError("Paste an API key before saving.");
    previous = resolveRefinerConfig(value, stored.promptRefinerConfig);
  }
  const config = resolveRefinerConfig(value, input);
  if (previous && (previous.provider !== config.provider || previous.baseUrl !== config.baseUrl)) {
    throw new RefinerConfigError("Paste a key for the new service or API address before saving.");
  }
  await requireProviderPermission(config);
  // Store the destination with its credential atomically; never mix providers.
  await chrome.storage.session.set({ [API_KEY_STORAGE_KEY]: value, [CONFIG_STORAGE_KEY]: config });
  return { configured: true, config };
}

export async function clearPromptRefinerApiKey(): Promise<PromptRefinerStatus> {
  await chrome.storage.session.remove([API_KEY_STORAGE_KEY, CONFIG_STORAGE_KEY]);
  return { configured: false };
}

function userFacingError(status: number, body: unknown): PromptRefinerError {
  const error = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  // Only inspect known codes; raw remote messages can contain drafts or secrets.
  if (status === 402 || code === 402 || code === "insufficient_quota" || code === "insufficient_credits") {
    return new PromptRefinerError("insufficient-credits");
  }
  if (status === 401 || code === 401 || code === "API_KEY_INVALID" || code === "invalid_api_key") {
    return new PromptRefinerError("invalid-api-key");
  }
  if (status === 403 || code === 403) return new PromptRefinerError("access-denied");
  if (status === 404 || code === 404 || code === "model_not_found") return new PromptRefinerError("model-unavailable");
  if (status === 429 || code === 429) return new PromptRefinerError("rate-limited");
  if (status === 400 || status === 422) return new PromptRefinerError("invalid-request");
  return new PromptRefinerError("request-failed");
}

function promptRefinerErrorMessage(error: unknown): PromptRefinerError {
  if (error instanceof PromptRefinerError) return error;
  return new PromptRefinerError("request-failed");
}

export function getPromptRefinerErrorMessage(error: unknown): string {
  if (error instanceof RefinerConfigError) return error.message;
  switch (promptRefinerErrorMessage(error).code) {
    case "not-configured":
      return "Add an API key in extension settings to refine prompts.";
    case "empty-prompt":
      return "Write a prompt before refining it.";
    case "prompt-too-large":
      return "This draft is too large to refine in one request. Shorten it and try again.";
    case "invalid-api-key":
      return "Your API key was rejected. Check the selected service and paste a valid key in extension settings.";
    case "permission-required":
      return "Allow access to your AI service: open extension settings and click Save key, then accept Chrome's permission request.";
    case "insufficient-credits":
      return "Your AI service reports insufficient credits or quota. Check its billing or spending limit, or choose an available free model in settings.";
    case "access-denied":
      return "Your AI service denied access. Check your key's permissions, account restrictions, and model access in settings.";
    case "model-unavailable":
      return "The model or API address is unavailable for this key. Check Advanced settings or choose another model.";
    case "invalid-request":
      return "Your AI service rejected the request. Check the model and API address in Advanced settings.";
    case "rate-limited":
      return "Your AI service is rate-limiting this key. Wait a moment and try again; free models have lower limits.";
    case "invalid-response":
      return "The AI service returned an incomplete or unusable suggestion. Your draft is unchanged. Try again or choose another model in settings.";
    case "request-failed":
      return "Could not reach your AI service or the request timed out. Your draft is unchanged. Check your connection and try again.";
  }
}

export async function refinePromptWithClaude(prompt: string): Promise<RefinementResult> {
  if (!prompt.trim()) throw new PromptRefinerError("empty-prompt");
  if (prompt.length > MAX_PROMPT_CHARACTERS) throw new PromptRefinerError("prompt-too-large");

  const stored = await readStoredKey();
  const apiKey = stored.promptRefinerApiKey?.trim();
  if (!apiKey) throw new PromptRefinerError("not-configured");
  const config = resolveRefinerConfig(apiKey, stored.promptRefinerConfig);
  await requireProviderPermission(config);
  const isAnthropic = config.provider === "anthropic";
  // Some services count thinking against the same completion budget. Leave room
  // for it without increasing the existing overall response ceiling.
  const thinkingAllowance = config.provider === "openrouter" || config.provider === "gemini" ? 4096 : 0;
  const tokenLimit = Math.min(MAX_OUTPUT_TOKENS, getRefinementOutputTokenLimit(prompt) + thinkingAllowance);
  const body: Record<string, unknown> = isAnthropic ? {
    model: config.model,
    max_tokens: tokenLimit,
    system: PROMPT_REFINEMENT_SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildRefinementUserMessage(prompt) }],
  } : {
    model: config.model,
    [config.provider === "openai" ? "max_completion_tokens" : "max_tokens"]: tokenLimit,
    messages: [
      { role: "system", content: PROMPT_REFINEMENT_SYSTEM_PROMPT },
      { role: "user", content: buildRefinementUserMessage(prompt) },
    ],
  };
  if (config.provider === "openai" && config.model === REFINER_PROVIDERS.openai.model) {
    body.reasoning_effort = "none";
  }
  if (config.provider === "gemini" && config.model === REFINER_PROVIDERS.gemini.model) {
    body.reasoning_effort = "minimal";
  }
  if (config.provider === "openrouter") body.reasoning = { effort: "low", exclude: true };
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (isAnthropic) {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
    headers["anthropic-dangerous-direct-browser-access"] = "true";
  } else {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${config.baseUrl}/${isAnthropic ? "messages" : "chat/completions"}`, {
      method: "POST",
      signal: controller.signal,
      credentials: "omit",
      redirect: "error",
      headers,
      body: JSON.stringify(body),
    });

    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch {
      if (response.ok) throw new PromptRefinerError("invalid-response");
    }
    const hasError = responseBody && typeof responseBody === "object" && (responseBody as { error?: unknown }).error;
    if (!response.ok || hasError) throw userFacingError(response.status, responseBody);

    const refined = extractRefinedPrompt(responseBody, config.provider);
    if (!refined) throw new PromptRefinerError("invalid-response");

    return buildRefinementResult(prompt, refined, config.provider);
  } catch (error) {
    throw promptRefinerErrorMessage(error);
  } finally {
    clearTimeout(timeout);
  }
}
