import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const ONLINE_DOMAIN = 'bilibili-monitor.fly.dev'
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: `https://${ONLINE_DOMAIN}`, changeOrigin: true },
      '/ws': { target: `wss://${ONLINE_DOMAIN}`, ws: true, changeOrigin: true },
      '/static': { target: `https://${ONLINE_DOMAIN}`, changeOrigin: true },
    },
  },
})
