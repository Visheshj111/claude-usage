import { getTrackedOrgId, notifyOrgIdFromWatcher, getLatestApiHeaders } from "../backend/network-monitor";
import { feedDetection } from "../backend/state-manager";
import type { DetectedUsage, PlanTier } from "../backend/types";

export const LAST_KNOWN_ORG_ID_KEY = "lastKnownOrgId";

export function isUsableOrgId(value: string | null | undefined): value is string {
  if (!value) return false;
  if (["discoverable", "undefined", "null"].includes(value)) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

let _orgIdBackgroundCache: string | null = null;
let _orgIdBgPromise: Promise<string | null> | null = null;

export function rememberContentOrgId(orgId: string): void {
  if (!isUsableOrgId(orgId)) return;
  _orgIdBackgroundCache = orgId;
  notifyOrgIdFromWatcher(orgId);
  chrome.storage?.local?.set({ [LAST_KNOWN_ORG_ID_KEY]: orgId }).catch(() => {});
}

export function getOrgIdFromCookie(): string | null {
  const match = document.cookie.match(/\blastActiveOrg=([^;]+)/);
  return isUsableOrgId(match?.[1]) ? match[1] : null;
}

const PLAN_TIER_CACHE_KEY = "planTierByOrg";
const PLAN_TIER_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface PlanTierCacheEntry {
  planTier: PlanTier;
  cachedAt: number;
}

type PlanTierCache = Record<string, PlanTierCacheEntry>;

export async function getOrgIdFromStorage(): Promise<string | null> {
  try {
    const result = await chrome.storage.local.get(LAST_KNOWN_ORG_ID_KEY) as { lastKnownOrgId?: string };
    return isUsableOrgId(result.lastKnownOrgId) ? result.lastKnownOrgId : null;
  } catch {
    return null;
  }
}

export async function getOrgIdFromBackground(): Promise<string | null> {
  if (isUsableOrgId(_orgIdBackgroundCache)) return _orgIdBackgroundCache;
  if (_orgIdBgPromise) return _orgIdBgPromise;
  _orgIdBgPromise = (async () => {
    const resp = await sendRuntimeMessage<string>({ type: "GET_ORG_ID" });
    if (isUsableOrgId(resp)) {
      rememberContentOrgId(resp);
      return resp;
    }
    return null;
  })();
  const result = await _orgIdBgPromise;
  if (!result) _orgIdBgPromise = null;
  return result;
}

export async function resolveOrgId(): Promise<string | null> {
  const tracked = getTrackedOrgId();
  if (isUsableOrgId(tracked)) return tracked;
  const cookie = getOrgIdFromCookie();
  if (cookie) {
    rememberContentOrgId(cookie);
    return cookie;
  }
  const stored = await getOrgIdFromStorage();
  if (stored) {
    rememberContentOrgId(stored);
    return stored;
  }
  return getOrgIdFromBackground();
}

export async function sendRuntimeMessage<T = unknown>(message: unknown): Promise<T | null> {
  try {
    if (!chrome.runtime?.id) return null;
    return await chrome.runtime.sendMessage(message) as T;
  } catch {
    return null;
  }
}

export function getRuntimeUrl(path: string): string | null {
  try {
    if (!chrome.runtime?.id) return null;
    return chrome.runtime.getURL(path);
  } catch {
    return null;
  }
}

export async function fetchPlanInfo(orgId: string): Promise<void> {
  try {
    const { [PLAN_TIER_CACHE_KEY]: planTierCache } = await chrome.storage.local.get(PLAN_TIER_CACHE_KEY) as {
      [PLAN_TIER_CACHE_KEY]?: PlanTierCache;
    };
    const cached = planTierCache?.[orgId];
    if (cached && Date.now() - cached.cachedAt < PLAN_TIER_CACHE_TTL_MS) {
      feedDetection({
        source: "network",
        confidence: 0.95,
        planTier: cached.planTier,
        orgId,
      });
      return;
    }

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const latestHeaders = getLatestApiHeaders();
    for (const [k, v] of Object.entries(latestHeaders)) {
      headers[k] = v;
    }

    const response = await fetch(
      `https://claude.ai/api/bootstrap/${orgId}/app_start?statsig_hashing_algorithm=djb2`,
      { credentials: "include", headers }
    );
    if (!response.ok) {
      console.debug("[CUT] Bootstrap plan fetch failed", { orgId, status: response.status });
      return;
    }

    const data = (await response.json()) as Record<string, unknown>;
    const account = data.account as Record<string, unknown> | undefined;
    const memberships = account?.memberships as Array<Record<string, unknown>> | undefined;
    if (!memberships?.length) return;

    const org = memberships.find((membership) => {
      const membershipOrg = membership.organization as Record<string, unknown> | undefined;
      return membershipOrg?.uuid === orgId;
    })?.organization as Record<string, unknown> | undefined;
    if (!org) return;

    const tier = org.rate_limit_tier as string | undefined;
    const capabilities = org.capabilities as string[] | undefined;
    const isTeam = !!org.raven_type;

    let planTier: PlanTier = "free";
    if (isTeam) {
      planTier = "team";
    } else if (capabilities?.includes("claude_max")) {
      planTier = tier?.includes("5x") ? "max_5x" : "max_20x";
    } else if (capabilities?.includes("claude_pro")) {
      planTier = "pro";
    }

    const detected: DetectedUsage = {
      source: "network",
      confidence: 0.95,
      planTier,
      orgId,
    };

    feedDetection(detected);
    await chrome.storage.local.set({
      [PLAN_TIER_CACHE_KEY]: {
        ...(planTierCache || {}),
        [orgId]: {
          planTier,
          cachedAt: Date.now(),
        },
      } satisfies PlanTierCache,
    });
  } catch (err) {
    console.debug("[CUT] Bootstrap plan fetch failed", { orgId, error: err });
  }
}
