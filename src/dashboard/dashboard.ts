import {
  buildDailySeries,
  count,
  dateKey,
  displayDate,
  escapeHtml,
  numberLabel,
  renderHeatmap,
  renderHourly,
  renderTrend,
  sumHours,
  summarize,
  type DailyPoint,
  type History,
  type Metric,
} from '../shared/analytics';
import type { ConversationEntry, DayUsage, HourlyUsage } from '../background/types';

interface DashboardData {
  daily?: Partial<DayUsage>;
  sessionPct?: number | null;
  source?: string;
  isRateLimited?: boolean;
  resetTimestamp?: number | null;
  resetIn?: number;
  weeklyUsage?: { usagePercent?: number | null };
  conversations?: Record<string, ConversationEntry>;
  settings?: { themeMode?: string };
}

let history: History = [];
let hourly: HourlyUsage = {};
let days = 14;
let metric: Metric = 'messages';
let busy = false;
let resetAt = 0;
let mode = 'auto';
let historySignature = '';
let conversationSignature = '';
const media = window.matchMedia('(prefers-color-scheme: dark)');
const element = (id: string) => document.getElementById(id)!;
const text = (id: string, value: string) => {
  element(id).textContent = value;
};

function applyTheme(theme = mode): void {
  mode = theme;
  document.documentElement.classList.toggle('dark', theme === 'dark' || (theme === 'auto' && media.matches));
  localStorage.setItem('themeMode', theme);
}

function notice(message = ''): void {
  text('page-status', message);
  element('page-status').hidden = !message;
}

document.addEventListener('DOMContentLoaded', () => {
  media.addEventListener('change', () => applyTheme());
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) {
      const settings = changes.settings.newValue as { themeMode?: string } | undefined;
      applyTheme(settings?.themeMode || 'auto');
    }
  });
  document.querySelectorAll<HTMLButtonElement>('[data-range]').forEach((button) => {
    button.addEventListener('click', () => {
      days = Number(button.dataset.range);
      document
        .querySelectorAll('[data-range]')
        .forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
      renderHistory();
    });
  });
  document.querySelectorAll<HTMLButtonElement>('[data-metric]').forEach((button) => {
    button.addEventListener('click', () => {
      metric = button.dataset.metric as Metric;
      document
        .querySelectorAll('[data-metric]')
        .forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
      renderHistory();
    });
  });
  element('db-force-reload').addEventListener('click', () => {
    void refresh(true);
  });
  element('db-export-history').addEventListener('click', exportHistory);
  void refresh();
  setInterval(() => {
    if (document.visibilityState !== 'hidden') void refresh();
  }, 15000);
  setInterval(renderCountdown, 1000);
});

async function refresh(force = false): Promise<void> {
  if (busy) return;
  busy = true;
  const button = element('db-force-reload') as HTMLButtonElement;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try {
    let refreshFailed = false;
    if (force) {
      const response = await chrome.runtime.sendMessage({ type: 'FORCE_FETCH_USAGE' });
      refreshFailed = response?.success !== true;
    }
    const [data, records, hours] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'GET_ALL_DATA' }) as Promise<DashboardData>,
      chrome.runtime.sendMessage({ type: 'GET_HISTORY' }) as Promise<History>,
      chrome.runtime.sendMessage({ type: 'GET_HOURLY_USAGE' }) as Promise<HourlyUsage>,
    ]);
    if (!data || !Array.isArray(records) || !hours) throw new Error('No response');
    applyTheme(data.settings?.themeMode || 'auto');
    renderQuota(data);
    history = records;
    hourly = hours;
    const signature = JSON.stringify([records, hours, dateKey(new Date())]);
    if (signature !== historySignature) {
      historySignature = signature;
      renderHistory();
      renderHeatmap(element('activity-heatmap'), buildDailySeries(history, 90));
    }
    const conversations = JSON.stringify(data.conversations || {});
    if (conversations !== conversationSignature) {
      conversationSignature = conversations;
      renderConversations(data.conversations || {});
    }
    text(
      'updated-at',
      `History updated ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`,
    );
    notice(
      refreshFailed
        ? 'Could not refresh Claude limits. Showing locally stored data; open Claude.ai and try again.'
        : '',
    );
  } catch {
    notice('Could not load fresh usage. Your saved data is unchanged. Reload the extension and try again.');
  } finally {
    busy = false;
    button.disabled = false;
    button.setAttribute('aria-busy', 'false');
  }
}

function renderHistory(): void {
  const series = buildDailySeries(history, days);
  const totals = summarize(series);
  text('range-label', `Last ${days} days · ${displayDate(series[0].date)} – ${displayDate(series[days - 1].date)}`);
  text('summary-messages', numberLabel(totals.messages));
  text('summary-tokens', numberLabel(totals.tokens));
  text('summary-active', String(totals.activeDays));
  text('active-note', `Out of ${days} calendar days`);
  text('summary-average', numberLabel(totals.average));
  text('trend-total', numberLabel(totals[metric]));
  text('trend-unit', `${metric === 'tokens' ? 'estimated tokens' : 'messages'} in this period`);
  text(
    'trend-note',
    metric === 'tokens'
      ? 'Estimated input + output tokens · Not a billing measure'
      : 'Sent + received · Recorded on this device',
  );
  renderTrend(element('trend-chart'), series, metric);
  const hours = sumHours(
    hourly,
    series.map((day) => day.date),
  );
  renderHourly(element('hourly-chart'), hours);
  const max = Math.max(...hours);
  text('peak-hour', max > 0 ? `Busiest: ${String(hours.indexOf(max)).padStart(2, '0')}:00` : 'Local time');
  text('history-count', `${days} calendar days · Missing days shown as zero`);
  element('history-body').innerHTML = totals.activeDays
    ? series
        .slice()
        .reverse()
        .map(
          (day) =>
            `<tr><th scope="row">${displayDate(day.date)}</th><td>${numberLabel(day.sent)}</td><td>${numberLabel(day.received)}</td><td>${numberLabel(day.tokens)}</td><td>${day.conversations}</td></tr>`,
        )
        .join('')
    : '<tr><td colspan="5" class="empty-cell">No activity in this period. Open Claude to start building your history.</td></tr>';
  (element('db-export-history') as HTMLButtonElement).disabled = totals.activeDays === 0;
}

function renderQuota(data: DashboardData): void {
  const pct =
    typeof data.sessionPct === 'number' && Number.isFinite(data.sessionPct)
      ? Math.min(100, Math.max(0, data.sessionPct))
      : null;
  const reported = data.source === 'network' || data.source === 'official-ui';
  text('quota-percent', pct === null ? '—' : `${Math.round(pct)}%`);
  element('quota-ring').style.strokeDashoffset = String(314.16 * (1 - (pct ?? 0) / 100));
  element('quota-ring').classList.toggle('danger', (pct ?? 0) >= 90 || data.isRateLimited === true);
  text(
    'source-label',
    data.isRateLimited ? 'Rate limited' : pct === null ? 'Waiting' : reported ? 'Reported' : 'Estimated',
  );
  text(
    'quota-note',
    pct === null
      ? 'Session quota is not available yet. Open Claude.ai to connect.'
      : reported
        ? 'Usage reported by Claude. Limits can vary by model and demand.'
        : 'Estimated usage. Actual limits vary by model, plan, and demand.',
  );
  resetAt =
    data.resetTimestamp && data.resetTimestamp > Date.now()
      ? data.resetTimestamp
      : count(data.resetIn)
        ? Date.now() + count(data.resetIn)
        : 0;
  renderCountdown();
  const weekly = data.weeklyUsage?.usagePercent;
  const hasWeekly = typeof weekly === 'number' && Number.isFinite(weekly);
  const weeklyPct = hasWeekly ? Math.min(100, Math.max(0, weekly)) : 0;
  text('weekly-percent', hasWeekly ? `${Math.round(weeklyPct)}%` : '—');
  element('weekly-bar').style.width = `${weeklyPct}%`;
  element('weekly-bar').classList.toggle('danger', weeklyPct >= 90);
  text('weekly-note', hasWeekly ? 'All models · Reported weekly usage' : 'Weekly quota has not been reported yet');
  text('today-tokens', numberLabel(count(data.daily?.tokensSent) + count(data.daily?.tokensReceived)));
}

function renderCountdown(): void {
  if (!resetAt) {
    text('reset-timer', 'Not available');
    return;
  }
  const seconds = Math.max(0, Math.floor((resetAt - Date.now()) / 1000));
  text(
    'reset-timer',
    seconds
      ? `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
      : 'Awaiting refresh',
  );
}

function renderConversations(conversations: Record<string, ConversationEntry>): void {
  const entries = Object.entries(conversations)
    .sort(([, a], [, b]) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
    .slice(0, 6);
  text('conv-count', entries.length ? `${entries.length} recent chats · All time` : 'Your latest chats · All time');
  element('conv-body').innerHTML = entries.length
    ? entries
        .map(([id, conv], index) => {
          const title = escapeHtml(conv.title || 'Untitled conversation');
          const name = /^[0-9a-f-]{36}$/i.test(id)
            ? `<a href="https://claude.ai/chat/${id}" target="_blank" rel="noopener noreferrer">${title}</a>`
            : `<span>${title}</span>`;
          return `<article class="conversation"><span class="conversation-index">${String(index + 1).padStart(2, '0')}</span><div>${name}<p>${numberLabel(count(conv.messagesSent) + count(conv.messagesReceived))} messages</p></div><span class="conversation-tokens">${numberLabel(count(conv.tokensSent) + count(conv.tokensReceived))}<small>est. tokens</small></span></article>`;
        })
        .join('')
    : '<div class="chart-empty"><span class="empty-mark" aria-hidden="true">↗</span><strong>Your next idea starts here</strong><span>Conversations appear as you use Claude.</span><a href="https://claude.ai/new" target="_blank" rel="noopener noreferrer">Start a conversation ↗</a></div>';
}

function exportHistory(): void {
  const series: DailyPoint[] = buildDailySeries(history, days);
  if (!summarize(series).activeDays) {
    notice('No recorded activity to export in this period.');
    return;
  }
  const rows = series.map((day) => `${day.date},${day.sent},${day.received},${day.tokens},${day.conversations}`);
  const blob = new Blob([['Date,Sent,Received,Estimated Tokens,Conversations', ...rows].join('\r\n')], {
    type: 'text/csv;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `claude-usage-${days}days-${dateKey(new Date())}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  notice(`Exported ${days} days of usage history.`);
}
