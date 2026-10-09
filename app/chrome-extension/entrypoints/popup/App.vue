<template>
  <div class="cm">
    <header class="cm-head">
      <img class="cm-logo" src="/icon/48.png" alt="" width="28" height="28" />
      <div class="cm-title">
        <strong>Chrome MCP</strong>
        <span>from UpGPT.ai</span>
      </div>
      <span class="cm-pill" :class="connected ? 'is-ok' : 'is-off'">
        {{ connected ? (serverRunning ? 'Running' : 'Connected') : 'Disconnected' }}
      </span>
    </header>

    <section class="cm-section">
      <h2>Status</h2>
      <dl class="cm-kv">
        <dt>Native host</dt>
        <dd>{{ connected ? 'connected' : 'not connected' }}</dd>
        <dt>MCP server</dt>
        <dd>
          <template v-if="serverRunning">http://127.0.0.1:{{ port }}/mcp</template>
          <template v-else>stopped</template>
        </dd>
        <dt>Port</dt>
        <dd>
          <input
            class="cm-input cm-port"
            type="number"
            min="1024"
            max="65535"
            v-model.number="portInput"
            @change="savePort"
          />
        </dd>
      </dl>
      <div class="cm-row">
        <button class="cm-btn is-primary" :disabled="busy" @click="toggleConnection">
          {{ connected ? 'Disconnect' : 'Connect' }}
        </button>
        <button class="cm-btn" :disabled="busy" @click="refresh">Refresh</button>
      </div>
      <p v-if="!connected" class="cm-note">
        Not connecting? See
        <a :href="LINKS.TROUBLESHOOTING" target="_blank" rel="noreferrer">troubleshooting</a>.
      </p>
    </section>

    <section class="cm-section">
      <details>
        <summary>MCP client config</summary>
        <div class="cm-tabs" role="tablist">
          <button
            v-for="c in clients"
            :key="c.id"
            class="cm-tab"
            :class="{ 'is-active': c.id === clientId }"
            role="tab"
            @click="clientId = c.id"
          >
            {{ c.label }}
          </button>
        </div>
        <pre class="cm-code">{{ activeClient.text }}</pre>
        <div class="cm-row">
          <button class="cm-btn" @click="copyConfig">{{ copied ? 'Copied' : 'Copy' }}</button>
        </div>
        <p class="cm-note">{{ activeClient.note }}</p>
      </details>
    </section>

    <section class="cm-section">
      <h2>Tools</h2>
      <p class="cm-note">
        High-risk tools are off until you turn them on. Changes apply to the next tool call.
      </p>
      <ul class="cm-toggles">
        <li v-for="t in toggles" :key="t.key">
          <label>
            <input
              type="checkbox"
              :checked="flags[t.key]"
              @change="setFlag(t.key, ($event.target as HTMLInputElement).checked)"
            />
            <span class="cm-toggle-label">
              {{ t.label }}
              <em v-if="t.risk" class="cm-risk">high risk</em>
            </span>
          </label>
          <small>{{ t.help }}</small>
        </li>
      </ul>
    </section>

    <section class="cm-section">
      <h2>Recording and flows</h2>
      <template v-if="flags.recording">
        <div class="cm-row">
          <button class="cm-btn" :class="{ 'is-primary': !recording }" @click="toggleRecording">
            {{ recording ? 'Stop recording' : 'Start recording' }}
          </button>
          <span class="cm-note"
            >{{ flows.length }} saved flow{{ flows.length === 1 ? '' : 's' }}</span
          >
        </div>
        <ul v-if="flows.length" class="cm-flows">
          <li v-for="f in flows.slice(0, 6)" :key="f.id">
            <span>{{ f.name || f.id }}</span>
            <button class="cm-btn is-small" @click="runFlow(f.id)">Run</button>
          </li>
        </ul>
      </template>
      <p v-else class="cm-note">Turn on “Recording and flows” above to record and replay.</p>
    </section>

    <section class="cm-section">
      <h2>Site policy</h2>
      <label class="cm-field">
        <span>Mode</span>
        <select class="cm-input" v-model="policyMode" @change="savePolicy">
          <option value="default">Default: any http(s) site except blocked ones</option>
          <option value="allowlist">Allowlist only</option>
        </select>
      </label>
      <label class="cm-field">
        <span>Allowed origins (one per line)</span>
        <textarea
          class="cm-input"
          rows="3"
          v-model="allowText"
          placeholder="https://app.example.com&#10;https://*.example.org"
          @change="savePolicy"
        ></textarea>
      </label>
      <label class="cm-field">
        <span>Blocked origins (one per line)</span>
        <textarea
          class="cm-input"
          rows="2"
          v-model="denyText"
          placeholder="https://bank.example.com"
          @change="savePolicy"
        ></textarea>
      </label>
      <p class="cm-note">
        Browser-internal pages, the Web Store and password managers are always blocked.
        {{ policySaved ? 'Saved.' : '' }}
      </p>
    </section>

    <section class="cm-section">
      <h2>About</h2>
      <p class="cm-note">
        Version {{ version }}. Every tool call from a connected client runs in your own Chrome.
        Calls to sensitive tools are written to <code>~/.chrome-mcp-agent/audit.log</code>.
      </p>
      <p class="cm-links">
        <a :href="LINKS.HOME" target="_blank" rel="noreferrer">upgpt.ai/chrome-mcp</a>
        <a :href="LINKS.DOCS" target="_blank" rel="noreferrer">Docs</a>
        <a :href="LINKS.TOOLS" target="_blank" rel="noreferrer">Tools</a>
        <a :href="LINKS.SECURITY" target="_blank" rel="noreferrer">Security</a>
        <a :href="LINKS.REPO" target="_blank" rel="noreferrer">Source</a>
      </p>
    </section>

    <footer class="cm-foot">Open source, MIT, built by UpGPT.ai</footer>
  </div>
</template>

<script lang="ts" setup>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import {
  HIGH_RISK_DEFAULTS,
  HIGH_RISK_STORAGE_KEY,
  parseHighRiskFlags,
  SITE_POLICY_ALLOW_ORIGINS_KEY,
  SITE_POLICY_DENY_ORIGINS_KEY,
  SITE_POLICY_MODE_KEY,
  type HighRiskFlags,
} from 'chrome-mcp-shared';
import { LINKS, NATIVE_HOST } from '@/common/constants';
import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';

type ToggleKey = keyof HighRiskFlags;

const toggles: { key: ToggleKey; label: string; help: string; risk: boolean }[] = [
  {
    key: 'javascript',
    label: 'Run JavaScript in pages',
    help: 'chrome_javascript. On by default.',
    risk: false,
  },
  {
    key: 'upload',
    label: 'Upload files',
    help: 'chrome_file_chooser and upload. Restricted to allowed folders when set.',
    risk: false,
  },
  {
    key: 'cookies',
    label: 'Cookies',
    help: 'Read and write cookies, including session cookies.',
    risk: true,
  },
  {
    key: 'storageValues',
    label: 'Storage values',
    help: 'Read localStorage, sessionStorage and IndexedDB values. Key names stay available.',
    risk: true,
  },
  {
    key: 'intercept',
    label: 'Network interception',
    help: 'Block, modify or mock requests.',
    risk: true,
  },
  {
    key: 'grantPermission',
    label: 'Grant site permissions',
    help: 'Grant camera, location and similar permissions to allow-listed origins.',
    risk: true,
  },
  {
    key: 'clipboard',
    label: 'Clipboard',
    help: 'Read and write the system clipboard.',
    risk: true,
  },
  {
    key: 'recording',
    label: 'Recording and flows',
    help: 'Record browser actions and replay them as flows.',
    risk: true,
  },
  {
    key: 'userscript',
    label: 'Persistent userscripts',
    help: 'Inject scripts that stay installed across page loads.',
    risk: true,
  },
];

const flags = reactive<HighRiskFlags>({ ...HIGH_RISK_DEFAULTS });
const connected = ref(false);
const serverRunning = ref(false);
const port = ref<number>(NATIVE_HOST.DEFAULT_PORT);
const portInput = ref<number>(NATIVE_HOST.DEFAULT_PORT);
const busy = ref(false);
const version = chrome.runtime.getManifest().version;

const policyMode = ref<'default' | 'allowlist'>('default');
const allowText = ref('');
const denyText = ref('');
const policySaved = ref(false);

const recording = ref(false);
const flows = ref<{ id: string; name?: string }[]>([]);

const clientId = ref('claude-code');
const copied = ref(false);

const url = computed(() => `http://127.0.0.1:${port.value}/mcp`);

const clients = computed(() => {
  const tokenFile = '~/.chrome-mcp-agent/auth-token';
  const json = (headers: Record<string, string>) =>
    JSON.stringify(
      { mcpServers: { 'chrome-mcp': { type: 'http', url: url.value, headers } } },
      null,
      2,
    );
  return [
    {
      id: 'claude-code',
      label: 'Claude Code',
      text:
        `claude mcp add --transport http -s user chrome-mcp ${url.value} \\\n` +
        `  --header "Authorization: Bearer $(cat ${tokenFile})"`,
      note: 'Run this in a terminal. On Windows, read %USERPROFILE%\\.chrome-mcp-agent\\auth-token.',
    },
    {
      id: 'claude-desktop',
      label: 'Claude Desktop',
      text: JSON.stringify(
        {
          mcpServers: {
            'chrome-mcp': {
              command: 'npx',
              args: ['-y', 'mcp-remote', url.value, '--header', 'Authorization:${AUTH}'],
              env: { AUTH: 'Bearer <contents of ~/.chrome-mcp-agent/auth-token>' },
            },
          },
        },
        null,
        2,
      ),
      note: 'Add to claude_desktop_config.json, replace the token, then restart Claude Desktop.',
    },
    {
      id: 'cursor',
      label: 'Cursor',
      text: json({ Authorization: 'Bearer <contents of ~/.chrome-mcp-agent/auth-token>' }),
      note: 'Add to ~/.cursor/mcp.json and replace the token placeholder.',
    },
    {
      id: 'generic',
      label: 'Other',
      text: json({ Authorization: 'Bearer <contents of ~/.chrome-mcp-agent/auth-token>' }),
      note: 'Streamable HTTP. Any client that supports custom headers works.',
    },
  ];
});

const activeClient = computed(() => clients.value.find((c) => c.id === clientId.value)!);

async function copyConfig() {
  try {
    await navigator.clipboard.writeText(activeClient.value.text);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    copied.value = false;
  }
}

async function loadSettings() {
  const stored = await chrome.storage.local.get([
    HIGH_RISK_STORAGE_KEY,
    SITE_POLICY_MODE_KEY,
    SITE_POLICY_ALLOW_ORIGINS_KEY,
    SITE_POLICY_DENY_ORIGINS_KEY,
    'nativeServerPort',
  ]);
  Object.assign(flags, parseHighRiskFlags(stored[HIGH_RISK_STORAGE_KEY]));
  policyMode.value = stored[SITE_POLICY_MODE_KEY] === 'allowlist' ? 'allowlist' : 'default';
  const toLines = (v: unknown) => (Array.isArray(v) ? v.map(String).join('\n') : '');
  allowText.value = toLines(stored[SITE_POLICY_ALLOW_ORIGINS_KEY]);
  denyText.value = toLines(stored[SITE_POLICY_DENY_ORIGINS_KEY]);
  const p = Number(stored.nativeServerPort);
  if (Number.isInteger(p) && p > 0) {
    port.value = p;
    portInput.value = p;
  }
}

async function setFlag(key: ToggleKey, value: boolean) {
  flags[key] = value;
  // Store only booleans. Absent keys keep their built-in default.
  await chrome.storage.local.set({ [HIGH_RISK_STORAGE_KEY]: { ...flags } });
  if (key === 'recording' && value) await loadFlows();
}

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

async function savePolicy() {
  await chrome.storage.local.set({
    [SITE_POLICY_MODE_KEY]: policyMode.value,
    [SITE_POLICY_ALLOW_ORIGINS_KEY]: lines(allowText.value),
    [SITE_POLICY_DENY_ORIGINS_KEY]: lines(denyText.value),
  });
  policySaved.value = true;
  setTimeout(() => (policySaved.value = false), 1500);
}

async function savePort() {
  const p = Number(portInput.value);
  if (!Number.isInteger(p) || p < 1024 || p > 65535) {
    portInput.value = port.value;
    return;
  }
  port.value = p;
  await chrome.storage.local.set({ nativeServerPort: p });
}

async function refresh() {
  try {
    const res = await chrome.runtime.sendMessage({
      type: BACKGROUND_MESSAGE_TYPES.REFRESH_SERVER_STATUS,
    });
    applyStatus(res);
  } catch {
    connected.value = false;
  }
}

function applyStatus(res: any) {
  if (res?.serverStatus) {
    serverRunning.value = !!res.serverStatus.isRunning;
    if (res.serverStatus.port) {
      port.value = res.serverStatus.port;
      portInput.value = res.serverStatus.port;
    }
  }
  if (res?.connected !== undefined) connected.value = !!res.connected;
}

async function toggleConnection() {
  busy.value = true;
  try {
    if (connected.value) {
      await chrome.runtime.sendMessage({ type: 'disconnect_native' });
      connected.value = false;
      serverRunning.value = false;
    } else {
      const res = await chrome.runtime.sendMessage({ type: 'connectNative', port: port.value });
      connected.value = !!res?.success;
      await refresh();
    }
  } catch {
    connected.value = false;
  } finally {
    busy.value = false;
  }
}

async function loadFlows() {
  try {
    const res = await chrome.runtime.sendMessage({ type: BACKGROUND_MESSAGE_TYPES.RR_LIST_FLOWS });
    if (res?.success) flows.value = res.flows || [];
    const st = await chrome.runtime.sendMessage({
      type: BACKGROUND_MESSAGE_TYPES.RR_GET_RECORDING_STATUS,
    });
    recording.value = st?.status === 'recording' || st?.status === 'paused';
  } catch {
    /* background not ready */
  }
}

async function toggleRecording() {
  try {
    if (recording.value) {
      await chrome.runtime.sendMessage({ type: BACKGROUND_MESSAGE_TYPES.RR_STOP_RECORDING });
      recording.value = false;
    } else {
      const res = await chrome.runtime.sendMessage({
        type: BACKGROUND_MESSAGE_TYPES.RR_START_RECORDING,
        meta: { name: 'New recording' },
      });
      recording.value = !!res?.success;
    }
    await loadFlows();
  } catch {
    recording.value = false;
  }
}

async function runFlow(flowId: string) {
  try {
    await chrome.runtime.sendMessage({
      type: BACKGROUND_MESSAGE_TYPES.RR_RUN_FLOW,
      flowId,
      options: { returnLogs: true },
    });
  } catch {
    /* result is shown in the flow log */
  }
}

const onMessage = (message: { type?: string; payload?: any }) => {
  if (message.type === BACKGROUND_MESSAGE_TYPES.SERVER_STATUS_CHANGED && message.payload) {
    serverRunning.value = !!message.payload.isRunning;
    if (message.payload.port) port.value = message.payload.port;
  }
  if (message.type === BACKGROUND_MESSAGE_TYPES.RR_FLOWS_CHANGED) void loadFlows();
};

onMounted(async () => {
  await loadSettings();
  await refresh();
  if (flags.recording) await loadFlows();
  chrome.runtime.onMessage.addListener(onMessage);
});

onUnmounted(() => chrome.runtime.onMessage.removeListener(onMessage));
</script>

<style scoped>
.cm {
  padding: 12px 14px 8px;
}
.cm-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
}
.cm-logo {
  border-radius: var(--cm-radius-sm);
}
.cm-title {
  display: flex;
  flex-direction: column;
  flex: 1;
  line-height: 1.2;
}
.cm-title strong {
  font-size: 15px;
}
.cm-title span,
.cm-note,
.cm-foot,
small {
  color: var(--cm-text-muted);
}
.cm-pill {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--cm-border);
}
.cm-pill.is-ok {
  color: var(--cm-ok);
  border-color: var(--cm-ok);
}
.cm-pill.is-off {
  color: var(--cm-warn);
  border-color: var(--cm-warn);
}
.cm-section {
  border-top: 1px solid var(--cm-border);
  padding: 10px 0;
}
h2 {
  margin: 0 0 6px;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--cm-text-muted);
}
summary {
  cursor: pointer;
  font-weight: 600;
}
.cm-kv {
  display: grid;
  grid-template-columns: 90px 1fr;
  gap: 4px 8px;
  margin: 0 0 8px;
}
.cm-kv dt {
  color: var(--cm-text-muted);
}
.cm-kv dd {
  margin: 0;
  font-family: var(--cm-mono);
  font-size: 12px;
}
.cm-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 6px 0;
}
.cm-btn {
  font: inherit;
  padding: 5px 12px;
  border-radius: var(--cm-radius-sm);
  border: 1px solid var(--cm-border);
  background: var(--cm-surface);
  color: var(--cm-text);
  cursor: pointer;
}
.cm-btn.is-primary {
  background: var(--cm-accent);
  border-color: var(--cm-accent);
  color: var(--cm-accent-contrast);
}
.cm-btn.is-small {
  padding: 2px 8px;
  font-size: 12px;
}
.cm-btn:disabled {
  opacity: 0.6;
  cursor: default;
}
.cm-input {
  font: inherit;
  width: 100%;
  padding: 5px 7px;
  border: 1px solid var(--cm-border);
  border-radius: var(--cm-radius-sm);
  background: var(--cm-bg);
  color: var(--cm-text);
}
.cm-port {
  width: 90px;
}
.cm-field {
  display: block;
  margin-bottom: 8px;
}
.cm-field span {
  display: block;
  margin-bottom: 3px;
  color: var(--cm-text-muted);
}
.cm-tabs {
  display: flex;
  gap: 4px;
  margin: 8px 0 6px;
  flex-wrap: wrap;
}
.cm-tab {
  font: inherit;
  padding: 3px 9px;
  border: 1px solid var(--cm-border);
  border-radius: 999px;
  background: transparent;
  color: var(--cm-text);
  cursor: pointer;
}
.cm-tab.is-active {
  background: var(--cm-accent);
  border-color: var(--cm-accent);
  color: var(--cm-accent-contrast);
}
.cm-code {
  margin: 0;
  padding: 8px;
  background: var(--cm-surface);
  border: 1px solid var(--cm-border);
  border-radius: var(--cm-radius-sm);
  font-family: var(--cm-mono);
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-all;
}
.cm-toggles,
.cm-flows {
  list-style: none;
  margin: 0;
  padding: 0;
}
.cm-toggles li {
  margin-bottom: 7px;
}
.cm-toggles label {
  display: flex;
  gap: 8px;
  align-items: center;
}
.cm-toggles small {
  display: block;
  margin-left: 24px;
}
.cm-risk {
  font-style: normal;
  font-size: 10px;
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 999px;
  color: var(--cm-danger);
  border: 1px solid var(--cm-danger);
}
.cm-flows li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 3px 0;
}
.cm-links {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin: 6px 0 0;
}
a {
  color: var(--cm-accent);
}
code {
  font-family: var(--cm-mono);
  font-size: 11px;
}
.cm-note {
  margin: 4px 0;
  font-size: 12px;
}
.cm-foot {
  border-top: 1px solid var(--cm-border);
  padding: 8px 0 4px;
  text-align: center;
  font-size: 11px;
}
</style>
