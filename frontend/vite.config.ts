import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const ONLINE_DOMAIN = 'bilibili-monitor.fly.dev'

// 线上后端返回的 cookie 带 Secure，http://localhost 下浏览器会丢弃。
// 本地开发时代理这里剥掉 Secure，生产不受影响。
const stripSecure = (proxy: any) => {
  proxy.on('proxyRes', (proxyRes: any) => {
    const sc = proxyRes.headers['set-cookie']
    if (sc) {
      proxyRes.headers['set-cookie'] = (Array.isArray(sc) ? sc : [sc]).map((c: string) =>
        c.replace(/;\s*Secure/gi, ''),
      )
    }
  })
}

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: `https://${ONLINE_DOMAIN}`, changeOrigin: true, configure: stripSecure },
      '/ws': { target: `wss://${ONLINE_DOMAIN}`, ws: true, changeOrigin: true },
      '/static': { target: `https://${ONLINE_DOMAIN}`, changeOrigin: true },
      // 登录页由后端以 HTML 返回，本地没有前端路由覆盖，代理过去。
      '/login': { target: `https://${ONLINE_DOMAIN}`, changeOrigin: true, configure: stripSecure },
    },
  },
})
