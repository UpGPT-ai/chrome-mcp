<script setup lang="ts">
import { ref } from 'vue';
import { LINKS, NATIVE_HOST } from '@/common/constants';

const COMMANDS = {
  mac: 'bash install.sh --yes',
  windows: 'install.cmd  (double-click it)',
  showConfig: 'node show-config.js',
  doctor: 'node native-server/dist/cli.js doctor',
  mcpUrl: 'http://127.0.0.1:' + NATIVE_HOST.DEFAULT_PORT + '/mcp',
} as const;

type CommandKey = keyof typeof COMMANDS;
const copiedKey = ref<CommandKey | null>(null);

async function copy(key: CommandKey): Promise<void> {
  try {
    await navigator.clipboard.writeText(COMMANDS[key]);
    copiedKey.value = key;
    window.setTimeout(() => {
      if (copiedKey.value === key) copiedKey.value = null;
    }, 2000);
  } catch {
    copiedKey.value = null;
  }
}

async function open(url: string): Promise<void> {
  try {
    await chrome.tabs.create({ url });
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}
</script>

<template>
  <div class="cm-root">
    <header class="cm-head">
      <img class="cm-logo" src="/icon/128.png" alt="" width="40" height="40" />
      <div>
        <h1>Chrome MCP from UpGPT.ai</h1>
        <p class="cm-muted"
          >The extension is installed. It works on its own; connecting an AI client is optional.</p
        >
      </div>
    </header>

    <main class="cm-main">
      <section class="cm-card">
        <h2>Use it right now. Nothing else to install.</h2>
        <p class="cm-muted">
          Pin Chrome MCP to the toolbar and open it. These work with the extension alone:
        </p>
        <ul class="cm-list">
          <li
            ><b>Record and replay flows.</b> Turn on “Recording and flows” in the popup, record your
            clicks and typing, replay them any time.</li
          >
          <li
            ><b>Web Editor.</b> Press <kbd>Ctrl/⌘ + Shift + O</kbd> on any page to edit it
            visually.</li
          >
          <li
            ><b>Everything stays on your machine.</b> Nothing is sent anywhere unless you connect a
            client.</li
          >
        </ul>
      </section>

      <section class="cm-card cm-optional">
        <h2>Optional add-on: let your AI assistant drive Chrome</h2>
        <p class="cm-muted">
          Adds a small local program so Claude, Cursor and other MCP clients can read tabs, click
          and fill forms in your real Chrome. Needs Node.js 20+. Skip it if you only want the
          features above.
        </p>
        <div class="cm-row">
          <span class="cm-label">macOS / Linux</span><code>{{ COMMANDS.mac }}</code>
          <button @click="copy('mac')">{{ copiedKey === 'mac' ? 'Copied' : 'Copy' }}</button>
        </div>
        <div class="cm-row">
          <span class="cm-label">Windows</span><code>{{ COMMANDS.windows }}</code>
        </div>
        <p class="cm-muted">
          Run it from the unzipped package folder, then run
          <code>{{ COMMANDS.showConfig }}</code> for your client's config, and click
          <b>Connect</b> in the popup. High-risk tools (cookies, storage, network intercept,
          clipboard) stay off until you enable them.
        </p>
        <p class="cm-note">
          Do not run <code>npm install -g mcp-chrome-bridge</code>. That is the upstream project; it
          replaces this registration and the connection stops working after Chrome restarts.
        </p>
      </section>

      <section class="cm-card">
        <h2>Something not working?</h2>
        <div class="cm-row">
          <code>{{ COMMANDS.doctor }}</code>
          <button @click="copy('doctor')">{{ copiedKey === 'doctor' ? 'Copied' : 'Copy' }}</button>
        </div>
        <p class="cm-links">
          <a href="#" @click.prevent="open(LINKS.INSTALL)">Install guide</a>
          <a href="#" @click.prevent="open(LINKS.TROUBLESHOOTING)">Troubleshooting</a>
          <a href="#" @click.prevent="open(LINKS.TOOLS)">All tools</a>
          <a href="#" @click.prevent="open(LINKS.SECURITY)">Security</a>
          <a href="#" @click.prevent="open(LINKS.REPO)">GitHub</a>
        </p>
      </section>
    </main>
  </div>
</template>

<style scoped>
.cm-root {
  min-height: 100vh;
  background: var(--cm-bg);
  color: var(--cm-text);
  font-family: var(--cm-font);
}
.cm-head {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 20px 24px;
  border-bottom: 1px solid var(--cm-border);
  background: var(--cm-surface);
}
.cm-logo {
  border-radius: 10px;
}
h1 {
  font-size: 18px;
  font-weight: 600;
  margin: 0;
}
h2 {
  font-size: 15px;
  font-weight: 600;
  margin: 0 0 6px;
}
.cm-main {
  max-width: 720px;
  margin: 0 auto;
  padding: 24px;
  display: grid;
  gap: 16px;
}
.cm-card {
  background: var(--cm-surface);
  border: 1px solid var(--cm-border);
  border-radius: var(--cm-radius);
  padding: 18px 20px;
}
.cm-muted {
  color: var(--cm-text-muted);
  font-size: 13px;
  margin: 4px 0 10px;
}
.cm-note {
  font-size: 12px;
  color: var(--cm-warn);
  margin: 10px 0 0;
}
.cm-row {
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--cm-bg);
  border: 1px solid var(--cm-border);
  border-radius: var(--cm-radius-sm);
  padding: 8px 12px;
  margin-bottom: 8px;
}
.cm-row code {
  flex: 1;
  word-break: break-all;
}
.cm-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--cm-text-muted);
  min-width: 96px;
}
code {
  font-family: var(--cm-mono);
  font-size: 12.5px;
}
button {
  background: var(--cm-accent);
  color: var(--cm-accent-contrast);
  border: 0;
  border-radius: var(--cm-radius-sm);
  padding: 5px 12px;
  font-size: 12px;
  cursor: pointer;
}
.cm-links {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin: 10px 0 0;
  font-size: 13px;
}
a {
  color: var(--cm-accent);
}
.cm-list {
  margin: 0;
  padding-left: 20px;
  list-style: disc;
  font-size: 13.5px;
  line-height: 1.7;
}
kbd {
  font-family: var(--cm-mono);
  font-size: 12px;
  background: var(--cm-bg);
  border: 1px solid var(--cm-border);
  border-radius: 4px;
  padding: 1px 5px;
}
.cm-optional {
  border-style: dashed;
}
</style>
