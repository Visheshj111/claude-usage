/**
 * Tracker — the detection pipeline orchestrator.
 *
 * Runs detectors in priority order:
 *   1. Network (intercepted quota headers/body)
 *   2. DOM (progress bars, aria attrs)
 *   3. Banners / page text
 *   4. Estimation fallback (message counting)
 *
 * Feeds results into state-manager.
 */

import type { NetworkQuota, DetectedUsage } from "./types";
import {
  feedDetection,
  clearRateLimit,
  getState,
} from "./state-manager";
import { detectUsage } from "./dom-detector";
import { retryAfterToTimestamp } from "./reset-parser";

export type ScanTrigger = "navigation" | "mutation" | "interval" | "manual";

export interface ScanOptions {
  fullDom?: boolean;
}

/**
 * Run the full detection pipeline.
 * Returns the resulting state.
 */
export function runDetection(_trigger: ScanTrigger = "manual", _options: ScanOptions = {}): ReturnType<typeof getState> {
  // 1. DOM detection
  const domResult = detectUsage();
  if (domResult) {
    feedDetection(domResult);
  }

  // If we found no limit indicators, clear any stale rate-limit
  // but only if detected by DOM/banner — never clear network detections
  if (!domResult?.isRateLimited) {
    const state = getState();
    if (state.isRateLimited && state.source !== "network" && state.source !== "official-ui") {
      clearRateLimit();
    }
  }

  return getState();
}

/**
 * Handle a network quota event (intercepted from fetch/XHR).
 */
export function handleNetworkQuota(quota: NetworkQuota): void {
  const detected: DetectedUsage = {
    confidence: 0.95,
    source: "network",
  };

  if (quota.remaining !== undefined && quota.limit !== undefined && quota.limit > 0) {
    const used = quota.limit - quota.remaining;
    detected.usagePercent = Math.round((used / quota.limit) * 100);
    detected.remainingMessages = quota.remaining;

    if (quota.remaining <= 0) {
      detected.isRateLimited = true;
    }
  } else if (quota.remaining !== undefined) {
    detected.remainingMessages = quota.remaining;
  }

  if (quota.reset !== undefined && quota.reset > 0) {
    detected.resetTimestamp = quota.reset;
  }

  if (quota.retryAfter !== undefined && quota.retryAfter > 0) {
    const resetFromRetry = retryAfterToTimestamp(quota.retryAfter);
    if (resetFromRetry) {
      detected.resetTimestamp = resetFromRetry;
    }
  }

  // If the network says we still have remaining and no reset, not rate-limited
  if (
    detected.remainingMessages !== undefined &&
    detected.remainingMessages > 0 &&
    detected.resetTimestamp === undefined
  ) {
    detected.isRateLimited = false;
  }

  // Pass through new fields
  if (quota.limitType !== undefined) {
    detected.limitType = quota.limitType;
  }
  if (quota.hardLimitResetAt !== undefined) {
    detected.hardLimitResetAt = quota.hardLimitResetAt;
  }
  if (quota.orgId !== undefined) {
    detected.orgId = quota.orgId;
  }
  detected.hasAccurateData = true;

  feedDetection(detected);
}

/**
 * Handle a mutation observer or periodic scan result.
 */
export function handleScan(): void {
  runDetection("mutation");
}

/**
 * Compute a fallback estimate based on message counting.
 * Low confidence — used only when nothing else is available.
 */
export function estimateUsage(
  messagesSent: number,
  messagesReceived: number,
  knownLimit: number | null,
  sessionWindowMs?: number
): void {
  if (knownLimit === null || knownLimit <= 0) return;

  const totalMessages = messagesSent + messagesReceived;
  const pct = Math.min(Math.round((totalMessages / knownLimit) * 100), 100);

  const detected: DetectedUsage = {
    usagePercent: pct,
    remainingMessages: Math.max(0, knownLimit - totalMessages),
    confidence: 0.3,
    source: "estimated",
    isRateLimited: totalMessages >= knownLimit,
  };

  // Estimate a reset timestamp from usage percentage and window duration.
  // This lets mid-chat installs show a reasonable countdown timer.
  if (sessionWindowMs && pct > 0) {
    const elapsed = Math.round((pct / 100) * sessionWindowMs);
    const windowStart = Date.now() - elapsed;
    detected.resetTimestamp = windowStart + sessionWindowMs;
  }

  feedDetection(detected);
}

/**
 * Schedule periodic detection.
 * Returns an unsubscribe function.
 */
export function startPeriodicScan(intervalMs = 10000): () => void {
  const handle = setInterval(() => runDetection("interval"), intervalMs);
  return () => clearInterval(handle);
}
