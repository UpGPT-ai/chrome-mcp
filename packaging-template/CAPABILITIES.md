# Chrome MCP: capabilities

Everything the connected AI client can do in your real, signed-in Chrome, and what is switched off.
Page access is always checked against a site policy (see the end). Every call is written to a local
audit log.

## Tools

### Reading the page

| Tool                     | What it does                                                                 |
| ------------------------ | ---------------------------------------------------------------------------- |
| `chrome_read_page`       | Accessibility-tree view of the page's elements.                              |
| `chrome_snapshot`        | Compact snapshot, one line per element: ref, role, name, value, state flags. |
| `chrome_get_web_content` | Fetch the text/HTML content of a page.                                       |
| `chrome_screenshot`      | Screenshot of the page or an element.                                        |
| `chrome_computer`        | Mouse and keyboard control plus screenshots.                                 |
| `chrome_console`         | Capture console output from a tab.                                           |
| `chrome_wait_for`        | Wait until a page condition is met.                                          |

### Acting on the page

| Tool                               | What it does                                                   |
| ---------------------------------- | -------------------------------------------------------------- |
| `chrome_click_element`             | Click an element.                                              |
| `chrome_fill_or_select`            | Fill or select a form control.                                 |
| `chrome_fill_form`                 | Fill several fields, then report validation.                   |
| `chrome_keyboard`                  | Simulate keyboard input.                                       |
| `chrome_handle_dialog`             | Answer alert/confirm/prompt dialogs.                           |
| `chrome_file_chooser`              | Set file paths on a file chooser.                              |
| `chrome_upload_file`               | Upload files to file inputs (on by default).                   |
| `chrome_handle_download`           | Wait for a download and return its details.                    |
| `chrome_print_pdf`                 | Print the page to a PDF in the downloads folder.               |
| `chrome_request_element_selection` | Ask you to pick elements on the page by hand.                  |
| `chrome_request_human`             | Pause for you to finish a CAPTCHA, passkey or hardware prompt. |
| `chrome_javascript`                | Run JavaScript in a tab (on by default).                       |

### Navigation, tabs and windows

`chrome_navigate`, `chrome_switch_tab`, `chrome_close_tabs`, `chrome_move_tabs`, `chrome_update_tab`,
`chrome_discard_tabs`, `chrome_duplicate_tab`, `chrome_reload_tabs`, `chrome_query_tabs`,
`get_windows_and_tabs`, `chrome_create_window`, `chrome_update_window`, `chrome_close_window`.

Tab groups: `chrome_group_tabs`, `chrome_ungroup_tabs`, `chrome_update_tab_group`, `chrome_list_tab_groups`.

### Network, history, bookmarks

`chrome_network_request` (a request sent with your browser's cookies), `chrome_network_capture`,
`chrome_history`, `chrome_bookmark_search`, `chrome_bookmark_add`, `chrome_bookmark_delete`.

### Performance and recording

`performance_start_trace`, `performance_stop_trace`, `performance_analyze_insight` (lightweight
summary), `chrome_gif_recorder` (animated GIF of tab activity).

### Flows (recorded, replayable)

`chrome_recording` (start/stop/check; off by default), `chrome_flow_list`, `chrome_flow_run`,
`chrome_flow_export` (plain JSON an agent can edit). Each published flow also appears as its own
`flow.<slug>` tool.

### Panels (the native host)

`chrome_panel_open`, `chrome_panel_wait`, `chrome_panel_update`, `chrome_panel_close`: show an HTML
panel to you and capture your answer.

### Google Workspace (optional, needs your own Google authorization)

`google_auth_status`, `google_auth_login`, `google_auth_logout`, `google_api_call`,
`google_api_schema`, `google_sheets_read`, `google_sheets_append`, `google_sheets_update`,
`google_sheets_ensure_tab`, `google_docs_read`, `google_docs_append_text`. Non-GET API calls are
dry-run unless confirmed. Gated by the `allowAuthTools` policy.

### Housekeeping

`chrome_audit_log` (read the last N audit entries), `chrome_reload_extension`.

### Not exposed

`chrome_inject_script`, `chrome_send_command_to_inject_script`, `chrome_userscript` and
`search_tabs_content` are disabled and not offered to clients.

## High-risk tools

Switch these in the extension popup under Tools. A tool that is off returns an error naming the switch.

| Capability        | Default | Controls                                                                    |
| ----------------- | ------- | --------------------------------------------------------------------------- |
| `cookies`         | OFF     | `chrome_cookies` (list shows metadata only; `get` returns values)           |
| `storageValues`   | OFF     | values returned by `chrome_storage` (key and database names stay available) |
| `intercept`       | OFF     | `chrome_intercept` (pause and rewrite network requests)                     |
| `grantPermission` | OFF     | `chrome_grant_permission` (needs the origin in the allowlist too)           |
| `clipboard`       | OFF     | `chrome_clipboard`                                                          |
| `recording`       | OFF     | `chrome_recording`                                                          |
| `javascript`      | ON      | `chrome_javascript`                                                         |
| `upload`          | ON      | `chrome_upload_file`                                                        |

`chrome_cookies`, `chrome_storage`, `chrome_intercept`, `chrome_grant_permission` and
`chrome_clipboard` are listed to the client but refuse to act until their switch is on.

## Safety features

- **Site policy:** `chrome://` pages, extension pages, the Chrome Web Store, password-manager pages
  and OS-settings pages are denied by default; an allowlist mode restricts agents to listed sites.
- **Untrusted envelope:** page text is wrapped in `<<UNTRUSTED_PAGE_CONTENT ...>>` markers and hidden
  text is dropped, so the model can tell page content from instructions.
- **Cross-origin confirmation:** moving to a different origin than the last page read returns
  `needs_confirmation` until the call repeats with `confirmCrossOrigin: true`.
- **Exfiltration guard:** a secret returned earlier (such as a cookie value) is refused if it later
  appears in a navigation URL query.
- **Local audit log:** `~/.chrome-mcp-agent/audit.log` (typed values, cookie values and URL queries
  redacted; rotates at 5 MB).
- **Local bridge:** listens on 127.0.0.1 only; checks Host, Origin and a bearer token
  (`~/.chrome-mcp-agent/auth-token`).
- **Data:** page content goes only to the AI client you connected. Nothing is sent to UpGPT.ai.

## Not in this zip

The bundled native server has no native SQLite module, so persistent agent-chat storage and offline
performance-trace analysis are unavailable. The browser tools above are unaffected.

Prompt-injection defences are heuristics. Use a separate Chrome profile for agent work, and keep
high-risk switches off unless a task needs one.
