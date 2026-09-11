export interface Settings {
  resetPeriod: string;
  tokenEstimationMethod: string;
  showNotifications: boolean;
  showInPageWidget?: boolean;
  /** Enabled by default; configuration is supplied separately in session storage. */
  refinerEnabled: boolean;
  themeMode?: string;
  limits: {
    dailyMessages: number;
    dailyTokens: number;
    sessionWindowMs: number;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  resetPeriod: "5h",
  tokenEstimationMethod: "chars/4",
  showNotifications: true,
  showInPageWidget: true,
  refinerEnabled: true,
  limits: {
    dailyMessages: 45,
    dailyTokens: 90000,
    sessionWindowMs: 5 * 60 * 60 * 1000,
  },
};

let settingsCache: Settings | null = null;
let settingsLoadPromise: Promise<Settings> | null = null;

function mergeSettings(stored: Partial<Settings> | undefined): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    limits: {
      ...DEFAULT_SETTINGS.limits,
      ...stored?.limits,
    },
  };
}

export async function getSettings(): Promise<Settings> {
  if (settingsCache) return settingsCache;
  if (settingsLoadPromise) return settingsLoadPromise;

  settingsLoadPromise = (async () => {
    const { settings } = await chrome.storage.local.get("settings");
    settingsCache = mergeSettings(settings as Partial<Settings> | undefined);
    return settingsCache!;
  })();

  const result = await settingsLoadPromise;
  settingsLoadPromise = null;
  return result;
}

export async function saveSettings(data: Settings): Promise<void> {
  settingsCache = null;   // invalidate before write
  settingsCache = mergeSettings(data);
  await chrome.storage.local.set({ settings: settingsCache });
}
