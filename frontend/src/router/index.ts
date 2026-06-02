import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      redirect: '/funding-arb',
    },
    {
      path: '/',
      component: () => import('@/layouts/AppLayout.vue'),
      children: [
        {
          path: 'funding-arb',
          name: 'funding-arb',
          component: () => import('@/pages/FundingArb.vue'),
          meta: { title: 'Funding Rate Arbitrage' },
        },
        {
          path: 'grid',
          name: 'grid',
          component: () => import('@/pages/GridScanner.vue'),
          meta: { title: 'Grid Trading' },
        },
        {
          path: 'ema-scalper',
          name: 'ema-scalper',
          component: () => import('@/pages/EmaScalper.vue'),
          meta: { title: '3 EMA Scalper' },
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
