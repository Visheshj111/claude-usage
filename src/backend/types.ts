// src/backend/types.ts
export type DataSource =
  | "network"
  | "official-ui"
  | "banner"
  | "estimated"
  | "computed"
  | "unknown";

export type LimitType = "soft" | "hard" | "unknown";

export type PlanTier = "free" | "pro" | "max_5x" | "max_20x" | "team" | "unknown";

export interface WeeklyUsage {
  /** 0–100 usage percentage for this week period */
  usagePercent: number | null;
  /** Messages used in this week period */
  messagesUsed: number | null;
  /** Max messages for this week period */
  maxMessages: number | null;
  /** When this week period resets (ms timestamp) */
  resetsAt: number | null;
}

export interface UsageState {
  /** 0–100 usage percentage of the current window */
  usagePercent: number | null;
  /** Messages remaining in current window */
  remainingMessages: number | null;
  /** Total limit for this window (detected or default) */
  sessionLimit: number | null;
  /** How many messages used so far this window */
  sessionMessagesUsed: number | null;
  /** When this usage window started (ms timestamp) */
  sessionWindowStartTs: number | null;
  /** Window duration in ms (default: 5 hours) */
  sessionWindowMs: number;
  /** Is the user currently rate-limited / hit the wall */
  isRateLimited: boolean;
  /** When the current window resets (ms timestamp) */
  resetTimestamp: number | null;
  /** Live countdown ms until reset (updated by ticker) */
  countdownMs: number | null;
  /** Where we got the data from */
  source: DataSource;
  /** 0.0–1.0 confidence in this reading */
  confidence: number;
  /** Whether the direct API (/usage) endpoint is reachable */
  apiConnected: boolean;
  /** Limit type: "soft" (5h window) or "hard" (cooldown) */
  limitType: LimitType;
  /** If hard-limited, when the hard cooldown expires */
  hardLimitResetAt: number | null;
  /** The orgId we're tracking */
  orgId: string | null;
  /** Whether usage is calculated from actual API data vs estimation */
  hasAccurateData: boolean;
  /** Detected plan tier */
  planTier: PlanTier;
  /** Weekly combined usage (all models) */
  weeklyUsage: WeeklyUsage | null;
  /** Weekly Sonnet usage (if separately tracked) */
  weeklySonnetUsage: WeeklyUsage | null;
  /** Weekly Opus usage (if separately tracked) */
  weeklyOpusUsage: WeeklyUsage | null;
  /** Whether currently in Anthropic's peak hours */
  isPeakHours: boolean;
  /** When the peak/off-peak period transitions (ms timestamp) */
  peakHoursTransitionAt: number | null;
}

export interface DetectedUsage {
  usagePercent?: number;
  remainingMessages?: number;
  sessionLimit?: number;
  sessionMessagesUsed?: number;
  isRateLimited?: boolean;
  resetTimestamp?: number;
  retireAfterSeconds?: number;
  confidence: number;
  source: DataSource;
  limitType?: LimitType;
  hardLimitResetAt?: number;
  orgId?: string;
  hasAccurateData?: boolean;
  planTier?: PlanTier;
  weeklyUsage?: WeeklyUsage;
  weeklySonnetUsage?: WeeklyUsage;
  weeklyOpusUsage?: WeeklyUsage;
  isPeakHours?: boolean;
  peakHoursTransitionAt?: number;
}

export interface NetworkQuota {
  remaining?: number;
  limit?: number;
  reset?: number;
  retryAfter?: number;
  limitType?: LimitType;
  hardLimitResetAt?: number;
  orgId?: string;
}

export interface PersistedState {
  lastKnownUsage: UsageState;
  lastUpdated: number;
  lastUrl: string;
  estimatedCount: {
    messagesSent: number;
    messagesReceived: number;
  };
}

export interface BannerMatch {
  type: "rate-limited" | "reset-time" | "usage-percent" | "remaining";
  value: number | null;
  text: string;
  limitType?: LimitType;
  hardLimitResetAt?: number;
}

export function emptyUsage(source: DataSource = "unknown"): UsageState {
  return {
    usagePercent: null,
    remainingMessages: null,
    sessionLimit: null,
    sessionMessagesUsed: null,
    sessionWindowStartTs: null,
    sessionWindowMs: 5 * 60 * 60 * 1000,
    isRateLimited: false,
    resetTimestamp: null,
    countdownMs: null,
    source,
    confidence: 0,
    apiConnected: false,
    limitType: "unknown",
    hardLimitResetAt: null,
    orgId: null,
    hasAccurateData: false,
    planTier: "unknown",
    weeklyUsage: null,
    weeklySonnetUsage: null,
    weeklyOpusUsage: null,
    isPeakHours: false,
    peakHoursTransitionAt: null,
  };
}

export function cloneUsage(s: UsageState): UsageState {
  return { ...s };
}

export function isSameState(a: UsageState, b: UsageState): boolean {
  return (
    a.usagePercent === b.usagePercent &&
    a.isRateLimited === b.isRateLimited &&
    a.resetTimestamp === b.resetTimestamp &&
    a.remainingMessages === b.remainingMessages &&
    a.sessionLimit === b.sessionLimit &&
    a.sessionMessagesUsed === b.sessionMessagesUsed &&
    a.source === b.source &&
    a.apiConnected === b.apiConnected &&
    a.limitType === b.limitType &&
    a.hardLimitResetAt === b.hardLimitResetAt &&
    a.orgId === b.orgId &&
    a.hasAccurateData === b.hasAccurateData &&
    a.planTier === b.planTier &&
    a.isPeakHours === b.isPeakHours &&
    a.weeklyUsage?.usagePercent === b.weeklyUsage?.usagePercent &&
    a.weeklyUsage?.maxMessages === b.weeklyUsage?.maxMessages
  );
}

/**
 * Compute usage percent from remaining + limit, or messages used + limit.
 */
export function computeUsagePercent(state: UsageState): number | null {
  if (state.remainingMessages !== null && state.sessionLimit !== null && state.sessionLimit > 0) {
    const used = state.sessionLimit - state.remainingMessages;
    return Math.min(100, Math.round((used / state.sessionLimit) * 100));
  }
  if (state.sessionMessagesUsed !== null && state.sessionLimit !== null && state.sessionLimit > 0) {
    return Math.min(100, Math.round((state.sessionMessagesUsed / state.sessionLimit) * 100));
  }
  return state.usagePercent;
}

export function colorForPct(pct: number): string {
  if (pct >= 90) return 'var(--danger)';
  if (pct >= 60) return 'var(--warn)';
  return 'var(--safe)';
}

export function fillClassForPct(pct: number): string {
  if (pct >= 90) return 'danger';
  if (pct >= 60) return 'warn';
  return 'safe';
}
