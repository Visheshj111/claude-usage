import { feedDetection, setApiConnected, setApiError, getState } from '../backend/state-manager';
import { isUsableOrgId, rememberContentOrgId, resolveOrgId, sendRuntimeMessage, fetchPlanInfo } from './org-id';
import { notifyOrgIdFromWatcher, getLatestApiHeaders } from '../backend/network-monitor';
import { POLLING } from '../config';
import { parseUsagePayload } from '../backend/usage-parser';
import type { DetectedUsage, WeeklyUsage } from '../backend/types';

let _onUIUpdate: (() => void) | null = null;
const _postCompletionTimers = new Set<ReturnType<typeof setTimeout>>();

export function setOnUIUpdate(cb: () => void): void {
  _onUIUpdate = cb;
}

let usageFetchPromise: Promise<boolean> | null = null;

// ── SSE session cache ─────────────────────────────────────────────────────────
// For free-plan users, /usage returns an empty response (limits: []).
// We cache the last SSE message_limit windows here and apply them as fallback.
//
// Key: orgId  Value: { session, weekly } (same shape as parsed from parseSseWindow)
// TTL: 8 days — a 7d window can reset that far out; evict via resets_at check, not age.

const SSE_CACHE_KEY = "cut_sse_usage_v1";

interface SseWindowSnapshot {
  percentage: number;
  resetsAt: number; // ms
}

interface SseUsageSnapshot {
  session?: SseWindowSnapshot;
  weekly?: SseWindowSnapshot;
}

async function loadSseCache(): Promise<Record<string, SseUsageSnapshot>> {
  try {
    const result = await chrome.storage.local.get(SSE_CACHE_KEY) as Record<string, unknown>;
    return (result[SSE_CACHE_KEY] as Record<string, SseUsageSnapshot>) || {};
  } catch {
    return {};
  }
}

async function saveSseCache(cache: Record<string, SseUsageSnapshot>): Promise<void> {
  try {
    await chrome.storage.local.set({ [SSE_CACHE_KEY]: cache });
  } catch {
    // ignore storage errors
  }
}

/**
 * Called by message-listener.ts after a successful mapEventToDetected parse.
 * Stores the SSE session/weekly windows for free-plan fallback.
 */
export async function storeSseSnapshot(orgId: string, detected: DetectedUsage): Promise<void> {
  if (!isUsableOrgId(orgId)) return;

  // Only store if we got useful session data from the SSE event
  if (detected.usagePercent === undefined && !detected.weeklyUsage) return;

  const cache = await loadSseCache();
  const previous = cache[orgId] || {};

  const next: SseUsageSnapshot = { ...previous };

  if (detected.usagePercent !== undefined && detected.resetTimestamp) {
    // Use a same-window tolerance: if the reset shifted by < 5 min it's the same window;
    // only update if the new value is higher (usage only goes up within a window).
    const prevSession = previous.session;
    const sameWindow = prevSession &&
      Math.abs(prevSession.resetsAt - detected.resetTimestamp) < 5 * 60 * 1000;
    if (!sameWindow || detected.usagePercent > prevSession.percentage) {
      next.session = { percentage: detected.usagePercent, resetsAt: detected.resetTimestamp };
    }
  }

  if (detected.weeklyUsage?.resetsAt && detected.weeklyUsage.usagePercent !== null) {
    const prevWeekly = previous.weekly;
    const sameWindow = prevWeekly &&
      Math.abs(prevWeekly.resetsAt - (detected.weeklyUsage.resetsAt ?? 0)) < 60 * 60 * 1000;
    const pct = detected.weeklyUsage.usagePercent ?? 0;
    if (!sameWindow || pct > prevWeekly.percentage) {
      next.weekly = { percentage: pct, resetsAt: detected.weeklyUsage.resetsAt };
    }
  }

  cache[orgId] = next;
  await saveSseCache(cache);
}

/**
 * When /usage returns empty data and the plan is free, apply the last cached SSE
 * session + weekly windows as a DetectedUsage with slightly lower confidence.
 *
 * Returns true if a fallback was applied.
 */
async function applySseFallback(orgId: string): Promise<boolean> {
  // Only apply for free plan (or unknown, which is the default before plan info loads)
  const plan = getState().planTier;
  if (plan !== 'free' && plan !== 'unknown') return false;

  const cache = await loadSseCache();
  const stored = cache[orgId];
  if (!stored) return false;

  const now = Date.now();
  const detected: DetectedUsage = {
    source: 'official-ui',
    confidence: 0.85,
    hasAccurateData: true,
    orgId,
  };

  let applied = false;

  if (stored.session?.resetsAt && stored.session.resetsAt > now) {
    detected.usagePercent = stored.session.percentage;
    detected.resetTimestamp = stored.session.resetsAt;
    detected.limitType = 'soft';
    if (stored.session.percentage >= 100) {
      detected.isRateLimited = true;
    }
    applied = true;
  }

  if (stored.weekly?.resetsAt && stored.weekly.resetsAt > now) {
    const weekly: WeeklyUsage = {
      usagePercent: stored.weekly.percentage,
      messagesUsed: null,
      maxMessages: null,
      resetsAt: stored.weekly.resetsAt,
    };
    detected.weeklyUsage = weekly;
    applied = true;
  }

  if (!applied) return false;

  feedDetection(detected);
  return true;
}

// ── Main fetch logic ──────────────────────────────────────────────────────────

export async function fetchUsageFromAPI(explicitOrgId?: string | null, force = false): Promise<boolean> {
  if (usageFetchPromise && !force) return usageFetchPromise;
  const promise = fetchUsageFromAPIInner(explicitOrgId);
  usageFetchPromise = promise;
  try {
    return await promise;
  } finally {
    if (usageFetchPromise === promise) usageFetchPromise = null;
  }
}

async function fetchUsageFromAPIInner(explicitOrgId?: string | null): Promise<boolean> {
  const candidateOrgId = explicitOrgId ?? await resolveOrgId();
  const orgId = isUsableOrgId(candidateOrgId) ? candidateOrgId : null;
  if (!orgId) return false;
  rememberContentOrgId(orgId);

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const latestHeaders = getLatestApiHeaders();
    for (const [k, v] of Object.entries(latestHeaders)) {
      headers[k] = String(v);
    }

    const response = await fetch(`https://claude.ai/api/organizations/${orgId}/usage`, {
      credentials: "include",
      headers,
    });
    if (!response.ok && response.status !== 403 && response.status !== 429) {
      setApiError(response.status);
      return false;
    }

    let data: Record<string, unknown> | null = null;
    try {
      data = await response.json();
    } catch {
      // JSON parse failed
    }

    if (!data) {
      if (!response.ok) setApiError(response.status);
      else setApiConnected(false);
      return false;
    }

    const detected = parseUsagePayload(data, orgId);
    if (!detected) {
      // /usage returned a valid JSON with no recognisable limit data.
      // This is the expected response for free-plan accounts.
      // Mark the API as connected (it responded 200) and try to apply the SSE fallback.
      if (response.ok) {
        console.log("[CUT] /usage parse returned null — keys:", Object.keys(data));
        setApiConnected(true);
        const appliedFallback = await applySseFallback(orgId);
        if (appliedFallback) {
          console.log("[CUT] Applied SSE session fallback for free-plan /usage response.");
        }
        // Return true: the API is reachable; we just don't have /usage limits.
        return true;
      }
      setApiError(response.status);
      return false;
    }

    console.log("[CUT] /usage parsed — pct:", detected.usagePercent, "remaining:", detected.remainingMessages, "source:", detected.source);
    setApiConnected(true);
    feedDetection(detected);
    return true;
  } catch {
    setApiConnected(false);
    return false;
  }
}

export async function refreshUsageAndUI(force = false, explicitOrgId?: string | null): Promise<boolean> {
  const orgId = explicitOrgId ?? await resolveOrgId();
  const fetched = await fetchUsageFromAPI(orgId, force);
  if (!fetched && force) {
    await sendRuntimeMessage({ type: "FORCE_FETCH_USAGE", orgId });
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  _onUIUpdate?.();
  return fetched;
}


export function handleBgUsagePush(data: Record<string, unknown>, orgId: string): void {
  if (!isUsableOrgId(orgId)) return;
  const detected = parseUsagePayload(data, orgId);
  if (!detected) return;

  setApiConnected(true);
  rememberContentOrgId(orgId);
  feedDetection(detected);
  fetchPlanInfo(orgId);
  _onUIUpdate?.();
}

export function schedulePostCompletionUsageRefresh(orgId: string | null): void {
  if (orgId) notifyOrgIdFromWatcher(orgId);
  // Cancel any pending timers from a previous completion
  for (const t of _postCompletionTimers) clearTimeout(t);
  _postCompletionTimers.clear();

  // Schedule ALL retry delays so we catch the backend updating /usage
  // (Claude's backend may take a few seconds to finalize accounting)
  for (const delay of POLLING.postCompletionRetries) {
    const t = setTimeout(() => {
      _postCompletionTimers.delete(t);
      void refreshUsageAndUI(true, orgId);
    }, delay);
    _postCompletionTimers.add(t);
  }
}
