import { REMOTE_CONFIG, DEFAULT_PEAK_HOURS } from './config';

type RemoteShape = Partial<{
  peakHours: { startHourET: number; endHourET: number };
  polling: Record<string, number>;
  notifications: { milestones: number[]; lowRemaining: number[] };
}>;

const current: { peakHours: { startHourET: number; endHourET: number } } = {
  peakHours: { ...DEFAULT_PEAK_HOURS },
};

async function loadFromStorage(): Promise<void> {
  try {
    const r = await chrome.storage.local.get('remoteConfig');
    if (r && r.remoteConfig && typeof r.remoteConfig === 'object') {
      const cfg = r.remoteConfig as RemoteShape;
      if (cfg.peakHours) current.peakHours = { ...current.peakHours, ...cfg.peakHours };
    }
  } catch {}
}

async function fetchRemote(): Promise<void> {
  if (!REMOTE_CONFIG.url) return;
  try {
    const resp = await fetch(REMOTE_CONFIG.url, { cache: 'no-store' });
    if (!resp.ok) return;
    const data = await resp.json() as RemoteShape;
    if (data.peakHours) current.peakHours = { ...current.peakHours, ...data.peakHours };
    await chrome.storage.local.set({ remoteConfig: data });
  } catch {
    // ignore fetch errors
  }
}

export async function initRemoteConfig(): Promise<void> {
  await loadFromStorage();
  await fetchRemote();
  if (REMOTE_CONFIG.url && REMOTE_CONFIG.refreshMs > 0) {
    setInterval(() => { void fetchRemote(); }, REMOTE_CONFIG.refreshMs);
  }
}

export function getRemoteConfig(): { peakHours: { startHourET: number; endHourET: number } } {
  return current;
}

export default { initRemoteConfig, getRemoteConfig };
