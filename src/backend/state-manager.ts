/**
 * State Manager — central UsageState hub.
 * - Accepts new detections from the pipeline
 * - Computes confidence-weighted merges
 * - Persists to storage
 * - Emits change callbacks
 */

import type { UsageState, DataSource, DetectedUsage } from "./types";
import { emptyUsage, cloneUsage, isSameState } from "./types";
import { updateCountdown } from "./reset-parser";
import { persistUsage, loadPersisted } from "./storage";

const SOURCE_PRIORITY: Record<DataSource, number> = {
  network: 100,
  "official-ui": 90,
  banner: 70,
  computed: 20,
  estimated: 30,
  unknown: 0,
};

const COOLDOWN_MS = 5000;

export type StateChangeCallback = (newState: UsageState, oldState: UsageState) => void;

let currentState: UsageState = emptyUsage();
let lastUpdated = 0;
const changeListeners: StateChangeCallback[] = [];
let timerHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Initialize state from persisted storage.
 */
export async function initState(): Promise<void> {
  const persisted = await loadPersisted();
  currentState = persisted.lastKnownUsage;
  lastUpdated = persisted.lastUpdated;

  if (currentState.resetTimestamp) {
    updateCountdown(currentState);
  }
}

/**
 * Get current state (with up-to-date countdown).
 */
export function getState(): UsageState {
  if (currentState.resetTimestamp) {
    updateCountdown(currentState);
  }
  return currentState;
}

/**
 * Feed a detected usage value into the state manager.
 * Merges with current state based on confidence and source priority.
 */
export function feedDetection(detected: DetectedUsage): UsageState {
  const oldState = cloneUsage(currentState);

  // Cooldown: don't overwrite high-confidence with low-confidence too fast
  if (
    detected.confidence < currentState.confidence &&
    detected.source !== "network" &&
    Date.now() - lastUpdated < COOLDOWN_MS
  ) {
    return currentState;
  }

  // Source priority check: don't downgrade source
  const newPrio = SOURCE_PRIORITY[detected.source] ?? 0;
  const oldPrio = SOURCE_PRIORITY[currentState.source] ?? 0;

  if (newPrio < oldPrio && detected.confidence < currentState.confidence) {
    return currentState;
  }

  // Merge fields
  if (detected.usagePercent !== undefined) {
    currentState.usagePercent = detected.source === "estimated"
      ? weightedMerge(currentState.usagePercent, detected.usagePercent, detected.confidence)
      : detected.usagePercent;
  }

  if (detected.isRateLimited !== undefined) {
    currentState.isRateLimited = detected.isRateLimited;
  }

  if (detected.limitType !== undefined) {
    currentState.limitType = detected.limitType;
  }

  if (detected.hardLimitResetAt !== undefined) {
    currentState.hardLimitResetAt = detected.hardLimitResetAt;
  }

  if (detected.orgId !== undefined) {
    currentState.orgId = detected.orgId;
  }

  if (detected.hasAccurateData !== undefined) {
    currentState.hasAccurateData = detected.hasAccurateData;
  }

  if (detected.planTier !== undefined) {
    currentState.planTier = detected.planTier;
  }

  if (detected.weeklyUsage !== undefined) {
    currentState.weeklyUsage = detected.weeklyUsage;
  }

  if (detected.weeklySonnetUsage !== undefined) {
    currentState.weeklySonnetUsage = detected.weeklySonnetUsage;
  }

  if (detected.weeklyOpusUsage !== undefined) {
    currentState.weeklyOpusUsage = detected.weeklyOpusUsage;
  }

  if (detected.isPeakHours !== undefined) {
    currentState.isPeakHours = detected.isPeakHours;
  }

  if (detected.peakHoursTransitionAt !== undefined) {
    currentState.peakHoursTransitionAt = detected.peakHoursTransitionAt;
  }

  if (detected.resetTimestamp !== undefined) {
    currentState.resetTimestamp = detected.resetTimestamp;
    currentState.sessionWindowStartTs = detected.resetTimestamp - currentState.sessionWindowMs;
    updateCountdown(currentState);
  }

  if (detected.remainingMessages !== undefined) {
    currentState.remainingMessages =
      currentState.remainingMessages !== null &&
      detected.source === "estimated"
        ? weightedMerge(currentState.remainingMessages, detected.remainingMessages, detected.confidence)
        : detected.remainingMessages;
  }

  if (detected.retireAfterSeconds !== undefined) {
    currentState.resetTimestamp = Date.now() + detected.retireAfterSeconds * 1000;
    updateCountdown(currentState);
  }

  let touchedSessionFields = false;

  if (detected.sessionLimit !== undefined) {
    currentState.sessionLimit = detected.sessionLimit;
    touchedSessionFields = true;
  }

  if (detected.sessionMessagesUsed !== undefined) {
    currentState.sessionMessagesUsed = detected.sessionMessagesUsed;
    touchedSessionFields = true;
  }

  if (detected.usagePercent !== undefined && detected.sessionLimit !== undefined) {
    currentState.sessionMessagesUsed = Math.round((detected.usagePercent / 100) * detected.sessionLimit);
    touchedSessionFields = true;
  }

  if (touchedSessionFields && currentState.sessionLimit && currentState.remainingMessages !== null) {
    currentState.sessionMessagesUsed = currentState.sessionLimit - currentState.remainingMessages;
  }

  // Update source and confidence (skip for computed — local clock calculations should not overwrite real data source)
  if (detected.source !== "computed") {
    currentState.source = detected.source;
    currentState.confidence = Math.max(currentState.confidence, detected.confidence);
  }

  lastUpdated = Date.now();

  if (!isSameState(currentState, oldState)) {
    persistUsage(currentState);
    emitChange(oldState);
  }

  return currentState;
}

/**
 * Mark as not rate-limited (e.g., on navigations where no limit banner is found).
 */
export function clearRateLimit(): void {
  const oldState = cloneUsage(currentState);
  if (!currentState.isRateLimited) return;
  currentState.isRateLimited = false;
  persistUsage(currentState);
  emitChange(oldState);
}

/**
 * Set the API connection status (red/green dot indicator).
 */
export function setApiConnected(connected: boolean): void {
  const oldState = cloneUsage(currentState);
  if (currentState.apiConnected === connected && currentState.apiErrorStatus === null) return;
  currentState.apiConnected = connected;
  if (connected) currentState.apiErrorStatus = null; // clear any previous error
  persistUsage(currentState);
  emitChange(oldState);
}

/**
 * Record a failed /usage API call with its HTTP status code.
 * Sets apiConnected=false and stores the status so the popup can show
 * a specific error (e.g. "API error 401" vs "API error 503").
 */
export function setApiError(status: number): void {
  const oldState = cloneUsage(currentState);
  if (!currentState.apiConnected && currentState.apiErrorStatus === status) return;
  currentState.apiConnected = false;
  currentState.apiErrorStatus = status;
  persistUsage(currentState);
  emitChange(oldState);
}

/**
 * Reset all state to empty.
 */
export async function resetState(): Promise<void> {
  const oldState = cloneUsage(currentState);
  currentState = emptyUsage();
  lastUpdated = Date.now();
  await persistUsage(currentState);
  emitChange(oldState);
}

/**
 * Start a periodic countdown ticker (every 1s) to keep countdownMs fresh.
 * Returns an unsubscribe function.
 */
export function startCountdownTicker(): () => void {
  if (timerHandle) return () => stopCountdownTicker();

  timerHandle = setInterval(() => {
    if (currentState.resetTimestamp && currentState.resetTimestamp > Date.now()) {
      const oldMs = currentState.countdownMs;
      currentState.countdownMs = currentState.resetTimestamp - Date.now();

      if (oldMs !== currentState.countdownMs) {
        emitChange(cloneUsage(currentState));
      }
    }
  }, 1000);

  return () => stopCountdownTicker();
}

export function stopCountdownTicker(): void {
  if (timerHandle) {
    clearInterval(timerHandle);
    timerHandle = null;
  }
}

export function onChange(cb: StateChangeCallback): void {
  changeListeners.push(cb);
}

export function offChange(cb: StateChangeCallback): void {
  const idx = changeListeners.indexOf(cb);
  if (idx >= 0) changeListeners.splice(idx, 1);
}

function emitChange(oldState: UsageState): void {
  for (const cb of changeListeners) {
    try {
      cb(currentState, oldState);
    } catch {
      // Swallow listener errors
    }
  }
}

function weightedMerge(
  current: number | null,
  incoming: number,
  incomingConfidence: number
): number {
  if (current === null) return incoming;
  const w = Math.min(incomingConfidence, 0.5);
  return Math.round(current * (1 - w) + incoming * w);
}
