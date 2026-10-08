import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { ERROR_MESSAGES } from '@/common/constants';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { attachObserve, beginObserve, type ObserveSession } from './observe';
import {
  OBSERVE_SETTLE_DEFAULT_MS,
  TOOL_NAMES,
  collectValidationErrors,
  describeFormField,
  formatAgentRef,
  matchFormField,
  parseAgentRef,
  parseFillFormArgs,
  type FieldValidity,
  type FormFieldCandidate,
  type FormFieldQuery,
  type ParsedFillField,
} from 'chrome-mcp-shared';

/**
 * chrome_fill_form — resolve several fields, fill them, report validity,
 * and optionally submit. Matching and validation assembly are pure.
 * Submit appends the same diff chrome_click_element returns for observe.
 */

interface FillFormToolArgs {
  fields?: unknown;
  submit?: unknown;
  frameId?: unknown;
  tabId?: number;
  windowId?: number;
}

interface IndexedField {
  index: number;
  field: ParsedFillField;
  frameId?: number;
  localRef?: string;
}

interface ApplyResult {
  ref?: string;
  ok?: boolean;
  error?: string;
}

function ok(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false };
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function frameIdsFor(frameId?: number): number[] | undefined {
  return typeof frameId === 'number' ? [frameId] : undefined;
}

function frameKey(frameId?: number): string {
  return typeof frameId === 'number' ? String(frameId) : 'main';
}

function portClosed(error: unknown): boolean {
  return /message port closed|receiving end does not exist|channel closed/i.test(errMsg(error));
}

function locateField(
  field: ParsedFillField,
  explicitFrame?: number,
): { frameId?: number; localRef?: string } | { error: string } {
  let refFrame: number | undefined;
  let localRef: string | undefined;
  if (field.ref) {
    const parsed = parseAgentRef(field.ref);
    localRef = parsed.ref;
    refFrame = parsed.frameId;
  }
  if (
    typeof explicitFrame === 'number' &&
    typeof refFrame === 'number' &&
    explicitFrame !== refFrame
  ) {
    return { error: 'frameId and ref frame suffix must match' };
  }
  return { frameId: refFrame ?? explicitFrame, localRef };
}

class FillFormTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.FILL_FORM;

  async execute(args: FillFormToolArgs): Promise<ToolResult> {
    const parsed = parseFillFormArgs(args);
    if ('error' in parsed) {
      return createErrorResponse(`${ERROR_MESSAGES.INVALID_PARAMETERS}: ${parsed.error}`);
    }

    const groups = new Map<string, IndexedField[]>();
    for (let index = 0; index < parsed.fields.length; index++) {
      const field = parsed.fields[index];
      const located = locateField(field, parsed.frameId);
      if ('error' in located) {
        return createErrorResponse(
          `${ERROR_MESSAGES.INVALID_PARAMETERS}: fields[${index}] ${located.error}`,
        );
      }
      const item: IndexedField = { index, field, ...located };
      const key = frameKey(item.frameId);
      const group = groups.get(key) || [];
      group.push(item);
      groups.set(key, group);
    }

    const filled: Array<{
      index: number;
      field: string;
      ref: string;
      value: string | number | boolean;
    }> = [];
    const failed: Array<{ index: number; field: string; reason: string }> = [];
    const validity: FieldValidity[] = [];
    let submitFrame = parsed.frameId;
    let session: ObserveSession | null = null;

    try {
      const explicit = await this.tryGetTab(args.tabId);
      const tab = explicit || (await this.getActiveTabOrThrowInWindow(args.windowId));
      if (!tab.id) {
        return createErrorResponse(ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID');
      }

      for (const group of groups.values()) {
        const frameId = group[0]?.frameId;
        await this.injectContentScript(
          tab.id,
          ['inject-scripts/fill-helper.js'],
          false,
          'ISOLATED',
          false,
          frameIdsFor(frameId),
        );
        const listed = await this.sendMessageToTab(
          tab.id,
          { action: TOOL_MESSAGE_TYPES.FILL_FORM_LIST },
          frameId,
        );
        if (!listed || !Array.isArray(listed.candidates)) {
          throw new Error('fill helper did not list fields. Reload the page and retry.');
        }
        const candidates: FormFieldCandidate[] = listed.candidates;
        const assignments: Array<{ item: IndexedField; ref: string }> = [];

        for (const item of group) {
          const fieldName = describeFormField(item.field, item.index);
          const query: FormFieldQuery = {
            ref: item.localRef,
            label: item.field.label,
            name: item.field.name,
            selector: item.field.selector,
            type: item.field.type,
          };
          if (item.field.selector && !item.localRef) {
            try {
              const resolved = (await this.sendMessageToTab(
                tab.id,
                { action: TOOL_MESSAGE_TYPES.FILL_FORM_RESOLVE, selector: item.field.selector },
                frameId,
              )) as FormFieldCandidate;
              if (resolved && resolved.ref) {
                query.resolvedRef = resolved.ref;
                if (!candidates.some((candidate) => candidate.ref === resolved.ref)) {
                  candidates.push(resolved);
                }
              }
            } catch (error) {
              failed.push({ index: item.index, field: fieldName, reason: errMsg(error) });
              continue;
            }
          }
          const matched = matchFormField(candidates, query);
          if ('error' in matched) {
            failed.push({ index: item.index, field: fieldName, reason: matched.error });
            continue;
          }
          assignments.push({ item, ref: matched.ref });
        }

        let results: ApplyResult[] = [];
        let groupValidity: FieldValidity[] = [];
        if (assignments.length > 0) {
          const applied = await this.sendMessageToTab(
            tab.id,
            {
              action: TOOL_MESSAGE_TYPES.FILL_FORM_APPLY,
              items: assignments.map((assignment) => ({
                ref: assignment.ref,
                value: assignment.item.field.value,
              })),
            },
            frameId,
          );
          results = Array.isArray(applied?.results) ? applied.results : [];
          groupValidity = Array.isArray(applied?.validity) ? applied.validity : [];
        } else {
          const read = await this.sendMessageToTab(
            tab.id,
            { action: TOOL_MESSAGE_TYPES.FILL_FORM_VALIDITY, refs: [] },
            frameId,
          );
          groupValidity = Array.isArray(read?.validity) ? read.validity : [];
        }

        const resultByRef = new Map<string, ApplyResult>();
        for (const result of results) {
          if (result && result.ref) resultByRef.set(result.ref, result);
        }
        for (const assignment of assignments) {
          const fieldName = describeFormField(assignment.item.field, assignment.item.index);
          const result = resultByRef.get(assignment.ref);
          if (!result || result.error) {
            failed.push({
              index: assignment.item.index,
              field: fieldName,
              reason: result?.error || 'fill did not return a result',
            });
            continue;
          }
          if (submitFrame === undefined && parsed.submit) submitFrame = frameId;
          filled.push({
            index: assignment.item.index,
            field: fieldName,
            ref: formatAgentRef(assignment.ref, frameId),
            value: assignment.item.field.value,
          });
        }
        for (const fact of groupValidity) {
          if (!fact || !fact.ref) continue;
          validity.push({ ...fact, ref: formatAgentRef(fact.ref, frameId) });
        }
      }

      const validationErrors = collectValidationErrors(validity);
      let submit: { ok: boolean; reason?: string } | undefined;
      if (parsed.submit) {
        if (failed.length > 0) {
          submit = { ok: false, reason: 'skipped because some fields failed' };
        } else {
          let submitRef: string | undefined;
          if (parsed.submit.kind === 'ref') {
            const target = parseAgentRef(parsed.submit.ref);
            submitRef = target.ref;
            if (typeof target.frameId === 'number') submitFrame = target.frameId;
          }
          try {
            session = await beginObserve(tab.id, OBSERVE_SETTLE_DEFAULT_MS);
          } catch {
            session = null;
          }
          try {
            await this.injectContentScript(
              tab.id,
              ['inject-scripts/fill-helper.js'],
              false,
              'ISOLATED',
              false,
              frameIdsFor(submitFrame),
            );
            const submitted = await this.sendMessageToTab(
              tab.id,
              { action: TOOL_MESSAGE_TYPES.FILL_FORM_SUBMIT, ref: submitRef },
              submitFrame,
            );
            submit =
              submitted && submitted.ok ? { ok: true } : { ok: false, reason: 'submit failed' };
          } catch (error) {
            submit = portClosed(error) ? { ok: true } : { ok: false, reason: errMsg(error) };
          }
        }
      }

      const orderedFilled = filled
        .sort((a, b) => a.index - b.index)
        .map(({ field, ref, value }) => ({ field, ref, value }));
      const orderedFailed = failed
        .sort((a, b) => a.index - b.index)
        .map(({ field, reason }) => ({ field, reason }));
      return attachObserve(
        session,
        ok({ filled: orderedFilled, failed: orderedFailed, validationErrors, submit }),
      );
    } catch (error) {
      return attachObserve(
        session,
        createErrorResponse(`chrome_fill_form failed: ${errMsg(error)}`),
      );
    }
  }
}

export const fillFormTool = new FillFormTool();
