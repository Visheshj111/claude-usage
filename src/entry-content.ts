/**
 * Content script entry point.
 *
 * Preserves ALL old functionality:
 *   - Message scanning (delta-based) → UPDATE_USAGE
 *   - Session tracking
 *   - In-page UI injection & update
 *   - SPA navigation handling
 *
 * Adds new detection backend:
 *   - DOM progress bar / banner detection
 *   - Network interception (fetch + XHR quota headers)
 *   - State management with confidence scoring
 *   - STATE_UPDATE messaging
 */

import { initState, getState, onChange, startCountdownTicker, feedDetection, setApiConnected, setApiError } from "./backend/state-manager";
import { runDetection, handleNetworkQuota, startPeriodicScan, estimateUsage } from "./backend/tracker";
import { interceptFetch, interceptXHR, getTrackedOrgId, setOnOrgIdDetected } from "./backend/network-monitor";
import type { DetectedUsage, PlanTier } from "./backend/types";
import { refineLocal, refineWithAPI, RefinementResult } from './refiner';

// ── Old tracking state ──
const TRACK = {
  conversationId: null as string | null,
  conversationTitle: "New Chat",
  knownConversations: new Set<string>(),
  lastUrl: location.href,
  isNewConversation: false,
  observer: null as MutationObserver | null,
  urlCheckInterval: null as ReturnType<typeof setInterval> | null,
  scanDebounce: null as ReturnType<typeof setTimeout> | null,
  lastUserChars: 0,
  lastAssistantChars: 0,
  lastUserCount: 0,
  lastAssistantCount: 0,
  sessionStarted: false,
  sessionCheckTimer: null as ReturnType<typeof setInterval> | null,
  uiUpdateInterval: null as ReturnType<typeof setInterval> | null,
  inputEl: null as HTMLElement | null,
  lastRefinement: null as RefinementResult | null,
  refineDeepInProgress: false,
};

const MESSAGE_SELECTORS = [
  '[data-testid="user-message"]',
  '[data-testid="assistant-message"]',
  '[data-message-author-role="user"]',
  '[data-message-author-role="assistant"]',
  '[data-message-id]',
  'article[data-testid^="message"]',
];

const TITLE_SELECTORS = [
  'h1[data-testid="conversation-title"]',
  '[data-testid="chat-title"]',
  ".conversation-title",
  "h1",
];

// ── Org ID / Direct API ──

function getOrgIdFromCookie(): string | null {
  const match = document.cookie.match(/\blastActiveOrg=([^;]+)/);
  return match ? match[1] : null;
}

let _orgIdBackgroundCache: string | null = null;
let _orgIdBgPromise: Promise<string | null> | null = null;
const PLAN_TIER_CACHE_KEY = "planTierByOrg";
const PLAN_TIER_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface PlanTierCacheEntry {
  planTier: PlanTier;
  cachedAt: number;
}

type PlanTierCache = Record<string, PlanTierCacheEntry>;

async function getOrgIdFromBackground(): Promise<string | null> {
  if (_orgIdBackgroundCache) return _orgIdBackgroundCache;
  if (_orgIdBgPromise) return _orgIdBgPromise;
  _orgIdBgPromise = (async () => {
    const resp = await sendRuntimeMessage<string>({ type: "GET_ORG_ID" });
    if (typeof resp === "string" && resp) {
      _orgIdBackgroundCache = resp;
      return resp;
    }
    return null;
  })();
  return _orgIdBgPromise;
}

async function resolveOrgId(): Promise<string | null> {
  const tracked = getTrackedOrgId();
  if (tracked) return tracked;
  const cookie = getOrgIdFromCookie();
  if (cookie) return cookie;
  return getOrgIdFromBackground();
}

async function sendRuntimeMessage<T = unknown>(message: unknown): Promise<T | null> {
  try {
    if (!chrome.runtime?.id) return null;
    return await chrome.runtime.sendMessage(message) as T;
  } catch {
    return null;
  }
}

function getRuntimeUrl(path: string): string | null {
  try {
    if (!chrome.runtime?.id) return null;
    return chrome.runtime.getURL(path);
  } catch {
    return null;
  }
}

async function fetchPlanInfo(orgId: string): Promise<void> {
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

    const response = await fetch(
      `https://claude.ai/api/bootstrap/${orgId}/app_start?statsig_hashing_algorithm=djb2`,
      { credentials: "include", headers: { "Content-Type": "application/json" } }
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

async function fetchUsageFromAPI(): Promise<void> {
  const orgId = await resolveOrgId();
  if (!orgId) {
    return; // not yet available — keep current state, try next interval
  }

  try {
    const response = await fetch(`https://claude.ai/api/organizations/${orgId}/usage`, {
      credentials: "include",
      headers: { "Content-Type": "application/json" },
    });
    if (!response.ok) {
      console.warn(`[CUT] /usage returned ${response.status} — API error`);
      setApiError(response.status);
      return;
    }

    const data: Record<string, unknown> = await response.json();

    if (!data.five_hour || typeof data.five_hour !== "object") {
      setApiConnected(false);
      return;
    }

    // API call succeeded — mark as connected
    setApiConnected(true);

    const fh = data.five_hour as Record<string, unknown>;

    const detected: DetectedUsage = {
      source: "network",
      confidence: 0.95,
    };

    if (typeof fh.utilization === "number") {
      detected.usagePercent = fh.utilization;
    }

    if (typeof fh.max_messages === "number" && fh.max_messages > 0) {
      detected.sessionLimit = fh.max_messages;
      if (typeof fh.utilization === "number") {
        const used = Math.round((fh.utilization / 100) * fh.max_messages);
        detected.remainingMessages = fh.max_messages - used;
      }
    }

    if (typeof fh.resets_at === "string") {
      const ts = new Date(fh.resets_at).getTime();
      if (!isNaN(ts)) {
        detected.resetTimestamp = ts;
      }
    }

    if (fh.utilization !== undefined && Number(fh.utilization) >= 100) {
      detected.isRateLimited = true;
    }

    // Hard limit (maxed) data from API
    if (data.maxed && typeof data.maxed === "object") {
      const mx = data.maxed as Record<string, unknown>;
      detected.limitType = "hard";
      if (typeof mx.resets_at === "string") {
        const ts = new Date(mx.resets_at).getTime();
        if (!isNaN(ts)) {
          detected.hardLimitResetAt = ts;
          detected.resetTimestamp = ts;
        }
      }
      if (typeof mx.messages_used === "number" && typeof fh.max_messages === "number" && fh.max_messages > 0) {
        detected.sessionMessagesUsed = mx.messages_used as number;
        detected.sessionLimit = fh.max_messages as number;
      }
      detected.isRateLimited = true;
    } else {
      detected.limitType = "soft";
    }

    // Weekly usage (seven_day)
    if (data.seven_day && typeof data.seven_day === "object") {
      const sd = data.seven_day as Record<string, unknown>;
      const weekly = parseWeeklyField(sd);
      if (weekly) detected.weeklyUsage = weekly;
    }

    // Per-model weekly breakdowns (Max plans)
    if (data.seven_day_sonnet && typeof data.seven_day_sonnet === "object") {
      const sd = data.seven_day_sonnet as Record<string, unknown>;
      const w = parseWeeklyField(sd);
      if (w) detected.weeklySonnetUsage = w;
    }

    if (data.seven_day_opus && typeof data.seven_day_opus === "object") {
      const sd = data.seven_day_opus as Record<string, unknown>;
      const w = parseWeeklyField(sd);
      if (w) detected.weeklyOpusUsage = w;
    }

    feedDetection(detected);
  } catch {
    setApiConnected(false);
  }
}

function parseWeeklyField(obj: Record<string, unknown>): import("./backend/types").WeeklyUsage | null {
  if (typeof obj.utilization !== "number" && typeof obj.max_messages !== "number") return null;
  return {
    usagePercent: typeof obj.utilization === "number" ? obj.utilization : null,
    messagesUsed: typeof obj.utilization === "number" && typeof obj.max_messages === "number"
      ? Math.round((obj.utilization / 100) * obj.max_messages)
      : null,
    maxMessages: typeof obj.max_messages === "number" ? obj.max_messages : null,
    resetsAt: typeof obj.resets_at === "string" ? new Date(obj.resets_at).getTime() : null,
  };
}

/**
 * Handle usage data pushed proactively from the background service worker.
 * This is the same parsing logic as fetchUsageFromAPI but skips orgId
 * resolution and the fetch — the background already did both.
 */
function handleBgUsagePush(data: Record<string, unknown>, orgId: string): void {
  if (!data || !data.five_hour || typeof data.five_hour !== "object") return;

  setApiConnected(true);
  
  // Immediately inform the network monitor of the orgId
  window.dispatchEvent(new CustomEvent("cut-org-id", { detail: orgId }));

  const fh = data.five_hour as Record<string, unknown>;
  const detected: DetectedUsage = { source: "network", confidence: 0.95 };

  if (typeof fh.utilization === "number") {
    detected.usagePercent = fh.utilization;
  }
  if (typeof fh.max_messages === "number" && fh.max_messages > 0) {
    detected.sessionLimit = fh.max_messages;
    if (typeof fh.utilization === "number") {
      const used = Math.round((fh.utilization / 100) * fh.max_messages);
      detected.remainingMessages = fh.max_messages - used;
    }
  }
  if (typeof fh.resets_at === "string") {
    const ts = new Date(fh.resets_at).getTime();
    if (!isNaN(ts)) detected.resetTimestamp = ts;
  }
  if (fh.utilization !== undefined && Number(fh.utilization) >= 100) {
    detected.isRateLimited = true;
  }

  if (data.maxed && typeof data.maxed === "object") {
    const mx = data.maxed as Record<string, unknown>;
    detected.limitType = "hard";
    if (typeof mx.resets_at === "string") {
      const ts = new Date(mx.resets_at).getTime();
      if (!isNaN(ts)) { detected.hardLimitResetAt = ts; detected.resetTimestamp = ts; }
    }
    if (typeof mx.messages_used === "number" && typeof fh.max_messages === "number" && fh.max_messages > 0) {
      detected.sessionMessagesUsed = mx.messages_used as number;
      detected.sessionLimit = fh.max_messages as number;
    }
    detected.isRateLimited = true;
  } else {
    detected.limitType = "soft";
  }

  if (data.seven_day && typeof data.seven_day === "object") {
    const w = parseWeeklyField(data.seven_day as Record<string, unknown>);
    if (w) detected.weeklyUsage = w;
  }
  if (data.seven_day_sonnet && typeof data.seven_day_sonnet === "object") {
    const w = parseWeeklyField(data.seven_day_sonnet as Record<string, unknown>);
    if (w) detected.weeklySonnetUsage = w;
  }
  if (data.seven_day_opus && typeof data.seven_day_opus === "object") {
    const w = parseWeeklyField(data.seven_day_opus as Record<string, unknown>);
    if (w) detected.weeklyOpusUsage = w;
  }

  // Also feed orgId and plan info
  detected.orgId = orgId;
  feedDetection(detected);
  fetchPlanInfo(orgId);
}

// Peak hours per Anthropic's March 2026 capacity announcement: weekdays
// 8am-2pm ET. Hardcoding this is inherently fragile — Anthropic could change
// or remove this policy at any time with no API signal. Treat this as a
// best-effort estimate, not authoritative.
function checkPeakHours(): void {
  const PEAK_START_HOUR_ET = 8;
  const PEAK_END_HOUR_ET = 14;
  const etFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    hour12: false,
    weekday: "short",
  });

  const now = new Date();
  const parts = etFormatter.formatToParts(now);
  const etHour = parseInt(parts.find(p => p.type === "hour")!.value, 10);
  const etWeekday = parts.find(p => p.type === "weekday")!.value;
  const isWeekday = etWeekday !== "Sat" && etWeekday !== "Sun";
  const inPeak = isWeekday && etHour >= PEAK_START_HOUR_ET && etHour < PEAK_END_HOUR_ET;

  // Walk forward minute-by-minute to find the exact transition time
  // in ET, correctly handling DST boundaries. At most ~8 days * 24h * 60min
  // = 11,520 iterations, running once per minute — negligible cost.
  let transitionAt = 0;
  const probe = new Date(now);
  let prevInPeak = inPeak;
  for (let i = 0; i < 8 * 24 * 60; i++) {
    probe.setTime(probe.getTime() + 60_000);
    const probeParts = etFormatter.formatToParts(probe);
    const probeHour = parseInt(probeParts.find(p => p.type === "hour")!.value, 10);
    const probeWeekday = probeParts.find(p => p.type === "weekday")!.value;
    const probeIsWeekday = probeWeekday !== "Sat" && probeWeekday !== "Sun";
    const probeInPeak = probeIsWeekday && probeHour >= PEAK_START_HOUR_ET && probeHour < PEAK_END_HOUR_ET;
    if (probeInPeak !== prevInPeak) {
      transitionAt = probe.getTime();
      break;
    }
    prevInPeak = probeInPeak;
  }

  const detected: DetectedUsage = {
    source: "computed",
    confidence: 0.99,
    isPeakHours: inPeak,
    peakHoursTransitionAt: transitionAt || 0,
  };
  feedDetection(detected);
}

// ── Init ──
let cleanupFns: (() => void)[] = [];
let initialized = false;

async function init(): Promise<void> {
  if (initialized) return;
  initialized = true;

  // 1. Init new backend
  await initState();

  // 2. Network interception (new)
  cleanupFns.push(interceptFetch((quota) => handleNetworkQuota(quota)));
  cleanupFns.push(interceptXHR((quota) => handleNetworkQuota(quota)));

  // 3. Initial detection (new)
  runDetection("navigation");

  // 4. Periodic scan (new)
  cleanupFns.push(startPeriodicScan(15000));

  // 4b. Peak hours check every 60s
  checkPeakHours();
  const peakInterval = setInterval(checkPeakHours, 60000);
  cleanupFns.push(() => clearInterval(peakInterval));

  // 5. Countdown ticker (new)
  startCountdownTicker();

  // 6. Emit state changes to background (new)
  onChange((newState) => {
    void sendRuntimeMessage({ type: "STATE_UPDATE", state: newState });
  });

  // 7. Old: inject styles & UI
  injectStyles();
  injectUI();

  // 8. (Removed blocking scroll to load all messages to improve startup performance)

  // 9. Old: start tracking
  processPage();
  startObserver();

  TRACK.urlCheckInterval = setInterval(checkUrlChange, 1000);
  window.addEventListener("popstate", onUrlChanged);
  ensureSession();

  // 9. Mid-chat installation: if existing messages found and no reset time
  //    was detected yet, feed an estimated state so the timer isn't blank
  const existingMsgs = TRACK.lastUserCount + TRACK.lastAssistantCount;
  if (existingMsgs > 0 && !getState().resetTimestamp) {
    const resp = await sendRuntimeMessage<any>({ type: "GET_SETTINGS" });
    if (resp) {
      const limit = resp?.limits?.dailyMessages ?? 45;
      const windowMs = resp?.limits?.sessionWindowMs ?? 5 * 60 * 60 * 1000;
      estimateUsage(TRACK.lastUserCount, TRACK.lastAssistantCount, limit, windowMs);
    }
  }

    // 10. Direct API polling: fetch accurate usage data from Claude's /usage endpoint
  // Fire immediately on init
  fetchUsageFromAPI();

  // Also fetch plan info (tier / capabilities)
  const orgIdForPlan = resolveOrgId();
  orgIdForPlan.then((oid) => { if (oid) fetchPlanInfo(oid); });

  // Long-running polling: fetch accurate usage data from Claude's /usage endpoint every 30s
  const usageApiInterval = setInterval(fetchUsageFromAPI, 10000);
  cleanupFns.push(() => clearInterval(usageApiInterval));
  
  // Fast retry: poll every 3s for the first 30s to catch orgId as soon as it's available
  const fastRetryInterval = setInterval(() => {
    fetchUsageFromAPI();
  }, 3000);
  const fastRetryTimer = setTimeout(() => {
    clearInterval(fastRetryInterval);
    // Log if we still have no orgId after the fast-retry window — the
    // popup will show "not detected" until the user opens a conversation.
    resolveOrgId().then((id) => {
      if (!id) console.debug("[CUT] orgId not detected after 30s — waiting for user to open a conversation.");
    });
  }, 30000);
  cleanupFns.push(() => { clearTimeout(fastRetryTimer); clearInterval(fastRetryInterval); });

  // When the network interceptor catches the first API call with an orgId, fire immediately
  setOnOrgIdDetected(() => {
    fetchUsageFromAPI();
    const trackedOrgId = getTrackedOrgId();
    if (trackedOrgId) fetchPlanInfo(trackedOrgId);
  });

  // 11. Check for webRequest quota data captured before content script loaded
  const pendingQuota = await sendRuntimeMessage({ type: "GET_WEBREQUEST_QUOTA" });
  if (pendingQuota) handleNetworkQuota(pendingQuota);

  TRACK.uiUpdateInterval = setInterval(updateUI, 1000);

  // 11. Mutation observer for DOM detection (new)
  const domObserver = new MutationObserver(() => {
    runDetection("mutation");
  });
  domObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-valuenow", "aria-valuemax", "style", "class"],
  });
  cleanupFns.push(() => domObserver.disconnect());
  cleanupFns.push(() => {
    document.getElementById('cut-refine-btn')?.remove();
    document.getElementById('cut-refine-overlay')?.remove();
    document.getElementById('cut-composer-refine')?.remove();
    document.getElementById('cut-composer-deep')?.remove();
  });

  // 12. Initialize composer refiner buttons (opt-in, session-based)
  initComposerRefiner();
}

// ── Old: Page / URL Detection ──
function processPage(): void {
  const url = location.href;
  const match = url.match(/\/chat\/([a-f0-9-]+)/);

  if (match && match[1] !== TRACK.conversationId) {
    TRACK.conversationId = match[1];
    TRACK.isNewConversation = !TRACK.knownConversations.has(TRACK.conversationId);
    TRACK.knownConversations.add(TRACK.conversationId);
    TRACK.lastUserChars = 0;
    TRACK.lastAssistantChars = 0;
    TRACK.lastUserCount = 0;
    TRACK.lastAssistantCount = 0;
    TRACK.conversationTitle = extractTitle();
    scanMessages();
  } else if (!match) {
    TRACK.conversationId = null;
  }
}

function extractTitle(): string {
  for (const sel of TITLE_SELECTORS) {
    const el = document.querySelector(sel);
    if (el && el.textContent?.trim()) return el.textContent.trim();
  }
  const metaTitle = document.querySelector("title");
  if (metaTitle) {
    let t = metaTitle.textContent?.replace(/ - Claude$/, "").trim() ?? "";
    if (t) return t;
  }
  return TRACK.conversationTitle || "New Chat";
}

function checkUrlChange(): void {
  const current = location.href;
  if (current !== TRACK.lastUrl) {
    TRACK.lastUrl = current;
    onUrlChanged();
  }
}

function onUrlChanged(): void {
  TRACK.inputEl = null;
  TRACK.conversationTitle = extractTitle();
  processPage();
  runDetection("navigation");
}

// ── Old: Session ──
function ensureSession(): void {
  if (!TRACK.sessionStarted) {
    TRACK.sessionStarted = true;
    sendRuntimeMessage({ type: "UPDATE_SESSION", data: { action: "start" } })
      .then(() => {
        // If messages were already on the page at init (mid-conversation install
        // or reload), immediately reconcile so the session reflects current state
        // rather than waiting for the next mutation event.
        if (TRACK.lastUserCount > 0 || TRACK.lastAssistantCount > 0) {
          scanMessages();
        }
      })
      .catch(() => {});
    startActivityMonitor();
  }
}

function startActivityMonitor(): void {
  let inactiveSince = 0;
  const INACTIVITY_TIMEOUT = 30 * 60 * 1000;

  const resetInactivity = () => { inactiveSince = 0; };

  (["mousemove", "keydown", "click", "scroll", "touchstart"] as const).forEach((ev) => {
    window.addEventListener(ev, resetInactivity, { passive: true });
  });

  TRACK.sessionCheckTimer = setInterval(() => {
    const now = Date.now();
    if (inactiveSince === 0) {
      inactiveSince = now;
    } else if (now - inactiveSince > INACTIVITY_TIMEOUT) {
      void sendRuntimeMessage({ type: "UPDATE_SESSION", data: { action: "stop" } });
      TRACK.sessionStarted = false;
      clearInterval(TRACK.sessionCheckTimer!);
    }
  }, 60000);
}

// ── Old: Message Scanning (Delta-based) ──
function scanMessages(): void {
  if (!TRACK.conversationId) return;

  const messages = findMessageElements();
  let userChars = 0, assistantChars = 0, userCount = 0, assistantCount = 0;

  for (const msg of messages) {
    const isUser = isUserMessage(msg);
    const text = extractText(msg);
    const len = text.length;
    if (isUser) { userChars += len; userCount++; }
    else { assistantChars += len; assistantCount++; }
  }

  const du = userChars - TRACK.lastUserChars;
  const da = assistantChars - TRACK.lastAssistantChars;
  const dcu = userCount - TRACK.lastUserCount;
  const dca = assistantCount - TRACK.lastAssistantCount;

  if (du > 0 || da > 0) {
    const data = {
      conversationId: TRACK.conversationId,
      conversationTitle: TRACK.conversationTitle,
      messagesSent: dcu,
      messagesReceived: dca,
      charsSent: du,
      charsReceived: da,
      tokensSent: Math.round(du / 4),
      tokensReceived: Math.round(da / 4),
      isNewConversation: TRACK.isNewConversation,
      // Absolute totals per conversation (for dedup on page refresh)
      convTotalMessagesSent: userCount,
      convTotalMessagesReceived: assistantCount,
      convTotalCharsSent: userChars,
      convTotalCharsReceived: assistantChars,
    };
    void sendRuntimeMessage({ type: "UPDATE_USAGE", data });
    void sendRuntimeMessage({ type: "UPDATE_SESSION", data: { action: "update", ...data } });
    TRACK.isNewConversation = false;
  }

  TRACK.lastUserChars = userChars;
  TRACK.lastAssistantChars = assistantChars;
  TRACK.lastUserCount = userCount;
  TRACK.lastAssistantCount = assistantCount;
}

function findMessageElements(): Element[] {
  const results: Element[] = [];
  const seen = new Set<string>();
  for (const sel of MESSAGE_SELECTORS) {
    for (const el of document.querySelectorAll(sel)) {
      const id = el.getAttribute("data-message-id") || el.getAttribute("data-testid") || el.outerHTML.slice(0, 80);
      if (!seen.has(id)) { seen.add(id); results.push(el); }
    }
  }
  results.sort((a, b) =>
    (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1
  );
  return results;
}

function isUserMessage(el: Element): boolean {
  const testId = el.getAttribute("data-testid") || "";
  const role = el.getAttribute("data-message-author-role") || "";
  return testId.includes("user") || role === "user";
}

function extractText(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  for (const c of clone.querySelectorAll("code")) c.textContent = " " + c.textContent + " ";
  for (const b of clone.querySelectorAll("button")) b.remove();
  return clone.textContent?.trim() ?? "";
}

// ── Old: Observer ──
function startObserver(): void {
  if (TRACK.observer) TRACK.observer.disconnect();
  TRACK.observer = new MutationObserver(() => {
    if (TRACK.scanDebounce) clearTimeout(TRACK.scanDebounce);
    TRACK.scanDebounce = setTimeout(() => {
      TRACK.conversationTitle = extractTitle();
      scanMessages();
      updateUI();
    }, 400);
  });
  TRACK.observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}

// ── Old: In-page UI Injection ──
function injectStyles(): void {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  const stylesheetUrl = getRuntimeUrl("dist/inpage/inpage.css");
  if (!stylesheetUrl) return;
  link.href = stylesheetUrl;
  document.head.appendChild(link);
}

function injectUI(): void {
  if (document.getElementById("cut-container")) return;

  const container = document.createElement("div");
  container.id = "cut-container";
  document.body.appendChild(container);

  detectTheme();

  container.innerHTML = `
    <div id="cut-widget">
      <div id="cut-badge">0%</div>
      <div id="cut-panel">
        <div class="cut-panel-header">
          <span class="cut-header-label">Claude usage</span>
          <div class="cut-panel-actions">
            <span class="cut-badge-sm" id="cut-badge-sm">0%</span>
            <span id="cut-force-reload" class="cut-header-btn" title="Reload usage">↻</span>
            <span id="cut-export" class="cut-header-btn" title="Export">⎋</span>
            <span id="cut-open-settings" class="cut-header-btn" title="Settings">⚙</span>
            <span id="cut-toggle-min" class="cut-header-btn" title="Minimize">–</span>
            <span id="cut-close" class="cut-header-btn" title="Close">×</span>
          </div>
        </div>

        <div class="cut-peak-banner" id="cut-peak-row">
          <div class="cut-peak-main">
            <span class="cut-peak-dot" id="cut-peak-dot"></span>
            <span class="cut-peak-message" id="cut-peak-message">Checking peak hours...</span>
            <span class="cut-peak-countdown" id="cut-peak-timer">--:--:--</span>
          </div>
          <div class="cut-peak-note">Applies to Claude.ai chat. Claude Code on Pro/Max plans is no longer throttled during peak hours (since May 2026).</div>
        </div>

        <div class="cut-section w-prog-section">
          <div class="cut-progress-row">
            <span class="cut-progress-label">Session</span>
            <div class="cut-progress-bar-wrap">
              <div class="cut-progress-bar">
                <div class="cut-progress-fill safe" id="cut-msg-bar"></div>
              </div>
              <span class="cut-progress-nums" id="cut-msg-nums">0 / 45</span>
            </div>
          </div>
          <div class="cut-progress-row">
            <span class="cut-progress-label">Tokens</span>
            <div class="cut-progress-bar-wrap">
              <div class="cut-progress-bar">
                <div class="cut-progress-fill safe" id="cut-token-bar"></div>
              </div>
              <span class="cut-progress-nums" id="cut-token-nums">0 / 90K</span>
            </div>
          </div>
        </div>

        <div class="cut-stat-grid w-stat-grid">
          <div class="cut-stat-cell">
            <span class="cut-stat-value" id="cut-sent">0</span>
            <span class="cut-stat-label">Sent</span>
          </div>
          <div class="cut-stat-cell">
            <span class="cut-stat-value" id="cut-recv">0</span>
            <span class="cut-stat-label">Recv</span>
          </div>
          <div class="cut-stat-cell">
            <span class="cut-stat-value cut-stat-remain" id="cut-remain">0</span>
            <span class="cut-stat-label">Remain</span>
          </div>
        </div>

        <div class="cut-footer-row w-foot">
          <span class="cut-reset-label">Resets <strong class="cut-reset-time" id="cut-reset-timer">--:--:--</strong></span>
          <span class="cut-details-link" id="cut-open-popup">Details →</span>
        </div>

        <div class="cut-ratelimit-row" id="cut-ratelimit-row" style="display:none">
          <span>Rate limited · Cooldown: <strong id="cut-cooldown-timer">--:--:--</strong></span>
        </div>
      </div>
    </div>
  `;

  // Part A — Button injection (only when refinerEnabled)
  chrome.storage.local.get('settings').then(({ settings }) => {
    const s = (settings || {}) as { refinerEnabled?: boolean; themeMode?: string };
    if (!s.refinerEnabled) return;

    const refineBtn = document.createElement('button');
    refineBtn.id = 'cut-refine-btn';
    refineBtn.title = 'Refine prompt (save credits)';
    refineBtn.innerHTML = '✦ Refine';
    document.body.appendChild(refineBtn);

    // Part B — Result overlay
    const overlay = document.createElement('div');
    overlay.id = 'cut-refine-overlay';
    overlay.style.display = 'none';
    overlay.innerHTML = `
      <div id="cut-refine-card">
        <div class="cut-refine-header">
          <span class="cut-refine-title">Refined prompt</span>
          <div class="cut-refine-savings" id="cut-refine-savings">Saved 0 tokens</div>
          <button class="cut-refine-close" id="cut-refine-close">×</button>
        </div>
        <div class="cut-refine-body">
          <div class="cut-refine-col">
            <div class="cut-refine-col-label">Original <span class="cut-refine-tokens" id="cut-orig-tokens">~0 tokens</span></div>
            <div class="cut-refine-text" id="cut-orig-text"></div>
          </div>
          <div class="cut-refine-divider"></div>
          <div class="cut-refine-col">
            <div class="cut-refine-col-label">Refined <span class="cut-refine-tokens cut-refine-tokens-saved" id="cut-refined-tokens">~0 tokens</span></div>
            <div class="cut-refine-text cut-refine-text-refined" id="cut-refined-text"></div>
          </div>
        </div>
        <div class="cut-refine-footer">
          <button class="cut-refine-btn-secondary" id="cut-refine-deep">Deep Refine (API)</button>
          <div class="cut-refine-footer-right">
            <button class="cut-refine-btn-secondary" id="cut-refine-dismiss">Dismiss</button>
            <button class="cut-refine-btn-primary" id="cut-refine-accept">Use refined ↵</button>
          </div>
        </div>
        <div class="cut-refine-status" id="cut-refine-status" style="display:none"></div>
      </div>
    `;
    document.body.appendChild(overlay);

    attachUIEvents();
    if (s.themeMode) detectTheme(s.themeMode);
  });
}

// ── Composer Refiner Buttons ───────────────────────────────────────────────
// Injects "✦ Refine" and "⚡ Deep" buttons into the ProseMirror toolbar.
// Only active when settings.refinerEnabled === true. No API key required.
function initComposerRefiner(): void {
  chrome.storage.local.get('settings').then(({ settings }) => {
    const s = (settings || {}) as { refinerEnabled?: boolean };
    if (!s.refinerEnabled) return;

    let deepInProgress = false;

    function injectComposerButtons(): void {
      // Bail out if buttons already present
      if (document.getElementById('cut-composer-refine')) return;

      const composer = document.querySelector<HTMLElement>('.ProseMirror[contenteditable="true"]');
      if (!composer) return;

      // Find a stable toolbar ancestor to anchor the buttons.
      // Claude renders a row of action buttons below the composer;
      // we insert our buttons into that same container when possible,
      // falling back to the fieldset or the composer's own parent.
      const toolbar =
        (composer.closest('fieldset') as HTMLElement | null) ||
        composer.parentElement;
      if (!toolbar) return;

      // Wrapper so the two buttons stay together
      const wrap = document.createElement('div');
      wrap.id = 'cut-composer-wrap';
      wrap.style.cssText = `
        display: inline-flex;
        gap: 4px;
        align-items: center;
        position: absolute;
        right: 12px;
        top: -40px;
        z-index: 200;
      `;

      // Ensure the toolbar can host an absolutely-positioned child
      if (getComputedStyle(toolbar).position === 'static') {
        toolbar.style.position = 'relative';
      }

      // ── ✦ Refine button (instant, local rules) ────────────────────────
      const refBtn = document.createElement('button');
      refBtn.id = 'cut-composer-refine';
      refBtn.title = 'Instant local refinement';
      refBtn.textContent = '✦ Refine';
      refBtn.style.cssText = `
        background: #6d28d9;
        color: #fff;
        border: none;
        padding: 5px 11px;
        border-radius: 6px;
        cursor: pointer;
        font-size: 12px;
        font-weight: 600;
        box-shadow: 0 1px 4px rgba(0,0,0,.18);
        transition: opacity .15s;
        white-space: nowrap;
      `;

      refBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const text = getInputText();
        if (!text || text.length <= 20) return;
        refBtn.textContent = '⏳ Refining…';
        refBtn.style.opacity = '0.6';
        try {
          const result = refineLocal(text);
          showRefinementOverlay(result);
        } finally {
          refBtn.textContent = '✦ Refine';
          refBtn.style.opacity = '1';
        }
      });

      // ── ⚡ Deep button (AI rewrite via claude.ai session) ──────────────
      const deepBtn = document.createElement('button');
      deepBtn.id = 'cut-composer-deep';
      deepBtn.title = 'AI rewrite via your Claude session (no API key needed)';
      deepBtn.textContent = '⚡ Deep';
      deepBtn.style.cssText = `
        background: #0e7490;
        color: #fff;
        border: none;
        padding: 5px 11px;
        border-radius: 6px;
        cursor: pointer;
        font-size: 12px;
        font-weight: 600;
        box-shadow: 0 1px 4px rgba(0,0,0,.18);
        transition: opacity .15s;
        white-space: nowrap;
      `;

      deepBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (deepInProgress) return;

        const orgId = getTrackedOrgId();
        if (!orgId) {
          // Surface error in overlay status if open, else show on the button
          const statusEl = document.getElementById('cut-refine-status') as HTMLElement | null;
          if (statusEl && document.getElementById('cut-refine-overlay')?.style.display !== 'none') {
            statusEl.textContent = 'Org ID not detected yet — try again in a moment.';
            statusEl.style.display = '';
          } else {
            deepBtn.textContent = '⚠ No session';
            setTimeout(() => { deepBtn.textContent = '⚡ Deep'; }, 2000);
          }
          return;
        }

        deepInProgress = true;
        deepBtn.textContent = '⏳ Refining…';
        deepBtn.style.opacity = '0.6';
        deepBtn.style.cursor = 'wait';
        refBtn.disabled = true;

        const text = getInputText();
        try {
          const result = await refineWithAPI(text, orgId);
          showRefinementOverlay(result);
          const statusEl = document.getElementById('cut-refine-status') as HTMLElement | null;
          if (statusEl) statusEl.style.display = 'none';
        } catch (err) {
          console.error('[CUT composer deep refine] failed:', err);
          const errMsg = err instanceof Error ? err.message : String(err);
          deepBtn.textContent = '❌ Failed';
          setTimeout(() => { deepBtn.textContent = '⚡ Deep'; }, 2500);
          // Fall back to local result and show error in overlay
          try {
            const fallback = refineLocal(text);
            showRefinementOverlay(fallback);
            const statusEl = document.getElementById('cut-refine-status') as HTMLElement | null;
            if (statusEl) {
              statusEl.textContent = `AI refine failed — showing local result instead. (${errMsg})`;
              statusEl.style.display = '';
            }
          } catch { /* if local also fails, leave the button error visible */ }
        } finally {
          deepBtn.style.opacity = '1';
          deepBtn.style.cursor = 'pointer';
          refBtn.disabled = false;
          deepInProgress = false;
          if (deepBtn.textContent === '⏳ Refining…') deepBtn.textContent = '⚡ Deep';
        }
      });

      wrap.appendChild(refBtn);
      wrap.appendChild(deepBtn);
      toolbar.appendChild(wrap);
    }

    // Initial inject attempt
    injectComposerButtons();

    // Re-inject after SPA navigation / composer remounts
    const observer = new MutationObserver(() => {
      if (!document.getElementById('cut-composer-refine')) {
        injectComposerButtons();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

function detectTheme(mode?: string): void {
  const container = document.getElementById("cut-container");
  if (!container) return;
  let isDark: boolean;
  if (mode === "dark") isDark = true;
  else if (mode === "light") isDark = false;
  else isDark = document.documentElement.classList.contains("dark")
    || window.matchMedia("(prefers-color-scheme: dark)").matches;
  container.classList.toggle("cut-dark", isDark);
  document.getElementById("cut-refine-btn")?.classList.toggle("cut-dark", isDark);
  document.getElementById("cut-refine-overlay")?.classList.toggle("cut-dark", isDark);
}

function attachUIEvents(): void {
  const get = (id: string) => document.getElementById(id);

  get("cut-toggle-min")?.addEventListener("click", toggleMinimize);
  get("cut-close")?.addEventListener("click", () => {
    get("cut-widget")?.classList.remove("cut-expanded");
    get("cut-widget")?.classList.add("cut-collapsed");
    const panel = get("cut-panel");
    if (panel) panel.style.display = "none";
    const badge = get("cut-badge");
    if (badge) badge.style.display = "flex";
  });
  get("cut-badge")?.addEventListener("click", () => {
    get("cut-widget")?.classList.remove("cut-collapsed");
    get("cut-widget")?.classList.add("cut-expanded");
    const panel = get("cut-panel");
    if (panel) panel.style.display = "block";
    const badge = get("cut-badge");
    if (badge) badge.style.display = "none";
  });
  get("cut-open-popup")?.addEventListener("click", () => {
    const dashboardUrl = getRuntimeUrl("dist/dashboard/dashboard.html");
    if (dashboardUrl) window.open(dashboardUrl, "_blank");
  });
  get("cut-open-settings")?.addEventListener("click", () => {
    try {
      if (chrome.runtime?.id) chrome.runtime.openOptionsPage();
    } catch {
      // Extension was reloaded while this content script was still alive.
    }
  });
  get("cut-export")?.addEventListener("click", handleWidgetExport);
  get("cut-force-reload")?.addEventListener("click", async () => {
    const btn = get("cut-force-reload");
    if (btn) {
      btn.style.transition = 'transform 0.2s ease';
      btn.style.transform = 'rotate(180deg)';
    }
    runDetection("manual");
    const orgId = getTrackedOrgId();
    if (orgId) {
      await sendRuntimeMessage({ type: "FORCE_FETCH_USAGE", orgId });
    }
    if (btn) {
      setTimeout(() => { btn.style.transform = ''; }, 200);
    }
  });

  // Prompt Refinement Wiring
  const refineBtn = document.getElementById("cut-refine-btn");
  if (refineBtn) {
    refineBtn.addEventListener("click", () => {
      const text = getInputText();
      if (!text || text.length <= 20) return;
      const btn = refineBtn as HTMLButtonElement;
      btn.textContent = 'Refining…';
      btn.classList.add('loading');
      try {
        const result = refineLocal(text);
        showRefinementOverlay(result);
      } finally {
        btn.innerHTML = '✦ Refine';
        btn.classList.remove('loading');
      }
    });
  }

  const acceptBtn = document.getElementById("cut-refine-accept");
  if (acceptBtn) {
    acceptBtn.addEventListener("click", () => {
      if (!TRACK.lastRefinement) return;
      setInputText(TRACK.lastRefinement.refined);
      hideRefinementOverlay();
    });
  }

  const dismissBtn = document.getElementById("cut-refine-dismiss");
  if (dismissBtn) dismissBtn.addEventListener("click", hideRefinementOverlay);
  const closeBtn = document.getElementById("cut-refine-close");
  if (closeBtn) closeBtn.addEventListener("click", hideRefinementOverlay);

  const overlay = document.getElementById("cut-refine-overlay");
  if (overlay) {
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) hideRefinementOverlay();
    });
  }

  const deepBtn = document.getElementById("cut-refine-deep") as HTMLButtonElement;
  if (deepBtn) {
    deepBtn.addEventListener("click", async () => {
      if (TRACK.refineDeepInProgress) return;
      const orgId = getTrackedOrgId();
      if (!orgId) {
        const status = document.getElementById('cut-refine-status') as HTMLElement;
        status.textContent = "Org ID not detected yet — try again in a moment.";
        status.style.display = '';
        return;
      }
      TRACK.refineDeepInProgress = true;
      deepBtn.textContent = 'Refining…';
      deepBtn.disabled = true;
      const originalText = TRACK.lastRefinement?.original || getInputText();

      try {
        const result = await refineWithAPI(originalText, orgId);
        showRefinementOverlay(result);
        (document.getElementById('cut-refine-status') as HTMLElement).style.display = 'none';
      } catch (err) {
        console.error("[CUT deep refine] failed:", err);
        // Show the real error message so the user knows what went wrong
        const errMsg = err instanceof Error ? err.message : String(err);
        const status = document.getElementById('cut-refine-status') as HTMLElement;
        status.textContent = `AI refine failed: ${errMsg}`;
        status.style.display = '';
        // Fall back to local refinement so the user still gets a useful result
        try {
          const fallback = refineLocal(TRACK.lastRefinement?.original || getInputText());
          showRefinementOverlay(fallback);
          // Re-show the error banner on top of the overlay result
          const statusAfter = document.getElementById('cut-refine-status') as HTMLElement;
          statusAfter.textContent = `AI refine failed — showing local result instead. (${errMsg})`;
          statusAfter.style.display = '';
        } catch {
          // If even local fails, leave the error message visible
        }
      } finally {
        deepBtn.textContent = 'Deep Refine (API)';
        deepBtn.disabled = false;
        TRACK.refineDeepInProgress = false;
      }
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const ol = document.getElementById('cut-refine-overlay');
      if (ol && ol.style.display !== 'none') {
        hideRefinementOverlay();
        e.stopPropagation();
      }
    }
  });

  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => detectTheme());
  const darkObserver = new MutationObserver(() => detectTheme());
  darkObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
}

function toggleMinimize(): void {
  const w = document.getElementById("cut-widget")!;
  const panel = document.getElementById("cut-panel")!;
  const badge = document.getElementById("cut-badge")!;
  const isMin = w.classList.contains("cut-collapsed");
  if (isMin) {
    w.classList.remove("cut-collapsed");
    w.classList.add("cut-expanded");
    panel.style.display = "block";
    badge.style.display = "none";
  } else {
    w.classList.add("cut-collapsed");
    w.classList.remove("cut-expanded");
    panel.style.display = "none";
    badge.style.display = "flex";
  }
}

// ── Old: UI Update ──
async function updateUI(): Promise<void> {
  checkRefineButton();
  try {
    const result = await sendRuntimeMessage<Record<string, unknown>>({ type: "GET_ALL_DATA" });
    if (!result) return;
    renderUI(result);
  } catch {
    // ignore
  }
}

function findInputEl(): HTMLElement | null {
  const selectors = [
    '[data-testid="user-input"]',
    'div.ProseMirror[contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]'
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el as HTMLElement;
  }
  return null;
}

function getInputText(): string {
  if (!TRACK.inputEl || !document.body.contains(TRACK.inputEl)) {
    TRACK.inputEl = findInputEl();
  }
  if (!TRACK.inputEl) return '';
  return TRACK.inputEl.textContent?.trim() || '';
}

function setInputText(text: string): void {
  if (!TRACK.inputEl) return;
  TRACK.inputEl.textContent = text;
  TRACK.inputEl.dispatchEvent(new InputEvent('input', { bubbles: true }));
  TRACK.inputEl.dispatchEvent(new Event('change', { bubbles: true }));
  
  const range = document.createRange();
  const sel = window.getSelection();
  range.selectNodeContents(TRACK.inputEl);
  range.collapse(false);
  sel?.removeAllRanges();
  sel?.addRange(range);
  TRACK.inputEl.focus();
}

function showRefinementOverlay(result: RefinementResult): void {
  const overlay = document.getElementById('cut-refine-overlay');
  if (!overlay) return;
  overlay.style.display = 'flex';
  
  (document.getElementById('cut-orig-text') as HTMLElement).textContent = result.original;
  (document.getElementById('cut-refined-text') as HTMLElement).textContent = result.refined;
  (document.getElementById('cut-orig-tokens') as HTMLElement).textContent = '~' + result.originalTokenEstimate + ' tokens';
  (document.getElementById('cut-refined-tokens') as HTMLElement).textContent = '~' + result.refinedTokenEstimate + ' tokens';

  const savingsEl = document.getElementById('cut-refine-savings') as HTMLElement;
  const statusEl = document.getElementById('cut-refine-status') as HTMLElement;

  if (result.tokensSaved > 0) {
    savingsEl.textContent = 'Saved ~' + result.tokensSaved + ' tokens (' + result.percentSaved + '%)';
    savingsEl.style.display = '';
    statusEl.style.display = 'none';
  } else {
    savingsEl.style.display = 'none';
    statusEl.textContent = "Already optimal — no changes needed.";
    statusEl.style.display = '';
  }

  TRACK.lastRefinement = result;
}

function hideRefinementOverlay(): void {
  const overlay = document.getElementById('cut-refine-overlay');
  if (overlay) overlay.style.display = 'none';
  const statusEl = document.getElementById('cut-refine-status');
  if (statusEl) statusEl.style.display = 'none';
  TRACK.refineDeepInProgress = false;
}

function checkRefineButton(): void {
  const refineBtn = document.getElementById("cut-refine-btn");
  if (!refineBtn) return;

  if (!TRACK.inputEl || !document.body.contains(TRACK.inputEl)) {
    TRACK.inputEl = findInputEl();
  }

  if (!TRACK.inputEl || !document.body.contains(TRACK.inputEl)) {
    refineBtn.style.display = "none";
    return;
  }

  const text = TRACK.inputEl.textContent?.trim() || "";
  if (text.length > 20) {
    refineBtn.style.display = "block";
    const rect = TRACK.inputEl.getBoundingClientRect();
    refineBtn.style.top = `${rect.top - 34}px`; // 26px height + 8px gap
    refineBtn.style.left = `${rect.left}px`;
  } else {
    refineBtn.style.display = "none";
  }
}

function renderUI(data: Record<string, unknown>): void {
  const get = (id: string) => document.getElementById(id);
  const daily = (data.daily || {}) as Record<string, number>;
  const remaining = (data.remaining || {}) as Record<string, number>;
  const resetIn = data.resetIn as number;
  const resetTimestamp = data.resetTimestamp as number | undefined;
  const settings = (data.settings || {}) as Record<string, unknown>;
  const sessionPct = data.sessionPct as number | null;
  const sessionLimit = data.sessionLimit as number | null;
  const isPeakHours = data.isPeakHours as boolean | undefined;
  const peakHoursTransitionAt = data.peakHoursTransitionAt as number | null | undefined;

  detectTheme(settings.themeMode as string | undefined);

  const msgsUsed = (daily.messagesSent || 0) + (daily.messagesReceived || 0);
  const msgsTotal = sessionLimit || remaining.messagesTotal || 45;
  const msgPct = sessionPct != null ? sessionPct : Math.min(100, Math.round((msgsUsed / msgsTotal) * 100));
  const tokensUsed = (daily.tokensSent || 0) + (daily.tokensReceived || 0);
  const tokensTotal = remaining.tokensTotal || 90000;
  const tokenPct = Math.min(100, Math.round((tokensUsed / tokensTotal) * 100));
  const msgsRemaining = Math.max(0, msgsTotal - msgsUsed);

  const badge = get("cut-badge");
  if (badge) {
    badge.textContent = msgPct >= 100 ? "!" : `${msgPct}%`;
    badge.className = "";
    if (msgPct >= 90) badge.classList.add("danger");
    else if (msgPct >= 60) badge.classList.add("warn");
  }

  const badgeSm = get("cut-badge-sm");
  if (badgeSm) {
    badgeSm.textContent = msgPct >= 100 ? "!" : `${msgPct}%`;
    badgeSm.className = "cut-badge-sm";
    if (msgPct >= 90) badgeSm.classList.add("danger");
    else if (msgPct >= 60) badgeSm.classList.add("warn");
  }

  setNums("cut-msg-nums", msgsUsed, msgsTotal);
  setBar("cut-msg-bar", msgPct);
  setNums("cut-token-nums", tokensUsed, tokensTotal);
  setBar("cut-token-bar", tokenPct);

  const resetEl = get("cut-reset-timer");
  if (resetTimestamp && resetTimestamp > Date.now()) {
    resetEl!.textContent = formatDuration(resetTimestamp - Date.now());
  } else if (resetIn != null && resetIn > 0) {
    resetEl!.textContent = formatDuration(resetIn);
  } else {
    resetEl!.textContent = "--:--:--";
  }

  const peakRow = get("cut-peak-row");
  const peakDot = get("cut-peak-dot");
  const peakMessage = get("cut-peak-message");
  const peakTimer = get("cut-peak-timer");
  if (peakRow && peakDot && peakMessage && peakTimer) {
    const isPeak = isPeakHours === true;
    peakRow.style.display = "";
    peakRow.className = "cut-peak-banner " + (isPeak ? "peak-on" : "peak-off");
    peakDot.className = "cut-peak-dot " + (isPeak ? "peak-on" : "peak-off");
    if (isPeak) {
      peakMessage.textContent = "Peak hours - sessions drain 3-5x faster.";
      peakTimer.textContent = peakHoursTransitionAt
        ? "Off-peak in " + formatDuration(peakHoursTransitionAt - Date.now())
        : "Off-peak time unknown";
    } else {
      peakMessage.textContent = "Off-peak - full speed.";
      peakTimer.textContent = peakHoursTransitionAt
        ? "Peak hours in " + formatDuration(peakHoursTransitionAt - Date.now())
        : "Peak hours time unknown";
    }
  }

  const sentEl = get("cut-sent");
  if (sentEl) sentEl.textContent = formatNum(daily.messagesSent);
  const recvEl = get("cut-recv");
  if (recvEl) recvEl.textContent = formatNum(daily.messagesReceived);
  const remainEl = get("cut-remain");
  if (remainEl) {
    remainEl.textContent = formatNum(msgsRemaining);
    remainEl.className = "cut-stat-value cut-stat-remain";
    if (msgsRemaining < 5) remainEl.classList.add("danger");
    else if (msgsRemaining < 10) remainEl.classList.add("warn");
  }
}


function setNums(id: string, used: number, total: number): void {
  const el = document.getElementById(id);
  if (el) el.textContent = `${formatNum(used)} / ${formatNum(total)}`;
}

function setBar(id: string, pct: number): void {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.width = `${pct}%`;
  el.className = "cut-progress-fill";
  if (pct >= 90) el.classList.add("danger");
  else if (pct >= 60) el.classList.add("warn");
  else el.classList.add("safe");
}

function formatDuration(ms: number): string {
  if (ms <= 0 || !Number.isFinite(ms)) return "00:00:00";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function formatNum(n: number | null | undefined): string {
  if (!n) return "0";
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n);
}

async function fetchConversationFromAPI(
  conversationId: string,
  orgId: string
): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(
      `https://claude.ai/api/organizations/${orgId}/chat_conversations/${conversationId}?tree=True&rendering_mode=messages&render_all_tools=true`,
      { credentials: "include", headers: { "Content-Type": "application/json" } }
    );
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function extractAPIMessageText(msg: Record<string, unknown>): string {
  const parts: string[] = [];
  const content = msg.content;
  if (!Array.isArray(content)) return "";

  for (const block of content) {
    if (typeof block !== "object" || !block) continue;
    const b = block as Record<string, unknown>;

    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    } else if (b.type === "tool_use" && typeof b.name === "string") {
      parts.push(`[Tool: ${b.name}]`);
      if (b.input && typeof b.input === "object") {
        parts.push("```json\n" + JSON.stringify(b.input, null, 2) + "\n```");
      }
    } else if (b.type === "tool_result" && b.content) {
      const toolContent = Array.isArray(b.content) ? b.content : [b.content];
      for (const tc of toolContent) {
        if (typeof tc === "object" && tc !== null && (tc as Record<string, unknown>).type === "tool_use") {
          parts.push(extractAPIMessageText(tc as Record<string, unknown>));
        } else if (typeof tc === "string") {
          parts.push(tc);
        } else if (typeof tc === "object" && tc !== null && typeof (tc as Record<string, unknown>).text === "string") {
          parts.push((tc as Record<string, unknown>).text as string);
        }
      }
    }
  }

  return parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function exportChat(): Promise<{ success: boolean; markdown?: string; title?: string; error?: string }> {
  const url = location.href;
  if (!url.includes("claude.ai") || !url.includes("/chat/")) {
    return { success: false, error: "Not on a chat page" };
  }

  const conversationId = url.match(/\/chat\/([a-f0-9-]+)/)?.[1];
  const orgId = await resolveOrgId();

  // Try API-first: authoritative, gets all messages regardless of virtual DOM
  if (conversationId && orgId) {
    const data = await fetchConversationFromAPI(conversationId, orgId);
    if (data && Array.isArray(data.chat_messages) && data.chat_messages.length > 0) {
      const title = (typeof data.name === "string" && data.name) ||
        TRACK.conversationTitle || extractTitle() || "Claude Chat";
      const timestamp = new Date().toISOString().slice(0, 10);
      const lines: string[] = [`# ${title}`, `*Exported on ${timestamp}*`, ""];

      const chatMessages = data.chat_messages as Record<string, unknown>[];
      for (const msg of chatMessages) {
        const sender = msg.sender === "human" ? "User" : "Claude";
        const text = extractAPIMessageText(msg);
        if (!text) continue;
        lines.push(`**${sender}**: ${text}`, "");
      }

      return { success: true, markdown: lines.join("\n"), title };
    }
  }

  // Fallback: DOM scraping (works without API access)
  const title = TRACK.conversationTitle || extractTitle() || "Claude Chat";
  const timestamp = new Date().toISOString().slice(0, 10);
  const lines: string[] = [`# ${title}`, `*Exported on ${timestamp}*`, ""];

  const domMessages = findDOMExportMessages();
  if (domMessages.length === 0) {
    return { success: false, error: "No messages found" };
  }

  for (const el of domMessages) {
    const role = isUserMessage(el) ? "User" : "Claude";
    const text = extractDOMText(el);
    if (!text) continue;
    lines.push(`**${role}**: ${text}`, "");
  }

  return { success: true, markdown: lines.join("\n"), title };
}

function findDOMExportMessages(): Element[] {
  const selectors = [
    '[data-message-author-role="user"]',
    '[data-message-author-role="assistant"]',
    '[data-testid="user-message"]',
    '[data-testid="assistant-message"]',
    'article[data-testid^="message"]',
    '[data-message-id]',
    'div[class*="message"]',
  ];
  const results: Element[] = [];
  const seen = new Set<string>();
  for (const sel of selectors) {
    for (const el of document.querySelectorAll(sel)) {
      const id = el.getAttribute("data-message-id") || el.getAttribute("data-testid") || el.outerHTML.slice(0, 80);
      if (!seen.has(id)) { seen.add(id); results.push(el); }
    }
  }
  results.sort((a, b) =>
    (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1
  );
  return results;
}

function extractDOMText(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  for (const b of clone.querySelectorAll("button")) b.remove();
  for (const pre of clone.querySelectorAll("pre")) {
    const code = pre.querySelector("code");
    if (code) {
      pre.textContent = "\n```\n" + code.textContent + "\n```\n";
    }
  }
  return clone.textContent?.trim().replace(/\n{3,}/g, "\n\n") ?? "";
}

function handleWidgetExport(): void {
  exportChat().then((result) => {
    if (!result.success || !result.markdown) {
      return;
    }
    downloadFile(result.markdown, result.title ?? "claude-chat", "md");
  });
}

function downloadFile(content: string, name: string, ext: string): void {
  const blob = new Blob([content], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name.replace(/[^a-zA-Z0-9\- ]/g, "").trim()}.${ext}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Message listener (registered immediately, before init completes) ──
try {
  if (chrome.runtime?.id) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      switch (msg.type) {
        case "GET_STATE":
          sendResponse(getState());
          break;
        case "WEBREQUEST_QUOTA":
          handleNetworkQuota(msg.quota);
          break;
        case "BG_USAGE_PUSH":
          // Background proactively fetched /usage and is pushing it to us
          handleBgUsagePush(msg.data, msg.orgId);
          break;
        case "MANUAL_SCAN":
          runDetection("manual");
          sendResponse(getState());
          break;
        case "EXPORT_CHAT":
          exportChat().then(sendResponse);
          return true;
      }
    });
  }
} catch {
  // Extension context was invalidated before listener registration.
}

// ── Page-context watcher events ──
// The injected script (entry-injector.ts at document_start) wraps fetch in the
// page's main world and dispatches CustomEvent('cut-quota') when it detects
// Claude quota fields in SSE streams or JSON responses.
window.addEventListener("cut-quota", ((e: CustomEvent) => {
  const data = e.detail;
  if (!data || typeof data !== "object") return;
  const quota = mapEventToQuota(data);
  if (quota) {
    handleNetworkQuota(quota);
    // Immediately refresh from the authoritative /usage endpoint —
    // the cut-quota event fires mid-stream so this runs within milliseconds
    // of Claude sending its first quota field in the response.
    fetchUsageFromAPI();
  }
}) as EventListener);

function mapEventToQuota(data: Record<string, unknown>): import("./backend/types").NetworkQuota | null {
  const quota: import("./backend/types").NetworkQuota = {};
  let found = false;

  if (data.message_limit && typeof data.message_limit === "object") {
    const ml = data.message_limit as Record<string, unknown>;
    if (ml.resetsAt || ml.resets_at) {
      const ts = new Date(String(ml.resetsAt ?? ml.resets_at)).getTime();
      if (!isNaN(ts)) { quota.reset = ts; quota.remaining = 0; found = true; }
    }
    const mlType = String(ml.type || "").toLowerCase();
    if (mlType === "maxed") {
      quota.limitType = "hard";
      if (quota.reset) quota.hardLimitResetAt = quota.reset;
    } else if (mlType === "within_5hour_window") {
      quota.limitType = "soft";
    }
  }

  if (data.usage_metadata && typeof data.usage_metadata === "object") {
    const um = data.usage_metadata as Record<string, unknown>;
    if (typeof um.remaining_messages === "number") {
      quota.remaining = um.remaining_messages; found = true;
    }
    if (typeof um.message_limit === "number") {
      quota.limit = um.message_limit; found = true;
    }
    const resetKey = um.window_reset_at || um.resets_at || um.reset_at;
    if (resetKey) {
      const ts = new Date(String(resetKey)).getTime();
      if (!isNaN(ts)) { quota.reset = ts; found = true; }
    }
  }

  return found ? quota : null;
}

// ── Start ──
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
