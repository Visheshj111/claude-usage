import { feedDetection, setApiConnected, setApiError } from "../backend/state-manager";
import type { DetectedUsage, WeeklyUsage } from "../backend/types";
import { isUsableOrgId, rememberContentOrgId, resolveOrgId, sendRuntimeMessage, fetchPlanInfo } from "./org-id";
import { notifyOrgIdFromWatcher } from "../backend/network-monitor";

let _onUIUpdate: (() => void) | null = null;

export function setOnUIUpdate(cb: () => void): void {
  _onUIUpdate = cb;
}

let usageFetchPromise: Promise<boolean> | null = null;

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
    const response = await fetch(`https://claude.ai/api/organizations/${orgId}/usage`, {
      credentials: "include",
      headers: { "Content-Type": "application/json" },
    });
    if (!response.ok) {
      console.warn(`[CUT] /usage returned ${response.status} — API error`);
      setApiError(response.status);
      return false;
    }

    const data: Record<string, unknown> = await response.json();
    const detected = parseUsagePayload(data, orgId);
    if (!detected) {
      setApiConnected(false);
      return false;
    }

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

function parseUsagePayload(data: Record<string, unknown>, orgId?: string): DetectedUsage | null {
  if (!data || !data.five_hour || typeof data.five_hour !== "object") return null;

  const fh = data.five_hour as Record<string, unknown>;
  const detected: DetectedUsage = {
    source: "network",
    confidence: 0.95,
    hasAccurateData: true,
  };
  if (orgId) detected.orgId = orgId;

  parseUsageWindow(fh, detected);

  if (data.maxed && typeof data.maxed === "object") {
    const mx = data.maxed as Record<string, unknown>;
    detected.limitType = "hard";
    const hardReset = timestampFromValue(mx.resets_at ?? mx.reset_at ?? mx.window_reset_at);
    if (hardReset) {
      detected.hardLimitResetAt = hardReset;
      detected.resetTimestamp = hardReset;
    }
    if (typeof mx.messages_used === "number") detected.sessionMessagesUsed = mx.messages_used;
    detected.isRateLimited = true;
  } else {
    detected.limitType = "soft";
  }

  if (data.seven_day && typeof data.seven_day === "object") {
    const w = parseWeeklyField(data.seven_day as Record<string, unknown>);
    if (w) detected.weeklyUsage = w;
  }
  if (data.seven_day_sonnet && typeof data.seven_day_sonnet === "object") {
    const w = parseWeeklyField(data.seven_day_sonnet as Record<string, unknown>);
    if (w) detected.weeklySonnetUsage = w;
  }
  if (data.seven_day_opus && typeof data.seven_day_opus === "object") {
    const w = parseWeeklyField(data.seven_day_opus as Record<string, unknown>);
    if (w) detected.weeklyOpusUsage = w;
  }

  return detected;
}

function parseUsageWindow(windowData: Record<string, unknown>, detected: DetectedUsage): void {
  const utilization = numberFromValue(windowData.utilization);
  const maxMessages = numberFromValue(windowData.max_messages ?? windowData.message_limit ?? windowData.limit);
  const remainingMessages = numberFromValue(windowData.remaining_messages ?? windowData.messages_remaining ?? windowData.remaining);
  const messagesUsed = numberFromValue(windowData.messages_used ?? windowData.used_messages ?? windowData.used);
  const resetTimestamp = timestampFromValue(windowData.resets_at ?? windowData.reset_at ?? windowData.window_reset_at);

  if (utilization !== null) detected.usagePercent = utilization;
  if (maxMessages !== null && maxMessages > 0) detected.sessionLimit = maxMessages;

  if (remainingMessages !== null) {
    detected.remainingMessages = Math.max(0, remainingMessages);
  } else if (maxMessages !== null && utilization !== null) {
    const used = (utilization / 100) * maxMessages;
    detected.remainingMessages = Math.max(0, Math.round((maxMessages - used) * 10) / 10);
  }

  if (messagesUsed !== null) {
    detected.sessionMessagesUsed = Math.max(0, messagesUsed);
  } else if (maxMessages !== null && detected.remainingMessages !== undefined) {
    detected.sessionMessagesUsed = Math.max(0, maxMessages - detected.remainingMessages);
  } else if (maxMessages !== null && utilization !== null) {
    detected.sessionMessagesUsed = Math.max(0, (utilization / 100) * maxMessages);
  }

  if (resetTimestamp) detected.resetTimestamp = resetTimestamp;
  if (utilization !== null && utilization >= 100) detected.isRateLimited = true;
}

function numberFromValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function timestampFromValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value > 1e12 ? value : value * 1000;
  if (typeof value === "string" && value.trim()) {
    const ts = new Date(value).getTime();
    return Number.isFinite(ts) ? ts : null;
  }
  return null;
}

function parseWeeklyField(obj: Record<string, unknown>): WeeklyUsage | null {
  if (typeof obj.utilization !== "number" && typeof obj.max_messages !== "number") return null;
  return {
    usagePercent: typeof obj.utilization === "number" ? obj.utilization : null,
    messagesUsed: typeof obj.utilization === "number" && typeof obj.max_messages === "number"
      ? Math.round((obj.utilization / 100) * obj.max_messages)
      : null,
    maxMessages: typeof obj.max_messages === "number" ? obj.max_messages : null,
    resetsAt: timestampFromValue(obj.resets_at),
  };
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
  void refreshUsageAndUI(true, orgId);
  setTimeout(() => { void refreshUsageAndUI(true, orgId); }, 1500);
  setTimeout(() => { void refreshUsageAndUI(true, orgId); }, 5000);
  setTimeout(() => { void refreshUsageAndUI(true, orgId); }, 12000);
}
