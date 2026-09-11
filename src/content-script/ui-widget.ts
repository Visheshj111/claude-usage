import { sendRuntimeMessage, getRuntimeUrl } from "./org-id";
import { lastMessageStats } from "./state";
import { runDetection } from "../backend/tracker";
import { URLS } from '../config';

export async function injectStyles(): Promise<void> {
  if (document.getElementById("cut-style")) return;
  // If native manifest CSS worked, the container will have fixed positioning.
  const container = document.getElementById("cut-container");
  if (container && getComputedStyle(container).position === "fixed") return;

  const stylesheetUrl = getRuntimeUrl("dist/inpage/inpage.css");
  if (!stylesheetUrl) return;
  
  try {
    const res = await fetch(stylesheetUrl);
    const cssText = await res.text();
    const style = document.createElement("style");
    style.id = "cut-style";
    style.textContent = cssText;
    
    // Claude.ai uses strict CSP. Copy nonce if available.
    const nonceEl = document.querySelector('[nonce]') as HTMLElement;
    if (nonceEl && nonceEl.nonce) {
      style.setAttribute("nonce", nonceEl.nonce);
    }
    
    document.head.appendChild(style);
  } catch (e) {
    console.debug("[CUT] CSS injection fallback failed", e);
  }
}

export function injectUI(): void {
  if (document.getElementById("cut-container")) return;

  const container = document.createElement("div");
  container.id = "cut-container";
  document.body.appendChild(container);

  detectTheme();

  container.innerHTML = `
    <div id="cut-widget">
      <div id="cut-badge">—</div>
      <div id="cut-panel" class="cut-loading">
        <div class="cut-panel-header">
          <span class="cut-header-label">Claude Usage</span>
          <div class="cut-panel-actions">
            <span class="cut-badge-sm" id="cut-badge-sm">—</span>
            <span id="cut-force-reload" class="cut-header-btn" title="Reload usage">↻</span>
            <span id="cut-export" class="cut-header-btn cut-text-btn" title="Export">⎋ Export</span>
            <span id="cut-open-settings" class="cut-header-btn cut-text-btn" title="Settings">⚙ Settings</span>
            <span id="cut-toggle-min" class="cut-header-btn" title="Minimize">–</span>
            <span id="cut-close" class="cut-header-btn" title="Close">×</span>
          </div>
        </div>

        <div class="cut-peak-banner" id="cut-peak-row">
          <div class="cut-peak-main">
            <span class="cut-peak-dot" id="cut-peak-dot"></span>
            <span class="cut-peak-status" id="cut-peak-message">Checking...</span>
            <span class="cut-peak-countdown" id="cut-peak-timer">--:--:--</span>
          </div>
        </div>

        <div class="cut-section w-prog-section">
          <div class="cut-progress-row">
            <span class="cut-progress-label">Session</span>
            <div class="cut-progress-bar-wrap">
              <div class="cut-progress-bar">
                <div class="cut-progress-fill safe" id="cut-msg-bar"></div>
              </div>
              <span class="cut-progress-nums" id="cut-msg-nums">—</span>
            </div>
          </div>
          <div class="cut-progress-row">
            <span class="cut-progress-label">Tokens</span>
            <div class="cut-progress-bar-wrap">
              <div class="cut-progress-bar">
                <div class="cut-progress-fill safe" id="cut-token-bar"></div>
              </div>
              <span class="cut-progress-nums" id="cut-token-nums">—</span>
            </div>
          </div>
        </div>

        <div class="cut-stat-grid w-stat-grid">
          <div class="cut-stat-cell">
            <span class="cut-stat-value" id="cut-sent">—</span>
            <span class="cut-stat-label">Sent</span>
          </div>
          <div class="cut-stat-cell">
            <span class="cut-stat-value" id="cut-recv">—</span>
            <span class="cut-stat-label">Recv</span>
          </div>
          <div class="cut-stat-cell">
            <span class="cut-stat-value cut-stat-remain" id="cut-remain">—</span>
            <span class="cut-stat-label">Remain</span>
          </div>
        </div>

        <div class="cut-ctx-row" id="cut-ctx-row" style="display:none">
          <span class="cut-ctx-item"><span class="cut-ctx-label">Length</span><span class="cut-ctx-value" id="cut-ctx-length">—</span></span>
          <span class="cut-ctx-sep">·</span>
          <span class="cut-ctx-item"><span class="cut-ctx-label">Cost</span><span class="cut-ctx-value" id="cut-ctx-cost">—</span></span>
          <span class="cut-ctx-sep">·</span>
          <span class="cut-ctx-item"><span class="cut-ctx-label">Cached</span><span class="cut-ctx-value" id="cut-ctx-cached">—</span></span>
        </div>

        <div class="cut-footer-row w-foot">
          <span class="cut-reset-label">Resets <strong class="cut-reset-time" id="cut-reset-timer">--:--:--</strong></span>
          <span class="cut-details-link" id="cut-open-popup">Dashboard →</span>
        </div>

        <div class="cut-ratelimit-row" id="cut-ratelimit-row" style="display:none">
          <span>Rate limited · Cooldown: <strong id="cut-cooldown-timer">--:--:--</strong></span>
        </div>
      </div>
    </div>
  `;

  attachUIEvents();

  chrome.storage.local.get('review_dismissed').then((res) => {
    if (!res.review_dismissed) {
      const reviewPopup = document.createElement('div');
      reviewPopup.id = 'cut-review-popup';
      reviewPopup.innerHTML = `
        <div class="cut-review-content">
          <span>Enjoying Claude Usage Tracker?</span>
          <a href="${URLS.reviewPage}" target="_blank" class="cut-review-btn">Give us a review ★</a>
        </div>
        <button id="cut-review-close" title="Dismiss">×</button>
      `;
      document.body.appendChild(reviewPopup);

      document.getElementById('cut-review-close')?.addEventListener('click', () => {
        reviewPopup.remove();
        chrome.storage.local.set({ review_dismissed: true });
      });
      reviewPopup.querySelector('.cut-review-btn')?.addEventListener('click', () => {
        reviewPopup.remove();
        chrome.storage.local.set({ review_dismissed: true });
      });
      detectTheme();
    }
  });
}

export function removeInPageUI(): void {
  document.getElementById("cut-container")?.remove();
  document.getElementById("cut-review-popup")?.remove();
}

export function setInPageWidgetVisible(visible: boolean): void {
  if (visible) {
    void injectStyles();
    injectUI();
    updateUI();
  } else {
    removeInPageUI();
  }
}

export function detectTheme(mode?: string): void {
  const container = document.getElementById("cut-container");
  if (!container) return;
  let isDark: boolean;
  if (mode === "dark") isDark = true;
  else if (mode === "light") isDark = false;
  else isDark = document.documentElement.classList.contains("dark")
    || window.matchMedia("(prefers-color-scheme: dark)").matches;
  container.classList.toggle("cut-dark", isDark);
  document.getElementById("cut-review-popup")?.classList.toggle("cut-dark", isDark);
}

export function attachUIEvents(): void {
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
    try {
      if (chrome.runtime?.id) chrome.runtime.sendMessage({ type: "OPEN_DASHBOARD" });
    } catch {
    }
  });
  get("cut-open-settings")?.addEventListener("click", () => {
    try {
      if (chrome.runtime?.id) chrome.runtime.openOptionsPage();
    } catch {
    }
  });
  get("cut-export")?.addEventListener("click", () => {
    import("./chat-export").then((mod) => mod.handleWidgetExport());
  });
  get("cut-force-reload")?.addEventListener("click", async () => {
    const btn = get("cut-force-reload");
    if (btn) {
      btn.style.transition = 'transform 0.2s ease';
      btn.style.transform = 'rotate(180deg)';
    }
    runDetection("manual");
    const { refreshUsageAndUI } = await import("./usage-api");
    await refreshUsageAndUI(true);
    if (btn) {
      setTimeout(() => { btn.style.transform = ''; }, 200);
    }
  });

  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => detectTheme());
  const darkObserver = new MutationObserver(() => detectTheme());
  darkObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
}

export function toggleMinimize(): void {
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

export async function updateUI(): Promise<void> {
  try {
    const result = await sendRuntimeMessage<Record<string, unknown>>({ type: "GET_ALL_DATA" });
    if (!result) return;
    renderUI(result);
  } catch {
  }
}

export function renderUI(data: Record<string, unknown>): void {
  // Remove loading state on first real render
  document.getElementById('cut-panel')?.classList.remove('cut-loading');
  const get = (id: string) => document.getElementById(id);
  const daily = (data.daily || {}) as Record<string, number>;
  const remaining = (data.remaining || {}) as Record<string, number>;
  const resetIn = data.resetIn as number;
  const resetTimestamp = data.resetTimestamp as number | undefined;
  const settings = (data.settings || {}) as Record<string, unknown>;
  const sessionPct = data.sessionPct as number | null;
  const sessionLimit = data.sessionLimit as number | null;
  const sessionMessagesUsed = data.sessionMessagesUsed as number | null;
  const remainingMessages = data.remaining ? (data.remaining as Record<string, number>).messages : null;
  const isPeakHours = data.isPeakHours as boolean | undefined;
  const peakHoursTransitionAt = data.peakHoursTransitionAt as number | null | undefined;

  detectTheme(settings.themeMode as string | undefined);

  const msgsTotal = sessionLimit || remaining.messagesTotal || null;
  const msgsUsedFromDaily = (daily.messagesSent || 0) + (daily.messagesReceived || 0);
  const msgsUsed = sessionMessagesUsed ?? msgsUsedFromDaily;
  const msgPct = sessionPct != null ? sessionPct : msgsTotal ? Math.min(100, Math.round((msgsUsed / msgsTotal) * 100)) : 0;
  const tokensUsed = (daily.tokensSent || 0) + (daily.tokensReceived || 0);
  const tokensTotal = remaining.tokensTotal || null;
  const tokenPct = tokensTotal ? Math.min(100, Math.round((tokensUsed / tokensTotal) * 100)) : 0;
  const msgsRemainingRaw = remainingMessages ?? (msgsTotal !== null ? Math.max(0, msgsTotal - msgsUsed) : null);
  const msgsRemaining = msgsRemainingRaw !== null ? Math.max(0, msgsRemainingRaw) : null;

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

  if (msgsTotal !== null) {
    setNums("cut-msg-nums", msgsUsed, msgsTotal);
  } else {
    const el = document.getElementById("cut-msg-nums");
    if (el) el.textContent = '—';
  }
  setBar("cut-msg-bar", msgPct);
  if (tokensTotal !== null) {
    setNums("cut-token-nums", tokensUsed, tokensTotal);
  } else {
    const el = document.getElementById("cut-token-nums");
    if (el) el.textContent = '—';
  }
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
      peakMessage.textContent = "Peak";
      peakTimer.textContent = peakHoursTransitionAt
        ? "Off-peak in " + formatDuration(peakHoursTransitionAt - Date.now())
        : "";
    } else {
      peakMessage.textContent = "Off-peak";
      peakTimer.textContent = peakHoursTransitionAt
        ? "Peak in " + formatDuration(peakHoursTransitionAt - Date.now())
        : "";
    }
  }

  const sentEl = get("cut-sent");
  if (sentEl) sentEl.textContent = formatNum(daily.messagesSent);
  const recvEl = get("cut-recv");
  if (recvEl) recvEl.textContent = formatNum(daily.messagesReceived);
  const remainEl = get("cut-remain");
  if (remainEl) {
    remainEl.textContent = msgsRemaining !== null ? formatMsgCount(msgsRemaining) : '—';
    remainEl.className = "cut-stat-value cut-stat-remain";
    if (msgsRemaining !== null && msgsRemaining < 5) remainEl.classList.add("danger");
    else if (msgsRemaining !== null && msgsRemaining < 10) remainEl.classList.add("warn");
  }

  const ctxRow = get("cut-ctx-row");
  if (ctxRow && lastMessageStats) {
    const s = lastMessageStats;
    const totalToks = s.totalTokens;
    const cachedToks = s.cacheReadTokens;
    const cachedPct = totalToks > 0 ? Math.round((cachedToks / totalToks) * 100) : 0;

    ctxRow.style.display = "";
    const lenEl = get("cut-ctx-length");
    const costEl = get("cut-ctx-cost");
    const cachedEl = get("cut-ctx-cached");
    if (lenEl) lenEl.textContent = formatNum(totalToks) + " tok";
    if (costEl) costEl.textContent = formatNum(Math.round(totalToks * 0.003)) + " cr";
    if (cachedEl) cachedEl.textContent = cachedPct > 0 ? cachedPct + "% cached" : "0%";
  } else if (ctxRow && !lastMessageStats) {
    ctxRow.style.display = "none";
  }
}

export function setNums(id: string, used: number, total: number): void {
  const el = document.getElementById(id);
  if (el) el.textContent = `${formatNum(used)} / ${formatNum(total)}`;
}

export function setBar(id: string, pct: number): void {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.width = `${pct}%`;
  el.className = "cut-progress-fill";
  if (pct >= 90) el.classList.add("danger");
  else if (pct >= 60) el.classList.add("warn");
  else el.classList.add("safe");
}

export function formatDuration(ms: number): string {
  if (ms <= 0 || !Number.isFinite(ms)) return "00:00:00";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function formatNum(n: number | null | undefined): string {
  if (n == null || isNaN(n as number)) return "0";
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return Math.round(n).toLocaleString();
  return String(Math.round(n));
}

export function formatMsgCount(n: number): string {
  if (n <= 0) return "0";
  if (n >= 1000) return Math.round(n).toLocaleString();
  const rounded = Math.round(n * 10) / 10;
  return rounded % 1 === 0 ? String(rounded) : rounded.toFixed(1);
}
