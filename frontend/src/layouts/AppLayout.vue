<template>
  <div class="flex h-screen overflow-hidden bg-surface-0">
    <!-- Sidebar -->
    <aside class="w-56 flex-shrink-0 bg-surface-50 border-r border-white/5 flex flex-col">
      <!-- Logo -->
      <div class="px-5 py-4 border-b border-white/5">
        <div class="flex items-center gap-2">
          <div class="w-8 h-8 rounded-lg bg-brand flex items-center justify-center">
            <i class="pi pi-chart-bar text-white text-sm" />
          </div>
          <div>
            <div class="font-bold text-sm text-white leading-none">TradingBot</div>
            <div class="text-[10px] text-gray-500 font-mono">MEXC Scalper</div>
          </div>
        </div>
      </div>

      <!-- Nav -->
      <nav class="flex-1 px-3 py-4 space-y-1">
        <RouterLink
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          class="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-gray-400 hover:text-white hover:bg-surface-200 transition-colors"
          active-class="!text-white !bg-surface-200 border border-white/10"
        >
          <i :class="['pi', item.icon, 'text-base']" />
          {{ item.label }}
        </RouterLink>
      </nav>

      <!-- Connection status -->
      <div class="px-5 py-3 border-t border-white/5">
        <div class="flex items-center gap-2 text-xs">
          <span :class="connected ? 'pulse-dot' : 'w-2 h-2 rounded-full bg-red-500'" />
          <span :class="connected ? 'text-profit' : 'text-red-400'">
            {{ connected ? 'Live' : 'Offline' }}
          </span>
        </div>
      </div>
    </aside>

    <!-- Main content -->
    <main class="flex-1 overflow-auto">
      <RouterView />
    </main>
  </div>
</template>

<script setup lang="ts">
import { useSocket } from '@/composables/useSocket'

const { connected } = useSocket()

const navItems = [
  { to: '/dashboard',  icon: 'pi-home',          label: 'Dashboard' },
  { to: '/brain',      icon: 'pi-microchip-ai',  label: 'AI Brain' },
  { to: '/live',       icon: 'pi-dollar',        label: 'Live Trading' },
  { to: '/scanner',    icon: 'pi-bell',          label: 'Scalping VCB' },
  { to: '/simulation', icon: 'pi-chart-line',    label: 'Sim Scalping' },
  { to: '/intraday',   icon: 'pi-chart-bar',     label: 'Intraday 4H' },
  { to: '/bots',       icon: 'pi-android',       label: 'Bot Manager' },
  { to: '/trades',     icon: 'pi-list',          label: 'Trade History' },
  { to: '/settings',   icon: 'pi-cog',           label: 'Settings' },
]
</script>
