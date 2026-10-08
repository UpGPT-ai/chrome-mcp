import { describe, expect, test } from '@jest/globals';
import {
  collectValidationErrors,
  describeFormField,
  matchFormField,
  parseFillFormArgs,
  type FormFieldCandidate,
} from 'chrome-mcp-shared';

const candidates: FormFieldCandidate[] = [
  {
    ref: 'ref_1',
    id: 'email',
    name: 'email',
    type: 'email',
    tag: 'input',
    labels: ['Email address'],
    placeholder: 'you@example.com',
  },
  {
    ref: 'ref_2',
    id: 'work-email',
    name: 'work',
    type: 'email',
    tag: 'input',
    labels: ['Work email'],
    placeholder: '',
  },
  {
    ref: 'ref_3',
    name: 'plan',
    type: 'select',
    tag: 'select',
    labels: ['Plan'],
  },
  {
    ref: 'ref_4',
    name: 'plan',
    type: 'text',
    tag: 'input',
    labels: ['Plan notes'],
    placeholder: 'Plan',
  },
  {
    ref: 'ref_5',
    type: 'checkbox',
    tag: 'input',
    labels: ['Subscribe'],
  },
  {
    ref: 'ref_6',
    type: 'contenteditable',
    tag: 'div',
    labels: ['Bio'],
  },
];

describe('parseFillFormArgs', () => {
  test('requires a locator and accepts an empty string value', () => {
    expect(parseFillFormArgs({ fields: [] })).toEqual({
      error: 'fields must be a non-empty array',
    });
    expect(parseFillFormArgs({ fields: [{ value: '' }] })).toEqual({
      error: 'fields[0] needs a ref, label, name, or selector',
    });
    expect(
      parseFillFormArgs({
        fields: [{ label: ' Email ', value: '', type: 'email' }],
        submit: { ref: ' ref_9 ' },
      }),
    ).toEqual({
      fields: [{ label: 'Email', value: '', type: 'email' }],
      submit: { kind: 'ref', ref: 'ref_9' },
      frameId: undefined,
    });
  });

  test('rejects a bad submit and keeps boolean values', () => {
    expect(parseFillFormArgs({ fields: [{ name: 'ok', value: false }], submit: 'yes' })).toEqual({
      error: 'submit must be true or { ref }',
    });
    expect(
      parseFillFormArgs({ fields: [{ name: 'ok', value: false }], submit: true }),
    ).toMatchObject({ submit: { kind: 'default' } });
  });
});

describe('describeFormField', () => {
  test('names the locator and the field index', () => {
    expect(describeFormField({ label: 'Email' }, 0)).toBe('fields[0] label "Email"');
    expect(describeFormField({ selector: '#email' }, 2)).toBe('fields[2] selector "#email"');
  });
});

describe('matchFormField', () => {
  test('prefers an exact label and uses type to break a shared name', () => {
    expect(matchFormField(candidates, { label: 'email address' })).toEqual({ ref: 'ref_1' });
    expect(matchFormField(candidates, { label: 'you@example.com' })).toEqual({ ref: 'ref_1' });
    expect(matchFormField(candidates, { name: 'Plan', type: 'select' })).toEqual({ ref: 'ref_3' });
    expect(matchFormField(candidates, { name: 'plan', type: 'text' })).toEqual({ ref: 'ref_4' });
  });

  test('reports an ambiguous label and a missing or mistyped ref', () => {
    expect(matchFormField(candidates, { label: 'email' })).toEqual({
      error: 'ambiguous match: ref_1, ref_2',
    });
    expect(matchFormField(candidates, { ref: 'ref_9' })).toEqual({ error: 'ref ref_9 not found' });
    expect(matchFormField(candidates, { ref: 'ref_5', type: 'radio' })).toEqual({
      error: 'ref ref_5 is checkbox, not radio',
    });
    expect(matchFormField(candidates, { selector: '#nope' })).toEqual({
      error: 'selector did not match an element',
    });
  });

  test('matches a contenteditable host by label and an already resolved selector', () => {
    expect(matchFormField(candidates, { label: 'Bio', type: 'contenteditable' })).toEqual({
      ref: 'ref_6',
    });
    expect(matchFormField(candidates, { resolvedRef: 'ref_3', type: 'dropdown' })).toEqual({
      ref: 'ref_3',
    });
  });
});

describe('collectValidationErrors', () => {
  test('reads native validity first, then aria, and drops valid fields', () => {
    const errors = collectValidationErrors([
      { ref: 'ref_1', valid: false, validationMessage: 'Enter an email', ariaErrorMessage: 'bad' },
      { ref: 'ref_2', valid: true, ariaInvalid: 'false' },
      { ref: 'ref_1', valid: false, validationMessage: 'duplicate' },
      { ref: 'ref_6', valid: true, ariaInvalid: 'true', ariaErrorMessage: ' Bio is required ' },
      { ref: 'ref_5', valid: false, validationMessage: '   ' },
    ]);
    expect(errors).toEqual([
      { ref: 'ref_1', message: 'Enter an email' },
      { ref: 'ref_6', message: 'Bio is required' },
      { ref: 'ref_5', message: 'invalid' },
    ]);
  });

  test('caps the error list', () => {
    const fields = Array.from({ length: 5 }, (_, i) => ({
      ref: `ref_${i}`,
      valid: false,
      validationMessage: `problem ${i}`,
    }));
    expect(collectValidationErrors(fields, 2)).toHaveLength(2);
  });
});
