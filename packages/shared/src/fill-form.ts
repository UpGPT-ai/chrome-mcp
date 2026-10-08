/**
 * Pure chrome_fill_form parsing, field matching, and validation assembly.
 * The page collects control facts; this module decides which control
 * matches a request and which validity facts become agent-facing errors.
 */

export const FILL_FORM_FIELD_CAP = 50;
export const FILL_FORM_ERROR_CAP = 40;

export interface FillFormFieldInput {
  ref?: unknown;
  label?: unknown;
  name?: unknown;
  selector?: unknown;
  type?: unknown;
  value?: unknown;
}

export interface FillFormArgs {
  fields?: unknown;
  submit?: unknown;
  frameId?: unknown;
}

export interface ParsedFillField {
  ref?: string;
  label?: string;
  name?: string;
  selector?: string;
  type?: string;
  value: string | number | boolean;
}

export type ParsedFillSubmit = null | { kind: 'default' } | { kind: 'ref'; ref: string };

export interface ParsedFillForm {
  fields: ParsedFillField[];
  submit: ParsedFillSubmit;
  frameId?: number;
}

export interface FormFieldCandidate {
  ref: string;
  id?: string;
  name?: string;
  type?: string;
  tag?: string;
  labels?: readonly string[];
  placeholder?: string;
}

export interface FormFieldQuery {
  ref?: string;
  label?: string;
  name?: string;
  selector?: string;
  type?: string;
  /** Set by the browser after a CSS selector resolves to a ref. */
  resolvedRef?: string;
}

export interface FieldValidity {
  ref: string;
  valid?: boolean;
  validationMessage?: string;
  ariaInvalid?: unknown;
  ariaErrorMessage?: string;
}

export interface FormValidationError {
  ref: string;
  message: string;
}

const TEXT_TYPES = new Set(['', 'text', 'email', 'password', 'search', 'tel', 'url', 'number']);

function norm(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function optionalString(value: unknown, name: string): string | undefined | { error: string } {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return { error: `${name} must be a string` };
  const trimmed = value.trim();
  if (!trimmed) return { error: `${name} must be a non-empty string` };
  return trimmed;
}

function fieldValue(value: unknown): string | number | boolean | { error: string } {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      return { error: 'field value must be a finite number, string, or boolean' };
    }
    return value;
  }
  return { error: 'field value must be a string, number, or boolean' };
}

export function describeFormField(
  field: Pick<ParsedFillField, 'ref' | 'label' | 'name' | 'selector'>,
  index: number,
): string {
  let locator = 'unspecified';
  if (field.ref) locator = `ref ${field.ref}`;
  else if (field.label) locator = `label "${field.label}"`;
  else if (field.name) locator = `name "${field.name}"`;
  else if (field.selector) locator = `selector "${field.selector}"`;
  return `fields[${index}] ${locator}`;
}

export function parseFillFormArgs(
  args: FillFormArgs | null | undefined,
): ParsedFillForm | { error: string } {
  if (args === null || args === undefined || typeof args !== 'object') {
    return { error: 'fields must be a non-empty array' };
  }
  if (!Array.isArray(args.fields) || args.fields.length === 0) {
    return { error: 'fields must be a non-empty array' };
  }
  if (args.fields.length > FILL_FORM_FIELD_CAP) {
    return { error: `fields cannot exceed ${FILL_FORM_FIELD_CAP}` };
  }

  let frameId: number | undefined;
  if (args.frameId !== undefined) {
    const n = typeof args.frameId === 'number' ? args.frameId : Number(args.frameId);
    if (!Number.isInteger(n) || n < 0) return { error: 'frameId must be a non-negative integer' };
    frameId = n;
  }

  let submit: ParsedFillSubmit = null;
  if (args.submit !== undefined && args.submit !== null && args.submit !== false) {
    if (args.submit === true) submit = { kind: 'default' };
    else if (typeof args.submit === 'object') {
      const ref = optionalString((args.submit as { ref?: unknown }).ref, 'submit.ref');
      if (typeof ref !== 'string') return ref || { error: 'submit.ref must be a non-empty string' };
      submit = { kind: 'ref', ref };
    } else {
      return { error: 'submit must be true or { ref }' };
    }
  }

  const fields: ParsedFillField[] = [];
  for (let i = 0; i < args.fields.length; i++) {
    const raw = args.fields[i];
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { error: `fields[${i}] must be an object` };
    }
    const input = raw as FillFormFieldInput;
    const value = fieldValue(input.value);
    if (typeof value === 'object') return { error: `fields[${i}] ${value.error}` };
    const ref = optionalString(input.ref, `fields[${i}].ref`);
    if (ref && typeof ref !== 'string') return ref;
    const label = optionalString(input.label, `fields[${i}].label`);
    if (label && typeof label !== 'string') return label;
    const name = optionalString(input.name, `fields[${i}].name`);
    if (name && typeof name !== 'string') return name;
    const selector = optionalString(input.selector, `fields[${i}].selector`);
    if (selector && typeof selector !== 'string') return selector;
    const type = optionalString(input.type, `fields[${i}].type`);
    if (type && typeof type !== 'string') return type;
    if (!ref && !label && !name && !selector) {
      return { error: `fields[${i}] needs a ref, label, name, or selector` };
    }
    const field: ParsedFillField = { value };
    if (ref) field.ref = ref;
    if (label) field.label = label;
    if (name) field.name = name;
    if (selector) field.selector = selector;
    if (type) field.type = type;
    fields.push(field);
  }

  return { fields, submit, frameId };
}

function typeMatches(candidate: FormFieldCandidate, wanted: string | undefined): boolean {
  if (!wanted) return true;
  const expected = norm(wanted);
  const type = norm(candidate.type);
  const tag = norm(candidate.tag);
  if (!expected) return true;
  if (expected === type || expected === tag) return true;
  if (
    (expected === 'text' || expected === 'textbox' || expected === 'input') &&
    (tag === 'textarea' ||
      type === 'contenteditable' ||
      type === 'textarea' ||
      TEXT_TYPES.has(type))
  ) {
    return true;
  }
  if (
    (expected === 'select' || expected === 'dropdown') &&
    (type === 'select' || tag === 'select')
  ) {
    return true;
  }
  return false;
}

function labelScore(candidate: FormFieldCandidate, wanted: string): number {
  const texts = [...(candidate.labels || []), candidate.placeholder || ''];
  let best = 0;
  for (const text of texts) {
    const hay = norm(text);
    if (!hay) continue;
    if (hay === wanted) best = Math.max(best, 6);
    else if (hay.includes(wanted) || (hay.length > 2 && wanted.includes(hay)))
      best = Math.max(best, 3);
  }
  return best;
}

/**
 * Pick one control. An explicit ref or a resolved selector wins.
 * Name and label must both match when both are provided.
 * Equal top scores are an ambiguous error.
 */
export function matchFormField(
  candidates: readonly FormFieldCandidate[],
  query: FormFieldQuery,
): { ref: string } | { error: string } {
  const explicit = norm(query.ref || query.resolvedRef);
  if (query.ref || query.resolvedRef) {
    if (!explicit) return { error: 'ref must be a non-empty string' };
    const found = candidates.find((candidate) => norm(candidate.ref) === explicit);
    if (!found) return { error: `ref ${query.ref || query.resolvedRef} not found` };
    if (!typeMatches(found, query.type)) {
      return {
        error: `ref ${found.ref} is ${found.type || found.tag || 'unknown'}, not ${query.type}`,
      };
    }
    return { ref: found.ref };
  }

  if (query.selector && !query.resolvedRef) return { error: 'selector did not match an element' };
  if (!query.label && !query.name) return { error: 'field needs a ref, label, name, or selector' };

  const wantedName = norm(query.name);
  const wantedLabel = norm(query.label);
  const scored: Array<{ ref: string; score: number }> = [];
  for (const candidate of candidates) {
    if (!candidate.ref) continue;
    if (!typeMatches(candidate, query.type)) continue;
    let score = 0;
    if (wantedName) {
      const name = norm(candidate.name);
      const id = norm(candidate.id);
      if (name !== wantedName && id !== wantedName) continue;
      score += name === wantedName ? 10 : 8;
    }
    if (wantedLabel) {
      const labels = labelScore(candidate, wantedLabel);
      if (labels === 0) continue;
      score += labels;
    }
    if (score > 0) scored.push({ ref: candidate.ref, score });
  }

  if (scored.length === 0) return { error: 'no matching field' };
  scored.sort((a, b) => b.score - a.score || a.ref.localeCompare(b.ref));
  const top = scored[0];
  if (scored.length > 1 && scored[1].score === top.score) {
    return { error: `ambiguous match: ${top.ref}, ${scored[1].ref}` };
  }
  return { ref: top.ref };
}

function ariaIsInvalid(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value !== 'string') return false;
  const flag = value.trim().toLowerCase();
  return flag === 'true' || flag === 'grammar' || flag === 'spelling';
}

export function validationErrorFor(field: FieldValidity): FormValidationError | null {
  const ref = String(field.ref || '').trim();
  if (!ref) return null;
  const nativeInvalid = field.valid === false;
  const ariaInvalid = ariaIsInvalid(field.ariaInvalid);
  if (!nativeInvalid && !ariaInvalid) return null;
  const nativeMessage = String(field.validationMessage || '').trim();
  const ariaMessage = String(field.ariaErrorMessage || '').trim();
  const message = (nativeInvalid && nativeMessage) || ariaMessage || 'invalid';
  return { ref, message };
}

export function collectValidationErrors(
  fields: readonly FieldValidity[],
  cap: number = FILL_FORM_ERROR_CAP,
): FormValidationError[] {
  const limit = Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : FILL_FORM_ERROR_CAP;
  const seen = new Set<string>();
  const errors: FormValidationError[] = [];
  for (const field of fields) {
    const error = validationErrorFor(field);
    if (!error || seen.has(error.ref)) continue;
    seen.add(error.ref);
    errors.push(error);
    if (errors.length >= limit) break;
  }
  return errors;
}
