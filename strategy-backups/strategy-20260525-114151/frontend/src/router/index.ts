import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      redirect: '/dashboard',
    },
    {
      path: '/',
      component: () => import('@/layouts/AppLayout.vue'),
      children: [
        {
          path: 'dashboard',
          name: 'dashboard',
          component: () => import('@/pages/Dashboard.vue'),
          meta: { title: 'Dashboard' },
        },
        {
          path: 'live',
          name: 'live',
          component: () => import('@/pages/LiveTrading.vue'),
          meta: { title: 'Live Trading' },
        },
        {
          path: 'smart',
          name: 'smart',
          component: () => import('@/pages/SmartScanner.vue'),
          meta: { title: 'Smart Scanner' },
        },
        {
          path: 'inst',
          name: 'inst',
          component: () => import('@/pages/InstScanner.vue'),
          meta: { title: 'Inst5m Scanner' },
        },
        {
          path: 'inst-15m',
          name: 'inst-15m',
          component: () => import('@/pages/InstScanner15m.vue'),
          meta: { title: 'Inst15m Scanner' },
        },
        {
          path: 'inst-1h',
          name: 'inst-1h',
          component: () => import('@/pages/InstScanner1h.vue'),
          meta: { title: 'Inst1h Scanner' },
        },
        {
          path: 'scanner-monitor',
          name: 'scanner-monitor',
          component: () => import('@/pages/ScannerMonitor.vue'),
          meta: { title: 'Scanner Monitor' },
        },
        {
          path: 'bots',
          name: 'bots',
          component: () => import('@/pages/BotConfig.vue'),
          meta: { title: 'Bot Manager' },
        },
        {
          path: 'trades',
          name: 'trades',
          component: () => import('@/pages/Trades.vue'),
          meta: { title: 'Trade History' },
        },
        {
          path: 'settings',
          name: 'settings',
          component: () => import('@/pages/Settings.vue'),
          meta: { title: 'Settings' },
        },
      ],
    },
  ],
})

router.afterEach((to) => {
  document.title = `${to.meta.title ?? 'TradingBot'} — MEXC Bot`
})

export default router
