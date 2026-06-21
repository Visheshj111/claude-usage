export {};

const _themeMedia = window.matchMedia('(prefers-color-scheme: dark)');
let _themeMode = 'auto';

document.addEventListener('DOMContentLoaded', () => {
  initPrivacy();

  _themeMedia.addEventListener('change', () => {
    if (_themeMode === 'auto') applyPopupTheme('auto');
  });

  document.getElementById('privacy-accept-btn').addEventListener('click', acceptPrivacy);

  document.getElementById('dashboard-btn').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('dist/dashboard/dashboard.html') });
  });

  document.getElementById('settings-btn').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  document.getElementById('reset-btn').addEventListener('click', async () => {
    if (confirm('Clear all tracked usage data?')) {
      await chrome.runtime.sendMessage({ type: 'RESET_USAGE' });
      render();
    }
  });

  document.getElementById('export-btn').addEventListener('click', handleExport);

  document.getElementById('show-privacy-link').addEventListener('click', (e) => {
    e.preventDefault();
    showPrivacyScreen();
  });
});

let _privacyRenderTimer = null;

function applyPopupTheme(themeMode) {
  _themeMode = themeMode || 'auto';
  localStorage.setItem('themeMode', _themeMode);
  const isDark = _themeMode === 'dark' ||
    (_themeMode === 'auto' && _themeMedia.matches);
  document.documentElement.classList.toggle('dark', isDark);
}

async function initPrivacy() {
  const { privacyAccepted } = await chrome.storage.local.get('privacyAccepted');
  if (privacyAccepted) {
    showMainContent();
  } else {
    showPrivacyScreen();
  }
}

function showPrivacyScreen() {
  document.getElementById('privacy-screen').style.display = '';
  document.getElementById('main-content').style.display = 'none';
  if (_privacyRenderTimer) {
    clearInterval(_privacyRenderTimer);
    _privacyRenderTimer = null;
  }
}

async function acceptPrivacy() {
  await chrome.storage.local.set({ privacyAccepted: true });
  showMainContent();
}

function showMainContent() {
  document.getElementById('privacy-screen').style.display = 'none';
  document.getElementById('main-content').style.display = '';
  render();
  if (!_privacyRenderTimer) {
    _privacyRenderTimer = setInterval(render, 1000);
  }
}

async function render() {
  const result = await chrome.runtime.sendMessage({ type: 'GET_ALL_DATA' });
  if (!result) return;

  const {
    sessionPct, sessionMessagesUsed, sessionLimit, sessionWindowMs,
    remaining, session, settings, conversations,
    source, isRateLimited, resetIn, resetTimestamp, apiConnected,
    limitType, hardLimitResetAt, orgId, hasAccurateData,
    planTier, weeklyUsage, weeklySonnetUsage, weeklyOpusUsage,
    confidence
  } = result;

  applyPopupTheme(settings?.themeMode || 'auto');

  const state = result;

  const windowHours = sessionWindowMs ? Math.round(sessionWindowMs / 3600000) : 5;
  document.getElementById('window-badge').textContent = windowHours + 'h';

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
  if (weeklyGroup) {
    weeklyGroup.style.display = weeklyUsage ? '' : 'none';
  }

  const sourceEl = document.getElementById('source-badge');
  sourceEl.textContent = source || 'unknown';
  sourceEl.className = 'source-badge' + (source ? ' ' + source : '');

  const apiDot = document.getElementById('api-dot');
  apiDot.className = 'api-dot' + (apiConnected ? ' connected' : '');
  apiDot.title = apiConnected ? 'API connected' : 'API disconnected';

  // Show limit type info
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

  // Show cooldown info
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

  // Peak hours banner
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

  // Show org info
  const orgEl = document.getElementById('org-id');
  if (orgEl) {
    if (orgId) {
      orgEl.textContent = 'Org: ' + orgId.substring(0, 8) + '...';
      orgEl.title = orgId;
      orgEl.style.display = '';
    } else {
      orgEl.style.display = 'none';
    }
  }

  const msgsUsed = sessionMessagesUsed || 0;
  const msgsTotal = sessionLimit || 45;
  const msgsRemaining = Math.max(0, msgsTotal - msgsUsed);
  const pct = sessionPct != null ? sessionPct : Math.min(100, Math.round((msgsUsed / msgsTotal) * 100));
  const tokensUsed = (remaining?.tokens != null) ? (remaining.tokensTotal || 90000) - remaining.tokens : 0;
  const tokensTotal = remaining?.tokensTotal || 90000;
  const tokenPct = Math.min(100, Math.round((tokensUsed / tokensTotal) * 100));

  document.getElementById('metric-pct').textContent = pct + '%';
  document.getElementById('metric-used').textContent = formatNum(msgsUsed);
  document.getElementById('metric-remain').textContent = formatNum(msgsRemaining);
  const remainEl = document.getElementById('metric-remain');
  remainEl.className = 'metric-val metric-remain';
  if (msgsRemaining < 5) remainEl.classList.add('danger');
  else if (msgsRemaining < 10) remainEl.classList.add('warn');

  // Confidence bar
  const confidenceBar = document.getElementById('confidence-bar');
  const confidencePct = document.getElementById('confidence-pct');
  if (confidenceBar && confidencePct) {
    const confPct = confidence != null ? Math.round(confidence * 100) : 0;
    confidenceBar.style.width = confPct + '%';
    let cls = 'confidence-fill';
    if (confPct >= 90) cls += ' safe';
    else if (confPct >= 60) cls += ' warn';
    else cls += ' danger';
    confidenceBar.className = cls;
    confidencePct.textContent = confPct + '%';
  }

  setGauge(pct);

  setBar('session-bar', pct);
  setBar('token-bar', tokenPct);
  document.getElementById('session-nums').textContent = `${formatNum(msgsUsed)} / ${formatNum(msgsTotal)}`;
  document.getElementById('token-nums').textContent = `${formatNum(tokensUsed)} / ${formatNum(tokensTotal)}`;

  const dot = document.getElementById('session-dot');
  if (session?.startTime) {
    dot.className = 'session-dot';
    document.getElementById('session-time').textContent = formatDuration(Date.now() - session.startTime);
    document.getElementById('session-convs').textContent = `${session.conversations || 0} convs`;
    document.getElementById('session-usage-line').textContent =
      `${formatNum(msgsUsed)} of ${formatNum(msgsTotal)} messages \u00B7 ${pct}% used`;
  } else {
    dot.className = 'session-dot inactive';
    document.getElementById('session-time').textContent = '--:--:--';
    document.getElementById('session-convs').textContent = '0 convs';
    document.getElementById('session-usage-line').textContent = '';
  }

  const resetEl = document.getElementById('reset-timer');
  if (resetTimestamp && resetTimestamp > Date.now()) {
    resetEl.textContent = formatDuration(resetTimestamp - Date.now());
  } else if (resetIn != null && resetIn > 0) {
    resetEl.textContent = formatDuration(resetIn);
  } else {
    resetEl.textContent = '--:--:--';
  }

  renderConversations(conversations);
}

function renderConversations(convs) {
  const list = document.getElementById('conv-list');
  const countEl = document.getElementById('conv-count');
  if (!convs || Object.keys(convs).length === 0) {
    list.innerHTML = '<li class="empty-li">None yet.</li>';
    if (countEl) countEl.textContent = '';
    return;
  }

  const entries = Object.entries(convs);
  if (countEl) countEl.textContent = String(entries.length);

  const sorted = entries
    .sort(([, a], [, b]) => new Date(b.startedAt) - new Date(a.startedAt))
    .slice(0, 5);

  list.innerHTML = sorted.map(([, conv]) => {
    const total = (conv.messagesSent || 0) + (conv.messagesReceived || 0);
    return `<li>
      <span class="conv-title">${esc(conv.title || 'Untitled')}</span>
      <span class="conv-meta">${total}</span>
    </li>`;
  }).join('');
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = String(val ?? '0');
}

function setBar(id, pct) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.width = `${pct}%`;
  el.className = 'prog-fill';
  if (pct >= 90) el.classList.add('danger');
  else if (pct >= 60) el.classList.add('warn');
  else el.classList.add('safe');
}

function setGauge(pct) {
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

function formatDuration(ms) {
  if (ms <= 0 || !Number.isFinite(ms)) return '00:00:00';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function formatNum(n) {
  if (!n && n !== 0) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function renderWeekly(weekly, barId, numsId, rowId?) {
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

async function handleExport() {
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

function downloadMarkdown(content, title) {
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

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
