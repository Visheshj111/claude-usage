import { type Settings, getSettings, DEFAULT_SETTINGS } from './settings';
import type { DayUsage, PeriodUsage, ConversationEntry, SessionData, HourlyUsage } from './types';
import { getState } from '../backend/state-manager';
import { NOTIFICATIONS, STORAGE, SESSION } from '../config';

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
  cutoff.setDate(cutoff.getDate() - STORAGE.hourlyPruneDays);
  const cutoffKey = getDateKey(cutoff);
  const pruned: HourlyUsage = {};
  for (const [dateKey, hours] of Object.entries(hourlyUsage)) {
    if (dateKey >= cutoffKey) {
      pruned[dateKey] = Array.from({ length: 24 }, (_, hour) => Number(hours?.[hour]) || 0);
    }
  }
  return pruned;
}

export async function handleUsageUpdate(data: Record<string, unknown>): Promise<{ success: boolean }> {
  const { usage: rawUsage, conversations: rawConvs, hourlyUsage: rawHourly } = await chrome.storage.local.get(["usage", "conversations", "hourlyUsage"]);
  const usage = rawUsage as Record<string, DayUsage | PeriodUsage> | undefined;
  const today = getDateKey();
  const periodKey = getPeriodKey("daily");

  const dayUsage = initDayUsage(usage?.[today] as DayUsage | undefined);
  const periodUsage = initPeriodUsage(usage?.[periodKey] as PeriodUsage | undefined);
  const conversationsDb: Record<string, ConversationEntry> = (rawConvs as Record<string, ConversationEntry>) || {};
  let hourlyMessageDelta = 0;
  const convId = data.conversationId as string | undefined;

  if (convId && conversationsDb[convId]) {
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
    updatedHourlyUsage = pruneHourlyUsage((rawHourly as HourlyUsage) || {});
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

export async function handleSessionUpdate(data: { action: string } & Record<string, unknown>): Promise<{ success: boolean; session?: SessionData | null }> {
  const { session: rawSession } = await chrome.storage.local.get("session");
  let s: SessionData | null = (rawSession as SessionData) || null;

  if (data.action === "start") {
    const SESSION_STALE_MS = SESSION.staleMs;
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

export async function getAllData(): Promise<Record<string, unknown>> {
  const { usage: rawUsage2, conversations: rawConvs, session: rawSession } = await chrome.storage.local.get([
    "usage", "conversations", "session",
  ]);
  const usageObj = (rawUsage2 as Record<string, DayUsage | PeriodUsage>) || {};
  const currentSettings = await getSettings();
  const today = getDateKey();
  const dayUsage = (usageObj[today] as DayUsage) || initDayUsage();
  const periodKey = getPeriodKey(currentSettings.resetPeriod);
  const periodUsage = (usageObj[periodKey] as PeriodUsage) || initPeriodUsage();

  const limits = currentSettings.limits || DEFAULT_SETTINGS.limits;
  const msgsUsed = dayUsage.messagesSent + dayUsage.messagesReceived;
  const tokensUsed = dayUsage.tokensSent + dayUsage.tokensReceived;
  const tokensRemaining = Math.max(0, limits.dailyTokens - tokensUsed);

  const backendState = getState();
  const sessionStorageData = rawSession as { startTime?: number } | null;
  const defaultWindowMs = 5 * 60 * 60 * 1000;
  const sessionWindowMsFromBackend = backendState.sessionWindowMs && backendState.sessionWindowMs > 0
    ? backendState.sessionWindowMs
    : undefined;
  const sessionWindowMs = sessionWindowMsFromBackend ?? limits.sessionWindowMs ?? defaultWindowMs;

  const windowStartTs = backendState.resetTimestamp
    ? backendState.resetTimestamp - sessionWindowMs
    : sessionStorageData?.startTime ?? undefined;
  const nextReset = backendState.resetTimestamp
    ? backendState.resetTimestamp
    : currentSettings.resetPeriod === "5h"
    ? 0
    : computeNextReset(currentSettings.resetPeriod, windowStartTs);
  const resetIn = nextReset > 0 ? nextReset - Date.now() : 0;

  const sessionLimit = backendState.sessionLimit ?? limits.dailyMessages;
  const sessionMessagesUsedFromRemaining = backendState.remainingMessages !== null
    ? Math.max(0, sessionLimit - backendState.remainingMessages)
    : null;
  const sessionMessagesUsed = backendState.sessionMessagesUsed ?? sessionMessagesUsedFromRemaining ?? msgsUsed;
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
    conversations: rawConvs,
    session: rawSession,
    settings: currentSettings,
    sessionPct,
    sessionLimit,
    sessionMessagesUsed,
    sessionWindowMs: sessionWindowMs,
    source: backendState.source,
    isRateLimited: backendState.isRateLimited,
    resetTimestamp: backendState.resetTimestamp,
    countdownMs: backendState.countdownMs,
    confidence: backendState.confidence,
    apiConnected: backendState.apiConnected,
    apiErrorStatus: backendState.apiErrorStatus,
    limitType: backendState.limitType,
    hardLimitResetAt: backendState.hardLimitResetAt,
    orgId: backendState.orgId,
    hasAccurateData: backendState.hasAccurateData,
    planTier: backendState.planTier,
    weeklyUsage: backendState.weeklyUsage,
    weeklySonnetUsage: backendState.weeklySonnetUsage,
    weeklyOpusUsage: backendState.weeklyOpusUsage,
    weeklyFableUsage: backendState.weeklyFableUsage,
    isPeakHours: backendState.isPeakHours,
    peakHoursTransitionAt: backendState.peakHoursTransitionAt,
    lastFetchedAt: (await chrome.storage.local.get('lastFetchedAt')).lastFetchedAt || null,
  };
}

export async function getHistory(): Promise<[string, DayUsage][]> {
  const { usage } = await chrome.storage.local.get("usage");
  if (!usage) return [];
  return Object.entries(usage)
    .filter(([key]) => /^\d{4}-\d{2}-\d{2}$/.test(key))
    .sort(([a], [b]) => a.localeCompare(b)) as [string, DayUsage][];
}

export async function getHourlyUsage(): Promise<HourlyUsage> {
  const { hourlyUsage } = await chrome.storage.local.get("hourlyUsage");
  return pruneHourlyUsage((hourlyUsage as HourlyUsage) || {});
}

const NOTIFIED_KEY = 'notifiedMilestones';

async function loadNotifiedMilestones(): Promise<Set<number>> {
  try {
    const { [NOTIFIED_KEY]: arr } = await chrome.storage.local.get(NOTIFIED_KEY) as { [k: string]: number[] };
    return new Set<number>(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set<number>();
  }
}

async function addNotifiedMilestone(key: number): Promise<void> {
  try {
    const set = await loadNotifiedMilestones();
    set.add(key);
    await chrome.storage.local.set({ [NOTIFIED_KEY]: [...set] });
  } catch {}
}

function checkMilestone(dayUsage: DayUsage, settings: Settings): void {
  if (!settings.showNotifications) return;
  const total = dayUsage.messagesSent + dayUsage.messagesReceived;
  const limit = settings.limits?.dailyMessages || 45;
  const pct = Math.round((total / limit) * 100);
  const remaining = limit - total;

  const milestones = NOTIFICATIONS.milestones;
  const lowRem = NOTIFICATIONS.lowRemaining;

  const key = pct >= 100 ? 100 : lowRem.includes(remaining) ? -remaining : Math.floor(pct / 25) * 25;

  if (!milestones.includes(pct) && !lowRem.includes(remaining)) return;

  loadNotifiedMilestones().then((set) => {
    if (set.has(key)) return;
    addNotifiedMilestone(key);
    chrome.notifications.create({
      type: 'basic' as chrome.notifications.TemplateType,
      iconUrl: chrome.runtime.getURL('icons/icon48.png'),
      title: 'Claude Usage',
      message:
        pct >= 100
          ? `You've used all ${limit} messages in this window.`
          : lowRem.includes(remaining)
          ? `Only ${remaining} messages left in this window!`
          : `${pct}% of your ${limit}-message window used.`,
    });
  });
}
