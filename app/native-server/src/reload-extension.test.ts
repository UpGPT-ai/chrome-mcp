import { TOOL_NAMES, TOOL_SCHEMAS } from 'chrome-mcp-shared';

describe('chrome_reload_extension schema', () => {
  const tool = TOOL_SCHEMAS.find((entry) => entry.name === TOOL_NAMES.BROWSER.RELOAD_EXTENSION);

  it('is registered under its tool name', () => {
    expect(TOOL_NAMES.BROWSER.RELOAD_EXTENSION).toBe('chrome_reload_extension');
    expect(tool).toBeDefined();
  });

  it('takes no arguments', () => {
    expect(tool?.inputSchema.properties).toEqual({});
    expect(tool?.inputSchema.required ?? []).toEqual([]);
  });
});
