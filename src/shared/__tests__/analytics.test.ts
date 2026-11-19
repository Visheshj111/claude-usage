import { describe, expect, it } from 'vitest';
import { buildDailySeries, sumHours, summarize, renderTrend, renderHourly, renderHeatmap } from '../analytics';

const now = new Date(2026, 10, 11, 12);

describe('local usage analytics', () => {
  it('sorts by local calendar day, fills missing days, and ignores out-of-range data', () => {
    const series = buildDailySeries(
      [
        ['2026-11-11', { messagesSent: 3, messagesReceived: 2, tokensSent: 100, tokensReceived: 400 }],
        ['2026-11-09', { messagesSent: 1 }],
        ['2026-11-12', { messagesSent: 99 }],
        ['2026-10-01', { messagesSent: 99 }],
      ],
      3,
      now,
    );
    expect(series.map((d) => [d.date, d.messages, d.tokens])).toEqual([
      ['2026-11-09', 1, 0],
      ['2026-11-10', 0, 0],
      ['2026-11-11', 5, 500],
    ]);
    expect(summarize(series)).toEqual({ messages: 6, tokens: 500, activeDays: 2, average: 2 });
  });

  it('keeps calendar days across month and daylight-saving boundaries', () => {
    expect(buildDailySeries([], 3, new Date(2026, 10, 2, 0, 30)).map((d) => d.date)).toEqual([
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
    ]);
  });

  it('normalizes invalid counts without changing stored data', () => {
    const history: [string, { messagesSent: number; tokensSent: number }][] = [
      ['2026-11-11', { messagesSent: -3, tokensSent: Infinity }],
    ];
    expect(buildDailySeries(history, 1, now)[0]).toMatchObject({ messages: 0, tokens: 0 });
    expect(history[0][1].messagesSent).toBe(-3);
    expect(summarize([])).toEqual({ messages: 0, tokens: 0, activeDays: 0, average: 0 });
  });

  it('aggregates 24 hourly buckets only within the selected range', () => {
    const hours = sumHours({ '2026-11-09': [1, 2], '2026-11-11': [4, -2, NaN], '2026-11-01': [99] }, [
      '2026-11-09',
      '2026-11-11',
    ]);
    expect(hours).toHaveLength(24);
    expect(hours.slice(0, 4)).toEqual([5, 2, 0, 0]);
    expect(hours.reduce((a, b) => a + b, 0)).toBe(7);
  });

  it('renders readable empty charts without invalid coordinates', () => {
    const host = document.createElement('div');
    renderTrend(host, buildDailySeries([], 7, now), 'messages');
    expect(host.textContent).toMatch(/no activity/i);
    expect(host.innerHTML).not.toMatch(/NaN|Infinity/);
    renderHourly(host, Array(24).fill(0));
    expect(host.textContent).toMatch(/no hourly activity/i);
  });

  it('supports keyboard chart inspection and switches to token values', () => {
    const series = buildDailySeries([['2026-11-11', { messagesSent: 5, tokensSent: 800 }]], 3, now);
    const host = document.createElement('div');
    document.body.append(host);
    renderTrend(host, series, 'tokens');
    const points = host.querySelectorAll<SVGElement>('[data-chart-label]');
    expect(points).toHaveLength(3);
    points[0].focus();
    points[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(document.activeElement).toBe(points[2]);
    expect(host.querySelector('[role="status"]')?.textContent).toContain('800');
    expect(host.querySelector('[role="status"]')?.textContent).toContain('tokens');
    host.remove();
  });

  it('aligns heatmap dates from oldest to newest with labeled empty days', () => {
    const host = document.createElement('div');
    renderHeatmap(host, buildDailySeries([['2026-11-11', { messagesSent: 4 }]], 3, now));
    const days = host.querySelectorAll('[data-date]');
    expect(Array.from(days, (d) => d.getAttribute('data-date'))).toEqual(['2026-11-09', '2026-11-10', '2026-11-11']);
    expect(days[0].getAttribute('aria-label')).toContain('0 messages');
    expect(days[2].getAttribute('aria-label')).toContain('4 messages');
  });
});
