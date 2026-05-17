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
          path: 'simulation',
          name: 'simulation',
          component: () => import('@/pages/SimulationReport.vue'),
          meta: { title: 'Simulazione' },
        },
        {
          path: 'brain',
          name: 'brain',
          component: () => import('@/pages/AiBrain.vue'),
          meta: { title: 'AI Brain' },
        },
        {
          path: 'live',
          name: 'live',
          component: () => import('@/pages/LiveTrading.vue'),
          meta: { title: 'Live Trading' },
        },
        {
          path: 'scanner',
          name: 'scanner',
          component: () => import('@/pages/PumpScanner.vue'),
          meta: { title: 'Pump Scanner' },
        },
        {
          path: 'mtf-scanner',
          name: 'mtf-scanner',
          component: () => import('@/pages/MtfScanner.vue'),
          meta: { title: 'Multi-TF Scanner' },
        },
        {
          path: 'mtf-sim',
          name: 'mtf-sim',
          component: () => import('@/pages/MtfSimReport.vue'),
          meta: { title: 'Simulazione MTF' },
        },
        {
          path: 'intraday',
          name: 'intraday',
          component: () => import('@/pages/Intraday.vue'),
          meta: { title: 'Intraday 4H' },
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
