import { createApp } from 'vue';
import App from './App.vue';

// Tailwind first, then custom tokens
import '../styles/tailwind.css';
import '../styles/tokens.css';

createApp(App).mount('#app');
