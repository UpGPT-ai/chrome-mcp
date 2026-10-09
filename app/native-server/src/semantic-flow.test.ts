import { describe, expect, test } from '@jest/globals';
import {
  SEMANTIC_FLOW_VERSION,
  TOOL_NAMES,
  TOOL_SCHEMAS,
  appendSemanticStep,
  createSemanticFlow,
  exportFlowCalls,
  isSecretField,
  locatorAttempts,
  parseFlowExportArgs,
  parseFlowRunArgs,
  parseRecordingArgs,
  recorderStepToSemantic,
  rememberFlow,
  replayAgentView,
  replayPlan,
  stepNotFoundError,
  summarizePageChange,
} from 'chrome-mcp-shared';

const page = { url: 'https://shop.test/pay', title: 'Pay' };
const password = {
  type: 'password',
  tag: 'input',
  autocomplete: 'current-password',
};

function fill(value: string, field: Record<string, string>, extra: Record<string, unknown> = {}) {
  return recorderStepToSemantic(
    {
      id: 'pw',
      type: 'fill',
      value,
      field,
      locator: { role: 'textbox', name: 'Secret', htmlName: 'secret', css: '#secret' },
      pageUrl: page.url,
      ...extra,
    },
    page,
  );
}

describe('semantic flow secrets and steps', () => {
  test('password, payment, and one-time-code values become {secret:true}', () => {
    const secret = 'hunter2';
    const cases = [
      password,
      { type: 'text', tag: 'input', autocomplete: 'cc-number' },
      { type: 'text', tag: 'input', autocomplete: 'one-time-code' },
      { type: 'text', tag: 'input', autocomplete: 'section-blue cc-csc' },
    ];
    for (const field of cases) {
      const step = fill(secret, field);
      expect(step?.value).toEqual({ secret: true });
      expect(JSON.stringify(step)).not.toContain(secret);
    }
    expect(isSecretField({ type: 'text', autocomplete: 'cc-exp' })).toBe(true);
    expect(isSecretField({ type: 'text', autocomplete: 'username' })).toBe(false);
  });

  test('a username stays text and a file placeholder is not a secret', () => {
    const user = fill('ada', { type: 'text', tag: 'input', autocomplete: 'username' });
    expect(user?.action).toBe('fill');
    expect(user?.value).toBe('ada');
    const file = recorderStepToSemantic(
      {
        id: 'file',
        type: 'fill',
        value: '{file_ab12}',
        field: { type: 'file', tag: 'input' },
        pageUrl: page.url,
      },
      page,
    );
    expect(file?.value).toBe('{file_ab12}');
    const hidden = fill(
      '{var_ab12}',
      { type: 'text', tag: 'input' },
      { secret: true, value: 'ada' },
    );
    expect(hidden?.value).toEqual({ secret: true });
    expect(JSON.stringify(hidden)).not.toContain('ada');
  });

  test('drops mouse paths and strips coordinates from a click', () => {
    expect(
      recorderStepToSemantic({ type: 'scroll', offset: { x: 3, y: 4 }, pageUrl: page.url }, page),
    ).toBeNull();
    expect(
      recorderStepToSemantic(
        { type: 'mousemove', path: [{ x: 1, y: 2 }], pageUrl: page.url },
        page,
      ),
    ).toBeNull();
    expect(recorderStepToSemantic({ type: 'switchTab', urlContains: page.url }, page)).toBeNull();
    const click = recorderStepToSemantic(
      {
        id: 'c1',
        type: 'click',
        clientX: 12,
        clientY: 40,
        target: { selector: '#go', ref: 'ref_9' },
        locator: { role: 'button', name: 'Go', css: '#go' },
        pageUrl: page.url,
      },
      page,
    );
    expect(click?.action).toBe('click');
    expect(JSON.stringify(click)).not.toContain('clientX');
    expect(JSON.stringify(click)).not.toContain('ref_9');
    const submit = recorderStepToSemantic(
      {
        id: 's1',
        type: 'dblclick',
        target: { submit: true },
        locator: { role: 'button', name: 'Pay', css: 'button.pay' },
        pageUrl: page.url,
      },
      page,
    );
    expect(submit?.action).toBe('submit');
  });

  test('maps select, check, key, and navigation', () => {
    const selected = recorderStepToSemantic(
      {
        id: 'sel',
        type: 'fill',
        value: 'visa',
        field: { tag: 'select', type: '' },
        locator: { role: 'combobox', name: 'Card', css: 'select' },
        pageUrl: page.url,
      },
      page,
    );
    expect(selected?.action).toBe('select');
    expect(selected?.value).toBe('visa');
    const cardExp = '12/99-secret';
    const redacted = recorderStepToSemantic(
      {
        id: 'exp',
        type: 'fill',
        value: cardExp,
        field: { tag: 'select', autocomplete: 'cc-exp' },
        pageUrl: page.url,
      },
      page,
    );
    expect(redacted?.action).toBe('select');
    expect(redacted?.value).toEqual({ secret: true });
    expect(JSON.stringify(redacted)).not.toContain(cardExp);
    const checked = recorderStepToSemantic(
      {
        id: 'box',
        type: 'fill',
        value: true,
        field: { type: 'checkbox', tag: 'input' },
        pageUrl: page.url,
      },
      page,
    );
    expect(checked?.action).toBe('check');
    expect(checked?.value).toBe(true);
    const key = recorderStepToSemantic(
      { id: 'k', type: 'key', keys: 'Enter', pageUrl: page.url },
      page,
    );
    expect(key).toMatchObject({ action: 'key', value: 'Enter' });
    const opened = recorderStepToSemantic(
      { id: 'tab', type: 'openTab', url: 'https://shop.test/next' },
      page,
    );
    expect(opened).toMatchObject({ action: 'navigate', url: 'https://shop.test/next' });
  });
});

describe('semantic flow export, replay, and page change', () => {
  test('version 1 export is a plain tool-call array and merges consecutive fills', () => {
    expect(SEMANTIC_FLOW_VERSION).toBe(1);
    let flow = createSemanticFlow({
      id: 'flow_1',
      name: 'Checkout',
      now: '2026-01-01T00:00:00.000Z',
    });
    expect(flow.version).toBe(1);
    const locator = { role: 'textbox', name: 'Email', htmlName: 'email', css: '#email' };
    flow = appendSemanticStep(
      flow,
      {
        id: 'a',
        action: 'fill',
        locator,
        value: 'a',
        url: 'https://shop.test/pay',
      },
      't1',
    );
    flow = appendSemanticStep(
      flow,
      {
        id: 'b',
        action: 'fill',
        locator,
        value: 'ada@ex.com',
        url: 'https://shop.test/pay',
      },
      't2',
    );
    expect(flow.steps).toHaveLength(1);
    expect(flow.steps[0].id).toBe('a');
    expect(flow.steps[0].value).toBe('ada@ex.com');
    flow = appendSemanticStep(
      flow,
      {
        id: 'go',
        action: 'click',
        locator: { role: 'button', name: 'Go', css: '#go' },
        url: 'https://shop.test/pay',
      },
      't3',
    );
    flow = appendSemanticStep(
      flow,
      {
        id: 'nav',
        action: 'navigate',
        url: 'https://shop.test/done',
        value: 'https://shop.test/done',
      },
      't4',
    );
    expect(flow.steps[2].before).toContain('https://shop.test/pay');
    expect(flow.steps[2].after).toContain('https://shop.test/done');
    const calls = exportFlowCalls(flow);
    expect(calls.map((call) => call.tool)).toEqual([
      'chrome_fill_or_select',
      'chrome_click_element',
      'chrome_navigate',
    ]);
    expect(calls[0].arguments.value).toBe('ada@ex.com');
    expect(calls[0].arguments.locator).toEqual(locator);
    expect(calls[2].arguments.url).toBe('https://shop.test/done');
    expect(JSON.stringify(calls)).not.toContain('clientX');
  });

  test('replay prompts for a missing secret and does not echo a resolved one', () => {
    const secret = 'hunter2';
    let flow = createSemanticFlow({
      id: 'flow_pw',
      name: 'Login',
      now: '2026-01-01T00:00:00.000Z',
    });
    const step = fill(secret, password);
    expect(step).toBeTruthy();
    flow = appendSemanticStep(flow, step!, 't1');
    const missing = replayPlan(flow, undefined);
    expect(missing).toEqual({
      needsSecret: true,
      prompts: [
        {
          step: 1,
          field: { action: 'fill', htmlName: 'secret', name: 'Secret' },
        },
      ],
    });
    expect(JSON.stringify(missing)).not.toContain(secret);
    const resolved = replayPlan(flow, { '1': secret });
    expect('steps' in resolved && resolved.steps[0].value).toBe(secret);
    expect(JSON.stringify(replayAgentView(resolved as { steps: [] }))).not.toContain(secret);
    const byName = replayPlan(flow, { secret: 'other-secret' });
    expect('steps' in byName && byName.steps[0].value).toBe('other-secret');
  });

  test('locator ladder is role then label, name, id, text, and css', () => {
    const attempts = locatorAttempts({
      role: 'button',
      name: 'Save',
      label: 'Save label',
      htmlName: 'save',
      id: 'save-btn',
      text: 'Save',
      css: 'button.save',
      framePath: ['https://shop.test/frame'],
    });
    expect(attempts.map((attempt) => attempt.kind)).toEqual([
      'role',
      'label',
      'name',
      'id',
      'text',
      'css',
    ]);
    expect(attempts[0].selector).toContain('button');
    expect(stepNotFoundError(2)).toBe('step 2 could not be found');
  });

  test('observe summary records a url change and omits an unchanged page', () => {
    expect(
      summarizePageChange(
        { url: 'https://a.test', title: 'A' },
        { url: 'https://b.test', title: 'B' },
      ),
    ).toEqual({ before: 'https://a.test A', after: 'https://b.test B' });
    expect(
      summarizePageChange(
        { url: 'https://a.test', title: 'A' },
        { url: 'https://a.test', title: 'A' },
      ),
    ).toEqual({});
  });

  test('argument parsers reject bad recording and flow calls', () => {
    expect(parseRecordingArgs({ action: 'pause' })).toEqual({
      error: 'action must be start, stop, or status',
    });
    expect(parseRecordingArgs({ action: 'start', name: 'Checkout', tabId: 3 })).toEqual({
      action: 'start',
      name: 'Checkout',
      tabId: 3,
    });
    expect(parseRecordingArgs({ action: 'start', tabId: '3' })).toEqual({
      error: 'tabId must be a non-negative integer',
    });
    expect(parseFlowRunArgs({})).toEqual({ error: 'flowId is required' });
    expect(parseFlowRunArgs({ flowId: 'flow_1', params: { '1': { secret: true } } })).toEqual({
      error: 'params values must be strings',
    });
    expect(parseFlowRunArgs({ flowId: 'flow_1', params: { '2': 'false' } })).toEqual({
      flowId: 'flow_1',
      params: { '2': 'false' },
      tabId: undefined,
    });
    expect(parseFlowExportArgs({ flowId: 'flow_1' })).toEqual({ flowId: 'flow_1' });
    const kept = rememberFlow(
      Array.from({ length: 50 }, (_, index) =>
        createSemanticFlow({ id: `old_${index}`, now: '2026-01-01T00:00:00.000Z' }),
      ),
      createSemanticFlow({ id: 'new', now: '2026-01-02T00:00:00.000Z' }),
    );
    expect(kept).toHaveLength(50);
    expect(kept[0].id).toBe('new');
    expect(kept.some((flow) => flow.id === 'old_49')).toBe(false);
  });

  test('schemas name the four tools and the off-by-default flag', () => {
    const names = [
      TOOL_NAMES.BROWSER.RECORDING,
      TOOL_NAMES.BROWSER.FLOW_LIST,
      TOOL_NAMES.BROWSER.FLOW_RUN,
      TOOL_NAMES.BROWSER.FLOW_EXPORT,
    ];
    expect(names).toEqual([
      'chrome_recording',
      'chrome_flow_list',
      'chrome_flow_run',
      'chrome_flow_export',
    ]);
    for (const name of names) {
      const schema = TOOL_SCHEMAS.find((tool) => tool.name === name);
      expect(schema?.description).toContain('highRiskTools.recording');
      expect(schema?.description).toContain('version');
    }
    const recording = TOOL_SCHEMAS.find((tool) => tool.name === TOOL_NAMES.BROWSER.RECORDING);
    expect(recording?.description).toContain('sitePolicyAllowOrigins');
    expect(recording?.description).toContain('{secret: true}');
    const exported = TOOL_SCHEMAS.find((tool) => tool.name === TOOL_NAMES.BROWSER.FLOW_EXPORT);
    expect(exported?.description).toContain('chrome_navigate');
  });
});
