import type { DayUsage, HourlyUsage } from '../background/types';

export type History = [string, Partial<DayUsage>][];
export type Metric = 'messages' | 'tokens';
export interface DailyPoint {
  date: string;
  messages: number;
  tokens: number;
  sent: number;
  received: number;
  conversations: number;
}

export function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function displayDate(key: string): string {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function numberLabel(value: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(count(value));
}

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
}

export function buildDailySeries(history: History, days: number, now = new Date()): DailyPoint[] {
  const byDate = new Map(history);
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days + 1 + index, 12);
    const key = dateKey(date);
    const day = byDate.get(key);
    const sent = count(day?.messagesSent);
    const received = count(day?.messagesReceived);
    return {
      date: key,
      sent,
      received,
      messages: sent + received,
      tokens: count(day?.tokensSent) + count(day?.tokensReceived),
      conversations: count(day?.conversations),
    };
  });
}

export function summarize(series: DailyPoint[]) {
  const messages = series.reduce((sum, day) => sum + day.messages, 0);
  return {
    messages,
    tokens: series.reduce((sum, day) => sum + day.tokens, 0),
    activeDays: series.filter((day) => day.messages > 0 || day.tokens > 0).length,
    average: series.length ? messages / series.length : 0,
  };
}

export function sumHours(hours: HourlyUsage, dates: string[]): number[] {
  return Array.from({ length: 24 }, (_, hour) => dates.reduce((sum, date) => sum + count(hours[date]?.[hour]), 0));
}

export function renderTrend(host: HTMLElement, series: DailyPoint[], metric: Metric, compact = false): void {
  const values = series.map((day) => count(day[metric]));
  if (!values.some((value) => value > 0)) {
    host.innerHTML = `<div class="chart-empty"><span class="empty-mark" aria-hidden="true">↗</span><strong>No activity recorded</strong><span>Your ${metric} will appear here as you use Claude.</span></div>`;
    return;
  }
  const width = 720;
  const height = compact ? 88 : 240;
  const left = compact ? 4 : 44;
  const right = width - 12;
  const top = compact ? 8 : 16;
  const bottom = height - (compact ? 8 : 30);
  const max = Math.max(...values, 1);
  const step = Math.pow(10, Math.floor(Math.log10(max)));
  const ceiling = Math.ceil(max / step) * step;
  const x = (index: number) => left + (index * (right - left)) / Math.max(1, values.length - 1);
  const y = (value: number) => bottom - (value / ceiling) * (bottom - top);
  const line = values.map((value, index) => `${index ? 'L' : 'M'}${x(index)},${y(value)}`).join(' ');
  const grid = compact
    ? ''
    : [0, 0.5, 1]
        .map(
          (ratio) =>
            `<line class="chart-grid" x1="${left}" x2="${right}" y1="${y(ceiling * ratio)}" y2="${y(ceiling * ratio)}"/><text class="chart-axis" x="${left - 10}" y="${y(ceiling * ratio) + 4}" text-anchor="end">${numberLabel(ceiling * ratio)}</text>`,
        )
        .join('');
  const ticks = compact
    ? ''
    : [...new Set([0, Math.floor((series.length - 1) / 2), series.length - 1])]
        .map(
          (index) =>
            `<text class="chart-axis" x="${x(index)}" y="${height - 6}" text-anchor="${index === 0 ? 'start' : index === series.length - 1 ? 'end' : 'middle'}">${escapeHtml(displayDate(series[index].date).replace(/, \d{4}$/, ''))}</text>`,
        )
        .join('');
  const points = compact
    ? ''
    : values
        .map((value, index) => {
          const label = `${displayDate(series[index].date)} · ${value.toLocaleString('en-US')} ${metric}${metric === 'tokens' ? ' (estimated)' : ''}`;
          return `<circle class="chart-point" cx="${x(index)}" cy="${y(value)}" r="4"/><rect class="chart-hit" x="${x(index) - 10}" y="${top}" width="20" height="${bottom - top}" ${inspectionAttributes(label, index)}/>`;
        })
        .join('');
  host.innerHTML = `<svg class="trend-svg" viewBox="0 0 ${width} ${height}" role="${compact ? 'img' : 'group'}" aria-label="${series.length}-day ${metric} trend"><title>${series.length}-day ${metric} trend</title>${grid}<path class="chart-area" d="${line} L${x(values.length - 1)},${bottom} L${left},${bottom} Z"/><path class="chart-line" d="${line}"/>${points}${ticks}</svg>${compact ? '' : '<p class="chart-inspection" role="status">Hover to inspect · Use arrow keys when focused</p>'}`;
  if (!compact) wireInspection(host);
}

export function renderHourly(host: HTMLElement, hours: number[]): void {
  const values = Array.from({ length: 24 }, (_, hour) => count(hours[hour]));
  const max = Math.max(...values, 0);
  if (!max) {
    host.innerHTML =
      '<div class="chart-empty"><span class="empty-mark" aria-hidden="true">▥</span><strong>No hourly activity yet</strong><span>New activity builds your daily rhythm.</span></div>';
    return;
  }
  const bars = values
    .map((value, hour) => {
      const h = (value / max) * 134;
      const label = `${String(hour).padStart(2, '0')}:00–${String(hour).padStart(2, '0')}:59 · ${value.toLocaleString('en-US')} messages`;
      return `<rect class="hour-bar${value === max ? ' hour-peak' : ''}" x="${16 + hour * 19}" y="${152 - h}" width="12" height="${h}" rx="3"/><rect class="chart-hit" x="${14 + hour * 19}" y="12" width="17" height="140" ${inspectionAttributes(label, hour)}/>`;
    })
    .join('');
  const ticks = [0, 6, 12, 18, 23]
    .map(
      (hour) =>
        `<text class="chart-axis" x="${22 + hour * 19}" y="176" text-anchor="middle">${String(hour).padStart(2, '0')}</text>`,
    )
    .join('');
  host.innerHTML = `<svg viewBox="0 0 480 188" role="group" aria-label="Messages by hour of day"><title>Messages by hour of day</title><line class="chart-grid" x1="14" x2="466" y1="152" y2="152"/>${bars}${ticks}</svg><p class="chart-inspection" role="status">Local time · Sent and received messages</p>`;
  wireInspection(host);
}

export function renderHeatmap(host: HTMLElement, series: DailyPoint[]): void {
  const max = Math.max(...series.map((day) => day.messages), 1);
  const first = series[0]?.date;
  const pad = first ? new Date(`${first}T12:00:00`).getDay() : 0;
  const padding = '<span class="heat-pad" aria-hidden="true"></span>'.repeat(pad);
  host.innerHTML = `<div class="heat-grid" role="group" aria-label="Daily activity, oldest to newest">${padding}${series
    .map((day, index) => {
      const level = day.messages ? Math.max(1, Math.ceil((day.messages / max) * 4)) : 0;
      const label = `${displayDate(day.date)} · ${day.messages.toLocaleString('en-US')} messages`;
      return `<span class="heat-cell heat-${level}" data-date="${escapeHtml(day.date)}" ${inspectionAttributes(label, index)}></span>`;
    })
    .join('')}</div><p class="chart-inspection" role="status">Each square is one day · Use arrow keys to explore</p>`;
  wireInspection(host);
}

function inspectionAttributes(label: string, index: number): string {
  return `tabindex="${index === 0 ? 0 : -1}" role="img" aria-label="${escapeHtml(label)}" data-chart-label="${escapeHtml(label)}"`;
}

function wireInspection(host: HTMLElement): void {
  const points = Array.from(host.querySelectorAll<HTMLElement | SVGElement>('[data-chart-label]'));
  const status = host.querySelector('[role="status"]');
  points.forEach((point, index) => {
    const inspect = () => {
      if (status) status.textContent = point.dataset.chartLabel || '';
    };
    point.addEventListener('pointerenter', inspect);
    point.addEventListener('focus', inspect);
    point.addEventListener('click', () => {
      point.focus();
      inspect();
    });
    point.addEventListener('keydown', (event) => {
      const key = (event as KeyboardEvent).key;
      const offset =
        key === 'ArrowRight' || key === 'ArrowDown' ? 1 : key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 0;
      if (!offset && key !== 'Home' && key !== 'End') return;
      event.preventDefault();
      const next =
        key === 'Home'
          ? 0
          : key === 'End'
            ? points.length - 1
            : Math.max(0, Math.min(points.length - 1, index + offset));
      points.forEach((item, i) => item.setAttribute('tabindex', i === next ? '0' : '-1'));
      points[next]?.focus();
    });
  });
}
