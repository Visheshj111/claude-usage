/**
 * src/backend/network-monitor.ts
 *
 * KEY CHANGES vs original:
 * 1. Updated CLAUDE_API_PATTERNS to match Claude's actual API paths
 * 2. Added SSE stream reading (Claude uses text/event-stream, not JSON)
 * 3. Reads Claude's `message_limit` error field for exact reset time
 * 4. Reads `usage_metadata.remaining_messages` from normal responses
 * 5. Parses `error.message` for "Available again at" time strings
 */

import type { NetworkQuota } from "./types";

export type QuotaCallback = (quota: NetworkQuota) => void;

const QUOTA_HEADERS = [
  "x-ratelimit-remaining",
  "x-ratelimit-limit",
  "x-ratelimit-reset",
  "ratelimit-remaining",
  "ratelimit-limit",
  "ratelimit-reset",
  "retry-after",
  "x-ratelimit-retry-after",
] as const;

// Track the org ID from intercepted API requests
let _cutOrgId: string | null = null;
let _onOrgIdDetected: ((orgId: string) => void) | null = null;

export function getTrackedOrgId(): string | null {
  if (!_cutOrgId) {
    const match = document.cookie.match(/\blastActiveOrg=([^;]+)/);
    if (match) {
      _cutOrgId = match[1];
    }
  }
  return _cutOrgId;
}

export function setOnOrgIdDetected(cb: (orgId: string) => void): void {
  _onOrgIdDetected = cb;
  // If orgId already available, fire immediately
  if (_cutOrgId) cb(_cutOrgId);
}

// Listen for orgId extracted by watcher.js in the main world
window.addEventListener("cut-org-id", ((e: CustomEvent<string>) => {
  const newOrgId = e.detail;
  if (newOrgId && newOrgId !== _cutOrgId) {
    _cutOrgId = newOrgId;
    _onOrgIdDetected?.(newOrgId);
  }
}) as EventListener);

// Claude's actual API endpoints (updated from generic guesses)
const CLAUDE_API_PATTERNS = [
  // Primary: conversation completion (SSE stream)
  /\/api\/organizations\/[^/]+\/chat_conversations\/[^/]+\/completion/i,
  // Create/list conversations
  /\/api\/organizations\/[^/]+\/chat_conversations/i,
  // Direct claude.ai API calls
  /claude\.ai\/api\//i,
  // Anthropic API if used directly
  /api\.anthropic\.com\/v1\//i,
  // Projects / workspaces
  /\/api\/organizations\/[^/]+\/projects/i,
  // Usage endpoint (the reference extension polls this)
  /\/api\/organizations\/[^/]+\/usage/i,
];

export function interceptFetch(onQuota: QuotaCallback): () => void {
  const originalFetch = window.fetch.bind(window);

  // Wrap the callback to inject the current orgId
  const quotaWithOrg: QuotaCallback = (quota) => {
    if (_cutOrgId) quota.orgId = _cutOrgId;
    onQuota(quota);
  };

  (window as any).fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const response = await originalFetch(input, init);

    if (isRelevantUrl(input)) {
      // Check standard headers
      const headerQuota = extractHeaders(response);
      if (headerQuota) quotaWithOrg(headerQuota);

      const contentType = response.headers.get("content-type") ?? "";

      if (contentType.includes("text/event-stream")) {
        // Claude's primary response format: SSE stream
        // Clone before the original consumer reads it
        const clone = response.clone();
        readSSEStream(clone, quotaWithOrg).catch(() => {});
      } else if (contentType.includes("application/json")) {
        const clone = response.clone();
        clone
          .json()
          .then((body) => {
            const bodyQuota = extractFromClaudeJson(body);
            if (bodyQuota) quotaWithOrg(bodyQuota);
          })
          .catch(() => {});
      }
    }

    return response;
  };

  return () => {
    (window as any).fetch = originalFetch;
  };
}

/**
 * Read and parse a Claude SSE stream for usage data.
 * Claude sends events like:
 *   data: {"type":"message_start","message":{"usage":{"input_tokens":50}}}
 *   data: {"type":"message_delta","usage":{"output_tokens":120}}
 *   data: {"type":"error","error":{"type":"overloaded_error"},"message_limit":{"resetsAt":"..."}}
 */
async function readSSEStream(response: Response, onQuota: QuotaCallback): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (raw === "[DONE]" || !raw) continue;

        try {
          const parsed = JSON.parse(raw);
          const quota = extractFromClaudeJson(parsed);
          if (quota) onQuota(quota);
        } catch {
          // Not JSON — ignore
        }
      }
    }
  } catch {
    // Stream ended or was cancelled — normal
  } finally {
    reader.releaseLock();
  }
}

export function interceptXHR(onQuota: QuotaCallback): () => void {
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const trackedRequests = new WeakSet<XMLHttpRequest>();

  const quotaWithOrg: QuotaCallback = (quota) => {
    if (_cutOrgId) quota.orgId = _cutOrgId;
    onQuota(quota);
  };

  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    async?: boolean,
    user?: string | null,
    password?: string | null
  ) {
    (this as any)._cutUrl = url;
    return originalOpen.call(this, method, url, async ?? true, user, password);
  };

  XMLHttpRequest.prototype.send = function (
    body?: Document | XMLHttpRequestBodyInit | null
  ) {
    const xhr = this;

    if (!trackedRequests.has(xhr)) {
      trackedRequests.add(xhr);

      xhr.addEventListener("loadend", () => {
        const url = (xhr as any)._cutUrl as string | undefined;
        if (!url || !isRelevantUrl(url)) return;

        const headers = xhr.getAllResponseHeaders().toLowerCase();
        const quota = extractHeadersFromRaw(headers);
        if (quota) quotaWithOrg(quota);

        // Also try parsing XHR response body
        try {
          if (xhr.responseType === "" || xhr.responseType === "text") {
            const text = xhr.responseText;
            if (text && text.trim().startsWith("{")) {
              const parsed = JSON.parse(text);
              const bodyQuota = extractFromClaudeJson(parsed);
              if (bodyQuota) quotaWithOrg(bodyQuota);
            }
          }
        } catch {
          // ignore parse errors
        }
      });
    }

    return originalSend.call(this, body);
  };

  return () => {
    XMLHttpRequest.prototype.open = originalOpen;
    XMLHttpRequest.prototype.send = originalSend;
  };
}

/**
 * Extract quota from a Claude-specific JSON body.
 *
 * Claude error response (rate limited):
 * {
 *   "type": "error",
 *   "error": { "type": "overloaded_error", "message": "..." },
 *   "message_limit": {
 *     "type": "within_5hour_window",
 *     "resetsAt": "2024-01-01T14:00:00Z"
 *   }
 * }
 *
 * Claude normal response may include:
 * {
 *   "usage_metadata": {
 *     "remaining_messages": 38,
 *     "message_limit": 45,
 *     "window_reset_at": "2024-01-01T14:00:00Z"
 *   }
 * }
 *
 * Also handles standard ratelimit fields as fallback.
 */
function extractFromClaudeJson(body: unknown): NetworkQuota | null {
  if (!body || typeof body !== "object") return null;

  const quota: NetworkQuota = {};
  let found = false;
  const obj = body as Record<string, unknown>;

  // ── Claude's message_limit error field ──
  // Sent when the user hits the rate limit
  if (obj.message_limit && typeof obj.message_limit === "object") {
    const ml = obj.message_limit as Record<string, unknown>;

    if (ml.resetsAt) {
      const ts = new Date(String(ml.resetsAt)).getTime();
      if (!isNaN(ts)) {
        quota.reset = ts;
        quota.remaining = 0; // hit the wall
        found = true;
      }
    }

    if (ml.resets_at) {
      const ts = new Date(String(ml.resets_at)).getTime();
      if (!isNaN(ts)) {
        quota.reset = ts;
        quota.remaining = 0;
        found = true;
      }
    }

    // Detect hard limit (cooldown) vs soft limit (5h window)
    const mlType = String(ml.type || "").toLowerCase();
    if (mlType === "maxed") {
      quota.limitType = "hard";
      if (quota.reset) {
        quota.hardLimitResetAt = quota.reset;
      }
      found = true;
    } else if (mlType === "within_5hour_window") {
      quota.limitType = "soft";
      found = true;
    }
  }

  // ── Claude's usage_metadata field ──
  // May be present in normal streaming responses
  if (obj.usage_metadata && typeof obj.usage_metadata === "object") {
    const um = obj.usage_metadata as Record<string, unknown>;

    if (typeof um.remaining_messages === "number") {
      quota.remaining = um.remaining_messages;
      found = true;
    }
    if (typeof um.message_limit === "number") {
      quota.limit = um.message_limit;
      found = true;
    }
    const resetKey = um.window_reset_at || um.resets_at || um.reset_at;
    if (resetKey) {
      const ts = new Date(String(resetKey)).getTime();
      if (!isNaN(ts)) {
        quota.reset = ts;
        found = true;
      }
    }
  }

  // ── Error message text parsing ──
  // "Available again at 3:45 PM" or "Rate limit resets at 14:00"
  if (obj.error && typeof obj.error === "object") {
    const err = obj.error as Record<string, unknown>;
    const msg = String(err.message || "");

    const timeMatch = msg.match(/(?:available again at|resets? at)\s+([\d:]+(?:\s*[ap]m)?)/i);
    if (timeMatch) {
      const ts = parseTimeStringToTimestamp(timeMatch[1]);
      if (ts) {
        quota.reset = ts;
        quota.remaining = 0;
        found = true;
      }
    }
  }

  // ── Standard ratelimit fields (fallback) ──
  const candidates = [
    ["remaining", "limit", "reset"],
    ["quota_remaining", "quota_limit", "quota_reset"],
    ["rateLimitRemaining", "rateLimitLimit", "rateLimitReset"],
  ];

  for (const [remainingKey, limitKey, resetKey] of candidates) {
    if (remainingKey && remainingKey in obj) {
      const v = Number(obj[remainingKey]);
      if (!isNaN(v)) { quota.remaining = Math.round(v); found = true; }
    }
    if (limitKey && limitKey in obj) {
      const v = Number(obj[limitKey]);
      if (!isNaN(v)) { quota.limit = Math.round(v); found = true; }
    }
    if (resetKey && resetKey in obj) {
      const v = Number(obj[resetKey]);
      if (!isNaN(v) && v > 0) {
        quota.reset = v > 1e12 ? v : v * 1000;
        found = true;
      } else {
        const ts = new Date(String(obj[resetKey])).getTime();
        if (!isNaN(ts)) { quota.reset = ts; found = true; }
      }
    }
  }

  // retry-after
  for (const key of ["retryAfter", "retry_after", "retry-after"]) {
    if (key in obj) {
      const v = Number(obj[key]);
      if (!isNaN(v) && v > 0) { quota.retryAfter = v; found = true; }
    }
  }

  return found ? quota : null;
}

function extractHeaders(response: Response): NetworkQuota | null {
  const quota: NetworkQuota = {};
  let found = false;

  for (const header of QUOTA_HEADERS) {
    const val = response.headers.get(header);
    if (val === null) continue;
    const num = parseFloat(val);
    if (isNaN(num)) continue;
    found = true;

    switch (header) {
      case "x-ratelimit-remaining": case "ratelimit-remaining":
        quota.remaining = Math.round(num); break;
      case "x-ratelimit-limit": case "ratelimit-limit":
        quota.limit = Math.round(num); break;
      case "x-ratelimit-reset": case "ratelimit-reset":
        quota.reset = num > 1e12 ? num : num * 1000; break;
      case "retry-after": case "x-ratelimit-retry-after":
        quota.retryAfter = num; break;
    }
  }

  return found ? quota : null;
}

function extractHeadersFromRaw(headers: string): NetworkQuota | null {
  const quota: NetworkQuota = {};
  let found = false;

  for (const header of QUOTA_HEADERS) {
    const regex = new RegExp(`^${header}:\\s*(.+)$`, "im");
    const match = headers.match(regex);
    if (!match) continue;
    const val = parseFloat(match[1].trim());
    if (isNaN(val)) continue;
    found = true;

    switch (header) {
      case "x-ratelimit-remaining": case "ratelimit-remaining":
        quota.remaining = Math.round(val); break;
      case "x-ratelimit-limit": case "ratelimit-limit":
        quota.limit = Math.round(val); break;
      case "x-ratelimit-reset": case "ratelimit-reset":
        quota.reset = val > 1e12 ? val : val * 1000; break;
      case "retry-after": case "x-ratelimit-retry-after":
        quota.retryAfter = val; break;
    }
  }

  return found ? quota : null;
}

function isRelevantUrl(input: RequestInfo | URL): boolean {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : (input as Request).url;
  if (!url) return false;

  try {
    const parsed = new URL(url, window.location.origin);
    const matched = CLAUDE_API_PATTERNS.some((p) => p.test(parsed.href));

    // Extract org ID from any matching API URL
    if (matched) {
      const orgMatch = parsed.pathname.match(/\/api\/organizations\/([^/]+)/);
      if (orgMatch) {
        const newOrgId = orgMatch[1];
        if (newOrgId !== _cutOrgId) {
          _cutOrgId = newOrgId;
          _onOrgIdDetected?.(newOrgId);
        }
      }
    }

    return matched;
  } catch {
    return false;
  }
}

/**
 * Parse "3:45 PM" or "14:00" into today's timestamp.
 * If the time has already passed today, returns tomorrow's.
 */
function parseTimeStringToTimestamp(str: string): number | null {
  const clean = str.trim();
  const match = clean.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!match) return null;

  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const ampm = (match[4] ?? "").toLowerCase();

  if (ampm === "pm" && hours < 12) hours += 12;
  if (ampm === "am" && hours === 12) hours = 0;

  const now = new Date();
  const target = new Date(now);
  target.setHours(hours, minutes, 0, 0);

  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }

  return target.getTime();
}
