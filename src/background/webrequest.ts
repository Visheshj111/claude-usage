import type { NetworkQuota } from '../backend/types';
import { parseUsagePayload } from '../backend/usage-parser';
import { feedDetection } from '../backend/state-manager';
import { POLLING, URLS } from '../config';

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

export const pendingTabQuota = new Map<number, NetworkQuota>();

export let _bgOrgId: string | null = null;
export let _lastBgFetchAt = 0;
const LAST_KNOWN_ORG_ID_KEY = "lastKnownOrgId";

export function isUsableOrgId(value: string | null | undefined): value is string {
  if (!value) return false;
  if (["discoverable", "undefined", "null"].includes(value)) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function rememberBgOrgId(orgId: string): void {
  if (!isUsableOrgId(orgId)) return;
  _bgOrgId = orgId;
  chrome.storage?.local?.set({ [LAST_KNOWN_ORG_ID_KEY]: orgId }).catch(() => {});
}

export async function getStoredOrgId(): Promise<string | null> {
  try {
    const result = await chrome.storage.local.get(LAST_KNOWN_ORG_ID_KEY) as { lastKnownOrgId?: string };
    return isUsableOrgId(result.lastKnownOrgId) ? result.lastKnownOrgId : null;
  } catch {
    return null;
  }
}

async function _fetchAndParseUsage(orgId: string): Promise<Record<string, unknown> | null> {
  const resp = await fetch(`${URLS.apiBase}/${orgId}/usage`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!resp.ok) return null;
  _lastBgFetchAt = Date.now();
  const data = await resp.json();
  try {
    const detected = parseUsagePayload(data, orgId);
    if (detected) feedDetection(detected);
  } catch {}
  try { await chrome.storage.local.set({ lastFetchedAt: Date.now() }); } catch {}
  return data;
}

export async function bgFetchAndPushUsageToAllTabs(orgId: string): Promise<void> {
  if (!isUsableOrgId(orgId)) return;
  try {
    const data = await _fetchAndParseUsage(orgId);
    if (!data) return;
    const tabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
    for (const tab of tabs) {
      if (tab.id) chrome.tabs.sendMessage(tab.id, { type: 'BG_USAGE_PUSH', data, orgId }).catch(() => {});
    }
  } catch {}
}

export async function bgFetchAndPushUsageToTab(tabId: number, orgId: string): Promise<void> {
  if (!isUsableOrgId(orgId)) return;
  try {
    const data = await _fetchAndParseUsage(orgId);
    if (!data) return;
    chrome.tabs.sendMessage(tabId, { type: 'BG_USAGE_PUSH', data, orgId }).catch(() => {});
  } catch {}
}

function isConversationSyncUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return /\/api\/organizations\/[^/]+\/chat_conversations\/[^/?]+/.test(parsed.pathname) &&
      parsed.searchParams.get("tree")?.toLowerCase() === "true" &&
      parsed.searchParams.get("render_all_tools")?.toLowerCase() === "true";
  } catch {
    return false;
  }
}

export function scheduleBgUsageRefresh(orgId: string, tabId?: number): void {
  if (!isUsableOrgId(orgId)) return;
  rememberBgOrgId(orgId);
  const fetchOnce = () => {
    if (typeof tabId === 'number' && tabId >= 0) {
      bgFetchAndPushUsageToTab(tabId, orgId);
    } else {
      bgFetchAndPushUsageToAllTabs(orgId);
    }
  };
  fetchOnce();
  for (const delay of POLLING.postCompletionRetries) {
    setTimeout(fetchOnce, delay);
  }
}

if (typeof chrome.webRequest !== "undefined" && chrome.webRequest) {
  (chrome.webRequest.onBeforeRequest as any).addListener(
    (details: any): void => {
      if (details.tabId < 0) return;
      const url: string = details.url || "";

      const orgMatch = url.match(/\/api\/organizations\/([^/]+)/);
      if (orgMatch) {
        const orgId = orgMatch[1];
        if (isUsableOrgId(orgId) && orgId !== _bgOrgId) {
          rememberBgOrgId(orgId);
          bgFetchAndPushUsageToTab(details.tabId, orgId);
        }
      }

      if (details.method === "POST" &&
          (url.includes("/completion") || url.includes("/retry_completion"))) {
        const urlParts = url.split("/");
        const orgIdx = urlParts.indexOf("organizations");
        if (orgIdx !== -1) {
          const orgId = urlParts[orgIdx + 1];
          if (!isUsableOrgId(orgId)) return;
          const alarmName = `completion-done-${orgId}`;
          chrome.alarms?.create(alarmName, { delayInMinutes: 0 }).catch(() => {});
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

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === "complete" && tab.url?.startsWith("https://claude.ai")) {
      chrome.cookies?.get({ name: "lastActiveOrg", url: "https://claude.ai" })
        .then((cookie) => {
          if (isUsableOrgId(cookie?.value)) {
            rememberBgOrgId(cookie.value);
            bgFetchAndPushUsageToTab(tabId, cookie.value);
          }
        })
        .catch(() => {});
    }
  });

  (chrome.webRequest.onCompleted as any).addListener(
    (details: any): void => {
      if (details.tabId < 0 || details.method !== "GET") return;
      const url: string = details.url || "";
      if (!isConversationSyncUrl(url)) return;
      const orgId = url.match(/\/api\/organizations\/([^/]+)/)?.[1];
      if (!isUsableOrgId(orgId)) return;
      scheduleBgUsageRefresh(orgId, details.tabId);
    },
    { urls: ["https://claude.ai/api/organizations/*/chat_conversations/*"] },
  );

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
