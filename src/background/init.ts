import { initState, getState, onChange, startCountdownTicker, resetState, feedDetection } from '../backend/state-manager';
import type { UsageState } from '../backend/types';
import { getSettings, saveSettings, DEFAULT_SETTINGS } from './settings';
import { handleUsageUpdate, handleSessionUpdate, getAllData, getHistory, getHourlyUsage } from './storage';
import {
  isUsableOrgId,
  rememberBgOrgId,
  getStoredOrgId,
  _bgOrgId,
  _lastBgFetchAt,
  bgFetchAndPushUsageToAllTabs,
  bgFetchAndPushUsageToTab,
  pendingTabQuota,
  scheduleBgUsageRefresh,
} from './webrequest';
import { updateIcon, formatBgDuration } from './icon';

let initialized = false;

function broadcastState(state: UsageState): void {
  chrome.runtime.sendMessage({ type: "STATE_UPDATE", state }).catch(() => {});
}

function scheduleResetAlarm(resetTimestamp: number): void {
  const now = Date.now();
  chrome.alarms?.getAll().then((alarms: chrome.alarms.Alarm[]) => {
    for (const a of alarms) {
      if (a.name.startsWith("reset_")) chrome.alarms?.clear(a.name);
    }
  }).catch(() => {});

  const beforeMs = resetTimestamp - 5 * 60 * 1000;
  if (beforeMs > now) {
    const delayMin = Math.max(0.1, (beforeMs - now) / 60000);
    chrome.alarms?.create("reset_soon", { delayInMinutes: delayMin }).catch(() => {});
  }

  const resetMs = resetTimestamp - now;
  if (resetMs > 0) {
    const delayMin = Math.max(0.1, resetMs / 60000);
    chrome.alarms?.create("reset_now", { delayInMinutes: delayMin }).catch(() => {});
  }
}

export async function init(): Promise<void> {
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

    const pct = newState.usagePercent ?? (newState.sessionLimit && newState.sessionMessagesUsed != null
      ? Math.min(100, Math.round((newState.sessionMessagesUsed / newState.sessionLimit) * 100))
      : 0);
    const weeklyPct = newState.weeklyUsage?.usagePercent ?? null;
    updateIcon(pct, weeklyPct);

    if (newState.resetTimestamp && newState.resetTimestamp !== oldState.resetTimestamp) {
      scheduleResetAlarm(newState.resetTimestamp);
    }
  });

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
        (async () => {
          const tabId = (typeof _sender !== 'undefined' && (_sender as any)?.tab) ? ((_sender as any).tab.id as number | undefined) : undefined;
          let orgId: string | null = isUsableOrgId(_bgOrgId) ? _bgOrgId : null;
          if (!orgId) {
            try {
              const cookie = await chrome.cookies?.get({ name: 'lastActiveOrg', url: 'https://claude.ai' });
              if (isUsableOrgId(cookie?.value)) orgId = cookie!.value;
            } catch {}
          }
          if (!orgId) {
            try { orgId = await getStoredOrgId(); } catch {}
          }

          if (isUsableOrgId(orgId)) {
            if (Date.now() - _lastBgFetchAt > 30_000) {
              try {
                if (typeof tabId === 'number' && tabId >= 0) {
                  await bgFetchAndPushUsageToTab(tabId, orgId);
                } else {
                  await bgFetchAndPushUsageToAllTabs(orgId);
                }
              } catch {}
            }
          }

          getAllData().then(sendResponse);
        })();
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

      case "STATE_UPDATE": {
        const incomingState = message.state as UsageState | undefined;
        if (incomingState && typeof incomingState === 'object') {
          const det: import('../backend/types').DetectedUsage = {
            source: incomingState.source || 'network',
            confidence: incomingState.confidence ?? 0.9,
          };
          if (incomingState.usagePercent != null)       det.usagePercent = incomingState.usagePercent;
          if (incomingState.remainingMessages != null)  det.remainingMessages = incomingState.remainingMessages;
          if (incomingState.sessionLimit != null)       det.sessionLimit = incomingState.sessionLimit;
          if (incomingState.sessionMessagesUsed != null) det.sessionMessagesUsed = incomingState.sessionMessagesUsed;
          if (incomingState.resetTimestamp != null)     det.resetTimestamp = incomingState.resetTimestamp;
          if (incomingState.isRateLimited != null)      det.isRateLimited = incomingState.isRateLimited;
          if (incomingState.limitType)                  det.limitType = incomingState.limitType;
          if (incomingState.hardLimitResetAt != null)   det.hardLimitResetAt = incomingState.hardLimitResetAt;
          if (incomingState.orgId)                      det.orgId = incomingState.orgId;
          if (incomingState.hasAccurateData != null)    det.hasAccurateData = incomingState.hasAccurateData;
          if (incomingState.planTier)                   det.planTier = incomingState.planTier;
          if (incomingState.weeklyUsage)                det.weeklyUsage = incomingState.weeklyUsage;
          if (incomingState.weeklySonnetUsage)          det.weeklySonnetUsage = incomingState.weeklySonnetUsage;
          if (incomingState.weeklyOpusUsage)            det.weeklyOpusUsage = incomingState.weeklyOpusUsage;
          if (incomingState.isPeakHours != null)        det.isPeakHours = incomingState.isPeakHours;
          if (incomingState.peakHoursTransitionAt != null) det.peakHoursTransitionAt = incomingState.peakHoursTransitionAt;
          if (incomingState.orgId && isUsableOrgId(incomingState.orgId)) rememberBgOrgId(incomingState.orgId);
          feedDetection(det);
        }
        broadcastState(getState());
        sendResponse({ ok: true });
        break;
      }

      case "RESET_STATE":
        resetState().then(() => sendResponse({ success: true }));
        return true;

      case "FORCE_FETCH_USAGE":
        if (isUsableOrgId(message.orgId)) {
          bgFetchAndPushUsageToAllTabs(message.orgId)
            .then(() => sendResponse({ success: true }))
            .catch(() => sendResponse({ success: false }));
          return true;
        } else if (isUsableOrgId(_bgOrgId)) {
          bgFetchAndPushUsageToAllTabs(_bgOrgId)
            .then(() => sendResponse({ success: true }))
            .catch(() => sendResponse({ success: false }));
          return true;
        } else {
          chrome.cookies?.get({ name: "lastActiveOrg", url: "https://claude.ai" })
            .then(async (cookie) => {
              const orgId = isUsableOrgId(cookie?.value) ? cookie.value : await getStoredOrgId();
              if (isUsableOrgId(orgId)) {
                rememberBgOrgId(orgId);
                return bgFetchAndPushUsageToAllTabs(orgId).then(() => sendResponse({ success: true }));
              }
              sendResponse({ success: false });
            })
            .catch(() => sendResponse({ success: false }));
          return true;
        }

      case "GET_ORG_ID":
        if (isUsableOrgId(_bgOrgId)) {
          sendResponse(_bgOrgId);
          break;
        }
        chrome.cookies
          .get({ name: "lastActiveOrg", url: "https://claude.ai" })
          .then(async (cookie) => {
            const orgId = isUsableOrgId(cookie?.value) ? cookie.value : await getStoredOrgId();
            if (isUsableOrgId(orgId)) rememberBgOrgId(orgId);
            sendResponse(isUsableOrgId(orgId) ? orgId : null);
          })
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

      case "CONTENT_SCRIPT_READY": {
        const readyTabId = (_sender as any)?.tab?.id as number | undefined;
        (async () => {
          let orgId: string | null = isUsableOrgId(_bgOrgId) ? _bgOrgId : null;
          if (!orgId) {
            try {
              const cookie = await chrome.cookies?.get({ name: "lastActiveOrg", url: "https://claude.ai" });
              if (isUsableOrgId(cookie?.value)) orgId = cookie!.value;
            } catch {}
          }
          if (!orgId) {
            try { orgId = await getStoredOrgId(); } catch {}
          }
          if (isUsableOrgId(orgId)) {
            rememberBgOrgId(orgId);
            if (typeof readyTabId === "number" && readyTabId >= 0) {
              await bgFetchAndPushUsageToTab(readyTabId, orgId);
            } else {
              await bgFetchAndPushUsageToAllTabs(orgId);
            }
          }
        })().catch(() => {});
        sendResponse({ ok: true });
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
    } else if (alarm.name.startsWith("completion-done-")) {
      const orgId = alarm.name.slice("completion-done-".length);
      if (orgId) scheduleBgUsageRefresh(orgId);
    }
  });
}
