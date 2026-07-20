/**
 * Content script entry point (thin bootstrap).
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

import { initState, getState, onChange, startCountdownTicker } from "./backend/state-manager";
import { runDetection, handleNetworkQuota, startPeriodicScan, estimateUsage } from "./backend/tracker";
import { interceptFetch, interceptXHR, setOnOrgIdDetected, notifyOrgIdFromWatcher } from "./backend/network-monitor";

import { TRACK } from "./content-script/state";
import { sendRuntimeMessage, resolveOrgId, fetchPlanInfo } from "./content-script/org-id";
import { setInPageWidgetVisible, detectTheme, updateUI } from "./content-script/ui-widget";
import { refreshUsageAndUI, setOnUIUpdate as setUsageUIUpdate } from "./content-script/usage-api";
import { checkPeakHours } from "./content-script/peak-hours";
import { processPage, startObserver, checkUrlChange, onUrlChanged, ensureSession } from "./content-script/message-scanner";
import { setTokenEstimationDivisor } from "./content-script/message-scanner";
import { initComposerRefiner } from "./content-script/composer-refiner";
import "./content-script/message-listener";
import { POLLING } from './config';

// ── Init ──
const cleanupFns: (() => void)[] = [];
let initialized = false;

async function init(): Promise<void> {
  if (initialized) return;
  initialized = true;

  await initState();

  cleanupFns.push(interceptFetch((quota) => handleNetworkQuota(quota)));
  cleanupFns.push(interceptXHR((quota) => handleNetworkQuota(quota)));

  runDetection("navigation");

  cleanupFns.push(startPeriodicScan(POLLING.scan));

  checkPeakHours();
  const peakInterval = setInterval(checkPeakHours, POLLING.peakCheck);
  cleanupFns.push(() => clearInterval(peakInterval));

  startCountdownTicker();

  onChange((newState) => {
    void sendRuntimeMessage({ type: "STATE_UPDATE", state: newState });
  });

  const initialSettings = await sendRuntimeMessage<any>({ type: "GET_SETTINGS" }) ?? {};

  // Wire token estimation method from settings
  const tokenMethod: string = (initialSettings as any)?.tokenEstimationMethod ?? 'chars/4';
  const divisorStr = tokenMethod.split('/')[1];
  const tokenDivisor = parseFloat(divisorStr);
  if (!isNaN(tokenDivisor) && tokenDivisor > 0) {
    setTokenEstimationDivisor(tokenDivisor);
  }

  setInPageWidgetVisible(initialSettings?.showInPageWidget !== false);


  const onSettingsChanged = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
    if (areaName !== "local" || !changes.settings) return;
    const nextSettings = (changes.settings.newValue || {}) as { showInPageWidget?: boolean; themeMode?: string };
    setInPageWidgetVisible(nextSettings.showInPageWidget !== false);
    if (nextSettings.themeMode) detectTheme(nextSettings.themeMode);
  };
  chrome.storage.onChanged.addListener(onSettingsChanged);
  cleanupFns.push(() => chrome.storage.onChanged.removeListener(onSettingsChanged));

  processPage();
  startObserver();

  TRACK.urlCheckInterval = setInterval(checkUrlChange, 1000);
  window.addEventListener("popstate", onUrlChanged);
  ensureSession();

  const existingMsgs = TRACK.lastUserCount + TRACK.lastAssistantCount;
  if (existingMsgs > 0 && !getState().resetTimestamp) {
    if (initialSettings) {
      const limit = initialSettings?.limits?.dailyMessages ?? 45;
      const windowMs = initialSettings?.limits?.sessionWindowMs ?? 5 * 60 * 60 * 1000;
      estimateUsage(TRACK.lastUserCount, TRACK.lastAssistantCount, limit, windowMs);
    }
  }

  void refreshUsageAndUI(true);

  void sendRuntimeMessage({ type: "CONTENT_SCRIPT_READY" });

  const orgIdForPlan = resolveOrgId();
  orgIdForPlan.then((oid) => { if (oid) fetchPlanInfo(oid); });

  let _fastRetryActive = true;
  const usageApiInterval = setInterval(() => { 
    if (!_fastRetryActive && document.visibilityState === 'visible' && TRACK.sessionStarted) {
      void refreshUsageAndUI(false); 
    }
  }, POLLING.usageNormal);
  cleanupFns.push(() => clearInterval(usageApiInterval));
  const fastRetryInterval = setInterval(() => {
    void refreshUsageAndUI(false);
  }, POLLING.usageFastRetry);
  const fastRetryTimer = setTimeout(() => {
    _fastRetryActive = false;
    clearInterval(fastRetryInterval);
    resolveOrgId().then((id) => {
      if (!id) console.debug("[CUT] orgId not detected after 30s — waiting for user to open a conversation.");
    });
  }, POLLING.usageFastRetryWindow);
  cleanupFns.push(() => { clearTimeout(fastRetryTimer); clearInterval(fastRetryInterval); });

  setOnOrgIdDetected((orgId) => {
    void refreshUsageAndUI(true, orgId);
    fetchPlanInfo(orgId);
  });

  const pendingQuota = await sendRuntimeMessage({ type: "GET_WEBREQUEST_QUOTA" });
  if (pendingQuota) handleNetworkQuota(pendingQuota);

  {
    const staleOrgId = (window as any).__cutLastCompletionOrgId as string | undefined;
    const staleTs = (window as any).__cutCompletionTimestamp as number | undefined;
    if (staleOrgId && staleTs && Date.now() - staleTs < 30_000) {
      console.debug("[CUT] Recovering missed completion event, orgId:", staleOrgId);
      notifyOrgIdFromWatcher(staleOrgId);
      void refreshUsageAndUI(true, staleOrgId);
    }
  }

  TRACK.uiUpdateInterval = setInterval(updateUI, POLLING.uiUpdate);

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

  initComposerRefiner();
}

// Wire up UI update callback for usage-api
setUsageUIUpdate(updateUI);

// ── Start ──
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
