/**
 * Background / Service Worker entry point.
 *
 * Preserves ALL old functionality:
 *   - usage / conversations / session / settings storage
 *   - UPDATE_USAGE, GET_ALL_DATA, SAVE_SETTINGS, RESET_USAGE, etc.
 *   - Milestone notifications
 *   - History
 *
 * Adds new detection backend:
 *   - UsageState management
 *   - Alarms heartbeat
 *   - STATE_UPDATE relay
 *
 * CHANGES:
 * 1. Settings: sessionWindowMs, resetPeriod "5h", dailyMessages 45, dailyTokens 90000
 * 2. computeNextReset(): "5h" case (rolling 5-hour window from windowStartTs)
 * 3. getAllData(): sessionPct, sessionLimit, sessionMessagesUsed, sessionWindowMs
 * 4. checkMilestone(): better ratios & remaining-message warnings
 */

import { initState, getState, onChange, startCountdownTicker, resetState } from "./backend/state-manager";
import type { UsageState, NetworkQuota } from "./backend/types";

// ── Settings interface ──
interface Settings {
  resetPeriod: string;
  tokenEstimationMethod: string;
  showNotifications: boolean;
  themeMode?: string;
  limits: {
    dailyMessages: number;
    dailyTokens: number;
    sessionWindowMs: number;
  };
}

interface DayUsage {
  messagesSent: number;
  messagesReceived: number;
  charsSent: number;
  charsReceived: number;
  tokensSent: number;
  tokensReceived: number;
  conversations: number;
}

interface PeriodUsage extends DayUsage {
  conversationIds: string[];
}

interface ConversationEntry {
  title: string;
  startedAt: string;
  totalMessages: number;
  messagesSent: number;
  messagesReceived: number;
  charsSent: number;
  charsReceived: number;
  tokensSent: number;
  tokensReceived: number;
}

interface SessionData {
  startTime: number;
  messagesSent: number;
  messagesReceived: number;
  tokensSent: number;
  tokensReceived: number;
  charsSent: number;
  charsReceived: number;
  conversations: number;
  elapsed?: number;
}

type HourlyUsage = Record<string, number[]>;

const DEFAULT_SETTINGS: Settings = {
  resetPeriod: "5h",
  tokenEstimationMethod: "chars/4",
  showNotifications: true,
  limits: {
    dailyMessages: 45,
    dailyTokens: 90000,
    sessionWindowMs: 5 * 60 * 60 * 1000,
  },
};

let settingsCache: Settings | null = null;
let settingsLoadPromise: Promise<Settings> | null = null;

async function getSettings(): Promise<Settings> {
  if (settingsCache) return settingsCache;
  if (settingsLoadPromise) return settingsLoadPromise;

  settingsLoadPromise = (async () => {
    const { settings } = await chrome.storage.local.get("settings");
    settingsCache = settings || DEFAULT_SETTINGS;
    return settingsCache;
  })();

  return settingsLoadPromise;
}

async function saveSettings(data: Settings): Promise<void> {
  settingsCache = data;
  await chrome.storage.local.set({ settings: data });
}

// ── Key helpers ──
function getDateKey(d?: Date): string {
  const date = d || new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function getPeriodKey(period: string): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  switch (period || "5h") {
    case "5h": return getDateKey();
    case "daily": return getDateKey();
    case "weekly": {
      const w = getWeekNumber(d);
      return `${y}-W${String(w).padStart(2, "0")}`;
    }
    case "monthly": return `${y}-${m}`;
    default: return getDateKey();
  }
}

function getWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

function computeNextReset(period: string, windowStartTs?: number): number {
  const now = new Date();

  switch (period || "5h") {
    case "5h": {
      const start = windowStartTs && windowStartTs > 0 ? windowStartTs : Date.now();
      return start + 5 * 60 * 60 * 1000;
    }
    case "daily": {
      const next = new Date(now);
      next.setDate(next.getDate() + 1);
      next.setHours(0, 0, 0, 0);
      return next.getTime();
    }
    case "weekly": {
      const next = new Date(now);
      const day = next.getDay();
      const diff = day === 0 ? 1 : 8 - day;
      next.setDate(next.getDate() + diff);
      next.setHours(0, 0, 0, 0);
      return next.getTime();
    }
    case "monthly": {
      return new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0).getTime();
    }
    default:
      return Date.now() + 5 * 60 * 60 * 1000;
  }
}

function initDayUsage(existing?: DayUsage): DayUsage {
  return existing || {
    messagesSent: 0, messagesReceived: 0,
    charsSent: 0, charsReceived: 0,
    tokensSent: 0, tokensReceived: 0,
    conversations: 0,
  };
}

function initPeriodUsage(existing?: PeriodUsage): PeriodUsage {
  return existing || {
    messagesSent: 0, messagesReceived: 0,
    charsSent: 0, charsReceived: 0,
    tokensSent: 0, tokensReceived: 0,
    conversations: 0, conversationIds: [],
  };
}

function pruneHourlyUsage(hourlyUsage: HourlyUsage): HourlyUsage {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 55);
  const cutoffKey = getDateKey(cutoff);
  const pruned: HourlyUsage = {};
  for (const [dateKey, hours] of Object.entries(hourlyUsage)) {
    if (dateKey >= cutoffKey) {
      pruned[dateKey] = Array.from({ length: 24 }, (_, hour) => Number(hours?.[hour]) || 0);
    }
  }
  return pruned;
}

// ── Message Handlers ──
async function handleUsageUpdate(data: Record<string, unknown>): Promise<{ success: boolean }> {
  const { usage, conversations, hourlyUsage } = await chrome.storage.local.get(["usage", "conversations", "hourlyUsage"]);
  const today = getDateKey();
  const periodKey = getPeriodKey("daily");

  const dayUsage = initDayUsage(usage?.[today]);
  const periodUsage = initPeriodUsage(usage?.[periodKey]);
  const conversationsDb: Record<string, ConversationEntry> = conversations || {};
  let hourlyMessageDelta = 0;
  const convId = data.conversationId as string | undefined;

  if (convId && conversationsDb[convId]) {
    // Conversation exists — compute delta to avoid double-count on page refresh
    const existing = conversationsDb[convId];
    const convSent = (data.convTotalMessagesSent as number) || 0;
    const convRecv = (data.convTotalMessagesReceived as number) || 0;
    const convCharsSent = (data.convTotalCharsSent as number) || 0;
    const convCharsRecv = (data.convTotalCharsReceived as number) || 0;
    const alreadySent = existing.messagesSent || 0;
    const alreadyRecv = existing.messagesReceived || 0;
    const alreadyCharsSent = existing.charsSent || 0;
    const alreadyCharsRecv = existing.charsReceived || 0;

    const deltaSent = Math.max(0, convSent - alreadySent);
    const deltaRecv = Math.max(0, convRecv - alreadyRecv);
    const deltaCharsSent = Math.max(0, convCharsSent - alreadyCharsSent);
    const deltaCharsRecv = Math.max(0, convCharsRecv - alreadyCharsRecv);

    if (deltaSent > 0 || deltaRecv > 0) {
      dayUsage.messagesSent += deltaSent;
      dayUsage.messagesReceived += deltaRecv;
      dayUsage.charsSent += deltaCharsSent;
      dayUsage.charsReceived += deltaCharsRecv;
      dayUsage.tokensSent += Math.round(deltaCharsSent / 4);
      dayUsage.tokensReceived += Math.round(deltaCharsRecv / 4);

      periodUsage.messagesSent += deltaSent;
      periodUsage.messagesReceived += deltaRecv;
      periodUsage.charsSent += deltaCharsSent;
      periodUsage.charsReceived += deltaCharsRecv;
      periodUsage.tokensSent += Math.round(deltaCharsSent / 4);
      periodUsage.tokensReceived += Math.round(deltaCharsRecv / 4);
      hourlyMessageDelta += deltaSent + deltaRecv;
    }
  } else {
    // New conversation or no stored data — use incoming values directly
    const incomingSent = (data.messagesSent as number) || 0;
    const incomingRecv = (data.messagesReceived as number) || 0;
    dayUsage.messagesSent += incomingSent;
    dayUsage.messagesReceived += incomingRecv;
    dayUsage.charsSent += (data.charsSent as number) || 0;
    dayUsage.charsReceived += (data.charsReceived as number) || 0;
    dayUsage.tokensSent += (data.tokensSent as number) || 0;
    dayUsage.tokensReceived += (data.tokensReceived as number) || 0;

    periodUsage.messagesSent += incomingSent;
    periodUsage.messagesReceived += incomingRecv;
    periodUsage.charsSent += (data.charsSent as number) || 0;
    periodUsage.charsReceived += (data.charsReceived as number) || 0;
    periodUsage.tokensSent += (data.tokensSent as number) || 0;
    periodUsage.tokensReceived += (data.tokensReceived as number) || 0;
    hourlyMessageDelta += incomingSent + incomingRecv;
  }

  if (data.isNewConversation) {
    dayUsage.conversations += 1;
    periodUsage.conversations += 1;
  }

  if (convId && !periodUsage.conversationIds.includes(convId)) {
    periodUsage.conversationIds.push(convId);
  }

  const updatedUsage: Record<string, DayUsage | PeriodUsage> = {
    ...(usage || {}),
    [today]: dayUsage,
    [periodKey]: periodUsage,
  };

  let updatedHourlyUsage: HourlyUsage | undefined;
  if (hourlyMessageDelta > 0) {
    const now = new Date();
    const hour = now.getHours();
    updatedHourlyUsage = pruneHourlyUsage(hourlyUsage || {});
    const hours = updatedHourlyUsage[today] || Array.from({ length: 24 }, () => 0);
    hours[hour] = (hours[hour] || 0) + hourlyMessageDelta;
    updatedHourlyUsage[today] = hours;
  }

  if (convId) {
    if (!conversationsDb[convId]) {
      conversationsDb[convId] = {
        title: (data.conversationTitle as string) || "Untitled",
        startedAt: new Date().toISOString(),
        totalMessages: 0,
        messagesSent: 0,
        messagesReceived: 0,
        charsSent: 0,
        charsReceived: 0,
        tokensSent: 0,
        tokensReceived: 0,
      };
    }
    const conv = conversationsDb[convId];
    // Use absolute totals to avoid double-counting on page refresh
    const convSent = (data.convTotalMessagesSent as number) || 0;
    const convRecv = (data.convTotalMessagesReceived as number) || 0;
    const convCharsSent = (data.convTotalCharsSent as number) || 0;
    const convCharsRecv = (data.convTotalCharsReceived as number) || 0;
    if (convSent > conv.messagesSent || convRecv > conv.messagesReceived) {
      conv.messagesSent = Math.max(conv.messagesSent, convSent);
      conv.messagesReceived = Math.max(conv.messagesReceived, convRecv);
      conv.charsSent = Math.max(conv.charsSent, convCharsSent);
      conv.charsReceived = Math.max(conv.charsReceived, convCharsRecv);
      conv.totalMessages = conv.messagesSent + conv.messagesReceived;
      conv.tokensSent = Math.round(conv.charsSent / 4);
      conv.tokensReceived = Math.round(conv.charsReceived / 4);
    }
    if (data.conversationTitle) conv.title = data.conversationTitle as string;
  }

  await chrome.storage.local.set({
    usage: updatedUsage,
    conversations: conversationsDb,
    ...(updatedHourlyUsage ? { hourlyUsage: updatedHourlyUsage } : {}),
  });

  const settings = await getSettings();
  checkMilestone(dayUsage, settings);

  return { success: true };
}

async function handleSessionUpdate(data: { action: string } & Record<string, unknown>): Promise<{ success: boolean; session?: SessionData | null }> {
  const { session } = await chrome.storage.local.get("session");
  let s: SessionData | null = session || null;

  if (data.action === "start") {
    // Intentionally longer than Claude's 5h quota window so a genuinely new
    // quota window doesn't accidentally get treated as a "new session" — those
    // are two separate concepts and should reset on different triggers (session
    // = browser activity, quota window = server-side reset).
    const SESSION_STALE_MS = 6 * 60 * 60 * 1000;
    const existing = s;
    const isStale = !existing || (Date.now() - existing.startTime) > SESSION_STALE_MS;
    if (isStale) {
      s = {
        startTime: Date.now(),
        messagesSent: 0,
        messagesReceived: 0,
        tokensSent: 0,
        tokensReceived: 0,
        charsSent: 0,
        charsReceived: 0,
        conversations: 0,
      };
    }
  } else if (data.action === "update" && s) {
    s.messagesSent += (data.messagesSent as number) || 0;
    s.messagesReceived += (data.messagesReceived as number) || 0;
    s.tokensSent += (data.tokensSent as number) || 0;
    s.tokensReceived += (data.tokensReceived as number) || 0;
    s.charsSent += (data.charsSent as number) || 0;
    s.charsReceived += (data.charsReceived as number) || 0;
    if (data.isNewConversation) s.conversations += 1;
  } else if (data.action === "stop") {
    s = null;
  }

  if (s) {
    s.elapsed = Date.now() - s.startTime;
  }

  await chrome.storage.local.set({ session: s });
  return { success: true, session: s };
}

async function getAllData(): Promise<Record<string, unknown>> {
  const { usage, conversations, session } = await chrome.storage.local.get([
    "usage", "conversations", "session",
  ]);
  const currentSettings = await getSettings();
  const today = getDateKey();
  const dayUsage = usage?.[today] || initDayUsage();
  const periodKey = getPeriodKey(currentSettings.resetPeriod);
  const periodUsage = usage?.[periodKey] || initPeriodUsage();

  const limits = currentSettings.limits || DEFAULT_SETTINGS.limits;
  const msgsUsed = dayUsage.messagesSent + dayUsage.messagesReceived;
  const msgsRemaining = Math.max(0, limits.dailyMessages - msgsUsed);
  const tokensUsed = dayUsage.tokensSent + dayUsage.tokensReceived;
  const tokensRemaining = Math.max(0, limits.dailyTokens - tokensUsed);

  const backendState = getState();
  const windowStartTs = backendState.resetTimestamp
    ? backendState.resetTimestamp - (limits.sessionWindowMs || 5 * 60 * 60 * 1000)
    : (session?.startTime as number | undefined) ?? undefined;
  const nextReset = computeNextReset(currentSettings.resetPeriod, windowStartTs);
  const resetIn = nextReset - Date.now();

  // Prefer backend state (from /usage API), fall back to old tracking + settings
  const sessionLimit = backendState.sessionLimit ?? limits.dailyMessages;
  const sessionMessagesUsed = backendState.sessionMessagesUsed ?? msgsUsed;
  const remainingMessages = backendState.remainingMessages ?? Math.max(0, sessionLimit - sessionMessagesUsed);
  const sessionPct = backendState.usagePercent ?? (sessionLimit > 0
    ? Math.min(100, Math.round((sessionMessagesUsed / sessionLimit) * 100))
    : null);

  return {
    daily: dayUsage,
    period: periodUsage,
    remaining: {
      messages: remainingMessages,
      messagesTotal: sessionLimit,
      tokens: tokensRemaining,
      tokensTotal: limits.dailyTokens,
    },
    nextReset,
    resetIn: Math.max(0, resetIn),
    limits,
    conversations,
    session,
    settings: currentSettings,
    sessionPct,
    sessionLimit,
    sessionMessagesUsed,
    sessionWindowMs: limits.sessionWindowMs ?? (5 * 60 * 60 * 1000),
    source: backendState.source,
    isRateLimited: backendState.isRateLimited,
    resetTimestamp: backendState.resetTimestamp,
    countdownMs: backendState.countdownMs,
    confidence: backendState.confidence,
    apiConnected: backendState.apiConnected,
    limitType: backendState.limitType,
    hardLimitResetAt: backendState.hardLimitResetAt,
    orgId: backendState.orgId,
    hasAccurateData: backendState.hasAccurateData,
    planTier: backendState.planTier,
    weeklyUsage: backendState.weeklyUsage,
    weeklySonnetUsage: backendState.weeklySonnetUsage,
    weeklyOpusUsage: backendState.weeklyOpusUsage,
    isPeakHours: backendState.isPeakHours,
    peakHoursTransitionAt: backendState.peakHoursTransitionAt,
  };
}

async function getHistory(): Promise<[string, DayUsage][]> {
  const { usage } = await chrome.storage.local.get("usage");
  if (!usage) return [];
  return Object.entries(usage)
    .filter(([key]) => /^\d{4}-\d{2}-\d{2}$/.test(key))
    .sort(([a], [b]) => a.localeCompare(b)) as [string, DayUsage][];
}

async function getHourlyUsage(): Promise<HourlyUsage> {
  const { hourlyUsage } = await chrome.storage.local.get("hourlyUsage");
  return pruneHourlyUsage(hourlyUsage || {});
}

const notifiedMilestones = new Set<number>();

function checkMilestone(dayUsage: DayUsage, settings: Settings): void {
  if (!settings.showNotifications) return;
  const total = dayUsage.messagesSent + dayUsage.messagesReceived;
  const limit = settings.limits?.dailyMessages || 45;
  const pct = Math.round((total / limit) * 100);
  const remaining = limit - total;

  const key = pct >= 100 ? 100 : remaining <= 5 ? -remaining : Math.floor(pct / 25) * 25;
  if (notifiedMilestones.has(key)) return;
  notifiedMilestones.add(key);

  if (pct === 50 || pct === 75 || pct === 90 || pct === 100 || remaining === 5 || remaining === 1) {
    chrome.notifications.create({
      type: "basic" as chrome.notifications.TemplateType,
      iconUrl: chrome.runtime.getURL("icons/icon48.png"),
      title: "Claude Usage",
      message: pct >= 100
        ? `You've used all ${limit} messages in this window.`
        : remaining <= 5
        ? `Only ${remaining} messages left in this window!`
        : `${pct}% of your ${limit}-message window used.`,
    });
  }
}

// ── WebRequest interception (catches API responses content script may miss) ──
const QUOTA_HEADERS_BG = [
  "x-ratelimit-remaining",
  "x-ratelimit-limit",
  "x-ratelimit-reset",
  "ratelimit-remaining",
  "ratelimit-limit",
  "ratelimit-reset",
  "retry-after",
  "x-ratelimit-retry-after",
];

// Buffer recent quota per tab so content script can pick up after init
const pendingTabQuota = new Map<number, NetworkQuota>();

if (typeof chrome.webRequest !== "undefined" && chrome.webRequest) {
  // ── Shared state ──
  let _bgOrgId: string | null = null;
  // Track pending completions: key = "orgId:conversationId", value = tabId
  const _pendingCompletions = new Map<string, number>();

  /**
   * Fetch /usage from the background (has cookie access) and push to
   * ALL open claude.ai tabs. This is the core of real-time accuracy:
   * called after every completion finishes.
   */
  async function bgFetchAndPushUsageToAllTabs(orgId: string): Promise<void> {
    try {
      const resp = await fetch(`https://claude.ai/api/organizations/${orgId}/usage`, {
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      if (!resp.ok) return;
      const data = await resp.json();

      // Push to ALL claude.ai tabs, not just the one that sent the request
      const tabs = await chrome.tabs.query({ url: "https://claude.ai/*" });
      for (const tab of tabs) {
        if (tab.id) {
          chrome.tabs.sendMessage(tab.id, { type: "BG_USAGE_PUSH", data, orgId }).catch(() => {});
        }
      }
    } catch {
      // Network error — content script's own polling will recover
    }
  }

  /**
   * Same but targets a single tab (for initial load).
   */
  async function bgFetchAndPushUsageToTab(tabId: number, orgId: string): Promise<void> {
    try {
      const resp = await fetch(`https://claude.ai/api/organizations/${orgId}/usage`, {
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      if (!resp.ok) return;
      const data = await resp.json();
      chrome.tabs.sendMessage(tabId, { type: "BG_USAGE_PUSH", data, orgId }).catch(() => {});
    } catch {
      // ignore
    }
  }

  // ── 1. onBeforeRequest: detect when a message is being sent ──
  // Fires on /completion and /retry_completion POSTs — this means the user
  // just sent a prompt. We store the orgId+conversationId so onCompleted
  // knows to re-fetch usage when the response finishes.
  (chrome.webRequest.onBeforeRequest as any).addListener(
    (details: any): void => {
      if (details.tabId < 0) return;
      const url: string = details.url || "";

      // Extract orgId from any API URL
      const orgMatch = url.match(/\/api\/organizations\/([^/]+)/);
      if (orgMatch) {
        const orgId = orgMatch[1];
        if (orgId !== _bgOrgId) {
          _bgOrgId = orgId;
          // First time seeing this org — immediately fetch usage for fast init
          bgFetchAndPushUsageToTab(details.tabId, orgId);
        }
      }

      // Track completion requests so we know when to re-fetch
      if (details.method === "POST" &&
          (url.includes("/completion") || url.includes("/retry_completion"))) {
        const urlParts = url.split("/");
        const orgIdx = urlParts.indexOf("organizations");
        const convIdx = urlParts.indexOf("chat_conversations");
        if (orgIdx !== -1 && convIdx !== -1) {
          const orgId = urlParts[orgIdx + 1];
          const convId = urlParts[convIdx + 1];
          const key = `${orgId}:${convId}`;
          _pendingCompletions.set(key, details.tabId);
        }
      }
    },
    {
      urls: [
        "https://claude.ai/api/organizations/*/chat_conversations/*/completion",
        "https://claude.ai/api/organizations/*/chat_conversations/*/retry_completion",
        "https://claude.ai/api/organizations/*",
      ],
    },
  );

  // ── 2. onCompleted: detect when Claude's response has finished ──
  // When a /chat_conversations/* request completes (the SSE stream ends),
  // immediately re-fetch /usage and push the updated percentage to all tabs.
  (chrome.webRequest.onCompleted as any).addListener(
    (details: any): void => {
      if (details.tabId < 0) return;
      const url: string = details.url || "";

      // Check if this is a conversation response completing
      const urlParts = url.split("/");
      const orgIdx = urlParts.indexOf("organizations");
      const convIdx = urlParts.indexOf("chat_conversations");

      if (orgIdx !== -1 && convIdx !== -1) {
        const orgId = urlParts[orgIdx + 1];
        const convId = urlParts[convIdx + 1]?.split("?")[0]; // strip query params

        // Check if this was a tracked completion (message response finished)
        const key = `${orgId}:${convId}`;
        if (_pendingCompletions.has(key)) {
          _pendingCompletions.delete(key);
          // The SSE stream just ended — Claude's response is done.
          // Re-fetch /usage now for an accurate, up-to-date percentage.
          bgFetchAndPushUsageToAllTabs(orgId);
        }
      }
    },
    {
      urls: [
        "https://claude.ai/api/organizations/*/chat_conversations/*",
      ],
    },
    ["responseHeaders"],
  );

  // ── 3. tabs.onUpdated: fetch usage when a claude.ai tab finishes loading ──
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === "complete" && tab.url?.startsWith("https://claude.ai")) {
      chrome.cookies?.get({ name: "lastActiveOrg", url: "https://claude.ai" })
        .then((cookie) => {
          if (cookie?.value) {
            _bgOrgId = cookie.value;
            bgFetchAndPushUsageToTab(tabId, cookie.value);
          }
        })
        .catch(() => {});
    }
  });

  // ── 4. onHeadersReceived: extract rate-limit headers (existing) ──
  (chrome.webRequest.onHeadersReceived as any).addListener(
    (details: any): void => {
      if (details.tabId < 0) return;

      const quota: NetworkQuota = {};
      let found = false;

      for (const header of details.responseHeaders ?? []) {
        const name = (header.name ?? "").toLowerCase();
        const idx = QUOTA_HEADERS_BG.indexOf(name);
        if (idx === -1) continue;
        const val = parseFloat(String(header.value));
        if (isNaN(val)) continue;
        found = true;

        switch (name) {
          case "x-ratelimit-remaining": case "ratelimit-remaining":
            quota.remaining = Math.round(val); break;
          case "x-ratelimit-limit": case "ratelimit-limit":
            quota.limit = Math.round(val); break;
          case "x-ratelimit-reset": case "ratelimit-reset":
            quota.reset = val > 1e12 ? val : val * 1000; break;
          case "retry-after": case "x-ratelimit-retry-after":
            quota.retryAfter = val; break;
        }
      }

      if (found) {
        pendingTabQuota.set(details.tabId, quota);
        chrome.tabs.sendMessage(details.tabId, { type: "WEBREQUEST_QUOTA", quota }).catch(() => {});
      }
    },
    { urls: ["https://claude.ai/api/*"] },
    ["responseHeaders"],
  );
}

// ── Alarm-based reset scheduling ──
function scheduleResetAlarm(resetTimestamp: number): void {
  const now = Date.now();

  // Cancel previous reset alarms
  chrome.alarms?.getAll().then((alarms: chrome.alarms.Alarm[]) => {
    for (const a of alarms) {
      if (a.name.startsWith("reset_")) chrome.alarms?.clear(a.name);
    }
  }).catch(() => {});

  // Schedule 5 minutes before reset
  const beforeMs = resetTimestamp - 5 * 60 * 1000;
  if (beforeMs > now) {
    const delayMin = Math.max(0.1, (beforeMs - now) / 60000);
    chrome.alarms?.create("reset_soon", { delayInMinutes: delayMin }).catch(() => {});
  }

  // Schedule at exact reset time
  const resetMs = resetTimestamp - now;
  if (resetMs > 0) {
    const delayMin = Math.max(0.1, resetMs / 60000);
    chrome.alarms?.create("reset_now", { delayInMinutes: delayMin }).catch(() => {});
  }
}

function formatBgDuration(ms: number): string {
  if (ms <= 0 || !Number.isFinite(ms)) return "00:00:00";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// ── Init ──
let initialized = false;

async function init(): Promise<void> {
  if (initialized) return;
  initialized = true;

  const { settings } = await chrome.storage.local.get("settings");
  if (!settings) {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  }

  await initState();
  startCountdownTicker();

  onChange((newState: UsageState, oldState: UsageState) => {
    broadcastState(newState);

    // Update toolbar icon with usage arc
    const pct = newState.usagePercent ?? (newState.sessionLimit && newState.sessionMessagesUsed != null
      ? Math.min(100, Math.round((newState.sessionMessagesUsed / newState.sessionLimit) * 100))
      : 0);
    const weeklyPct = newState.weeklyUsage?.usagePercent ?? null;
    updateIcon(pct, weeklyPct);

    // Schedule notification alarms when reset time is first detected or changes
    if (newState.resetTimestamp && newState.resetTimestamp !== oldState.resetTimestamp) {
      scheduleResetAlarm(newState.resetTimestamp);
    }
  });

  // Also set initial icon
  const current = getState();
  if (current) {
    const initPct = current.usagePercent ?? (current.sessionLimit && current.sessionMessagesUsed != null
      ? Math.min(100, Math.round((current.sessionMessagesUsed / current.sessionLimit) * 100))
      : 0);
    const initWeeklyPct = current.weeklyUsage?.usagePercent ?? null;
    updateIcon(initPct, initWeeklyPct);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message.type) {
      case "UPDATE_USAGE":
        handleUsageUpdate(message.data).then(sendResponse);
        return true;

      case "GET_ALL_DATA":
        getAllData().then(sendResponse);
        return true;

      case "GET_SETTINGS":
        getSettings().then(sendResponse);
        return true;

      case "SAVE_SETTINGS":
        saveSettings(message.data).then(() => sendResponse({ success: true }));
        return true;

      case "RESET_USAGE":
        chrome.storage.local.set({ usage: {}, conversations: {}, hourlyUsage: {} }).then(() => {
          sendResponse({ success: true });
        });
        return true;

      case "UPDATE_SESSION":
        handleSessionUpdate(message.data).then(sendResponse);
        return true;

      case "GET_SESSION": {
        chrome.storage.local.get("session").then(({ session }) => {
          sendResponse(session || null);
        });
        return true;
      }

      case "RESET_SESSION":
        chrome.storage.local.set({ session: null }).then(() => {
          sendResponse({ success: true });
        });
        return true;

      case "GET_HISTORY":
        getHistory().then(sendResponse);
        return true;

      case "GET_HOURLY_USAGE":
        getHourlyUsage().then(sendResponse);
        return true;

      case "GET_STATE":
        sendResponse(getState());
        break;

      case "STATE_UPDATE":
        broadcastState(message.state);
        sendResponse({ ok: true });
        break;

      case "RESET_STATE":
        resetState().then(() => sendResponse({ success: true }));
        return true;

      case "FORCE_FETCH_USAGE":
        if (message.orgId) {
          bgFetchAndPushUsageToAllTabs(message.orgId);
          sendResponse({ success: true });
        } else if (_bgOrgId) {
          bgFetchAndPushUsageToAllTabs(_bgOrgId);
          sendResponse({ success: true });
        } else {
          chrome.cookies?.get({ name: "lastActiveOrg", url: "https://claude.ai" })
            .then((cookie) => {
              if (cookie?.value) {
                _bgOrgId = cookie.value;
                bgFetchAndPushUsageToAllTabs(cookie.value);
                sendResponse({ success: true });
              } else {
                sendResponse({ success: false });
              }
            })
            .catch(() => sendResponse({ success: false }));
          return true;
        }
        break;

      case "GET_ORG_ID":
        chrome.cookies
          .get({ name: "lastActiveOrg", url: "https://claude.ai" })
          .then((cookie) => sendResponse(cookie?.value ?? null))
          .catch(() => sendResponse(null));
        return true;

      case "GET_WEBREQUEST_QUOTA": {
        const tabId = (_sender as any)?.tab?.id;
        if (tabId !== undefined && pendingTabQuota.has(tabId)) {
          const quota = pendingTabQuota.get(tabId);
          pendingTabQuota.delete(tabId);
          sendResponse(quota ?? null);
        } else {
          sendResponse(null);
        }
        break;
      }
    }
  });

  chrome.alarms?.create("heartbeat", { periodInMinutes: 1 });

  chrome.alarms?.onAlarm.addListener((alarm) => {
    if (alarm.name === "heartbeat") {
      broadcastState(getState());
    } else if (alarm.name === "reset_soon") {
      const state = getState();
      if (state.countdownMs !== null && state.countdownMs > 0) {
        chrome.notifications.create({
          type: "basic",
          iconUrl: chrome.runtime.getURL("icons/icon48.png"),
          title: "Usage Reset Soon",
          message: `Your usage window resets in ${formatBgDuration(state.countdownMs)}`,
        }).catch(() => {});
      }
    } else if (alarm.name === "reset_now") {
      broadcastState(getState());
    }
  });
}

const CANVAS_SIZE = 32;

function updateIcon(sessionPct: number, weeklyPct: number | null): void {
  const canvas = new OffscreenCanvas(CANVAS_SIZE, CANVAS_SIZE);
  const ctx = canvas.getContext("2d")!;
  const cx = CANVAS_SIZE / 2;
  const cy = CANVAS_SIZE / 2;
  const startAngle = -Math.PI / 2;

  const colorForPct = (pct: number): string => {
    if (pct >= 90) return "#ef4444";
    if (pct >= 70) return "#f59e0b";
    return "#22c55e";
  };

  const clampPct = (pct: number): number => Math.max(0, Math.min(100, pct));

  const drawRing = (
    radius: number,
    lineWidth: number,
    pct: number | null,
    neutralWhenMissing = false
  ): void => {
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.strokeStyle = neutralWhenMissing && pct == null
      ? "rgba(128,128,128,0.16)"
      : "rgba(128,128,128,0.25)";
    ctx.lineWidth = lineWidth;
    ctx.lineCap = "round";
    ctx.stroke();

    if (pct == null) return;

    const clamped = clampPct(pct);
    const endAngle = startAngle + (Math.PI * 2 * clamped) / 100;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, startAngle, endAngle);
    ctx.strokeStyle = colorForPct(clamped);
    ctx.lineWidth = lineWidth;
    ctx.lineCap = "round";
    ctx.stroke();
  };

  drawRing(13, 3, sessionPct);
  drawRing(8, 2.5, weeklyPct, true);

  const imageData = ctx.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  chrome.action.setIcon({ imageData }).catch(() => {});
}

function broadcastState(state: UsageState): void {
  chrome.runtime.sendMessage({ type: "STATE_UPDATE", state }).catch(() => {});
}

if (typeof globalThis !== "undefined") {
  init();
}
