import { describe, expect, test } from '@jest/globals';
import {
  AGENT_PREFERRED_ORDER,
  NATIVE_PDF_BYTE_LIMIT,
  TOOL_SCHEMAS,
  base64ByteLength,
  devToolsAttachedMessage,
  filesForChooserMode,
  formatCdpRef,
  formatPierceSnapshot,
  isDebuggerAttachedError,
  listPierceBackendIds,
  parseCdpRef,
  parseFileAllowDirs,
  parseFileChooserArgs,
  parsePrintPdfArgs,
  pathInsideDir,
  pdfTooLarge,
  pierceBoxBudget,
  pierceFailureAction,
  quadIntersectsRect,
  resolveDownloadPath,
  validateChooserPaths,
  viewportPointFromQuad,
  viewportRectFromLayout,
  type CdpDomNode,
} from 'chrome-mcp-shared';

const sampleDom: CdpDomNode = {
  nodeType: 9,
  nodeName: '#document',
  children: [
    {
      nodeType: 1,
      nodeName: 'DIV',
      backendNodeId: 1,
      children: [{ nodeType: 3, nodeName: '#text', nodeValue: 'ignore' }],
    },
    {
      nodeType: 1,
      nodeName: 'BUTTON',
      backendNodeId: 4,
      children: [{ nodeType: 3, nodeName: '#text', nodeValue: 'Save' }],
    },
    {
      nodeType: 1,
      nodeName: 'DIV',
      backendNodeId: 9,
      attributes: ['aria-label', 'Panel'],
      shadowRoots: [
        {
          nodeType: 11,
          nodeName: '#document-fragment',
          children: [
            {
              nodeType: 1,
              nodeName: 'INPUT',
              backendNodeId: 12,
              attributes: ['type', 'text', 'placeholder', 'Email'],
            },
          ],
        },
      ],
    },
    {
      nodeType: 1,
      nodeName: 'INPUT',
      backendNodeId: 7,
      attributes: ['type', 'checkbox', 'aria-label', 'Say "hi"', 'checked', '', 'disabled', ''],
    },
  ],
};

describe('chrome_file_chooser paths', () => {
  test('requires absolute paths and rejects escapes', () => {
    expect(validateChooserPaths(['notes/file.txt'])).toEqual({
      error: 'path must be absolute: notes/file.txt',
    });
    expect(validateChooserPaths([''])).toEqual({ error: 'path is empty' });
    expect(validateChooserPaths(['/tmp/a\0b'])).toEqual({ error: 'path contains a null byte' });
    expect(validateChooserPaths([])).toEqual({
      error: 'paths must be a non-empty array of absolute file paths',
    });
    expect(validateChooserPaths(['/tmp/allow/../allow/file.txt'])).toEqual({
      paths: ['/tmp/allow/file.txt'],
    });
  });

  test('accepts any absolute path when no allow-list is set', () => {
    expect(validateChooserPaths(['/tmp/allow/file.txt'], null)).toEqual({
      paths: ['/tmp/allow/file.txt'],
    });
    expect(validateChooserPaths(['/tmp/allow/file.txt'], [])).toEqual({
      paths: ['/tmp/allow/file.txt'],
    });
    expect(validateChooserPaths(['C:\\Users\\a\\b.txt'])).toEqual({
      paths: ['C:\\Users\\a\\b.txt'],
    });
  });

  test('keeps a path inside an allow directory and rejects a prefix lookalike', () => {
    expect(pathInsideDir('/tmp/allow', '/tmp/allow/file.txt')).toBe(true);
    expect(pathInsideDir('/tmp/allow', '/tmp/allow-extra/file.txt')).toBe(false);
    expect(pathInsideDir('/tmp/allow', '/tmp/allow')).toBe(false);
    expect(pathInsideDir('C:\\Downloads', 'C:\\downloads\\a.pdf')).toBe(true);
    expect(pathInsideDir('C:\\Downloads', 'C:\\Downloads-extra\\a.pdf')).toBe(false);

    const allow = ['/tmp/allow'];
    expect(validateChooserPaths(['/tmp/allow/file.txt'], allow)).toEqual({
      paths: ['/tmp/allow/file.txt'],
    });
    expect(validateChooserPaths(['/tmp/allow/../allow-extra/file.txt'], allow)).toEqual({
      error: 'path is outside the file chooser allow-list: /tmp/allow-extra/file.txt',
    });
  });

  test('parses an allow-list and treats a missing list as no policy', () => {
    expect(parseFileAllowDirs(undefined)).toBeNull();
    expect(parseFileAllowDirs([])).toBeNull();
    expect(parseFileAllowDirs(['/tmp/allow/', '/var/tmp'])).toEqual(['/tmp/allow', '/var/tmp']);
    expect(parseFileAllowDirs(['notes'])).toEqual({
      error: 'fileChooserAllowDirs entries must be absolute directories',
    });
    expect(parseFileAllowDirs({ dir: '/tmp' })).toEqual({
      error: 'fileChooserAllowDirs must be a list of absolute directories',
    });
  });

  test('requires exactly one of ref or selector', () => {
    expect(parseFileChooserArgs({ paths: ['/tmp/a'] })).toEqual({
      error: 'provide exactly one of ref or selector',
    });
    expect(parseFileChooserArgs({ ref: 'ref_1', selector: '#file', paths: ['/tmp/a'] })).toEqual({
      error: 'provide exactly one of ref or selector',
    });
    expect(parseFileChooserArgs({ ref: ' cdp_4 ', paths: ['/tmp/a'], timeoutMs: 1000 })).toEqual({
      ref: 'cdp_4',
      selector: undefined,
      frameId: undefined,
      tabId: undefined,
      windowId: undefined,
      timeoutMs: 1000,
    });
    expect(parseFileChooserArgs({ selector: '#file', paths: ['/tmp/a'], timeoutMs: 10 })).toEqual({
      error: 'timeoutMs must be from 500 to 60000',
    });
  });

  test('keeps the first file when the chooser is selectSingle', () => {
    expect(filesForChooserMode('selectSingle', ['/a', '/b'])).toEqual({
      files: ['/a'],
      ignored: ['/b'],
    });
    expect(filesForChooserMode('selectMultiple', ['/a', '/b']).ignored).toEqual([]);
  });
});

describe('pierce snapshot', () => {
  test('assigns stable cdp ids and flattens shadow content', () => {
    const first = formatPierceSnapshot(sampleDom, { filter: 'all', maxItems: 20 });
    const second = formatPierceSnapshot(sampleDom, { filter: 'all', maxItems: 20 });
    expect(first.missingRoot).toBe(false);
    expect(first.lines).toEqual(second.lines);
    expect(first.lines).toEqual([
      'cdp_4 button "Save"',
      'cdp_9 generic "Panel"',
      'cdp_12 textbox "Email"',
      'cdp_7 checkbox "Say \\"hi\\"" disabled checked',
    ]);
    expect(first.lines.every((line) => !line.startsWith(' '))).toBe(true);
    expect(formatCdpRef(12)).toBe('cdp_12');
    expect(parseCdpRef('cdp_12')).toEqual({ backendNodeId: 12 });
    expect(parseCdpRef('ref_12')).toBeNull();
  });

  test('filters interactive nodes, viewports, and maxItems', () => {
    expect(formatPierceSnapshot(sampleDom, { filter: 'interactive', maxItems: 20 }).lines).toEqual([
      'cdp_4 button "Save"',
      'cdp_12 textbox "Email"',
      'cdp_7 checkbox "Say \\"hi\\"" disabled checked',
    ]);

    const visible = formatPierceSnapshot(sampleDom, {
      filter: 'all',
      maxItems: 20,
      inViewport: new Set([4]),
    });
    expect(visible.lines).toEqual(['cdp_4 button "Save"']);
    expect(visible.truncated).toBe(false);

    const capped = formatPierceSnapshot(sampleDom, { filter: 'all', maxItems: 1 });
    expect(capped.lines).toEqual(['cdp_4 button "Save"']);
    expect(capped.truncated).toBe(true);
    expect(capped.omitted).toBe(3);

    const subtree = formatPierceSnapshot(sampleDom, {
      filter: 'all',
      maxItems: 20,
      rootBackendNodeId: 9,
    });
    expect(subtree.missingRoot).toBe(false);
    expect(subtree.lines.map((line) => line.split(' ')[0])).toEqual(['cdp_9', 'cdp_12']);
    expect(
      formatPierceSnapshot(sampleDom, { filter: 'all', maxItems: 5, rootBackendNodeId: 99 })
        .missingRoot,
    ).toBe(true);
  });

  test('intersects quads with the document viewport and budgets box checks', () => {
    const rect = viewportRectFromLayout({
      pageX: 0,
      pageY: 20,
      clientWidth: 100,
      clientHeight: 50,
    });
    expect(rect).toEqual({ left: 0, top: 20, right: 100, bottom: 70 });
    expect(quadIntersectsRect([10, 30, 40, 30, 40, 50, 10, 50], rect!)).toBe(true);
    expect(quadIntersectsRect([10, 0, 20, 0, 20, 10, 10, 10], rect!)).toBe(false);
    expect(quadIntersectsRect([5, 5, 5, 5, 5, 5, 5, 5], rect!)).toBe(false);
    expect(viewportPointFromQuad([10, 20, 30, 20, 30, 40, 10, 40], 5, 5, 'center')).toEqual({
      x: 15,
      y: 25,
    });
    expect(pierceBoxBudget(400)).toBe(1600);
    expect(pierceBoxBudget(10)).toBe(200);
    expect(listPierceBackendIds(sampleDom, { filter: 'interactive', limit: 1 })).toEqual({
      ids: [4],
      capped: true,
    });
  });

  test('treats DevTools as an error and other CDP failures as a fallback', () => {
    const attached =
      'Debugger is already attached to tab 3 by another client (e.g., DevTools/extension)';
    expect(isDebuggerAttachedError(attached)).toBe(true);
    expect(isDebuggerAttachedError(devToolsAttachedMessage(3))).toBe(true);
    expect(isDebuggerAttachedError('Inspector.targetCrashed')).toBe(false);
    expect(pierceFailureAction(attached)).toBe('devtools');
    expect(pierceFailureAction('DOM.getDocument returned no root')).toBe('fallback');
  });
});

describe('chrome_print_pdf', () => {
  const now = new Date(Date.UTC(2026, 9, 8, 15, 4, 5));

  test('defaults print options and builds a timestamped name', () => {
    expect(parsePrintPdfArgs({}, now)).toEqual({
      landscape: false,
      printBackground: false,
      pageRanges: undefined,
      saveName: 'page-20261008-150405.pdf',
      tabId: undefined,
      windowId: undefined,
    });
    expect(
      parsePrintPdfArgs({ landscape: true, printBackground: true, savePath: 'report' }, now),
    ).toMatchObject({
      landscape: true,
      printBackground: true,
      saveName: 'report.pdf',
    });
  });

  test('validates page ranges and rejects paths that leave the downloads directory', () => {
    expect(parsePrintPdfArgs({ pageRanges: '1-5, 8' }, now)).toMatchObject({
      pageRanges: '1-5, 8',
    });
    expect(parsePrintPdfArgs({ pageRanges: '5-1' }, now)).toEqual({
      error: 'pageRanges start must be less than or equal to end',
    });
    expect(parsePrintPdfArgs({ pageRanges: '0-2' }, now)).toEqual({
      error: 'pageRanges pages start at 1',
    });
    expect(parsePrintPdfArgs({ savePath: '/tmp/out.pdf' }, now)).toEqual({
      error: 'savePath must be a file name or a path inside the downloads directory',
    });
    expect(parsePrintPdfArgs({ savePath: '../secret.pdf' }, now)).toEqual({
      error: 'savePath must not contain . or ..',
    });
    expect(parsePrintPdfArgs({ savePath: 'a/\0b.pdf' }, now)).toEqual({
      error: 'savePath contains a null byte',
    });
    expect(parsePrintPdfArgs({ savePath: 'foo//bar.pdf' }, now)).toMatchObject({
      saveName: 'foo/bar.pdf',
    });

    expect(resolveDownloadPath('/tmp/allow', 'nested/a.pdf')).toEqual({
      filePath: '/tmp/allow/nested/a.pdf',
    });
    expect(resolveDownloadPath('/tmp/allow', '../allow-extra/a.pdf')).toEqual({
      error: 'savePath must not contain . or ..',
    });
    expect(pathInsideDir('/tmp/allow', '/tmp/allow-extra/a.pdf')).toBe(false);
  });

  test('counts base64 bytes without writing and rejects an oversized PDF', () => {
    expect(base64ByteLength('YQ==')).toBe(1);
    expect(base64ByteLength('YWI=')).toBe(2);
    expect(base64ByteLength('YWJj')).toBe(3);
    expect(base64ByteLength('')).toEqual({ error: 'PDF data is empty' });
    expect(base64ByteLength('====')).toEqual({ error: 'PDF data is not valid base64' });
    expect(pdfTooLarge(10)).toBeNull();
    expect(pdfTooLarge(0)).toBe('PDF data is empty');
    expect(pdfTooLarge(NATIVE_PDF_BYTE_LIMIT + 1)).toContain('native messaging limit');
  });

  test('registers the tools and the pierce flag', () => {
    const snapshot = TOOL_SCHEMAS.find((tool) => tool.name === 'chrome_snapshot');
    const schema = snapshot?.inputSchema as { properties?: Record<string, unknown> };
    expect(schema.properties?.pierce).toBeTruthy();
    const chooser = TOOL_SCHEMAS.find((tool) => tool.name === 'chrome_file_chooser');
    const pdf = TOOL_SCHEMAS.find((tool) => tool.name === 'chrome_print_pdf');
    expect(chooser?.description).toContain(AGENT_PREFERRED_ORDER);
    expect(pdf?.description).toContain(AGENT_PREFERRED_ORDER);
    expect(String(snapshot?.description)).toContain('pierce:true');
  });
});
