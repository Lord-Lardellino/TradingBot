<template>
  <div class="flex h-screen overflow-hidden bg-surface-0">

    <!-- ── Mobile top header ───────────────────────────────────────────── -->
    <header class="md:hidden fixed top-0 inset-x-0 z-30 h-12 bg-surface-50 border-b border-white/5 flex items-center px-4 gap-3 shrink-0">
      <button @click="sidebarOpen = true" class="text-gray-400 hover:text-white p-1 -ml-1">
        <i class="pi pi-bars text-lg" />
      </button>
      <div class="flex items-center gap-2">
        <div class="w-6 h-6 rounded bg-brand flex items-center justify-center">
          <i class="pi pi-chart-bar text-white text-xs" />
        </div>
        <span class="font-bold text-sm text-white">TradingBot</span>
      </div>
      <div class="ml-auto flex items-center gap-2 text-xs">
        <span :class="connected ? 'pulse-dot' : 'w-2 h-2 rounded-full bg-red-500'" />
        <span :class="connected ? 'text-profit' : 'text-red-400'">{{ connected ? 'Live' : 'Offline' }}</span>
      </div>
    </header>

    <!-- ── Sidebar backdrop (mobile) ───────────────────────────────────── -->
    <Transition name="backdrop">
      <div
        v-if="sidebarOpen"
        class="md:hidden fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
        @click="sidebarOpen = false"
      />
    </Transition>

    <!-- ── Sidebar ─────────────────────────────────────────────────────── -->
    <aside
      :class="[
        'fixed md:relative inset-y-0 left-0 z-50 md:z-auto',
        'w-56 flex-shrink-0 bg-surface-50 border-r border-white/5 flex flex-col',
        'transition-transform duration-200 ease-in-out',
        sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
      ]"
    >
      <!-- Logo -->
      <div class="px-5 py-4 border-b border-white/5 flex items-center gap-2">
        <div class="w-8 h-8 rounded-lg bg-brand flex items-center justify-center">
          <i class="pi pi-chart-bar text-white text-sm" />
        </div>
        <div class="flex-1">
          <div class="font-bold text-sm text-white leading-none">TradingBot</div>
          <div class="text-[10px] text-gray-500 font-mono">MEXC Scalper</div>
        </div>
        <button class="md:hidden text-gray-500 hover:text-white p-1" @click="sidebarOpen = false">
          <i class="pi pi-times text-sm" />
        </button>
      </div>

      <!-- Nav -->
      <nav class="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
        <template v-for="item in navItems" :key="item.to ?? item.section">
          <div v-if="item.section" class="pt-3 pb-1 px-2">
            <span class="text-[10px] font-semibold uppercase tracking-widest text-gray-600">{{ item.section }}</span>
          </div>
          <RouterLink
            v-else
            :to="item.to!"
            class="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-gray-400 hover:text-white hover:bg-surface-200 transition-colors"
            active-class="!text-white !bg-surface-200 border border-white/10"
            @click="sidebarOpen = false"
          >
            <i :class="['pi', item.icon, 'text-base']" />
            {{ item.label }}
          </RouterLink>
        </template>
      </nav>

      <!-- Connection status -->
      <div class="px-5 py-3 border-t border-white/5">
        <div class="flex items-center gap-2 text-xs">
          <span :class="connected ? 'pulse-dot' : 'w-2 h-2 rounded-full bg-red-500'" />
          <span :class="connected ? 'text-profit' : 'text-red-400'">{{ connected ? 'Live' : 'Offline' }}</span>
        </div>
      </div>
    </aside>

    <!-- ── Main content ────────────────────────────────────────────────── -->
    <main class="flex-1 overflow-auto pt-12 md:pt-0">
      <RouterView />
    </main>

    <!-- ── Gemma AI floating chat ─────────────────────────────────────── -->
    <GemmaChat />
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useSocket } from '@/composables/useSocket'
import GemmaChat from '@/components/GemmaChat.vue'

const { connected } = useSocket()
const sidebarOpen = ref(false)

const navItems: { to?: string; icon?: string; label?: string; section?: string }[] = [
  { to: '/funding-arb',  icon: 'pi-dollar',        label: '💰 Funding Arb' },
  { to: '/grid',         icon: 'pi-th-large',      label: '🔲 Grid Trading' },

  { section: 'Altro' },
  { to: '/trades',      icon: 'pi-list',         label: 'Trade History' },
  { to: '/settings',    icon: 'pi-cog',          label: 'Settings' },
]
</script>

<style scoped>
.backdrop-enter-active, .backdrop-leave-active { transition: opacity 0.2s ease; }
.backdrop-enter-from, .backdrop-leave-to { opacity: 0; }
</style>
