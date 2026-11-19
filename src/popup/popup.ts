export {};
import { showExportDialog } from '../shared/export-dialog';
import { buildDailySeries, count, renderTrend, summarize, type History } from '../shared/analytics';

let nextHistoryRefresh = 0;
let rendering = false;

const _themeMedia = window.matchMedia('(prefers-color-scheme: dark)');
let _themeMode = 'auto';

document.addEventListener('DOMContentLoaded', () => {
  initPrivacy();

  _themeMedia.addEventListener('change', () => {
    if (_themeMode === 'auto') applyPopupTheme('auto');
  });

  document.getElementById('privacy-accept-btn')?.addEventListener('click', acceptPrivacy);

  document.getElementById('dashboard-btn')?.addEventListener('click', (e) => {
    e.preventDefault();
    void navigate('OPEN_DASHBOARD');
  });

  document.getElementById('settings-btn')?.addEventListener('click', (e) => {
    e.preventDefault();
    void navigate('OPEN_SETTINGS');
  });

  document.getElementById('reset-btn')?.addEventListener('click', async () => {
    if (!confirm('Clear all tracked usage data?')) return;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'RESET_USAGE' });
      if (!response?.success) throw new Error('Clear failed');
      nextHistoryRefresh = 0;
      await render();
    } catch {
      showStatus('Could not clear local history. Try again.');
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
  const isDark = _themeMode === 'dark' || (_themeMode === 'auto' && _themeMedia.matches);
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
  if (mainContent) {
    mainContent.style.display = '';
    mainContent.classList.add('loading'); // show skeletons until first render
  }
  render();
  if (!_privacyRenderTimer) {
    _privacyRenderTimer = setInterval(() => {
      if (document.visibilityState !== 'hidden') render();
    }, 1000);
  }
}

function showStatus(message: string): void {
  const status = document.getElementById('popup-status');
  if (status) {
    status.textContent = message;
    status.hidden = !message;
  }
}

async function navigate(type: 'OPEN_SETTINGS' | 'OPEN_DASHBOARD'): Promise<void> {
  try {
    const response = await chrome.runtime.sendMessage({ type });
    if (!response?.success) throw new Error('Navigation failed');
    showStatus('');
  } catch {
    showStatus('Could not open the page. Reopen the extension and try again.');
  }
}

async function renderHistory(): Promise<void> {
  if (Date.now() < nextHistoryRefresh) return;
  nextHistoryRefresh = Date.now() + 30_000;
  const host = document.getElementById('week-chart');
  try {
    const history = (await chrome.runtime.sendMessage({ type: 'GET_HISTORY' })) as History;
    if (!Array.isArray(history)) throw new Error('History unavailable');
    const series = buildDailySeries(history, 7);
    const total = document.getElementById('week-total');
    if (total) total.textContent = `${summarize(series).messages.toLocaleString('en-US')} messages`;
    if (host) renderTrend(host, series, 'messages', true);
  } catch {
    if (host && !host.querySelector('svg'))
      host.textContent = 'History unavailable. Reopen the extension to try again.';
  }
}

async function render(): Promise<void> {
  if (rendering) return;
  rendering = true;
  try {
    await renderUsage();
    await renderHistory();
  } catch {
    showStatus('Could not load usage. Open Claude.ai, then reopen the extension.');
  } finally {
    document.getElementById('main-content')?.classList.remove('loading');
    rendering = false;
  }
}

async function renderUsage(): Promise<void> {
  const result = await chrome.runtime.sendMessage({ type: 'GET_ALL_DATA' });
  if (!result) throw new Error('Usage unavailable');

  // Remove skeleton loading state on first successful data render
  document.getElementById('main-content')?.classList.remove('loading');

  const {
    sessionPct,
    sessionMessagesUsed,
    sessionLimit,
    sessionWindowMs,
    remaining,
    session,
    settings,
    conversations,
    source,
    resetIn,
    resetTimestamp,
    apiConnected,
    apiErrorStatus,
    limitType,
    hardLimitResetAt,
    orgId,
    planTier,
    weeklyUsage,
    weeklySonnetUsage,
    weeklyOpusUsage,
    weeklyFableUsage,
    confidence,
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
  renderWeekly(weeklyFableUsage, 'weekly-fable-bar', 'weekly-fable-nums', 'weekly-fable-row');
  const weeklyGroup = document.getElementById('weekly-group');
  if (weeklyGroup)
    weeklyGroup.style.display = weeklyUsage || weeklySonnetUsage || weeklyOpusUsage || weeklyFableUsage ? '' : 'none';

  const sourceEl = document.getElementById('source-badge');
  if (sourceEl) {
    sourceEl.textContent =
      source === 'network' || source === 'official-ui'
        ? 'Reported usage'
        : sessionPct != null
          ? 'Estimated usage'
          : 'Not connected';
    sourceEl.className = 'source-badge' + (source ? ' ' + source : '');
  }

  const apiDot = document.getElementById('api-dot');
  if (apiDot) {
    apiDot.className = 'api-dot' + (apiConnected ? ' connected' : '');
    if (apiConnected) {
      apiDot.title = 'API connected';
    } else if (apiErrorStatus) {
      const hint: string =
        apiErrorStatus === 401
          ? ' (session expired — reload claude.ai)'
          : apiErrorStatus === 429
            ? ' (rate limited by server)'
            : apiErrorStatus >= 500
              ? ' (claude.ai may be down)'
              : '';
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

  const msgsTotal = count(sessionLimit) || count(remaining?.messagesTotal) || null;
  const apiRemaining =
    typeof remaining?.messages === 'number' && Number.isFinite(remaining.messages) ? count(remaining.messages) : null;
  const pct = typeof sessionPct === 'number' && Number.isFinite(sessionPct) ? Math.min(100, count(sessionPct)) : null;
  const msgsUsed = count(sessionMessagesUsed);
  const msgsRemaining =
    apiRemaining ?? (msgsTotal !== null && sessionMessagesUsed != null ? Math.max(0, msgsTotal - msgsUsed) : null);
  const tokensUsed = count(result.daily?.tokensSent) + count(result.daily?.tokensReceived);
  const tokensEl = document.getElementById('popup-tokens');
  if (tokensEl) tokensEl.textContent = formatNum(tokensUsed);
  const note = document.getElementById('usage-note');
  if (note)
    note.textContent = result.isRateLimited
      ? 'Limit reached. Check the reset time below.'
      : pct === null
        ? 'Open Claude.ai to connect usage.'
        : 'Limits vary by model, plan, and demand.';
  const heading = document.querySelector('.hero-copy h1');
  if (heading) heading.textContent = result.isRateLimited ? 'Time for a pause.' : 'Your usage, now.';

  const metricPct = document.getElementById('metric-pct');
  const metricUsed = document.getElementById('metric-used');
  if (metricPct) metricPct.textContent = pct === null ? '—' : Math.round(pct) + '%';
  if (metricUsed) metricUsed.textContent = formatNum(msgsUsed);
  const remainEl = document.getElementById('metric-remain');
  if (remainEl) {
    // Show decimal precision (e.g. 26.1) when we have accurate data
    remainEl.textContent = msgsRemaining !== null ? formatMsgCount(msgsRemaining) : '—';
    remainEl.className = 'metric-val metric-remain';
    if (msgsRemaining !== null && msgsRemaining < 5) remainEl.classList.add('danger');
    else if (msgsRemaining !== null && msgsRemaining < 10) remainEl.classList.add('warn');
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
  setBar('session-bar', pct ?? 0);

  const sessionNums = document.getElementById('session-nums');
  if (sessionNums)
    sessionNums.textContent = msgsTotal !== null ? `${formatNum(msgsUsed)} / ${formatNum(msgsTotal)}` : 'Limit unknown';

  const dot = document.getElementById('session-dot');
  const sessionData = session as { startTime?: number; conversations?: number } | null;
  if (sessionData?.startTime) {
    if (dot) dot.className = 'session-dot';
    const sessionTime = document.getElementById('session-time');
    const sessionConvs = document.getElementById('session-convs');
    const sessionUsageLine = document.getElementById('session-usage-line');
    if (sessionTime) sessionTime.textContent = formatDuration(Date.now() - sessionData.startTime);
    if (sessionConvs) sessionConvs.textContent = `${sessionData.conversations || 0} convs`;
    if (sessionUsageLine)
      sessionUsageLine.textContent = `${formatNum(msgsUsed)} messages · ${pct === null ? 'Usage unknown' : Math.round(pct) + '% used'}`;
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
    list.innerHTML = sorted
      .map(([, conv]) => {
        const total = (conv.messagesSent || 0) + (conv.messagesReceived || 0);
        return `<li>
        <span class="conv-title">${esc(conv.title || 'Untitled')}</span>
        <span class="conv-meta">${total}</span>
      </li>`;
      })
      .join('');
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

function setGauge(pct: number | null): void {
  const ring = document.getElementById('gauge-ring');
  const text = document.getElementById('gauge-text');
  if (!ring || !text) return;
  const circumference = 301.6;
  ring.style.strokeDashoffset = String(circumference * (1 - (pct ?? 0) / 100));
  ring.setAttribute('class', 'gauge-fill');
  if (pct !== null && pct >= 90) ring.classList.add('danger');
  else if (pct !== null && pct >= 60) ring.classList.add('warn');
  text.textContent = pct === null ? '—' : Math.round(pct) + '%';
}

function formatDuration(ms: number): string {
  if (ms <= 0 || !Number.isFinite(ms)) return '00:00:00';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function formatNum(n: number | null | undefined): string {
  if (n == null || isNaN(n as number)) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return Math.round(n).toLocaleString();
  return String(Math.round(n));
}

/** Show one decimal place when value isn't a whole number (e.g. 26.1 remaining) */
function formatMsgCount(n: number | null | undefined): string {
  if (n == null || isNaN(n as number)) return '0';
  if (n <= 0) return '0';
  if (n >= 1000) return Math.round(n).toLocaleString();
  const rounded = Math.round(n * 10) / 10;
  return rounded % 1 === 0 ? String(rounded) : rounded.toFixed(1);
}

function renderWeekly(
  weekly:
    { usagePercent?: number | null; messagesUsed?: number | null; maxMessages?: number | null } | null | undefined,
  barId: string,
  numsId: string,
  rowId?: string,
): void {
  const bar = document.getElementById(barId);
  const nums = document.getElementById(numsId);
  const row = rowId ? document.getElementById(rowId) : null;

  // Show the row if we have either absolute counts OR a percentage
  const hasData = weekly && (weekly.maxMessages || weekly.usagePercent != null);
  if (!hasData) {
    if (bar) bar.style.width = '0%';
    if (nums) nums.textContent = '';
    if (row) row.style.display = 'none';
    return;
  }

  const pct =
    weekly.usagePercent ??
    (weekly.maxMessages ? Math.round(((weekly.messagesUsed ?? 0) / weekly.maxMessages) * 100) : 0);
  if (bar) {
    bar.style.width = pct + '%';
    bar.className = 'prog-fill';
    if (pct >= 90) bar.classList.add('danger');
    else if (pct >= 60) bar.classList.add('warn');
    else bar.classList.add('safe');
  }
  if (nums) {
    if (weekly.maxMessages) {
      nums.textContent = `${formatNum(weekly.messagesUsed ?? 0)} / ${formatNum(weekly.maxMessages)}`;
    } else {
      // New format: only percentage available
      nums.textContent = `${Math.round(pct)}%`;
    }
  }
  if (row) row.style.display = '';
}

async function handleExport(): Promise<void> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id || !tab.url?.includes('claude.ai')) {
    alert('Open a claude.ai conversation to export.');
    return;
  }

  const isDark = document.body.classList.contains('cut-dark');
  const dialogResult = await showExportDialog(document.body, isDark);
  if (!dialogResult) return; // User cancelled

  const { percentage: percent, format } = dialogResult;

  try {
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'EXPORT_CHAT', percentage: percent, format: format });
    if (!result?.success || !result?.content) {
      alert(result?.error || 'Could not export chat.');
      return;
    }
    downloadFile(result.content, result.title || 'claude-chat', format);
  } catch {
    alert('Could not reach the page. Try refreshing claude.ai.');
  }
}

function downloadFile(content: string, title: string, ext: string): void {
  const typeMap: Record<string, string> = {
    md: 'text/markdown',
    txt: 'text/plain',
    json: 'application/json',
  };
  const blob = new Blob([content], { type: typeMap[ext] || 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = title.replace(/[^a-zA-Z0-9\- ]/g, '').trim() + '.' + ext;
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
