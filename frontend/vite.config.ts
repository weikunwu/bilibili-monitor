import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 必须用规范域名：bilibili-monitor.fly.dev 和 www.blackbubu.us 会被后端 301 到 blackbubu.us，
// 浏览器跟随 301 时跨域 CORS 拦截，fetch 直接抛 TypeError 而不是返回 401，导致前端看不到
// 401 也无法跳登录。
const ONLINE_DOMAIN = 'blackbubu.us'

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
      // /login /register /forgot-password /upgrade 等都是 SPA 路由，让 Vite 走 HMR
      // 的 index.html fallback 即可，不要代理到线上（线上 index.html 里引用的 /assets
      // hash 在本地不存在，会加载失败）。
    },
  },
})
