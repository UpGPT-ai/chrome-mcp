/**
 * DOM-semantic flows (format version 1).
 * The extension records and replays. This module decides the step shape,
 * secret placeholders, locator ladder, and tool-call export.
 * No Node imports. Keep SECRET_AUTOCOMPLETE in sync with recorder.js.
 */

import { buildObserveDiff } from './observe-diff';

export const SEMANTIC_FLOW_VERSION = 1;
export const SEMANTIC_FLOW_STORAGE_KEY = 'semanticFlows';
export const SEMANTIC_DRAFT_STORAGE_KEY = 'semanticRecordingDraft';
export const SEMANTIC_FLOW_CAP = 50;

export const SECRET_AUTOCOMPLETE = [
  'cc-name',
  'cc-given-name',
  'cc-additional-name',
  'cc-family-name',
  'cc-number',
  'cc-exp',
  'cc-exp-month',
  'cc-exp-year',
  'cc-csc',
  'cc-type',
  'one-time-code',
  'current-password',
  'new-password',
] as const;

const SECRET_AUTOCOMPLETE_SET = new Set<string>(SECRET_AUTOCOMPLETE);

export const SEMANTIC_ACTIONS = [
  'click',
  'fill',
  'select',
  'check',
  'navigate',
  'submit',
  'key',
] as const;

export type SemanticAction = (typeof SEMANTIC_ACTIONS)[number];

export interface SemanticLocator {
  role?: string;
  name?: string;
  label?: string;
  htmlName?: string;
  id?: string;
  text?: string;
  css?: string;
  framePath?: string[];
}

export interface SecretValue {
  secret: true;
}

export type StepValue = string | boolean | SecretValue;

export interface SemanticStep {
  id: string;
  action: SemanticAction;
  locator?: SemanticLocator;
  value?: StepValue;
  url: string;
  before?: string;
  after?: string;
}

export interface SemanticFlow {
  version: 1;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  steps: SemanticStep[];
}

export interface LocatorAttempt {
  kind: 'role' | 'label' | 'name' | 'id' | 'text' | 'css';
  role?: string;
  name?: string;
  text?: string;
  htmlName?: string;
  id?: string;
  selector?: string;
}

export interface PreparedStep {
  index: number;
  action: SemanticAction;
  url: string;
  value?: StepValue;
  locator?: SemanticLocator;
  attempts: LocatorAttempt[];
  framePath?: string[];
}

export interface SecretPrompt {
  step: number;
  field: {
    action: SemanticAction;
    label?: string;
    htmlName?: string;
    id?: string;
    name?: string;
  };
}

export interface ExportedCall {
  tool: string;
  arguments: Record<string, unknown>;
}

const VAR_PLACEHOLDER = /^\{var_[a-z0-9]{4}\}$/;
const FILE_PLACEHOLDER = /^\{file_[a-z0-9]{4}\}$/;

const ROLE_SELECTOR: Record<string, string> = {
  button:
    'button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"], input[type="image"]',
  link: 'a[href], [role="link"]',
  a: 'a[href], [role="link"]',
  textbox:
    'input:not([type]), input[type="text"], input[type="email"], input[type="search"], input[type="tel"], input[type="url"], input[type="password"], input[type="number"], textarea, [role="textbox"]',
  checkbox: 'input[type="checkbox"], [role="checkbox"]',
  radio: 'input[type="radio"], [role="radio"]',
  combobox: 'select, [role="combobox"]',
  select: 'select, [role="combobox"]',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value: unknown, max = 200): string {
  if (typeof value !== 'string') return '';
  if (value.includes('\0')) return '';
  const text = value.replace(/[\r\n\t]/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? text.slice(0, max) : text;
}

export function autocompleteTokens(value: unknown): string[] {
  const text = cleanText(value, 300).toLowerCase();
  if (!text) return [];
  return text.split(/\s+/).filter(Boolean);
}

export function isSecretField(field: unknown): boolean {
  if (!isRecord(field)) return false;
  const type = cleanText(field.type, 40).toLowerCase();
  if (type === 'password') return true;
  return autocompleteTokens(field.autocomplete).some((token) => SECRET_AUTOCOMPLETE_SET.has(token));
}

export function isSecretValue(value: unknown): value is SecretValue {
  return isRecord(value) && value.secret === true;
}

export function stepNotFoundError(step: number): string {
  const n = Number.isFinite(step) ? Math.max(1, Math.floor(step)) : 1;
  return `step ${n} could not be found`;
}

export function summarizePageChange(
  before: { url?: string; title?: string } | null | undefined,
  after: { url?: string; title?: string } | null | undefined,
): { before?: string; after?: string } {
  const diff = buildObserveDiff({
    urlBefore: cleanText(before?.url, 2000),
    urlAfter: cleanText(after?.url, 2000),
    titleBefore: cleanText(before?.title, 300),
    titleAfter: cleanText(after?.title, 300),
    linesBefore: [],
    linesAfter: [],
    requests: [],
    consoleErrors: [],
    dialogOpened: false,
  });
  const side = (which: 'before' | 'after'): string | undefined => {
    const parts: string[] = [];
    if (diff.url) parts.push(diff.url[which]);
    if (diff.title) parts.push(diff.title[which]);
    return parts.length ? parts.join(' ') : undefined;
  };
  const left = side('before');
  const right = side('after');
  if (!left && !right) return {};
  return { before: left, after: right };
}

function quoteAttr(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function roleSelector(role: string): string {
  return ROLE_SELECTOR[role] || `[role="${quoteAttr(role)}"]`;
}

export function locatorAttempts(locator: SemanticLocator | undefined): LocatorAttempt[] {
  if (!locator) return [];
  const attempts: LocatorAttempt[] = [];
  const role = cleanText(locator.role, 40);
  const name = cleanText(locator.name, 200);
  if (role && name) {
    attempts.push({ kind: 'role', role, name, selector: roleSelector(role) });
  }
  const label = cleanText(locator.label, 200);
  if (label) attempts.push({ kind: 'label', text: label });
  const htmlName = cleanText(locator.htmlName, 200);
  if (htmlName) {
    attempts.push({
      kind: 'name',
      htmlName,
      selector: `[name="${quoteAttr(htmlName)}"]`,
    });
  }
  const id = cleanText(locator.id, 200);
  if (id) attempts.push({ kind: 'id', id, selector: `#${quoteAttr(id)}` });
  const text = cleanText(locator.text, 200);
  if (text) attempts.push({ kind: 'text', text });
  const css = cleanText(locator.css, 500);
  if (css) attempts.push({ kind: 'css', selector: css });
  return attempts;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => cleanText(entry, 2000)).filter(Boolean);
}

function locatorFrom(raw: Record<string, unknown>): SemanticLocator | undefined {
  const source = isRecord(raw.locator)
    ? raw.locator
    : isRecord(raw.target) && isRecord(raw.target.locator)
      ? raw.target.locator
      : undefined;
  const locator: SemanticLocator = {};
  if (source) {
    const role = cleanText(source.role, 40);
    const name = cleanText(source.name, 200);
    const label = cleanText(source.label, 200);
    const htmlName = cleanText(source.htmlName, 200);
    const id = cleanText(source.id, 200);
    const text = cleanText(source.text, 200);
    const css = cleanText(source.css, 500);
    if (role) locator.role = role;
    if (name) locator.name = name;
    if (label) locator.label = label;
    if (htmlName) locator.htmlName = htmlName;
    if (id) locator.id = id;
    if (text) locator.text = text;
    if (css) locator.css = css;
  }
  const target = isRecord(raw.target) ? raw.target : undefined;
  if (target && Array.isArray(target.candidates)) {
    for (const candidate of target.candidates) {
      if (!isRecord(candidate)) continue;
      const kind = cleanText(candidate.type, 20);
      const value = cleanText(candidate.value, 500);
      if (!value) continue;
      if (kind === 'text' && !locator.text) locator.text = value.slice(0, 200);
      if (kind === 'css' && !locator.css) locator.css = value;
      if (kind === 'attr' && !locator.htmlName) {
        const named = value.match(/^\[name="([^"]+)"\]$/);
        if (named) locator.htmlName = named[1];
      }
    }
  }
  if (target && !locator.css) {
    const selector = cleanText(target.selector, 500);
    if (selector && !selector.includes('|>')) locator.css = selector;
  }
  const framePath = stringList(raw.framePath);
  const frameUrl = cleanText(raw.frameUrl, 2000);
  const frames = framePath.length ? framePath : frameUrl ? [frameUrl] : [];
  if (frames.length) locator.framePath = frames;
  if (
    !locator.role &&
    !locator.name &&
    !locator.label &&
    !locator.htmlName &&
    !locator.id &&
    !locator.text &&
    !locator.css &&
    !locator.framePath
  ) {
    return undefined;
  }
  return locator;
}

function recordedValue(raw: Record<string, unknown>, field: unknown): StepValue | undefined {
  if (raw.secret === true || isSecretField(field)) return { secret: true };
  const value = raw.value;
  if (isSecretValue(value)) return { secret: true };
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  if (value.includes('\0')) return undefined;
  if (FILE_PLACEHOLDER.test(value)) return value;
  if (VAR_PLACEHOLDER.test(value)) return { secret: true };
  return value;
}

function rawAction(raw: Record<string, unknown>): SemanticAction | null {
  const type = cleanText(raw.type, 40).toLowerCase();
  if (
    type === 'scroll' ||
    type === 'drag' ||
    type === 'mousemove' ||
    type === 'hover' ||
    type === 'switchtab' ||
    type === 'switchframe'
  ) {
    return null;
  }
  if (type === 'navigate' || type === 'opentab') return 'navigate';
  if (type === 'key') return 'key';
  if (type === 'click' || type === 'dblclick') {
    const target = isRecord(raw.target) ? raw.target : undefined;
    if (raw.submit === true || target?.submit === true) return 'submit';
    return 'click';
  }
  if (type === 'fill') {
    const field = isRecord(raw.field) ? raw.field : undefined;
    const target = isRecord(raw.target) ? raw.target : undefined;
    const tag = cleanText(field?.tag || target?.tag, 40).toLowerCase();
    const inputType = cleanText(field?.type, 40).toLowerCase();
    if (tag === 'select' || tag === 'select-one' || inputType === 'select-one') return 'select';
    if (
      typeof raw.value === 'boolean' ||
      tag === 'checkbox' ||
      tag === 'radio' ||
      inputType === 'checkbox' ||
      inputType === 'radio'
    ) {
      return 'check';
    }
    return 'fill';
  }
  return null;
}

export function recorderStepToSemantic(
  raw: unknown,
  page: { url?: string; title?: string } = {},
): SemanticStep | null {
  if (!isRecord(raw)) return null;
  const action = rawAction(raw);
  if (!action) return null;
  const id = cleanText(raw.id, 80) || `step_${action}`;
  const pageUrl = cleanText(raw.pageUrl, 2000) || cleanText(page.url, 2000);
  const destination = cleanText(raw.url, 2000);
  const url = action === 'navigate' ? destination || pageUrl : pageUrl || destination;
  if (!url) return null;
  if (action === 'navigate') {
    return { id, action, url, value: url };
  }
  if (action === 'key') {
    const keys = cleanText(raw.keys, 80) || cleanText(raw.value, 80);
    if (!keys) return null;
    const locator = locatorFrom(raw);
    return locator ? { id, action, url, value: keys, locator } : { id, action, url, value: keys };
  }
  const field = raw.field;
  const locator = locatorFrom(raw);
  const value = recordedValue(raw, field);
  const step: SemanticStep = { id, action, url };
  if (locator) step.locator = locator;
  if (value !== undefined && action !== 'click' && action !== 'submit') step.value = value;
  return step;
}

export function createSemanticFlow(input: {
  id: string;
  name?: string;
  now?: string;
}): SemanticFlow {
  const now = input.now || new Date().toISOString();
  const name = cleanText(input.name, 120) || 'New Recording';
  return {
    version: SEMANTIC_FLOW_VERSION,
    id: input.id,
    name,
    createdAt: now,
    updatedAt: now,
    steps: [],
  };
}

function locatorKey(locator: SemanticLocator | undefined): string {
  if (!locator) return '';
  const parts = [
    locator.role || '',
    locator.name || '',
    locator.label || '',
    locator.htmlName || '',
    locator.id || '',
    locator.text || '',
    locator.css || '',
    (locator.framePath || []).join('|'),
  ];
  if (parts.every((part) => part === '')) return '';
  return parts.join('\u241f');
}

function withPageChange(previous: SemanticStep | undefined, step: SemanticStep): SemanticStep {
  if (!previous || step.before || step.after) return step;
  const change = summarizePageChange({ url: previous.url }, { url: step.url });
  if (!change.before && !change.after) return step;
  return { ...step, before: change.before, after: change.after };
}

function sameFill(left: SemanticStep, right: SemanticStep): boolean {
  if (left.action !== right.action) return false;
  if (left.action !== 'fill' && left.action !== 'select') return false;
  return locatorKey(left.locator) !== '' && locatorKey(left.locator) === locatorKey(right.locator);
}

export function appendSemanticStep(
  flow: SemanticFlow,
  step: SemanticStep,
  now?: string,
): SemanticFlow {
  const steps = flow.steps.slice();
  const existing = steps.findIndex((item) => item.id === step.id);
  if (existing >= 0) {
    const prior = steps[existing];
    steps[existing] = {
      ...step,
      before: step.before ?? prior.before,
      after: step.after ?? prior.after,
    };
  } else if (steps.length && sameFill(steps[steps.length - 1], step)) {
    const prior = steps[steps.length - 1];
    steps[steps.length - 1] = {
      ...prior,
      value: step.value,
      url: step.url,
      after: step.after ?? prior.after,
    };
  } else {
    steps.push(withPageChange(steps[steps.length - 1], step));
  }
  return { ...flow, steps, updatedAt: now || new Date().toISOString() };
}

export function rememberFlow(
  flows: SemanticFlow[],
  flow: SemanticFlow,
  cap: number = SEMANTIC_FLOW_CAP,
): SemanticFlow[] {
  const next = [flow, ...flows.filter((item) => item.id !== flow.id)];
  const limit = Number.isFinite(cap) ? Math.max(1, Math.floor(cap)) : SEMANTIC_FLOW_CAP;
  return next.slice(0, limit);
}

export function isSemanticFlow(value: unknown): value is SemanticFlow {
  if (!isRecord(value)) return false;
  return (
    value.version === SEMANTIC_FLOW_VERSION &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    Array.isArray(value.steps)
  );
}

function callArgs(fields: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) args[key] = value;
  }
  return args;
}

export function exportFlowCalls(flow: SemanticFlow): ExportedCall[] {
  return flow.steps.map((step) => {
    const shared = callArgs({
      locator: step.locator,
      before: step.before,
      after: step.after,
    });
    if (step.action === 'navigate') {
      return {
        tool: 'chrome_navigate',
        arguments: callArgs({
          url: typeof step.value === 'string' ? step.value : step.url,
          ...shared,
        }),
      };
    }
    if (step.action === 'key') {
      return {
        tool: 'chrome_keyboard',
        arguments: callArgs({ keys: step.value, ...shared }),
      };
    }
    if (step.action === 'fill' || step.action === 'select' || step.action === 'check') {
      return {
        tool: 'chrome_fill_or_select',
        arguments: callArgs({
          selector: step.locator?.css,
          value: step.value,
          ...shared,
        }),
      };
    }
    return {
      tool: 'chrome_click_element',
      arguments: callArgs({
        selector: step.locator?.css,
        submit: step.action === 'submit' ? true : undefined,
        ...shared,
      }),
    };
  });
}

function optionalId(value: unknown, label: string): number | undefined | { error: string } {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return { error: `${label} must be a non-negative integer` };
  }
  return value;
}

function isFailure(value: unknown): value is { error: string } {
  return isRecord(value) && typeof value.error === 'string';
}

export function parseRecordingArgs(
  args: unknown,
):
  | { action: 'start'; name?: string; tabId?: number }
  | { action: 'stop' | 'status' }
  | { error: string } {
  if (!isRecord(args)) return { error: 'arguments must be an object' };
  if (args.action !== 'start' && args.action !== 'stop' && args.action !== 'status') {
    return { error: 'action must be start, stop, or status' };
  }
  const tabId = optionalId(args.tabId, 'tabId');
  if (isFailure(tabId)) return tabId;
  if (args.action === 'start') {
    if (args.name !== undefined && args.name !== null && typeof args.name !== 'string') {
      return { error: 'name must be a string' };
    }
    const name = cleanText(args.name, 120);
    const parsed: { action: 'start'; name?: string; tabId?: number } = { action: 'start' };
    if (name) parsed.name = name;
    if (typeof tabId === 'number') parsed.tabId = tabId;
    return parsed;
  }
  return { action: args.action };
}

export function parseFlowListArgs(args: unknown): { name?: string } | { error: string } {
  if (args === undefined || args === null) return {};
  if (!isRecord(args)) return { error: 'arguments must be an object' };
  if (args.name !== undefined && args.name !== null && typeof args.name !== 'string') {
    return { error: 'name must be a string' };
  }
  const name = cleanText(args.name, 120);
  return name ? { name } : {};
}

export function parseStringParams(
  value: unknown,
): Record<string, string> | undefined | { error: string } {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) return { error: 'params must be an object of strings' };
  const params: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') return { error: 'params values must be strings' };
    if (entry.includes('\0')) return { error: 'params values must be strings' };
    params[key] = entry;
  }
  return params;
}

export function parseFlowRunArgs(
  args: unknown,
): { flowId: string; params?: Record<string, string>; tabId?: number } | { error: string } {
  if (!isRecord(args)) return { error: 'arguments must be an object' };
  const flowId = cleanText(args.flowId, 80);
  if (!flowId) return { error: 'flowId is required' };
  const params = parseStringParams(args.params);
  if (isFailure(params)) return params;
  const tabId = optionalId(args.tabId, 'tabId');
  if (isFailure(tabId)) return tabId;
  return params ? { flowId, params, tabId } : { flowId, tabId };
}

export function parseFlowExportArgs(args: unknown): { flowId: string } | { error: string } {
  if (!isRecord(args)) return { error: 'arguments must be an object' };
  const flowId = cleanText(args.flowId, 80);
  if (!flowId) return { error: 'flowId is required' };
  return { flowId };
}

function paramForStep(
  step: SemanticStep,
  index: number,
  params: Record<string, string>,
): string | undefined {
  const indexKey = String(index);
  if (Object.prototype.hasOwnProperty.call(params, indexKey)) return params[indexKey];
  const keys = [step.locator?.htmlName, step.locator?.id, step.locator?.label, step.locator?.name];
  for (const key of keys) {
    if (key && Object.prototype.hasOwnProperty.call(params, key)) return params[key];
  }
  return undefined;
}

export function replayPlan(
  flow: SemanticFlow,
  params: unknown,
): { error: string } | { needsSecret: true; prompts: SecretPrompt[] } | { steps: PreparedStep[] } {
  if (!isSemanticFlow(flow)) return { error: 'flow version is not supported' };
  const parsed = parseStringParams(params);
  if (isFailure(parsed)) return parsed;
  const map = parsed || {};
  const prompts: SecretPrompt[] = [];
  const steps: PreparedStep[] = [];
  for (let i = 0; i < flow.steps.length; i++) {
    const step = flow.steps[i];
    const index = i + 1;
    const override = paramForStep(step, index, map);
    const secret = isSecretValue(step.value);
    if (secret && override === undefined) {
      const field: SecretPrompt['field'] = { action: step.action };
      if (step.locator?.label) field.label = step.locator.label;
      if (step.locator?.htmlName) field.htmlName = step.locator.htmlName;
      if (step.locator?.id) field.id = step.locator.id;
      if (step.locator?.name) field.name = step.locator.name;
      prompts.push({ step: index, field });
      continue;
    }
    let value = step.value;
    if (override !== undefined) {
      if (step.action === 'check') {
        if (override !== 'true' && override !== 'false') {
          return { error: `params for check step ${index} must be "true" or "false"` };
        }
        value = override === 'true';
      } else {
        value = override;
      }
    }
    const framePath = step.locator?.framePath;
    steps.push({
      index,
      action: step.action,
      url: step.url,
      value,
      locator: step.locator,
      attempts: locatorAttempts(step.locator),
      framePath: framePath && framePath.length ? framePath : undefined,
    });
  }
  if (prompts.length) return { needsSecret: true, prompts };
  return { steps };
}

/** Agent-facing replay status. Resolved secret strings stay in the plan only. */
export function replayAgentView(
  plan: { needsSecret: true; prompts: SecretPrompt[] } | { steps: PreparedStep[] },
): { needsSecret: true; prompts: SecretPrompt[] } | { ready: true; stepCount: number } {
  if ('steps' in plan) return { ready: true, stepCount: plan.steps.length };
  return { needsSecret: true, prompts: plan.prompts };
}
