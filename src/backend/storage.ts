/**
 * Storage layer — thin wrapper around chrome.storage.local
 * Falls back to memory if storage is unavailable.
 */

import type { UsageState, PersistedState } from "./types";
import { emptyUsage } from "./types";

const PERSIST_KEY = "tracker_state";

let memoryStore: Record<string, unknown> = {};

function getApi(): typeof chrome.storage.local | null {
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      return chrome.storage.local;
    }
    return null;
  } catch {
    return null;
  }
}

export async function persistUsage(state: UsageState): Promise<void> {
  const existing = await loadPersisted();
  existing.lastKnownUsage = state;
  existing.lastUpdated = Date.now();

  const api = getApi();
  if (api) {
    await api.set({ [PERSIST_KEY]: existing });
  } else {
    memoryStore[PERSIST_KEY] = existing;
  }
}

export async function loadPersisted(): Promise<PersistedState> {
  const fallback: PersistedState = {
    lastKnownUsage: emptyUsage(),
    lastUpdated: 0,
    lastUrl: "",
    estimatedCount: { messagesSent: 0, messagesReceived: 0 },
  };

  const api = getApi();
  if (api) {
    try {
      const result = await api.get(PERSIST_KEY);
      const stored = result[PERSIST_KEY] as PersistedState | undefined;
      if (stored && stored.lastKnownUsage) {
        return stored;
      }
    } catch {
      // ignore storage errors
    }
  }

  const mem = memoryStore[PERSIST_KEY] as PersistedState | undefined;
  return mem ?? fallback;
}

export async function persistField<T>(key: string, value: T): Promise<void> {
  const api = getApi();
  if (api) {
    await api.set({ [key]: value });
  } else {
    memoryStore[key] = value;
  }
}

export async function loadField<T>(key: string): Promise<T | undefined> {
  const api = getApi();
  if (api) {
    try {
      const result = await api.get(key);
      return result[key] as T | undefined;
    } catch {
      return undefined;
    }
  }
  return memoryStore[key] as T | undefined;
}

export async function persistEstimatedCount(
  sent: number,
  received: number
): Promise<void> {
  const existing = await loadPersisted();
  existing.estimatedCount.messagesSent += sent;
  existing.estimatedCount.messagesReceived += received;

  const api = getApi();
  if (api) {
    await api.set({ [PERSIST_KEY]: existing });
  } else {
    memoryStore[PERSIST_KEY] = existing;
  }
}

export async function clearAll(): Promise<void> {
  memoryStore = {};
  const api = getApi();
  if (api) {
    await api.remove(PERSIST_KEY);
  }
}
