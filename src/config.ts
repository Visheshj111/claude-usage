// Central config for thresholds, polling intervals, and defaults.
// All magic numbers should live here — never inline them in feature files.

export const THRESHOLDS = {
  warnPct: 60,
  highPct: 70,
  dangerPct: 90,
};

export const NOTIFICATIONS = {
  milestones: [50, 75, 90, 100],
  lowRemaining: [5, 1],
};

export const POLLING = {
  /** DOM/banner scan interval (ms) */
  scan: 15_000,
  /** Peak-hours check interval (ms) */
  peakCheck: 60_000,
  /** In-page widget UI refresh interval (ms) */
  uiUpdate: 1_000,
  /** Normal usage API poll interval once session is established (ms) */
  usageNormal: 120_000,
  /** Fast-retry interval immediately after page load (ms) */
  usageFastRetry: 3_000,
  /** How long fast-retry runs before switching to normal polling (ms) */
  usageFastRetryWindow: 30_000,
  /** Min time between background usage fetches from service worker (ms) */
  bgFetchCooldown: 30_000,
  /** Staggered delays (ms) after a completion event to re-fetch usage */
  postCompletionRetries: [1_500, 5_000, 12_000] as const,
};

export const SESSION = {
  /** User inactivity threshold before session is marked stopped (ms) */
  inactivityTimeoutMs: 30 * 60 * 1_000,
  /** Age at which an existing session record is considered stale (ms) */
  staleMs: 6 * 60 * 60 * 1_000,
};

export const STORAGE = {
  /** Prune hourly-usage data older than this many days */
  hourlyPruneDays: 55,
};

export const CACHE = {
  /** TTL for the cached plan-tier fetched from the bootstrap endpoint (ms) */
  planTierTtlMs: 24 * 60 * 60 * 1_000,
};

/** Centralised URL constants — never hardcode these in feature files. */
export const URLS = {
  claudeBase: "https://claude.ai",
  apiBase: "https://claude.ai/api/organizations",
  reviewPage:
    "https://chromewebstore.google.com/detail/claude-usage-tracker-stat/lhmabonbcohkgnifkjhknalkekeeigko",
};

/** Per-source confidence scores fed into the state-manager. */
export const CONFIDENCE = {
  network: 0.95,
  officialUi: 0.90,
  banner: 0.85,
  dom: 0.70,
  computed: 0.99,
  estimated: 0.30,
};

/**
 * Cooldown window in the state-manager: low-confidence detections that arrive
 * within this many ms of a high-confidence update are silently ignored.
 */
export const DETECTION_COOLDOWN_MS = 5_000;

export const REMOTE_CONFIG = {
  // If empty, remote config is disabled. Fill with a JSON endpoint that returns
  // an object merging into the config shape (e.g. { peakHours: { startHourET: 8, endHourET: 14 } }).
  url: "",
  refreshMs: 6 * 60 * 60 * 1_000, // refresh every 6 hours
};

export const DEFAULT_PEAK_HOURS = {
  startHourET: 8,
  endHourET: 14,
};

export default {
  THRESHOLDS,
  NOTIFICATIONS,
  POLLING,
  SESSION,
  STORAGE,
  CACHE,
  URLS,
  CONFIDENCE,
  DETECTION_COOLDOWN_MS,
  REMOTE_CONFIG,
  DEFAULT_PEAK_HOURS,
};
