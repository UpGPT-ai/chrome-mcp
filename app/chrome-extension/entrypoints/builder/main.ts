import { createApp } from 'vue';
import App from './App.vue';

// Shared design tokens, then Tailwind
import '../styles/tokens.css';
import '../styles/tailwind.css';

createApp(App).mount('#app');
