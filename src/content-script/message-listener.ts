import { getState } from "../backend/state-manager";
import { handleNetworkQuota, runDetection } from "../backend/tracker";
import { handleBgUsagePush, refreshUsageAndUI, schedulePostCompletionUsageRefresh } from "./usage-api";
import { exportChat } from "./chat-export";
import { lastMessageStats, setLastMessageStats } from "./state";
import { formatNum } from "./ui-widget";
import type { NetworkQuota } from "../backend/types";

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

window.addEventListener("cut-quota", ((e: CustomEvent) => {
  const data = e.detail;
  if (!data || typeof data !== "object") return;
  const quota = mapEventToQuota(data);
  if (quota) {
    handleNetworkQuota(quota);
    void refreshUsageAndUI(false);
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

function mapEventToQuota(data: Record<string, unknown>): NetworkQuota | null {
  const quota: NetworkQuota = {};
  let found = false;

  if (data.message_limit && typeof data.message_limit === "object") {
    const ml = data.message_limit as Record<string, unknown>;
    if (ml.resetsAt || ml.resets_at) {
      const ts = new Date(String(ml.resetsAt ?? ml.resets_at)).getTime();
      if (!isNaN(ts)) { quota.reset = ts; quota.remaining = 0; found = true; }
    }
    const mlType = String(ml.type || "").toLowerCase();
    if (mlType === "maxed") {
      quota.limitType = "hard";
      if (quota.reset) quota.hardLimitResetAt = quota.reset;
    } else if (mlType === "within_5hour_window") {
      quota.limitType = "soft";
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
