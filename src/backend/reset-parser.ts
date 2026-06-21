/**
 * Reset-time parser and countdown calculator.
 * Parses detected timestamps and computes countdown.
 * Never assumes a value — returns null when uncertain.
 */

import type { UsageState } from "./types";

/**
 * Compute countdown in milliseconds from a reset timestamp.
 * Returns null if the timestamp is invalid or in the past.
 */
export function computeCountdown(resetTimestamp: number | null): number | null {
  if (resetTimestamp === null || resetTimestamp <= 0) return null;

  const now = Date.now();
  const diff = resetTimestamp - now;

  if (diff <= 0) return 0;

  return diff;
}

/**
 * Given a retire-after value in seconds, compute the absolute reset timestamp.
 */
export function retryAfterToTimestamp(retryAfterSeconds: number): number | null {
  if (retryAfterSeconds <= 0) return null;
  return Date.now() + retryAfterSeconds * 1000;
}

/**
 * Format a countdown for display: "HH:MM:SS"
 */
export function formatCountdown(ms: number | null): string {
  if (ms === null || ms <= 0) return "00:00:00";

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return [
    String(hours).padStart(2, "0"),
    String(minutes).padStart(2, "0"),
    String(seconds).padStart(2, "0"),
  ].join(":");
}

/**
 * Check whether a reset timestamp is still valid (not yet reached).
 */
export function isResetPending(resetTimestamp: number | null): boolean {
  if (resetTimestamp === null) return false;
  return resetTimestamp > Date.now();
}

/**
 * Update countdown in-place on a UsageState.
 */
export function updateCountdown(state: UsageState): void {
  if (state.resetTimestamp === null || state.resetTimestamp <= Date.now()) {
    state.countdownMs = null;
    return;
  }
  state.countdownMs = state.resetTimestamp - Date.now();
}
