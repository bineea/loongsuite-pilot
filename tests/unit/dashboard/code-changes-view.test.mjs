import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('../../../assets/dashboard/index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function view() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      innerHTML: '', textContent: '', value: '', dataset: {}, listeners: {},
      classList: { add() {}, remove() {}, toggle() {} }, style: {},
      addEventListener(name, fn) { this.listeners[name] = fn; },
      setAttribute() {}, contains() { return false; }, querySelectorAll() { return []; },
    });
    return elements.get(id);
  };
  const document = {
    getElementById: element, querySelectorAll: () => [],
    documentElement: {}, activeElement: null,
  };
  const api = Function('window', 'document', 'navigator', 'fetch', 'setInterval', 'clearInterval',
    `${script}\nreturn { render: s => { currentSummary = s; renderSummary(s); }, language: applyLanguage };`)(
    { localStorage: { getItem: () => 'zh-CN' } }, document,
    { language: 'zh-CN' }, () => new Promise(() => {}), () => 1, () => {},
  );
  return { ...api, element };
}

const measured = { agentType: 'codex', addedLines: 12, deletedLines: 5, filesChanged: 2,
  measuredOperations: 2, unmeasuredOperations: 1, failedOperations: 1 };
const unknown = { agentType: 'claude-code', addedLines: 0, deletedLines: 0, filesChanged: 0,
  measuredOperations: 0, unmeasuredOperations: 3, failedOperations: 0 };
const summary = {
  codeChangeHistory: { startDate: '2026-04-30', endDate: '2026-11-16', days: [
    { day: '2026-09-01', codeChanges: [{ ...measured, addedLines: 56 }] },
    { day: '2026-11-01', codeChanges: [measured] },
    { day: '2026-11-03', codeChanges: [{ ...measured, addedLines: 22 }, unknown] },
    { day: '2026-11-16', codeChanges: [measured, unknown] },
  ] },
  ranges: { today: { codeChanges: [measured, unknown] },
    sevenDays: { codeChanges: [{ ...measured, addedLines: 34 }] },
    thirtyDays: { codeChanges: [{ ...measured, addedLines: 56 }] } },
};

describe('代码增删行看板', () => {
  it('按 Agent 显示实测增删行、净增和覆盖情况，未知不冒充零', () => {
    const ui = view();
    ui.render(summary);
    const table = ui.element('code-changes').innerHTML;
    expect(table).toContain('codex');
    expect(table).toContain('+12');
    expect(table).toContain('−5');
    expect(table).toContain('+7');
    expect(table).toContain('claude-code');
    expect(table).toContain('未测量');
    expect(table).toContain('—');
  });

  it('自选首尾日期包含边界，语言切换与自动刷新保留范围', () => {
    const ui = view();
    ui.render(summary);
    ui.element('code-start').listeners.change({ target: { value: '2026-11-01' } });
    ui.element('code-end').listeners.change({ target: { value: '2026-11-03' } });
    expect(ui.element('code-changes').innerHTML).toContain('+34');
    ui.language('en');
    expect(ui.element('code-changes').innerHTML).toContain('+34');
    expect(ui.element('code-changes').innerHTML).toContain('Unmeasured');
    ui.render(summary);
    expect(ui.element('code-changes').innerHTML).toContain('+34');
    ui.element('code-start').listeners.change({ target: { value: '2026-09-01' } });
    ui.element('code-end').listeners.change({ target: { value: '2026-09-01' } });
    expect(ui.element('code-changes').innerHTML).toContain('+56');
  });

  it('兼容旧摘要并转义 Agent 名称', () => {
    const ui = view();
    ui.render({ ranges: { today: {} } });
    expect(ui.element('code-changes').innerHTML).toContain('不支持自选日期');
    ui.render({ ...summary, codeChangeHistory: { ...summary.codeChangeHistory, days: [
      { day: '2026-11-16', codeChanges: [{ ...measured, agentType: '<img src=x onerror=alert(1)>' }] },
    ] } });
    expect(ui.element('code-changes').innerHTML).toContain('&lt;img');
    expect(ui.element('code-changes').innerHTML).not.toContain('<img');
  });

  it.each(['', '2026-02-30', '2026-11-17', '2026-04-29'])( '无效或超出保留范围的日期不展示误导结果 %s', start => {
    const ui = view(); ui.render(summary);
    ui.element('code-start').listeners.change({ target: { value: start } });
    expect(ui.element('code-changes').innerHTML).not.toContain('<table');
    expect(ui.element('code-changes').innerHTML).toMatch(/日期|范围/);
  });

  it('结束早于开始时报错，没有记录的合法单日显示无数据', () => {
    const ui = view(); ui.render(summary);
    ui.element('code-end').listeners.change({ target: { value: '2026-11-01' } });
    expect(ui.element('code-changes').innerHTML).toContain('开始日期不能晚于结束日期');
    ui.element('code-start').listeners.change({ target: { value: '2026-11-02' } });
    ui.element('code-end').listeners.change({ target: { value: '2026-11-02' } });
    expect(ui.element('code-changes').innerHTML).toContain('尚无代码编辑统计');
  });
});
