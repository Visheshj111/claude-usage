export {};

const _themeMedia = window.matchMedia('(prefers-color-scheme: dark)');
let _themeMode = 'auto';

document.addEventListener('DOMContentLoaded', () => {
  initPrivacy();

  _themeMedia.addEventListener('change', () => {
    if (_themeMode === 'auto') applyPopupTheme('auto');
  });

  document.getElementById('privacy-accept-btn')?.addEventListener('click', acceptPrivacy);

  document.getElementById('dashboard-btn')?.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('dist/dashboard/dashboard.html') });
  });

  document.getElementById('settings-btn')?.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  document.getElementById('reset-btn')?.addEventListener('click', async () => {
    if (confirm('Clear all tracked usage data?')) {
      await chrome.runtime.sendMessage({ type: 'RESET_USAGE' });
      render();
    }
  });

  document.getElementById('export-btn')?.addEventListener('click', handleExport);

  document.getElementById('show-privacy-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    showPrivacyScreen();
  });
});

let _privacyRenderTimer: ReturnType<typeof setInterval> | null = null;

function applyPopupTheme(themeMode: string): void {
  _themeMode = themeMode || 'auto';
  localStorage.setItem('themeMode', _themeMode);
  const isDark = _themeMode === 'dark' ||
    (_themeMode === 'auto' && _themeMedia.matches);
  document.documentElement.classList.toggle('dark', isDark);
}

async function initPrivacy(): Promise<void> {
  const { privacyAccepted } = await chrome.storage.local.get('privacyAccepted');
  if (privacyAccepted) {
    showMainContent();
  } else {
    showPrivacyScreen();
  }
}

function showPrivacyScreen(): void {
  const privacyScreen = document.getElementById('privacy-screen');
  const mainContent = document.getElementById('main-content');
  if (privacyScreen) privacyScreen.style.display = '';
  if (mainContent) mainContent.style.display = 'none';
  if (_privacyRenderTimer) {
    clearInterval(_privacyRenderTimer);
    _privacyRenderTimer = null;
  }
}

async function acceptPrivacy(): Promise<void> {
  await chrome.storage.local.set({ privacyAccepted: true });
  showMainContent();
}

function showMainContent(): void {
  const privacyScreen = document.getElementById('privacy-screen');
  const mainContent = document.getElementById('main-content');
  if (privacyScreen) privacyScreen.style.display = 'none';
  if (mainContent) mainContent.style.display = '';
  render();
  if (!_privacyRenderTimer) {
    _privacyRenderTimer = setInterval(render, 1000);
  }
}

async function render(): Promise<void> {
  const result = await chrome.runtime.sendMessage({ type: 'GET_ALL_DATA' });
  if (!result) return;

  const {
    sessionPct, sessionMessagesUsed, sessionLimit, sessionWindowMs,
    remaining, session, settings, conversations,
    source, resetIn, resetTimestamp, apiConnected, apiErrorStatus,
    limitType, hardLimitResetAt, orgId,
    planTier, weeklyUsage, weeklySonnetUsage, weeklyOpusUsage,
    confidence
  } = result;

  applyPopupTheme(settings?.themeMode || 'auto');

  const state = result;

  const windowHours = sessionWindowMs ? Math.round(sessionWindowMs / 3600000) : 5;
  const windowBadge = document.getElementById('window-badge');
  if (windowBadge) windowBadge.textContent = windowHours + 'h';

  // Plan badge
  const planEl = document.getElementById('plan-badge');
  if (planEl && planTier && planTier !== 'unknown') {
    planEl.textContent = planTier.replace('_', ' ');
    planEl.style.display = '';
  } else if (planEl) {
    planEl.style.display = 'none';
  }

  // Weekly usage breakdown
  renderWeekly(weeklyUsage, 'weekly-bar', 'weekly-nums');
  renderWeekly(weeklySonnetUsage, 'weekly-sonnet-bar', 'weekly-sonnet-nums', 'weekly-sonnet-row');
  renderWeekly(weeklyOpusUsage, 'weekly-opus-bar', 'weekly-opus-nums', 'weekly-opus-row');
  const weeklyGroup = document.getElementById('weekly-group');
  if (weeklyGroup) weeklyGroup.style.display = weeklyUsage ? '' : 'none';

  const sourceEl = document.getElementById('source-badge');
  if (sourceEl) {
    sourceEl.textContent = source || 'unknown';
    sourceEl.className = 'source-badge' + (source ? ' ' + source : '');
  }

  const apiDot = document.getElementById('api-dot');
  if (apiDot) {
    apiDot.className = 'api-dot' + (apiConnected ? ' connected' : '');
    if (apiConnected) {
      apiDot.title = 'API connected';
    } else if (apiErrorStatus) {
      const hint: string =
        apiErrorStatus === 401 ? ' (session expired — reload claude.ai)' :
        apiErrorStatus === 429 ? ' (rate limited by server)' :
        apiErrorStatus >= 500 ? ' (claude.ai may be down)' : '';
      apiDot.title = `API error ${apiErrorStatus}${hint}`;
    } else {
      apiDot.title = 'API disconnected';
    }
  }

  // Limit type
  const limitTypeEl = document.getElementById('limit-type');
  if (limitTypeEl) {
    if (limitType === 'hard') {
      limitTypeEl.textContent = 'Hard limit';
      limitTypeEl.className = 'limit-type hard';
    } else if (limitType === 'soft') {
      limitTypeEl.textContent = 'Soft limit';
      limitTypeEl.className = 'limit-type soft';
    } else {
      limitTypeEl.textContent = '';
      limitTypeEl.className = 'limit-type';
    }
  }

  // Cooldown
  const cooldownEl = document.getElementById('cooldown-info');
  const cooldownTimerEl = document.getElementById('cooldown-timer');
  if (cooldownEl && cooldownTimerEl) {
    if (limitType === 'hard' && hardLimitResetAt && hardLimitResetAt > Date.now()) {
      cooldownTimerEl.textContent = formatDuration(hardLimitResetAt - Date.now());
      cooldownEl.style.display = '';
    } else {
      cooldownEl.style.display = 'none';
    }
  }

  // Peak hours
  const peakRow = document.getElementById('peak-row');
  const peakDot = document.getElementById('peak-dot');
  const peakMessage = document.getElementById('peak-message');
  const peakTimer = document.getElementById('peak-timer');
  if (peakRow && peakDot && peakMessage && peakTimer) {
    const isPeak = state.isPeakHours === true;
    peakRow.style.display = '';
    peakRow.className = 'peak-banner ' + (isPeak ? 'peak-on' : 'peak-off');
    peakDot.className = 'peak-dot ' + (isPeak ? 'peak-on' : 'peak-off');
    if (isPeak) {
      peakMessage.textContent = 'Peak hours — sessions drain 3-5x faster.';
      peakTimer.textContent = state.peakHoursTransitionAt
        ? 'Off-peak in ' + formatDuration(state.peakHoursTransitionAt - Date.now())
        : 'Off-peak time unknown';
    } else {
      peakMessage.textContent = 'Off-peak — full speed.';
      peakTimer.textContent = state.peakHoursTransitionAt
        ? 'Peak hours in ' + formatDuration(state.peakHoursTransitionAt - Date.now())
        : 'Peak hours time unknown';
    }
  }

  // Org info
  const orgEl = document.getElementById('org-id');
  if (orgEl) {
    if (orgId) {
      orgEl.textContent = 'Org: ' + orgId.substring(0, 8) + '...';
      orgEl.title = orgId;
      orgEl.style.display = '';
    } else {
      orgEl.textContent = 'Org: not detected';
      orgEl.title = 'Open a claude.ai conversation to enable tracking.';
      orgEl.style.display = '';
    }
  }

  const msgsUsed: number = sessionMessagesUsed || 0;
  const msgsTotal: number = sessionLimit || 45;
  const msgsRemaining = Math.max(0, msgsTotal - msgsUsed);
  const pct: number = sessionPct != null ? sessionPct : Math.min(100, Math.round((msgsUsed / msgsTotal) * 100));
  const tokensUsed: number = (remaining?.tokens != null) ? (remaining.tokensTotal || 90000) - remaining.tokens : 0;
  const tokensTotal: number = remaining?.tokensTotal || 90000;
  const tokenPct = Math.min(100, Math.round((tokensUsed / tokensTotal) * 100));

  const metricPct = document.getElementById('metric-pct');
  const metricUsed = document.getElementById('metric-used');
  if (metricPct) metricPct.textContent = pct + '%';
  if (metricUsed) metricUsed.textContent = formatNum(msgsUsed);
  const remainEl = document.getElementById('metric-remain');
  if (remainEl) {
    remainEl.textContent = formatNum(msgsRemaining);
    remainEl.className = 'metric-val metric-remain';
    if (msgsRemaining < 5) remainEl.classList.add('danger');
    else if (msgsRemaining < 10) remainEl.classList.add('warn');
  }

  // Confidence bar
  const confidenceBar = document.getElementById('confidence-bar');
  const confidencePctEl = document.getElementById('confidence-pct');
  if (confidenceBar && confidencePctEl) {
    const confPct = confidence != null ? Math.round(confidence * 100) : 0;
    confidenceBar.style.width = confPct + '%';
    let cls = 'confidence-fill';
    if (confPct >= 90) cls += ' safe';
    else if (confPct >= 60) cls += ' warn';
    else cls += ' danger';
    confidenceBar.className = cls;
    confidencePctEl.textContent = confPct + '%';
  }

  setGauge(pct);
  setBar('session-bar', pct);
  setBar('token-bar', tokenPct);

  const sessionNums = document.getElementById('session-nums');
  const tokenNums = document.getElementById('token-nums');
  if (sessionNums) sessionNums.textContent = `${formatNum(msgsUsed)} / ${formatNum(msgsTotal)}`;
  if (tokenNums) tokenNums.textContent = `${formatNum(tokensUsed)} / ${formatNum(tokensTotal)}`;

  const dot = document.getElementById('session-dot');
  const sessionData = session as { startTime?: number; conversations?: number } | null;
  if (sessionData?.startTime) {
    if (dot) dot.className = 'session-dot';
    const sessionTime = document.getElementById('session-time');
    const sessionConvs = document.getElementById('session-convs');
    const sessionUsageLine = document.getElementById('session-usage-line');
    if (sessionTime) sessionTime.textContent = formatDuration(Date.now() - sessionData.startTime);
    if (sessionConvs) sessionConvs.textContent = `${sessionData.conversations || 0} convs`;
    if (sessionUsageLine) sessionUsageLine.textContent =
      `${formatNum(msgsUsed)} of ${formatNum(msgsTotal)} messages \u00B7 ${pct}% used`;
  } else {
    if (dot) dot.className = 'session-dot inactive';
    const sessionTime = document.getElementById('session-time');
    const sessionConvs = document.getElementById('session-convs');
    const sessionUsageLine = document.getElementById('session-usage-line');
    if (sessionTime) sessionTime.textContent = '--:--:--';
    if (sessionConvs) sessionConvs.textContent = '0 convs';
    if (sessionUsageLine) sessionUsageLine.textContent = '';
  }

  const resetEl = document.getElementById('reset-timer');
  if (resetEl) {
    if (resetTimestamp && resetTimestamp > Date.now()) {
      resetEl.textContent = formatDuration(resetTimestamp - Date.now());
    } else if (resetIn != null && resetIn > 0) {
      resetEl.textContent = formatDuration(resetIn);
    } else {
      resetEl.textContent = '--:--:--';
    }
  }

  renderConversations(conversations);
}

interface ConvEntry {
  startedAt: string;
  messagesSent?: number;
  messagesReceived?: number;
  title?: string;
}

function renderConversations(convs: Record<string, ConvEntry> | null | undefined): void {
  const list = document.getElementById('conv-list');
  const countEl = document.getElementById('conv-count');
  if (!convs || Object.keys(convs).length === 0) {
    if (list) list.innerHTML = '<li class="empty-li">None yet.</li>';
    if (countEl) countEl.textContent = '';
    return;
  }

  const entries = Object.entries(convs);
  if (countEl) countEl.textContent = String(entries.length);

  const sorted = entries
    .sort(([, a], [, b]) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
    .slice(0, 5);

  if (list) {
    list.innerHTML = sorted.map(([, conv]) => {
      const total = (conv.messagesSent || 0) + (conv.messagesReceived || 0);
      return `<li>
        <span class="conv-title">${esc(conv.title || 'Untitled')}</span>
        <span class="conv-meta">${total}</span>
      </li>`;
    }).join('');
  }
}

function setBar(id: string, pct: number): void {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.width = `${pct}%`;
  el.className = 'prog-fill';
  if (pct >= 90) el.classList.add('danger');
  else if (pct >= 60) el.classList.add('warn');
  else el.classList.add('safe');
}

function setGauge(pct: number): void {
  const ring = document.getElementById('gauge-ring');
  const text = document.getElementById('gauge-text');
  if (!ring || !text) return;
  const circumference = 301.6;
  ring.style.strokeDashoffset = String(circumference * (1 - pct / 100));
  ring.setAttribute('class', 'gauge-fill');
  if (pct >= 90) ring.classList.add('danger');
  else if (pct >= 60) ring.classList.add('warn');
  text.textContent = pct + '%';
}

function formatDuration(ms: number): string {
  if (ms <= 0 || !Number.isFinite(ms)) return '00:00:00';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function formatNum(n: number | null | undefined): string {
  if (!n && n !== 0) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function renderWeekly(
  weekly: { usagePercent?: number | null; messagesUsed?: number | null; maxMessages?: number | null } | null | undefined,
  barId: string,
  numsId: string,
  rowId?: string
): void {
  const bar = document.getElementById(barId);
  const nums = document.getElementById(numsId);
  const row = rowId ? document.getElementById(rowId) : null;

  if (!weekly?.maxMessages) {
    if (bar) bar.style.width = '0%';
    if (nums) nums.textContent = '';
    if (row) row.style.display = 'none';
    return;
  }

  const pct = weekly.usagePercent ?? Math.round(((weekly.messagesUsed ?? 0) / weekly.maxMessages) * 100);
  if (bar) {
    bar.style.width = pct + '%';
    bar.className = 'prog-fill';
    if (pct >= 90) bar.classList.add('danger');
    else if (pct >= 60) bar.classList.add('warn');
    else bar.classList.add('safe');
  }
  if (nums) nums.textContent = `${formatNum(weekly.messagesUsed ?? 0)} / ${formatNum(weekly.maxMessages)}`;
  if (row) row.style.display = '';
}

async function handleExport(): Promise<void> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id || !tab.url?.includes('claude.ai')) {
    alert('Open a claude.ai conversation to export.');
    return;
  }

  try {
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'EXPORT_CHAT' });
    if (!result?.success || !result?.markdown) {
      alert(result?.error || 'Could not export chat.');
      return;
    }
    downloadMarkdown(result.markdown, result.title || 'claude-chat');
  } catch {
    alert('Could not reach the page. Try refreshing claude.ai.');
  }
}

function downloadMarkdown(content: string, title: string): void {
  const blob = new Blob([content], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = title.replace(/[^a-zA-Z0-9\- ]/g, '').trim() + '.md';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function esc(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
