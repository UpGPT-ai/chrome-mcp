# CONTRACT: DOM-first agent tools (no-screenshot navigation)

Repo: ~/tools/mcp-chrome (pnpm monorepo). Branch: feat/dom-agent-tools.
Goal: let an agent see the page as structured text and act on it by element id, with the result of each
action returned as a diff, so screenshots become the exception.

## Already exists (do NOT rebuild; extend)

- `chrome_read_page` (read-page.ts + inject-scripts/accessibility-tree-helper.js): a11y tree, `ref_N` ids
  (window.\_\_claudeElementMap), filter=interactive, depth, refId focus. Viewport-only. Partial open-shadow support.
- `chrome_computer` already has: left_click, right_click, double_click, triple_click, left_click_drag,
  scroll, scroll_to, type, key, fill, fill_form, hover, wait, screenshot. Accepts `ref`.
- `chrome_click_element`, `chrome_fill_or_select` (interaction.ts), `chrome_keyboard`, `chrome_console`,
  `chrome_network_capture`, `chrome_javascript`, wait-helper.js (text appear/disappear).
- Tab tools in tabs-manage.ts are the TEMPLATE for adding a tool (schema in packages/shared/src/tools.ts,
  executor class extending BaseBrowserToolExecutor, export in browser/index.ts, registered via the tools map).

## Work items (the real gaps)

1. **`chrome_snapshot`** (new tool, new file browser/snapshot.ts). Compact accessibility snapshot:
   one line per element: `ref role "name" [value=..] [state flags: disabled checked expanded required invalid]`.
   Options: `scope` ('viewport'|'page', default 'page'), `filter` ('interactive'|'all'), `refId`, `maxItems`,
   `since` (a snapshotId from a previous call; returns only added/removed/changed lines). Returns `snapshotId`.
   Refs MUST stay stable for the same element across calls while it remains in the DOM
   (reuse the existing ref map; never renumber an element already mapped).
2. **Frames and shadow DOM.** Snapshot and ref-based click/fill/computer must work for refs inside
   same-origin iframes (ref carries `frameId`) and inside open shadow roots at any depth. Cross-origin
   iframes: list the frame as `frame[src=..] (cross-origin, not traversed)` and support `frameId`-targeted
   chrome.scripting execution when the extension has host access. Extend accessibility-tree-helper.js and the
   click/fill helpers; do not fork them.
3. **Action-then-diff (`observe`).** Add optional `observe: true|{settleMs?:number}` to
   chrome_click_element, chrome_fill_or_select and chrome_computer. When set, after the action wait for
   DOM quiet (default settle 300ms, cap 3000ms) and append to the result a `diff` object:
   `{url:{before,after}|null, title:{..}|null, domChanges:{added:[snapshot lines], removed:[..], changed:[..]} (cap 40 each),
  newRequests:[{method,url,status}] (cap 20), newConsoleErrors:[..] (cap 10), dialogOpened:boolean}`.
   Implementation reuses snapshot diffing from item 1 plus console-buffer.ts and a lightweight webRequest tap.
4. **`chrome_wait_for`** (new tool, browser/wait-for.ts). Conditions (any one or `all`): `text`, `textGone`,
   `selector`, `selectorGone`, `ref`, `refGone`, `urlMatches` (regex), `networkIdleMs` (no requests for N ms),
   `domQuietMs`. `timeoutMs` default 10000, max 60000. Returns `{met: string[], waitedMs}` or a timeout error naming
   which conditions were unmet. Reuse wait-helper.js for text conditions.
5. **Hover and drag verification and fixes.** Audit chrome_computer hover and left_click_drag by `ref`
   (start ref + end ref, plus offsets). Hover must trigger real :hover/mouseenter menus (CDP Input.dispatchMouseEvent
   with a move sequence, not just synthetic events) and support `holdMs`. Drag must support slider handles and
   HTML5 drag-and-drop (dragstart/dragover/drop via CDP Input.dispatchDragEvent or setDragInterception).
   Fix what is broken; document what remains unsupported in the tool description.
6. **`chrome_fill_form`** (new tool, browser/fill-form.ts). Input: `fields: [{ref?|label?|name?|selector?, value, type?}]`,
   `submit?: boolean|{ref}`. Resolves each field (label text via aria-labelledby/for/placeholder), fills with proper
   events (input/change/blur, React-controlled-input safe via native setter), handles select, checkbox, radio, date,
   contenteditable. After filling, returns `{filled:[..], failed:[{field,reason}], validationErrors:[{ref,message}]}`
   by reading `:invalid`, `validationMessage`, and aria-invalid/aria-errormessage. Optionally submits and returns the diff (item 3).
7. **Storage, cookies, interception.**
   - `chrome_cookies` (get/set/delete/list by url|domain; needs manifest permission `cookies`).
   - `chrome_storage` (action get|set|remove|clear|list for `local`|`session` storage and IndexedDB database/store names list, on the tab's origin, via scripting).
   - `chrome_intercept` (CDP Fetch domain on a tab): action `add_rule|list_rules|remove_rule|clear`, rule =
     `{urlPattern, method?, action:'block'|'mock'|'modify_headers', status?, headers?, body?, contentType?}`;
     rules live in memory per tab, are removed on tab close or detach; every matched request is logged and
     retrievable via `list_rules` (hit counts + last 20 hits). Must coexist with chrome_network_capture's debugger use
     (share one debugger attachment per tab; look at network-capture-debugger.ts for how it attaches).

## Cross-cutting rules

- Every new tool: schema in packages/shared/src/tools.ts (TOOL_NAMES + TOOL_SCHEMAS), executor in browser/, export in
  browser/index.ts, name constants added. Match tabs-manage.ts style and its error helpers (`createErrorResponse`).
- Tool descriptions must tell the agent the preferred order: snapshot -> act by ref (observe:true) -> read diff;
  screenshot only if layout matters.
- New manifest permissions (cookies) go in wxt.config.ts; list them in the final report because the user must re-approve.
- No new runtime dependencies without asking.
- Tests: where the native-server/shared packages have jest/vitest, add unit tests for pure logic
  (snapshot diff, wait condition evaluation, form field resolution, intercept rule matching). Extract that logic into
  pure functions to make it testable. Browser-bound code is verified manually by the orchestrator.
- No Co-Authored-By or "Generated with" trailers in any commit message. Conventional commits, one per work item.

## Build order and gates (orchestrator runs gates, not the implementer)

Order: 1 -> 2 -> 3 -> 4 -> 6 -> 5 -> 7 (3 depends on 1; 6 depends on 3).
Gates after each item: `cd packages/shared && npx tsup src/index.ts --format cjs,esm --dts --clean`, then
`cd app/chrome-extension && npx wxt build 2>&1 | tail`, then `cd app/native-server && npx jest --coverage=false`.
Stop after each item and report the files changed.
