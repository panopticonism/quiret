import './app.css'
import App from './App.svelte'
import { mount } from 'svelte'

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .catch((err) => console.warn('Service worker registration failed:', err))
  })
}

// Ask the browser to keep offline downloads from being evicted.
if (navigator.storage?.persist) {
  navigator.storage.persisted().then((p) => {
    if (!p) navigator.storage.persist().catch(() => {})
  }).catch(() => {})
}

const app = mount(App, {
  target: document.getElementById('app'),
})

export default app
