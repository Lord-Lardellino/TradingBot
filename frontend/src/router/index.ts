import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      redirect: '/tg-signals',
    },
    {
      path: '/',
      component: () => import('@/layouts/AppLayout.vue'),
      children: [
        {
          path: 'tg-signals',
          name: 'tg-signals',
          component: () => import('@/pages/TgSignals.vue'),
          meta: { title: 'Telegram Signals' },
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
