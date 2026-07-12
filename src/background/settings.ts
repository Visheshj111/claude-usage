export interface Settings {
  resetPeriod: string;
  tokenEstimationMethod: string;
  showNotifications: boolean;
  showInPageWidget?: boolean;
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
  limits: {
    dailyMessages: 45,
    dailyTokens: 90000,
    sessionWindowMs: 5 * 60 * 60 * 1000,
  },
};

let settingsCache: Settings | null = null;
let settingsLoadPromise: Promise<Settings> | null = null;

export async function getSettings(): Promise<Settings> {
  if (settingsCache) return settingsCache;
  if (settingsLoadPromise) return settingsLoadPromise;

  settingsLoadPromise = (async () => {
    const { settings } = await chrome.storage.local.get("settings");
    settingsCache = (settings as Settings) || DEFAULT_SETTINGS;
    return settingsCache!;
  })();

  return settingsLoadPromise;
}

export async function saveSettings(data: Settings): Promise<void> {
  settingsCache = data;
  await chrome.storage.local.set({ settings: data });
}
