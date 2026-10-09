import { createApp } from 'vue';
import { NativeMessageType } from 'chrome-mcp-shared';
import './style.css';
import App from './App.vue';

// Ask the background to ensure the native connection. Fire and forget: the popup renders either way.
void chrome.runtime.sendMessage({ type: NativeMessageType.ENSURE_NATIVE }).catch(() => {});
createApp(App).mount('#app');
