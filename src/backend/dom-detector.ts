/**
 * src/backend/dom-detector.ts
 *
 * KEY CHANGES vs original:
 * 1. PROGRESS_SELECTORS — added Claude-specific element patterns
 * 2. BANNER_PATTERNS — match Claude's actual "Available again at X:XX PM" text
 * 3. TIME_PATTERNS — better "3:45 PM" / "in 3 hours 12 minutes" parsing
 * 4. scanPageText — extracts remaining count from "X messages left in this 5-hour window"
 * 5. Added model-chip scan near the input area (Claude shows usage near model selector)
 */

import type { DetectedUsage, BannerMatch } from "./types";

// Claude's actual banner texts (matched against real Claude.ai strings)
const BANNER_PATTERNS = [
  // "You've reached your usage limit" / "You've hit your message limit"
  /you['`\u2019]ve\s+(?:reached|hit)\s+(?:your\s+)?(?:usage|message|rate|daily)\s+limit/i,
  // "Usage limit reached" / "Message limit reached"
  /(?:usage|message|rate)\s+limit\s+(?:reached|exceeded|hit)/i,
  // "Claude is available again at 3:45 PM"
  /(?:claude\s+is\s+)?available\s+again\s+at\s+([\d:]+(?:\s*[ap]m)?)/i,
  // "Available again in 3 hours 12 minutes"
  /available\s+again\s+in\s+(\d+)\s+(hour|minute|second)s?(?:\s+(\d+)\s+(hour|minute|second)s?)?/i,
  // "Try again later" / "Too many requests"
  /try\s+again\s+later/i,
  /too\s+many\s+requests/i,
  // "X messages remaining" / "X messages left"
  /(\d+)\s+messages?\s+(?:remaining|left)/i,
  // "X / Y messages" (e.g. "38 / 45 messages")
  /(\d+)\s*\/\s*(\d+)\s+messages?/i,
  // "X messages left in this 5-hour window"
  /(\d+)\s+messages?\s+(?:left|remaining)\s+in\s+(?:this\s+)?(?:5.hour|five.hour|current)\s+window/i,
  // "Limit resets at X:XX PM" / "Resets in X hours"
  /limit\s+resets?\s+(?:at\s+[\d:]+(?:\s*[ap]m)?|in\s+\d+)/i,
  // Hard-limit / cooldown patterns
  /cooldown/i,
  /rate.limited/i,
  /you.*have.*been.*rate.*limited/i,
  /cooldown.*until/i,
] as const;

// Time patterns — updated to handle "3:45 PM", "in 3 hours 12 minutes", ISO timestamps
const TIME_PATTERNS = [
  // "available again at 3:45 PM" or "at 14:00"
  /(?:available\s+again\s+at|resets?\s+at)\s+([\d:]+(?:\s*[ap]m)?)/i,
  // "available again in X hours [Y minutes]"
  /available\s+again\s+in\s+(\d+)\s+(hours?|minutes?|seconds?)(?:\s+(\d+)\s+(hours?|minutes?|seconds?))?/i,
  // Generic "in X hours/minutes"
  /in\s+(\d+)\s+(hours?|minutes?|seconds?)/i,
  // ISO date string
  /([\d]{4}-[\d]{2}-[\d]{2}[T ][\d]{2}:[\d]{2}(?::[\d]{2})?(?:Z|[+-][\d:]+)?)/,
] as const;

// Progress bar selectors — added Claude-specific class/testid patterns
const PROGRESS_SELECTORS = [
  '[role="progressbar"]',
  "progress",
  "meter",
  // Generic testids
  '[data-testid="usage-progress"]',
  '[data-testid*="usage"]',
  '[data-testid*="limit"]',
  // Claude-specific class fragments (class names may change but fragments are stable)
  '[class*="UsageMeter"]',
  '[class*="usage-meter"]',
  '[class*="MessageLimit"]',
  '[class*="RateLimit"]',
  '[class*="usageBar"]',
  '[class*="usage-bar"]',
  // Look near the model selector (Claude shows usage chip in the toolbar)
  'fieldset [role="progressbar"]',
  'header [role="progressbar"]',
  'nav [role="progressbar"]',
  // Aria patterns
  '[aria-label*="usage"]',
  '[aria-label*="messages"]',
  '[aria-label*="remaining"]',
];

// Banner/alert selectors — Claude uses these to show limit messages
const BANNER_SELECTORS = [
  '[class*="banner"]',
  '[class*="toast"]',
  '[class*="notification"]',
  '[class*="alert"]',
  '[class*="warning"]',
  '[role="alert"]',
  '[role="status"]',
  '[data-testid*="limit"]',
  '[data-testid*="usage"]',
  '[data-testid*="banner"]',
  '[data-testid*="warning"]',
  // Claude-specific
  '[class*="LimitBanner"]',
  '[class*="UsageLimit"]',
  '[class*="MessageLimit"]',
  '[class*="RateLimitBanner"]',
];

// ── Primary entry point ──

export function detectUsage(): DetectedUsage | null {
  let best: DetectedUsage | null = null;

  const fromProgress = scanProgressBars();
  if (fromProgress && (!best || fromProgress.confidence > best.confidence)) {
    best = fromProgress;
  }

  const fromBanners = scanBanners();
  if (fromBanners && (!best || fromBanners.confidence > best.confidence)) {
    best = fromBanners;
  }

  const fromText = scanPageText();
  if (fromText && (!best || fromText.confidence > best.confidence)) {
    best = fromText;
  }

  return best;
}

// ── Progress bar scanning ──

function scanProgressBars(): DetectedUsage | null {
  for (const sel of PROGRESS_SELECTORS) {
    const elements = document.querySelectorAll(sel);
    for (const el of elements) {
      const result = parseProgressElement(el);
      if (result) return result;
    }
  }
  return null;
}

function parseProgressElement(el: Element): DetectedUsage | null {
  const result: DetectedUsage = { confidence: 0, source: "official-ui" };

  // aria-valuenow / aria-valuemax (most reliable)
  const now = el.getAttribute("aria-valuenow");
  const max = el.getAttribute("aria-valuemax");

  if (now !== null && max !== null) {
    const n = parseFloat(now);
    const m = parseFloat(max);
    if (!isNaN(n) && !isNaN(m) && m > 0) {
      result.usagePercent = Math.round((n / m) * 100);
      result.remainingMessages = Math.round(m - n);
      result.sessionLimit = Math.round(m);
      result.sessionMessagesUsed = Math.round(n);
      result.confidence = 0.9;
      if (n >= m) result.isRateLimited = true;
      return result;
    }
  }

  // <progress> native element
  if (el instanceof HTMLProgressElement) {
    const v = el.value;
    const m = el.max;
    if (m > 0) {
      result.usagePercent = Math.round((v / m) * 100);
      result.remainingMessages = Math.round(m - v);
      result.sessionLimit = Math.round(m);
      result.sessionMessagesUsed = Math.round(v);
      result.confidence = 0.9;
      if (v >= m) result.isRateLimited = true;
      return result;
    }
  }

  // <meter> element
  if (el instanceof HTMLMeterElement) {
    const v = el.value;
    const m = el.max;
    if (m > 0) {
      result.usagePercent = Math.round((v / m) * 100);
      result.remainingMessages = Math.round(m - v);
      result.sessionLimit = Math.round(m);
      result.confidence = 0.85;
      return result;
    }
  }

  // Inline style width: X%
  const styleWidth = el.getAttribute("style");
  if (styleWidth) {
    const pctMatch = styleWidth.match(/width\s*:\s*(\d+(?:\.\d+)?)\s*%/);
    if (pctMatch) {
      result.usagePercent = Math.round(parseFloat(pctMatch[1]));
      result.confidence = 0.6;
      return result;
    }
  }

  // data-pct / data-percent
  const dataPct = el.getAttribute("data-pct") || el.getAttribute("data-percent");
  if (dataPct) {
    const p = parseFloat(dataPct);
    if (!isNaN(p)) {
      result.usagePercent = Math.round(p);
      result.confidence = 0.6;
      return result;
    }
  }

  return null;
}

// ── Banner scanning ──

function scanBanners(): DetectedUsage | null {
  for (const sel of BANNER_SELECTORS) {
    const elements = document.querySelectorAll(sel);
    for (const el of elements) {
      const text = el.textContent?.trim();
      if (!text || text.length < 5) continue;

      const match = parseBannerText(text);
      if (!match) continue;

      const result: DetectedUsage = { confidence: 0.75, source: "banner" };

      if (match.type === "rate-limited") {
        result.isRateLimited = true;
        if (match.value !== null) result.resetTimestamp = match.value;
        if (match.limitType !== undefined) result.limitType = match.limitType;
        if (match.hardLimitResetAt !== undefined) result.hardLimitResetAt = match.hardLimitResetAt;
        return result;
      } else if (match.type === "reset-time" && match.value !== null) {
        result.resetTimestamp = match.value;
        return result;
      } else if (match.type === "usage-percent" && match.value !== null) {
        result.usagePercent = match.value;
        return result;
      } else if (match.type === "remaining" && match.value !== null) {
        result.remainingMessages = match.value;
        result.confidence = 0.7;
        return result;
      }
    }
  }
  return null;
}

// ── Full page text scan ──

function scanPageText(): DetectedUsage | null {
  const text = document.body?.textContent ?? "";
  if (!text) return null;

  for (const pattern of BANNER_PATTERNS) {
    const m = text.match(pattern);
    if (!m) continue;

    const result: DetectedUsage = { confidence: 0.5, source: "banner" };
    const fullMatch = m[0].toLowerCase();

    // Hard limit / cooldown detection
    const isCooldown = text.toLowerCase().includes("cooldown") ||
      text.toLowerCase().includes("rate limited") ||
      (text.toLowerCase().includes("try again") && text.toLowerCase().includes("much later"));

    // Rate limited
    if (
      fullMatch.includes("limit reached") ||
      fullMatch.includes("limit exceeded") ||
      fullMatch.includes("limit hit") ||
      fullMatch.includes("try again later") ||
      fullMatch.includes("too many requests") ||
      fullMatch.includes("you've reached")
    ) {
      result.isRateLimited = true;
      if (isCooldown) {
        result.limitType = "hard";
      } else {
        result.limitType = "soft";
      }
    }

    // "X messages remaining" or "X messages left"
    if ((fullMatch.includes("remaining") || fullMatch.includes("left")) && m[1]) {
      const rem = parseInt(m[1], 10);
      if (!isNaN(rem)) {
        result.remainingMessages = rem;
        result.confidence = 0.65;
      }
    }

    // "X / Y messages"
    if (fullMatch.includes("/") && m[1] && m[2]) {
      const used = parseInt(m[1], 10);
      const total = parseInt(m[2], 10);
      if (!isNaN(used) && !isNaN(total) && total > 0) {
        result.usagePercent = Math.round((used / total) * 100);
        result.remainingMessages = total - used;
        result.sessionLimit = total;
        result.sessionMessagesUsed = used;
        result.confidence = 0.7;
      }
    }

    // Try to extract a reset time from this block
    const timeTs = extractTimeFromText(text);
    if (timeTs) {
      result.resetTimestamp = timeTs;
      result.confidence = Math.max(result.confidence, 0.65);
      if (result.limitType === "hard") {
        result.hardLimitResetAt = timeTs;
      }
    }

    return result;
  }

  return null;
}

// ── Time extraction ──

function extractTimeFromText(text: string): number | null {
  for (const pattern of TIME_PATTERNS) {
    const m = text.match(pattern);
    if (!m) continue;

    // "in X hours [Y minutes]"
    if (m[1] && m[2]) {
      const amount1 = parseInt(m[1], 10);
      const unit1 = normalizeUnit(m[2]);
      if (!isNaN(amount1) && unit1) {
        let ms = amount1 * unit1;

        // second group: "in X hours Y minutes"
        if (m[3] && m[4]) {
          const amount2 = parseInt(m[3], 10);
          const unit2 = normalizeUnit(m[4]);
          if (!isNaN(amount2) && unit2) ms += amount2 * unit2;
        }

        if (ms > 0) return Date.now() + ms;
      }
    }

    // Absolute time "at 3:45 PM" or "at 14:00"
    const timeMatch = m[0].match(/([\d]{1,2}:[\d]{2}(?:\s*[ap]m)?)/i);
    if (timeMatch) {
      const ts = parseAbsoluteTime(timeMatch[1]);
      if (ts) return ts;
    }

    // ISO timestamp
    const isoMatch = m[0].match(/([\d]{4}-[\d]{2}-[\d]{2}[T ][\d]{2}:[\d]{2})/);
    if (isoMatch) {
      const ts = new Date(isoMatch[1]).getTime();
      if (!isNaN(ts)) return ts;
    }
  }

  return null;
}

function normalizeUnit(unit: string): number | null {
  const u = unit.toLowerCase().replace(/s$/, "");
  const map: Record<string, number> = {
    hour: 3600000,
    minute: 60000,
    second: 1000,
  };
  return map[u] ?? null;
}

function parseAbsoluteTime(str: string): number | null {
  const clean = str.trim();
  const match = clean.match(/^(\d{1,2}):(\d{2})(?:\s*(am|pm))?$/i);
  if (!match) return null;

  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const ampm = (match[3] ?? "").toLowerCase();

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

// ── Banner text parser (exported for tests) ──

export function parseBannerText(text: string): BannerMatch | null {
  const lower = text.toLowerCase();

  // Hard-limit / cooldown (rate limited with long cooldown)
  const isCooldown = lower.includes("cooldown") ||
    lower.includes("rate limited") ||
    (lower.includes("try again") && lower.includes("much later")) ||
    lower.includes("you have been rate limited");

  // Rate limited
  if (
    lower.includes("rate limit") ||
    lower.includes("usage limit reached") ||
    lower.includes("message limit reached") ||
    lower.includes("usage limit exceeded") ||
    (lower.includes("try again") && lower.includes("later")) ||
    lower.includes("too many requests") ||
    (lower.includes("you've reached") && lower.includes("limit")) ||
    (lower.includes("you've hit") && lower.includes("limit"))
  ) {
    const resetTs = extractTimeFromText(text);
    const match: BannerMatch = {
      type: "rate-limited",
      value: resetTs,
      text: text.slice(0, 200),
    };
    if (isCooldown) {
      match.limitType = "hard";
      if (resetTs) match.hardLimitResetAt = resetTs;
    } else {
      match.limitType = "soft";
    }
    return match;
  }

  // Available again — check for hard cooldown indicators
  if (lower.includes("available again")) {
    const resetTs = extractTimeFromText(text);
    const match: BannerMatch = {
      type: "reset-time",
      value: resetTs,
      text: text.slice(0, 200),
    };
    if (isCooldown) {
      match.limitType = "hard";
      if (resetTs) match.hardLimitResetAt = resetTs;
    }
    return match;
  }

  // "X% used/complete"
  const pctMatch = text.match(/(\d+)%\s*(?:used|complete|full)/i);
  if (pctMatch) {
    return {
      type: "usage-percent",
      value: parseInt(pctMatch[1], 10),
      text: text.slice(0, 200),
    };
  }

  // "X messages remaining/left"
  const remMatch = text.match(/(\d+)\s+messages?\s*(?:remaining|left)/i);
  if (remMatch) {
    return {
      type: "remaining",
      value: parseInt(remMatch[1], 10),
      text: text.slice(0, 200),
    };
  }

  return null;
}
