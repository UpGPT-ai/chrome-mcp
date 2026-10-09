# Upstream review

Review of open pull requests and issues on [hangwin/mcp-chrome](https://github.com/hangwin/mcp-chrome)
against this fork, done 2026-10-09. Read-only: nothing was posted upstream.

| Upstream | Subject                                                                                        | Fork status                                      | Where                                                                                                                                                                                                                                                                               |
| -------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR #389  | SSRF guard on `file_url`, path traversal on `file_name`, temp-dir check on read                | Was open. Fixed here with our own implementation | `app/native-server/src/file-guard.ts`, `file-handler.ts`, tests in `src/__tests__/file-guard.test.ts` (commit `7d4ff7e`)                                                                                                                                                            |
| PR #383  | CORS origin check used `startsWith('http://127.0.0.1')`, so `http://127.0.0.1.evil.com` passed | Already fixed                                    | Exact-match `isAllowedOrigin` in `app/native-server/src/security/local-auth.ts`; the CORS plugin in `server/index.ts` uses it. Also Host check and bearer token. Tests in `security/local-auth.test.ts`                                                                             |
| PR #365  | `/ping` should report 503 when the extension bridge is stale                                   | Not ported: the stale state cannot occur here    | The bridge runs inside the native-messaging process; on stdin end or error `NativeMessagingHost.cleanup()` stops the server and exits, so a reachable `/ping` means a live host. `/ping` is also token-exempt, so probing the extension from it would widen an unauthenticated path |
| #382     | One `Server` per session, close on disconnect, `reply.hijack()` on `GET /mcp`                  | Already fixed                                    | `createMcpServer()` per `/sse` and `/mcp` session, `hijack()` in `GET /mcp` (`server/index.ts`, `mcp/mcp-server.ts`)                                                                                                                                                                |
| #377     | `ERR_HTTP_HEADERS_SENT` on streamable HTTP handshake                                           | Already fixed                                    | Same `hijack()` change; `POST /mcp` only replies in the catch path when `reply.sent` is false                                                                                                                                                                                       |
| #372     | Delegate SSE response ownership to the transport                                               | Already fixed                                    | Same as above                                                                                                                                                                                                                                                                       |
| #354     | Per-transport server factory fixes "Already connected"                                         | Already fixed                                    | Same factory. We deliberately do not call `server.close()` inside `transport.onclose` for `/mcp` (it recurses on DELETE); the comment in `server/index.ts` explains                                                                                                                 |
| #346     | Per-session server instances                                                                   | Already fixed                                    | Same factory                                                                                                                                                                                                                                                                        |
| #338     | Sequential streamable HTTP clients fail with "Already connected"                               | Already fixed                                    | Same factory. Regression tests added in `app/native-server/src/mcp/mcp-server.test.ts`                                                                                                                                                                                              |

## Notes

- #389: policy is to refuse non-http(s) schemes and any host that resolves to a non-public address
  (loopback, private, link-local and cloud metadata, CGNAT, multicast, mapped/6to4/Teredo forms). Each
  redirect hop is re-checked (maximum 5). `file_name` is reduced to one path segment, and reads,
  writes and cleanup must resolve strictly inside `chrome-mcp-uploads`. This is a behavior change:
  `chrome_upload_file` with a `fileUrl` on localhost or a LAN address now fails. Use `filePath` or
  `base64Data` for local files. No relaxation switch exists yet.
- `readBase64File` had no caller in the extension, so restricting it to the temp dir removes
  an arbitrary file read primitive without affecting a shipped tool.
- The "Already connected" family had no regression test before this review. `mcp-server.test.ts` now
  covers distinct servers per call, two concurrent sessions, and the one-transport limit of the SDK.
- Not checked: end-to-end behavior against real clients (OpenCode, Cursor, Hermes) mentioned in the
  upstream reports.
