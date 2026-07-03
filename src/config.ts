// Central config for thresholds, polling intervals, and defaults.

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
  scan: 15000,
  peakCheck: 60000,
  uiUpdate: 1000,
  usageNormal: 10000,
  usageFastRetry: 3000,
  usageFastRetryWindow: 30000,
};

export const CONFIDENCE = {
  network: 0.95,
  computed: 0.99,
};

export const REMOTE_CONFIG = {
  // If empty, remote config is disabled. Fill with a JSON endpoint that returns
  // an object merging into the config shape (e.g. { peakHours: { startHourET: 8, endHourET: 14 } }).
  url: "",
  refreshMs: 6 * 60 * 60 * 1000, // refresh every 6 hours
};

export const DEFAULT_PEAK_HOURS = {
  startHourET: 8,
  endHourET: 14,
};

export default {
  THRESHOLDS,
  NOTIFICATIONS,
  POLLING,
  CONFIDENCE,
  REMOTE_CONFIG,
  DEFAULT_PEAK_HOURS,
};
