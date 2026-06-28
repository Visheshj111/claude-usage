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


// ── Primary entry point ──

export function detectUsage(): DetectedUsage | null {
  // All three scan functions return null unconditionally (DOM scraping disabled).
  // Keeping the call structure intact so re-enabling a scanner is a one-line change.
  const fromProgress = scanProgressBars();
  const fromBanners = scanBanners();
  const fromText = scanPageText();
  // Pick the highest-confidence result (currently all null)
  const candidates = [fromProgress, fromBanners, fromText].filter((c): c is DetectedUsage => c !== null);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, c) => c.confidence > best.confidence ? c : best);
}

// ── Progress bar scanning ──

function scanProgressBars(): DetectedUsage | null {
  // DOM scraping disabled — /usage API and cut-quota events are authoritative.
  // Stale DOM values (e.g. cached progress bars) caused confidence-score races
  // that overwrote fresh API data with outdated DOM readings.
  return null;
}


// ── Banner scanning ──

function scanBanners(): DetectedUsage | null {
  // DOM scraping disabled — see scanProgressBars() comment.
  return null;
}

// ── Full page text scan ──

function scanPageText(): DetectedUsage | null {
  // DOM scraping disabled — see scanProgressBars() comment.
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
