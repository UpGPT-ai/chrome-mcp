import {
  SEMANTIC_DRAFT_STORAGE_KEY,
  SEMANTIC_FLOW_CAP,
  SEMANTIC_FLOW_STORAGE_KEY,
  appendSemanticStep,
  createSemanticFlow,
  isSemanticFlow,
  recorderStepToSemantic,
  rememberFlow,
  summarizePageChange,
  type SemanticFlow,
  type SemanticStep,
} from 'chrome-mcp-shared';

/**
 * Parallel semantic flow store. The DAG recorder keeps its own steps.
 * A draft in chrome.storage.local survives a service-worker restart.
 */

let current: SemanticFlow | null = null;
let lastTitle = '';
let begun = false;
let ready: Promise<void> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function pageTitleOf(raw: unknown): string {
  if (!isRecord(raw) || typeof raw.pageTitle !== 'string') return '';
  if (raw.pageTitle.includes('\0')) return '';
  return raw.pageTitle
    .replace(/[\r\n\t]/g, ' ')
    .trim()
    .slice(0, 300);
}

function persistDraft(): void {
  const snapshot = current;
  void chrome.storage.local.set({ [SEMANTIC_DRAFT_STORAGE_KEY]: snapshot }).catch(() => {});
}

async function loadDraft(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(SEMANTIC_DRAFT_STORAGE_KEY);
    const draft = stored?.[SEMANTIC_DRAFT_STORAGE_KEY];
    if (!begun && isSemanticFlow(draft)) current = draft;
  } catch {
    // A missing draft just means nothing is in progress.
  }
}

export function initSemanticRecording(): void {
  if (!ready) ready = loadDraft();
}

export async function prepareSemanticRecording(): Promise<void> {
  initSemanticRecording();
  if (ready) await ready;
}

export function beginSemanticRecording(meta: { id: string; name?: string }): void {
  begun = true;
  lastTitle = '';
  current = createSemanticFlow({ id: meta.id, name: meta.name });
  persistDraft();
}

export function noteRecorderSteps(steps: unknown[]): void {
  if (!current || !Array.isArray(steps) || steps.length === 0) return;
  let next = current;
  for (const raw of steps) {
    try {
      const semantic = recorderStepToSemantic(raw, {});
      if (!semantic) continue;
      const title = pageTitleOf(raw);
      const previous = next.steps[next.steps.length - 1];
      const change = previous
        ? summarizePageChange(
            { url: previous.url, title: lastTitle },
            { url: semantic.url, title: title || lastTitle },
          )
        : {};
      const step: SemanticStep =
        change.before || change.after ? { ...semantic, ...change } : semantic;
      next = appendSemanticStep(next, step);
      if (title) lastTitle = title;
    } catch {
      // One bad step must not stop the recording.
    }
  }
  current = next;
  persistDraft();
}

export function noteSemanticNavigate(id: string, url: string): void {
  noteRecorderSteps([{ id, type: 'navigate', url, pageUrl: url }]);
}

export function semanticStatus(): {
  recording: boolean;
  flowId?: string;
  name?: string;
  steps: number;
} {
  if (!current) return { recording: false, steps: 0 };
  return {
    recording: true,
    flowId: current.id,
    name: current.name,
    steps: current.steps.length,
  };
}

export async function finishSemanticRecording(): Promise<SemanticFlow | null> {
  if (ready) await ready;
  const flow = current;
  current = null;
  lastTitle = '';
  begun = false;
  try {
    await chrome.storage.local.remove(SEMANTIC_DRAFT_STORAGE_KEY);
  } catch {
    // The saved list below is the copy that matters.
  }
  if (!flow || flow.steps.length === 0) return null;
  try {
    const stored = await chrome.storage.local.get(SEMANTIC_FLOW_STORAGE_KEY);
    const existing = Array.isArray(stored?.[SEMANTIC_FLOW_STORAGE_KEY])
      ? stored[SEMANTIC_FLOW_STORAGE_KEY].filter(isSemanticFlow)
      : [];
    const next = rememberFlow(existing, flow, SEMANTIC_FLOW_CAP);
    await chrome.storage.local.set({ [SEMANTIC_FLOW_STORAGE_KEY]: next });
  } catch {
    // The in-memory flow was still returned to the caller.
  }
  return flow;
}

async function readStoredFlows(): Promise<SemanticFlow[]> {
  await prepareSemanticRecording();
  try {
    const stored = await chrome.storage.local.get(SEMANTIC_FLOW_STORAGE_KEY);
    const flows = Array.isArray(stored?.[SEMANTIC_FLOW_STORAGE_KEY])
      ? stored[SEMANTIC_FLOW_STORAGE_KEY].filter(isSemanticFlow)
      : [];
    if (!current) return flows;
    return [current, ...flows.filter((flow) => flow.id !== current?.id)];
  } catch {
    return current ? [current] : [];
  }
}

export async function listSemanticFlows(name?: string): Promise<SemanticFlow[]> {
  const flows = await readStoredFlows();
  if (!name) return flows;
  const query = name.toLowerCase();
  return flows.filter((flow) => flow.id === name || flow.name.toLowerCase().includes(query));
}

export async function getSemanticFlow(id: string): Promise<SemanticFlow | null> {
  const flows = await readStoredFlows();
  return flows.find((flow) => flow.id === id) || null;
}
