export {};

const LIMIT_DAYS = 14;
const _themeMedia = window.matchMedia('(prefers-color-scheme: dark)');
let _themeMode = 'auto';

document.addEventListener('DOMContentLoaded', () => {
  applyDashboardTheme();
  _themeMedia.addEventListener('change', () => {
    if (_themeMode === 'auto') applyThemeMode('auto');
  });
  refresh();
  setInterval(refresh, 10000);
  
  document.getElementById('db-force-reload')?.addEventListener('click', async () => {
    const btn = document.getElementById('db-force-reload');
    if (btn) btn.style.transform = 'rotate(180deg)';
    await chrome.runtime.sendMessage({ type: 'FORCE_FETCH_USAGE' });
    await refresh();
    if (btn) {
      setTimeout(() => { btn.style.transform = ''; }, 200);
    }
  });
});

async function applyDashboardTheme() {
  const { settings } = await chrome.storage.local.get('settings');
  applyThemeMode(settings?.themeMode || 'auto');
}

function applyThemeMode(themeMode) {
  _themeMode = themeMode || 'auto';
  localStorage.setItem('themeMode', _themeMode);
  const isDark = _themeMode === 'dark' ||
    (_themeMode === 'auto' && _themeMedia.matches);
  document.documentElement.classList.toggle('dark', isDark);
}

async function refresh() {
  const data = await chrome.runtime.sendMessage({ type: 'GET_ALL_DATA' });
  if (!data) return;
  renderOverview(data);
  renderHistory();
  renderHourlyHeatmap();
  renderConversations(data);
}

function renderOverview(d) {
  const { daily, remaining, resetIn, session, settings } = d;
  const msgs = (daily.messagesSent || 0) + (daily.messagesReceived || 0);
  const tokens = (daily.tokensSent || 0) + (daily.tokensReceived || 0);
  const msgsTotal = remaining.messagesTotal || 100;
  const tokensTotal = remaining.tokensTotal || 50000;

  document.getElementById('period-badge').textContent = settings?.resetPeriod || 'daily';
  document.getElementById('overview-period').textContent = capitalize(settings?.resetPeriod || 'daily');

  setText('ov-messages', formatNum(msgs));
  setText('ov-messages-of', `/ ${formatNum(msgsTotal)}`);
  setText('ov-tokens', formatNum(tokens));
  setText('ov-tokens-of', `/ ${formatNum(tokensTotal)}`);
  setText('ov-sent', formatNum(daily.messagesSent));
  setText('ov-recv', formatNum(daily.messagesReceived));
  setText('ov-convs', formatNum(daily.conversations));

  const timer = document.getElementById('ov-session');
  timer.textContent = session?.startTime ? formatDuration(Date.now() - session.startTime) : '--:--:--';

  const msgPct = Math.min(100, Math.round((msgs / msgsTotal) * 100));
  const tokPct = Math.min(100, Math.round((tokens / tokensTotal) * 100));

  setBar('bar-messages', msgPct);
  setNums('nums-messages', msgs, msgsTotal);
  setBar('bar-tokens', tokPct);
  setNums('nums-tokens', tokens, tokensTotal);

  const resetEl = document.getElementById('reset-timer');
  if (resetEl) resetEl.textContent = formatDuration(resetIn);

  const dot = document.getElementById('status-dot');
  if (dot) {
    dot.style.background = session?.startTime ? 'var(--safe)' : 'var(--text-muted)';
  }
  const lbl = document.getElementById('status-label');
  if (lbl) lbl.textContent = session?.startTime ? 'Tracking' : 'Idle';
}

async function renderHistory() {
  const result = await chrome.runtime.sendMessage({ type: 'GET_HISTORY' });
  const tbody = document.getElementById('history-body');
  const countEl = document.getElementById('history-count');

  if (!result || result.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="6">No data yet.</td></tr>';
    if (countEl) countEl.textContent = '0 days';
    return;
  }

  const days = result.slice(-LIMIT_DAYS).reverse();
  if (countEl) countEl.textContent = `${days.length} days`;

  tbody.innerHTML = days.map(([date, day]) => {
    const total = (day.messagesSent || 0) + (day.messagesReceived || 0);
    const tokens = (day.tokensSent || 0) + (day.tokensReceived || 0);
    const maxTotal = Math.max(...result.map(([, r]) => (r.messagesSent || 0) + (r.messagesReceived || 0)), 1);
    const barW = Math.round((total / maxTotal) * 100);
    return `<tr>
      <td class="col-date">${date}</td>
      <td class="col-num">${formatNum(day.messagesSent)}</td>
      <td class="col-num">${formatNum(day.messagesReceived)}</td>
      <td class="col-num">${formatNum(tokens)}</td>
      <td class="col-num">${formatNum(day.conversations)}</td>
      <td><span class="mini-bar" style="width:${barW}px"></span></td>
    </tr>`;
  }).join('');
}

async function renderHourlyHeatmap() {
  const hourlyUsage = await chrome.runtime.sendMessage({ type: 'GET_HOURLY_USAGE' });
  const grid = document.getElementById('hours-heatmap');
  const range = document.getElementById('heatmap-range');
  if (!grid) return;

  const days = getRecentDateKeys(56);
  const maxHour = Math.max(
    ...days.flatMap((dateKey) => {
      const hours = hourlyUsage?.[dateKey] || [];
      return Array.from({ length: 24 }, (_, hour) => Number(hours[hour]) || 0);
    }),
    0
  );

  if (range) range.textContent = `${days.length} days`;

  const hourHeaders = Array.from({ length: 24 }, (_, hour) => {
    const label = hour % 3 === 0 ? String(hour).padStart(2, '0') : '';
    return `<span class="heat-hour">${label}</span>`;
  }).join('');

  const rows = days.map((dateKey) => {
    const hours = hourlyUsage?.[dateKey] || [];
    const dayTotal = Array.from({ length: 24 }, (_, hour) => Number(hours[hour]) || 0)
      .reduce((sum, count) => sum + count, 0);
    const cells = Array.from({ length: 24 }, (_, hour) => {
      const count = Number(hours[hour]) || 0;
      const level = heatLevel(count, maxHour);
      const label = `${dateKey} ${String(hour).padStart(2, '0')}:00 - ${formatNum(count)} messages`;
      return `<span class="heat-cell level-${level}" title="${esc(label)}" aria-label="${esc(label)}"></span>`;
    }).join('');
    return `<div class="heat-row">
      <span class="heat-date" title="${esc(dateKey)}">${formatHeatmapDate(dateKey)}</span>
      <div class="heat-cells" title="${esc(`${dateKey}: ${formatNum(dayTotal)} messages`)}">${cells}</div>
    </div>`;
  }).join('');

  grid.innerHTML = `<div class="heat-header"><span></span><div class="heat-hours">${hourHeaders}</div></div>${rows}`;
}

function renderConversations(d) {
  const convs = d.conversations;
  const tbody = document.getElementById('conv-body');
  const countEl = document.getElementById('conv-count');

  if (!convs || Object.keys(convs).length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="4">No conversations yet.</td></tr>';
    if (countEl) countEl.textContent = '0';
    return;
  }

  const entries = Object.entries(convs);
  if (countEl) countEl.textContent = String(entries.length);

  const sorted = entries
    .sort(([, a], [, b]) => new Date(b.startedAt) - new Date(a.startedAt))
    .slice(0, 20);

  tbody.innerHTML = sorted.map(([, conv]) => {
    const total = (conv.messagesSent || 0) + (conv.messagesReceived || 0);
    const tokens = (conv.tokensSent || 0) + (conv.tokensReceived || 0);
    const date = formatDate(conv.startedAt);
    const title = conv.title || 'Untitled';
    return `<tr>
      <td class="col-title">${esc(title)}</td>
      <td class="col-num">${total}</td>
      <td class="col-num">${formatNum(tokens)}</td>
      <td class="col-date">${date}</td>
    </tr>`;
  }).join('');
}

// ---- Helpers ----

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = String(val ?? '0');
}

function setNums(id, used, total) {
  const el = document.getElementById(id);
  if (el) el.textContent = `${formatNum(used)} / ${formatNum(total)}`;
}

function setBar(id, pct) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.width = `${pct}%`;
  el.className = 'progress-fill';
  if (pct >= 90) el.classList.add('danger');
  else if (pct >= 70) el.classList.add('warn');
}

function formatDuration(ms) {
  if (ms <= 0 || !Number.isFinite(ms)) return '00:00:00';
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function formatNum(n) {
  if (!n && n !== 0) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function formatDate(iso) {
  if (!iso) return '--';
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getRecentDateKeys(days) {
  const result = [];
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(d);
    day.setDate(d.getDate() - i);
    result.push(`${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`);
  }
  return result;
}

function formatHeatmapDate(dateKey) {
  const [, month, day] = dateKey.split('-');
  return `${month}/${day}`;
}

function heatLevel(count, max) {
  if (!count || max <= 0) return 0;
  const ratio = count / max;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
