import { sendRuntimeMessage } from "./org-id";
import { formatDuration, formatNum } from "./ui-widget";

const COMPOSER_SELECTORS = [
  '[data-testid="composer"]',
  'div.ProseMirror[contenteditable="true"]',
  'div[contenteditable="true"][role="textbox"]',
];

let injected = false;
let cleanupFns: (() => void)[] = [];
let domObserver: MutationObserver | null = null;
let locationCheckInterval: ReturnType<typeof setInterval> | null = null;

function findComposerEl(): HTMLElement | null {
  for (const sel of COMPOSER_SELECTORS) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) return el;
  }
  return null;
}

function findBottomBar(composerEl: HTMLElement): HTMLElement | null {
  let el = composerEl.parentElement;
  let attempts = 0;
  while (el && attempts < 8) {
    if (typeof el.className === 'string' && el.className.includes('max-w-')) {
      return el.parentElement;
    }
    const style = getComputedStyle(el);
    if (style.maxWidth && style.maxWidth !== 'none' && !style.maxWidth.includes('%')) {
      const mw = parseFloat(style.maxWidth);
      if (mw > 0 && mw < 1500) return el.parentElement;
    }
    el = el.parentElement;
    attempts++;
  }
  
  el = composerEl;
  for (let i = 0; i < 4; i++) {
    if (el.parentElement) el = el.parentElement;
  }
  return el;
}

function isConversationPage(): boolean {
  return /^\/chat\//.test(location.pathname) || /^\/project\//.test(location.pathname);
}

function injectIntegratedUI(data: Record<string, unknown>): void {
  if (document.getElementById("cut-integrated-left") || document.getElementById("cut-integrated-right")) return;

  const composerEl = findComposerEl();
  if (!composerEl) return;

  const bottomBar = findBottomBar(composerEl);
  if (!bottomBar) return;

  const daily = (data.daily || {}) as Record<string, number>;
  const remaining = (data.remaining || {}) as Record<string, number>;
  const sessionPct = data.sessionPct as number | null;
  const sessionLimit = data.sessionLimit as number | null;
  const sessionMessagesUsed = data.sessionMessagesUsed as number | null;
  const remainingMessages = data.remaining ? (data.remaining as Record<string, number>).messages : null;
  const isPeakHours = data.isPeakHours as boolean | undefined;
  const peakHoursTransitionAt = data.peakHoursTransitionAt as number | null | undefined;
  const resetTimestamp = data.resetTimestamp as number | undefined;
  const resetIn = data.resetIn as number;
  const source = data.source as string | undefined;
  const weeklyUsage = data.weeklyUsage as Record<string, unknown> | undefined;
  const msgsTotal = sessionLimit ?? remaining.messagesTotal ?? null;
  const msgsUsedFromDaily = (daily.messagesSent || 0) + (daily.messagesReceived || 0);
  const msgsUsed = sessionMessagesUsed ?? msgsUsedFromDaily;
  const hasLimits = msgsTotal !== null && msgsTotal > 0;
  const msgPct = hasLimits && sessionPct != null
    ? sessionPct
    : hasLimits
    ? Math.min(100, Math.round((msgsUsed / msgsTotal) * 100))
    : 0;
  const msgsRemainingRaw = hasLimits ? (remainingMessages ?? Math.max(0, msgsTotal - msgsUsed)) : null;
  const msgsRemaining = msgsRemainingRaw !== null ? Math.max(0, msgsRemainingRaw) : null;

  const leftEl = document.createElement("div");
  leftEl.id = "cut-integrated-left";
  leftEl.className = !hasLimits ? "cut-integrated-panel cut-loading" : "cut-integrated-panel";
  leftEl.innerHTML = `
    <div class="cut-int-gauge-wrap">
      <div class="cut-int-gauge" id="cut-int-gauge">${hasLimits ? `${msgPct}%` : "--%"}</div>
      <div class="cut-int-gauge-label">Session used</div>
    </div>
    <div class="cut-int-stat">
      <span class="cut-int-stat-lbl">Reset</span>
      <span class="cut-int-stat-val" id="cut-int-reset-timer">${resetTimestamp && resetTimestamp > Date.now() ? formatDuration(resetTimestamp - Date.now()) : resetIn > 0 ? formatDuration(resetIn) : "--:--:--"}</span>
    </div>
    <div class="cut-int-stat">
      <span class="cut-int-stat-lbl">Source</span>
      <span class="cut-int-stat-val cut-int-source" id="cut-int-source">${source || "—"}</span>
    </div>
  `;

  const rightEl = document.createElement("div");
  rightEl.id = "cut-integrated-right";
  rightEl.className = !hasLimits ? "cut-integrated-panel cut-loading" : "cut-integrated-panel";
  rightEl.innerHTML = `
    <div class="cut-int-status-row">
      <span class="cut-int-peak-dot ${isPeakHours ? "peak-on" : "peak-off"}" id="cut-int-peak-dot"></span>
      <span class="cut-int-peak-text" id="cut-int-peak-text">${isPeakHours ? "Peak hours" : "Off-peak"}</span>
      <span class="cut-int-peak-timer" id="cut-int-peak-timer">${peakHoursTransitionAt ? formatDuration(peakHoursTransitionAt - Date.now()) : ""}</span>
    </div>
    <div class="cut-int-stat">
      <span class="cut-int-stat-lbl">Messages left</span>
      <span class="cut-int-stat-val" id="cut-int-remaining">${msgsRemaining !== null ? formatNum(msgsRemaining) : "--"}</span>
    </div>
    <div class="cut-int-bar-section">
      <div class="cut-int-bar-row">
        <span class="cut-int-bar-lbl">Week</span>
        <div class="cut-int-bar-track">
          <div class="cut-int-bar-fill safe" id="cut-int-week-bar" style="width:${weeklyUsage?.usagePercent != null ? weeklyUsage.usagePercent : 0}%"></div>
        </div>
      </div>
    </div>
  `;

  bottomBar.style.position = "relative";
  bottomBar.style.display = "flex";
  bottomBar.style.flexDirection = "row";
  bottomBar.style.alignItems = "center";
  bottomBar.style.justifyContent = "center";

  let composerWrapper = composerEl;
  while (composerWrapper.parentElement && composerWrapper.parentElement !== bottomBar) {
    composerWrapper = composerWrapper.parentElement;
  }

  if (composerWrapper) {
    composerWrapper.style.flex = "0 1 auto";
    composerWrapper.style.width = "100%";
    composerWrapper.style.maxWidth = "min(48rem, 100%)";
  }

  bottomBar.insertBefore(leftEl, bottomBar.firstChild);
  bottomBar.appendChild(rightEl);

  cleanupFns.push(() => {
    leftEl.remove();
    rightEl.remove();
    if (composerWrapper) {
      composerWrapper.style.flex = "";
      composerWrapper.style.width = "";
      composerWrapper.style.maxWidth = "";
    }
  });
  injected = true;
}

function removeIntegratedUI(): void {
  cleanupFns.forEach((fn) => fn());
  cleanupFns = [];
  injected = false;
}

async function fetchAndRender(): Promise<void> {
  try {
    const result = await sendRuntimeMessage<Record<string, unknown>>({ type: "GET_ALL_DATA" });
    if (!result) return;
    renderIntegratedUI(result);
  } catch {
  }
}

function renderIntegratedUI(data: Record<string, unknown>): void {
  const leftEl = document.getElementById("cut-integrated-left");
  const rightEl = document.getElementById("cut-integrated-right");
  if (!leftEl || !rightEl) return;

  const daily = (data.daily || {}) as Record<string, number>;
  const remaining = (data.remaining || {}) as Record<string, number>;
  const sessionPct = data.sessionPct as number | null;
  const sessionLimit = data.sessionLimit as number | null;
  const sessionMessagesUsed = data.sessionMessagesUsed as number | null;
  const remainingMessages = data.remaining ? (data.remaining as Record<string, number>).messages : null;
  const isPeakHours = data.isPeakHours as boolean | undefined;
  const peakHoursTransitionAt = data.peakHoursTransitionAt as number | null | undefined;
  const resetTimestamp = data.resetTimestamp as number | undefined;
  const resetIn = data.resetIn as number;
  const source = data.source as string | undefined;
  const weeklyUsage = data.weeklyUsage as Record<string, unknown> | undefined;
  const msgsTotal = sessionLimit ?? remaining.messagesTotal ?? null;
  const msgsUsedFromDaily = (daily.messagesSent || 0) + (daily.messagesReceived || 0);
  const msgsUsed = sessionMessagesUsed ?? msgsUsedFromDaily;
  const hasLimits = msgsTotal !== null && msgsTotal > 0;
  const msgPct = hasLimits && sessionPct != null
    ? sessionPct
    : hasLimits
    ? Math.min(100, Math.round((msgsUsed / msgsTotal) * 100))
    : 0;
  const msgsRemainingRaw = hasLimits ? (remainingMessages ?? Math.max(0, msgsTotal - msgsUsed)) : null;
  const msgsRemaining = msgsRemainingRaw !== null ? Math.max(0, msgsRemainingRaw) : null;

  leftEl.classList.toggle("cut-loading", !hasLimits);
  rightEl.classList.toggle("cut-loading", !hasLimits);

  const gauge = document.getElementById("cut-int-gauge");
  if (gauge) gauge.textContent = !hasLimits ? "--%" : `${msgPct}%`;

  const resetEl = document.getElementById("cut-int-reset-timer");
  if (resetEl) {
    if (resetTimestamp && resetTimestamp > Date.now()) {
      resetEl.textContent = formatDuration(resetTimestamp - Date.now());
    } else if (resetIn > 0) {
      resetEl.textContent = formatDuration(resetIn);
    } else {
      resetEl.textContent = "--:--:--";
    }
  }

  const sourceEl = document.getElementById("cut-int-source");
  if (sourceEl) sourceEl.textContent = source || "—";

  const peakDot = document.getElementById("cut-int-peak-dot");
  const peakText = document.getElementById("cut-int-peak-text");
  const peakTimer = document.getElementById("cut-int-peak-timer");
  if (peakDot && peakText && peakTimer) {
    const isPeak = isPeakHours === true;
    peakDot.className = "cut-int-peak-dot " + (isPeak ? "peak-on" : "peak-off");
    peakText.textContent = isPeak ? "Peak hours" : "Off-peak";
    peakTimer.textContent = peakHoursTransitionAt
      ? formatDuration(peakHoursTransitionAt - Date.now())
      : "";
  }

  const remainEl = document.getElementById("cut-int-remaining");
  if (remainEl) {
    remainEl.textContent = msgsRemaining !== null ? formatNum(msgsRemaining) : "--";
  }

  const weekBar = document.getElementById("cut-int-week-bar");
  if (weekBar) {
    const wp = weeklyUsage?.usagePercent as number | undefined;
    weekBar.style.width = `${wp != null ? Math.min(100, wp) : 0}%`;
    weekBar.className = "cut-int-bar-fill";
    if (wp != null && wp >= 90) weekBar.classList.add("danger");
    else if (wp != null && wp >= 60) weekBar.classList.add("warn");
    else weekBar.classList.add("safe");
  }
}

function findAndInject(): void {
  if (!isConversationPage()) return;
  if (injected) return;

  const composerEl = findComposerEl();
  if (!composerEl) return;

  fetchAndRender().then(() => {
    injectIntegratedUI({});
  });
}

let injectionTimeout: ReturnType<typeof setTimeout> | null = null;

function startComposerObserver(): void {
  if (domObserver) domObserver.disconnect();
  if (injectionTimeout) clearTimeout(injectionTimeout);

  domObserver = new MutationObserver(() => {
    if (!injected && isConversationPage()) {
      findAndInject();
    }
  });
  domObserver.observe(document.body, { childList: true, subtree: true });

  injectionTimeout = setTimeout(() => {
    if (!injected && domObserver) {
      domObserver.disconnect();
      domObserver = null;
    }
  }, 10000);
}

function startLocationCheck(): void {
  if (locationCheckInterval) clearInterval(locationCheckInterval);
  let lastUrl = location.href;

  locationCheckInterval = setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;

      if (isConversationPage()) {
        removeIntegratedUI();
        findAndInject();
        startComposerObserver();
      } else {
        removeIntegratedUI();
      }
    }
  }, 1000);
}

export function initIntegratedLayout(): void {
  findAndInject();
  startComposerObserver();
  startLocationCheck();
}

export function updateIntegratedUI(): void {
  if (!injected) return;
  void fetchAndRender();
}

export function destroyIntegratedLayout(): void {
  removeIntegratedUI();
  if (domObserver) {
    domObserver.disconnect();
    domObserver = null;
  }
  if (injectionTimeout) {
    clearTimeout(injectionTimeout);
    injectionTimeout = null;
  }
  if (locationCheckInterval) {
    clearInterval(locationCheckInterval);
    locationCheckInterval = null;
  }
}
