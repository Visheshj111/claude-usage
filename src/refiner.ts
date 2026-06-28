// src/refiner.ts
// Prompt refinement module — local rule-based and API-backed refinement.

export interface RefinementResult {
  original: string;
  refined: string;
  originalTokenEstimate: number;
  refinedTokenEstimate: number;
  tokensSaved: number;
  percentSaved: number;
  method: "local" | "api";
  changed: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function tokenEstimate(text: string): number {
  return Math.ceil(text.length / 4);
}

function buildResult(
  original: string,
  refined: string,
  method: "local" | "api"
): RefinementResult {
  const originalTokenEstimate = tokenEstimate(original);
  const refinedTokenEstimate = tokenEstimate(refined);
  const tokensSaved = originalTokenEstimate - refinedTokenEstimate;
  const percentSaved =
    originalTokenEstimate > 0
      ? Math.round((tokensSaved / originalTokenEstimate) * 100)
      : 0;
  return {
    original,
    refined,
    originalTokenEstimate,
    refinedTokenEstimate,
    tokensSaved,
    percentSaved,
    method,
    changed: refined !== original,
  };
}

// ── refineLocal ────────────────────────────────────────────────────────────

const FILLER_OPENERS: string[] = [
  "i would appreciate it if you could ",
  "it would be great if you could ",
  "i was wondering if you could ",
  "is it possible for you to ",
  "would you be able to ",
  "please could you ",
  "could you please ",
  "i would like you to ",
  "please can you ",
  "can you please ",
  "would you mind ",
  "i'd like you to ",
  "i want you to ",
  "i need you to ",
  "i was wondering if ",
  "is it possible to ",
  "could you ",
  "can you ",
];

const POLITENESS_ENDINGS: string[] = [
  ". please let me know if you need more info",
  ". let me know if you have questions",
  ". i appreciate your help",
  ", i appreciate your help",
  ". i appreciate it",
  ", i appreciate it",
  " thanks in advance",
  ", thank you",
  ". thank you",
  " thank you",
  ", thanks",
  ". thanks",
];

// Ordered so longer/more-specific phrases are replaced before shorter ones.
const VERBOSE_PHRASES: Array<[string, string]> = [
  ["in spite of the fact that", "although"],
  ["regardless of the fact that", "although"],
  ["it is important to note that", ""],
  ["it should be noted that", ""],
  ["due to the fact that", "because"],
  ["at this point in time", "now"],
  ["at the present time", "now"],
  ["for the purpose of", "for"],
  ["a large number of", "many"],
  ["a small number of", "few"],
  ["in the event that", "if"],
  ["on a regular basis", "regularly"],
  ["make sure that", "ensure"],
  ["please note that", ""],
  ["as you may know", ""],
  ["as mentioned above", ""],
  ["needless to say", ""],
  ["with regard to", "regarding"],
  ["with respect to", "regarding"],
  ["first and foremost", "first"],
  ["each and every", "every"],
  ["basic fundamentals", "fundamentals"],
  ["past history", "history"],
  ["future plans", "plans"],
  ["in the context of", "in"],
  ["end result", "result"],
  ["in order to", "to"],
  ["in terms of", "for"],
];

export function refineLocal(text: string): RefinementResult {
  let s = text;

  // 1. Strip filler openers (case-insensitive; trim after)
  const lower = s.trimStart().toLowerCase();
  for (const opener of FILLER_OPENERS) {
    if (lower.startsWith(opener)) {
      // Preserve the leading whitespace if any, strip the opener
      const leadingWs = s.length - s.trimStart().length;
      s = s.slice(0, leadingWs) + s.trimStart().slice(opener.length);
      // Capitalise the new first character of the actual content
      const trimmed = s.trimStart();
      if (trimmed.length > 0) {
        s = s.slice(0, s.length - trimmed.length) + trimmed[0].toUpperCase() + trimmed.slice(1);
      }
      break; // only strip one opener
    }
  }

  // 2. Strip politeness endings (trim before removing)
  const trimmedRight = s.trimEnd();
  const lowerRight = trimmedRight.toLowerCase();
  for (const ending of POLITENESS_ENDINGS) {
    if (lowerRight.endsWith(ending)) {
      s = trimmedRight.slice(0, trimmedRight.length - ending.length);
      break; // only strip one ending
    }
  }

  // 3. Condense verbose phrases (global, case-insensitive)
  for (const [from, to] of VERBOSE_PHRASES) {
    const re = new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    s = s.replace(re, to);
  }

  // 4. Collapse whitespace
  s = s.replace(/ {2,}/g, " ");              // multiple spaces → one
  s = s.replace(/\n{3,}/g, "\n\n");         // 3+ newlines → two
  s = s.trim();

  // Guard: if result is empty or trivially short, return original unchanged
  if (s.length < 4) {
    return buildResult(text, text, "local");
  }

  return buildResult(text, s, "local");
}

// ── refineWithAPI ──────────────────────────────────────────────────────────

const REFINER_SYSTEM_PROMPT = `You are a prompt optimizer. Rewrite the user's prompt to be shorter while preserving
100% of the intent, requirements, and technical details.

Rules:
- Keep every specific requirement, constraint, file name, number, variable name,
  or technical term exactly as-is
- Remove filler phrases, politeness, meta-commentary ("Here's my question:", etc.)
- Remove redundant context that's implied by the request itself
- Never change what's being asked, its scope, or the expected output format
- Never add assumptions, suggestions, or new requirements
- If the user uses numbered steps or bullet points to organize a complex request,
  preserve that structure — it's intentional
- Output ONLY the refined prompt text. No preamble, no explanation, no quotes
  around the output. If the prompt is already optimal, output it exactly as-is.`;

export async function refineWithAPI(
  text: string,
  orgId: string
): Promise<RefinementResult> {
  const baseUrl = `https://claude.ai/api/organizations/${orgId}`;

  // Step 1: create an ephemeral conversation
  const createResp = await fetch(`${baseUrl}/chat_conversations`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "", uuid: crypto.randomUUID() }),
  });

  if (!createResp.ok) {
    throw new Error(
      `[refiner] Failed to create conversation: ${createResp.status}`
    );
  }

  const convo = (await createResp.json()) as { uuid?: string };
  const convId = convo.uuid;
  if (!convId) {
    throw new Error("[refiner] No conversation uuid in response");
  }

  // Step 2: send a completion request and stream the response
  const completionResp = await fetch(
    `${baseUrl}/chat_conversations/${convId}/completion`,
    {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
      },
      body: JSON.stringify({
        stream: true,
        messages: [
          {
            role: "user",
            content: `${REFINER_SYSTEM_PROMPT}\n\nPrompt to optimize:\n${text}`,
          },
        ],
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        source: "chat_window",
        attachments: [],
        files: [],
      }),
    }
  );

  if (!completionResp.ok) {
    throw new Error(
      `[refiner] Completion request failed: ${completionResp.status}`
    );
  }

  // Step 3: parse SSE stream (same pattern as watcher.js)
  const refined = await readSSEResponse(completionResp);

  // Step 4: fire-and-forget DELETE to clean up the ephemeral conversation
  // so it doesn't permanently appear in the user's claude.ai history.
  void fetch(`${baseUrl}/chat_conversations/${convId}`, {
    method: "DELETE",
    credentials: "include",
  }).catch(() => { /* swallow — cleanup failure is non-fatal */ });

  if (!refined || refined.trim().length === 0) {
    throw new Error("[refiner] API returned empty response");
  }

  return buildResult(text, refined.trim(), "api");
}

async function readSSEResponse(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("[refiner] No readable body");

  const decoder = new TextDecoder();
  let buffer = "";
  let output = "";

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
          const obj = JSON.parse(raw) as Record<string, unknown>;

          // message_delta carries the text output
          if (obj.type === "message_delta") {
            const delta = obj.delta as Record<string, unknown> | undefined;
            if (typeof delta?.text === "string") {
              output += delta.text;
            }
          }

          // content_block_delta (alternative format)
          if (obj.type === "content_block_delta") {
            const delta = obj.delta as Record<string, unknown> | undefined;
            if (delta?.type === "text_delta" && typeof delta.text === "string") {
              output += delta.text;
            }
          }
        } catch {
          // Malformed SSE line — skip
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return output;
}
