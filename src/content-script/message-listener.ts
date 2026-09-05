import { getState, feedDetection } from "../backend/state-manager";
import { handleNetworkQuota, runDetection } from "../backend/tracker";
import { handleBgUsagePush, refreshUsageAndUI, schedulePostCompletionUsageRefresh, storeSseSnapshot } from "./usage-api";
import { exportChat } from "./chat-export";
import { lastMessageStats, setLastMessageStats } from "./state";
import { formatNum } from "./ui-widget";
import type { NetworkQuota, DetectedUsage, WeeklyUsage } from "../backend/types";

// ── Message listener (registered immediately, before init completes) ──
try {
  if (chrome.runtime?.id) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      switch (msg.type) {
        case "GET_STATE":
          sendResponse(getState());
          break;
        case "WEBREQUEST_QUOTA":
          handleNetworkQuota(msg.quota);
          break;
        case "BG_USAGE_PUSH":
          handleBgUsagePush(msg.data, msg.orgId);
          break;
        case "MANUAL_SCAN":
          runDetection("manual");
          sendResponse(getState());
          break;
        case "EXPORT_CHAT":
          exportChat(msg.percentage, msg.format).then(sendResponse);
          return true;
      }
    });
  }
} catch {
  // Extension context was invalidated before listener registration.
}

// ── Page-context watcher events ──

// cut-completion-done: SSE stream fully consumed — Claude has finished responding.
window.addEventListener("cut-completion-done", ((e: CustomEvent<string>) => {
  schedulePostCompletionUsageRefresh(e.detail || null);
}) as EventListener);

window.addEventListener("cut-conversation-synced", ((e: CustomEvent<{ orgId?: string }>) => {
  schedulePostCompletionUsageRefresh(e.detail?.orgId || null);
}) as EventListener);

window.addEventListener('cut-debug', ((e: CustomEvent<string>) => {
  console.log('[CUT] WATCHER:', e.detail);
}) as EventListener);

window.addEventListener("cut-quota", ((e: CustomEvent) => {
  const data = e.detail;
  if (!data || typeof data !== "object") return;

  console.log("[CUT] cut-quota event received. Has message_limit:", !!data.message_limit, "Has windows:", !!(data.message_limit as any)?.windows);

  // Prefer the richer DetectedUsage path (handles new windows format + weekly data)
  const detected = mapEventToDetected(data);
  if (detected) {
    console.log("[CUT] cut-quota → new windows format. pct:", detected.usagePercent, "resetTs:", detected.resetTimestamp, "weekly:", detected.weeklyUsage?.usagePercent);
    feedDetection(detected);
    // Persist SSE snapshot for free-plan fallback (async, fire-and-forget).
    // orgId may not be in `detected` (SSE payload doesn't carry it), fall back to state.
    const snapshotOrgId = detected.orgId ?? getState().orgId;
    if (snapshotOrgId) {
      void storeSseSnapshot(snapshotOrgId, detected);
    }
    void refreshUsageAndUI(false);
    return;
  }

  // Legacy path: usage_metadata only (no message_limit in this event)
  const quota = mapEventToQuota(data);
  if (quota) {
    console.log("[CUT] cut-quota → legacy quota. remaining:", quota.remaining, "reset:", quota.reset);
    handleNetworkQuota(quota);
    void refreshUsageAndUI(false);
  } else {
    console.log("[CUT] cut-quota → no usable data extracted from event.");
  }
}) as EventListener);


// cut-message-stats: emitted by watcher.js from SSE message_start events.
window.addEventListener("cut-message-stats", ((e: CustomEvent<{ inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number; totalTokens: number; timestamp: number }>) => {
  if (e.detail && typeof e.detail.totalTokens === "number") {
    setLastMessageStats(e.detail);
    const ctxRow = document.getElementById("cut-ctx-row");
    if (ctxRow) {
      const s = lastMessageStats!;
      const totalToks = s.totalTokens;
      const cachedToks = s.cacheReadTokens;
      const cachedPct = totalToks > 0 ? Math.round((cachedToks / totalToks) * 100) : 0;
      ctxRow.style.display = "";
      const lenEl = document.getElementById("cut-ctx-length");
      const costEl = document.getElementById("cut-ctx-cost");
      const cachedEl = document.getElementById("cut-ctx-cached");
      if (lenEl) lenEl.textContent = formatNum(totalToks) + " tok";
      if (costEl) costEl.textContent = formatNum(Math.round(totalToks * 0.003)) + " cr";
      if (cachedEl) cachedEl.textContent = cachedPct > 0 ? cachedPct + "% cached" : "0%";
    }
  }
}) as EventListener);

/**
 * Parse one window entry from the new message_limit.windows map.
 *
 * New format (2026-08-20):
 *   { status: "exceeded_limit" | "within_limit", resets_at: <unix seconds>, utilization: 0.0-1.0 }
 *
 * - utilization is a 0–1 fraction  →  multiply × 100 for display percent
 * - resets_at is unix seconds       →  multiply × 1000 for ms timestamp
 * - status "exceeded_limit" + surpassed_threshold means truly maxed, clamp to 100 %
 */
function parseSseWindow(win: Record<string, unknown>): { percentage: number; resetsAt: number } | null {
  if (!win || typeof win.utilization !== "number" || !win.resets_at) return null;
  const exceeded = win.status === "exceeded_limit";
  return {
    percentage: exceeded ? 100 : Math.round((win.utilization as number) * 100),
    resetsAt: (win.resets_at as number) * 1000,
  };
}

/**
 * Map a `cut-quota` event payload to a full DetectedUsage using the NEW message_limit.windows
 * format. Returns null if the payload does not contain a recognised message_limit structure,
 * which lets the caller fall through to the legacy NetworkQuota path.
 */
function mapEventToDetected(data: Record<string, unknown>): DetectedUsage | null {
  if (!data.message_limit || typeof data.message_limit !== "object") return null;
  const ml = data.message_limit as Record<string, unknown>;

  // New format has a `windows` object; old format does not.
  const windows = ml.windows as Record<string, Record<string, unknown>> | undefined;
  if (!windows || typeof windows !== "object") return null;

  const detected: DetectedUsage = {
    source: "network",
    confidence: 0.95,
    hasAccurateData: true,
  };

  // ── 5-hour session window ──
  const win5h = windows["5h"];
  if (win5h && typeof win5h === "object") {
    const parsed = parseSseWindow(win5h);
    if (parsed) {
      detected.usagePercent = parsed.percentage;
      detected.resetTimestamp = parsed.resetsAt;
      if (parsed.percentage >= 100) {
        detected.isRateLimited = true;
      }
      detected.limitType = "soft";
    }
  }

  // ── 7-day weekly window ──
  const win7d = windows["7d"];
  if (win7d && typeof win7d === "object") {
    const parsed = parseSseWindow(win7d);
    if (parsed) {
      const weekly: WeeklyUsage = {
        usagePercent: parsed.percentage,
        messagesUsed: null,
        maxMessages: null,
        resetsAt: parsed.resetsAt,
      };
      detected.weeklyUsage = weekly;
    }
  }

  // ── Top-level type fallback (old-style or extra info) ──
  // New type strings: "exceeded_limit" / "within_limit"
  // Old type strings: "maxed" / "within_5hour_window"
  const mlType = String(ml.type || "").toLowerCase();
  if (mlType === "maxed") {
    detected.limitType = "hard";
    if (detected.resetTimestamp) detected.hardLimitResetAt = detected.resetTimestamp;
    detected.isRateLimited = true;
    detected.usagePercent = 100;
  }

  // Top-level resetsAt as unix seconds (new) or ISO string (old) — use as fallback
  if (!detected.resetTimestamp && ml.resetsAt) {
    const raw = ml.resetsAt;
    const ts = typeof raw === "number"
      ? (raw > 1e10 ? raw : raw * 1000)   // unix seconds vs ms
      : new Date(String(raw)).getTime();  // ISO string
    if (!isNaN(ts) && ts > 0) detected.resetTimestamp = ts;
  }

  // Only return if we actually extracted something useful
  if (detected.usagePercent === undefined && !detected.resetTimestamp && !detected.weeklyUsage) {
    return null;
  }
  return detected;
}

/**
 * Legacy fallback: handles usage_metadata and old-style message_limit without `windows`.
 */
function mapEventToQuota(data: Record<string, unknown>): NetworkQuota | null {
  const quota: NetworkQuota = {};
  let found = false;

  if (data.message_limit && typeof data.message_limit === "object") {
    const ml = data.message_limit as Record<string, unknown>;
    // Old format: resetsAt is an ISO date string
    if (ml.resetsAt || ml.resets_at) {
      const raw = ml.resetsAt ?? ml.resets_at;
      const ts = typeof raw === "number"
        ? (raw > 1e10 ? raw : raw * 1000)
        : new Date(String(raw)).getTime();
      if (!isNaN(ts)) { quota.reset = ts; quota.remaining = 0; found = true; }
    }
    const mlType = String(ml.type || "").toLowerCase();
    if (mlType === "maxed") {
      quota.limitType = "hard";
      if (quota.reset) quota.hardLimitResetAt = quota.reset;
    } else if (mlType === "within_5hour_window" || mlType === "within_limit") {
      quota.limitType = "soft";
    } else if (mlType === "exceeded_limit") {
      quota.limitType = "soft";
      quota.remaining = 0;
      found = true;
    }
  }

  if (data.usage_metadata && typeof data.usage_metadata === "object") {
    const um = data.usage_metadata as Record<string, unknown>;
    if (typeof um.remaining_messages === "number") {
      quota.remaining = um.remaining_messages; found = true;
    }
    if (typeof um.message_limit === "number") {
      quota.limit = um.message_limit; found = true;
    }
    const resetKey = um.window_reset_at || um.resets_at || um.reset_at;
    if (resetKey) {
      const ts = new Date(String(resetKey)).getTime();
      if (!isNaN(ts)) { quota.reset = ts; found = true; }
    }
  }

  return found ? quota : null;
}
