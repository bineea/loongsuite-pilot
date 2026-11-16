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

  it('范围切换后使用相应统计，语言切换保留范围', () => {
    const ui = view();
    ui.render(summary);
    ui.element('code-range').listeners.change({ target: { value: 'sevenDays' } });
    expect(ui.element('code-changes').innerHTML).toContain('+34');
    ui.language('en');
    expect(ui.element('code-changes').innerHTML).toContain('+34');
    expect(ui.element('code-changes').innerHTML).toContain('Unmeasured');
    ui.element('code-range').listeners.change({ target: { value: 'thirtyDays' } });
    expect(ui.element('code-changes').innerHTML).toContain('+56');
  });

  it('兼容旧摘要并转义 Agent 名称', () => {
    const ui = view();
    ui.render({ ranges: { today: {} } });
    expect(ui.element('code-changes').innerHTML).toContain('尚无代码编辑统计');
    ui.render({ ranges: { today: { codeChanges: [{ ...measured, agentType: '<img src=x onerror=alert(1)>' }] } } });
    expect(ui.element('code-changes').innerHTML).toContain('&lt;img');
    expect(ui.element('code-changes').innerHTML).not.toContain('<img');
  });
});
