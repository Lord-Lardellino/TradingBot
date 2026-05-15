<template>
  <div class="p-6 space-y-5">

    <!-- ── Header ──────────────────────────────────────────────────────── -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-xl font-bold text-white flex items-center gap-2">
          <span
            class="inline-block w-2.5 h-2.5 rounded-full"
            :class="account?.connected ? 'bg-green-400 animate-pulse' : 'bg-red-500'"
          />
          Live Trading
          <span class="text-xs font-normal text-gray-500">MEXC Futures · VCB Scalping</span>
        </h1>
        <p class="text-xs text-gray-500 mt-0.5 flex items-center gap-2">
          <span v-if="config?.enabled" class="inline-flex items-center gap-1 text-green-400 font-semibold">
            <span class="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
            BOT ATTIVO — ordini reali in esecuzione
          </span>
          <span v-else class="text-gray-600">Bot disabilitato · nessun ordine automatico</span>
          <span v-if="account?.connected" class="text-gray-700 font-mono">
            · aggiornato {{ secondsAgo }}s fa
          </span>
        </p>
      </div>
      <div class="flex items-center gap-2">
        <div class="flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs"
          :class="config?.enabled
            ? 'bg-green-500/10 border-green-500/30 text-green-400'
            : 'bg-surface-200 border-white/5 text-gray-500'"
        >
          <ToggleSwitch
            :model-value="config?.enabled ?? false"
            :disabled="configLoading"
            @update:model-value="toggleEnabled"
          />
          <span class="font-semibold">{{ config?.enabled ? 'ATTIVO' : 'SPENTO' }}</span>
        </div>
        <Button
          size="small"
          icon="pi pi-refresh"
          label="Aggiorna"
          severity="secondary"
          :loading="loading"
          @click="refresh"
        />
      </div>
    </div>

    <!-- ── Error / Not Connected ────────────────────────────────────────── -->
    <div v-if="account && !account.connected"
      class="flex items-start gap-3 rounded-xl border border-yellow-500/30 bg-yellow-500/5 p-4"
    >
      <i class="pi pi-exclamation-triangle text-yellow-400 text-lg mt-0.5" />
      <div>
        <div class="text-sm font-semibold text-yellow-300">Conto non connesso</div>
        <div class="text-xs text-gray-400 mt-1">
          {{ account.error ?? 'API keys non trovate o non valide.' }}
          Verifica <code class="text-yellow-400">MEXC_API_KEY</code> e
          <code class="text-yellow-400">MEXC_API_SECRET</code> nel file
          <code class="text-yellow-400">.env</code>.
        </div>
      </div>
    </div>

    <div v-if="loading && !account" class="flex justify-center py-20">
      <ProgressSpinner />
    </div>

    <template v-else>

      <!-- ── 1. Account Summary ─────────────────────────────────────────── -->
      <div class="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">

        <div class="stat-card col-span-2 md:col-span-1 xl:col-span-2 flex items-center gap-4">
          <div class="w-10 h-10 rounded-xl bg-indigo-500/20 flex items-center justify-center flex-shrink-0">
            <i class="pi pi-wallet text-indigo-400" />
          </div>
          <div>
            <div class="text-xs text-gray-500 mb-0.5">Equity Totale</div>
            <div class="text-2xl font-bold font-mono text-white">{{ fmt(account?.equity ?? 0) }}</div>
            <div class="text-xs text-gray-600 font-mono">USDT</div>
          </div>
        </div>

        <div class="stat-card">
          <div class="text-xs text-gray-500 mb-1">Disponibile</div>
          <div class="text-xl font-bold font-mono text-green-400">{{ fmt(account?.availableBalance ?? 0) }}</div>
          <div class="text-xs text-gray-600 font-mono mt-0.5">USDT liberi</div>
        </div>

        <div class="stat-card">
          <div class="text-xs text-gray-500 mb-1">PnL Non Realizzato</div>
          <div class="text-xl font-bold font-mono"
            :class="(account?.unrealizedPnl ?? 0) >= 0 ? 'text-profit' : 'text-loss'"
          >
            {{ (account?.unrealizedPnl ?? 0) >= 0 ? '+' : '' }}{{ fmt(account?.unrealizedPnl ?? 0) }}
          </div>
          <div class="text-xs text-gray-600 font-mono mt-0.5">USDT</div>
        </div>

        <div class="stat-card">
          <div class="text-xs text-gray-500 mb-1">Balance Wallet</div>
          <div class="text-xl font-bold font-mono text-white">{{ fmt(account?.totalBalance ?? 0) }}</div>
          <div class="text-xs text-gray-600 font-mono mt-0.5">USDT</div>
        </div>

        <div class="stat-card">
          <div class="text-xs text-gray-500 mb-1">Margine Usato</div>
          <div class="text-xl font-bold font-mono text-yellow-400">{{ fmt(account?.usedMargin ?? 0) }}</div>
          <div class="text-xs text-gray-600 font-mono mt-0.5">USDT</div>
        </div>

        <div class="stat-card">
          <div class="text-xs text-gray-500 mb-1">Margin Ratio</div>
          <div class="text-xl font-bold font-mono" :class="marginRatioClass">
            {{ (account?.marginRatio ?? 0).toFixed(1) }}%
          </div>
          <div class="text-xs mt-0.5" :class="marginRatioClass">{{ marginRatioLabel }}</div>
        </div>

      </div>

      <!-- ── 2. Open Positions (MEXC live) ─────────────────────────────── -->
      <div class="stat-card !p-0 overflow-hidden">
        <div class="flex items-center justify-between px-5 py-3 border-b border-white/5">
          <div class="flex items-center gap-2">
            <span class="font-semibold text-white text-sm">Posizioni Aperte MEXC</span>
            <span class="text-xs font-mono px-1.5 py-0.5 rounded"
              :class="positions.length > 0 ? 'bg-green-500/20 text-green-400' : 'bg-surface-200 text-gray-500'"
            >{{ positions.length }}</span>
          </div>
          <div v-if="positions.length > 0" class="text-xs text-gray-500">
            PnL non realizzato:
            <span class="font-mono font-semibold" :class="store.totalUnrealizedPnl >= 0 ? 'text-profit' : 'text-loss'">
              {{ store.totalUnrealizedPnl >= 0 ? '+' : '' }}{{ fmt(store.totalUnrealizedPnl) }} USDT
            </span>
          </div>
        </div>

        <div v-if="!positions.length" class="flex flex-col items-center py-8 text-gray-600">
          <i class="pi pi-inbox text-2xl mb-3 text-gray-700" />
          <div class="text-sm">Nessuna posizione aperta</div>
        </div>

        <div v-else class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-xs text-gray-500 border-b border-white/5">
                <th class="text-left px-5 py-2.5 font-medium">Coppia</th>
                <th class="text-left px-4 py-2.5 font-medium">Dir.</th>
                <th class="text-right px-4 py-2.5 font-medium">Valore ($)</th>
                <th class="text-right px-4 py-2.5 font-medium">Entry</th>
                <th class="text-right px-4 py-2.5 font-medium">Mark</th>
                <th class="text-right px-4 py-2.5 font-medium">Liquidazione</th>
                <th class="text-right px-4 py-2.5 font-medium">PnL</th>
                <th class="text-right px-4 py-2.5 font-medium">PnL%</th>
                <th class="text-right px-4 py-2.5 font-medium">Margine</th>
                <th class="text-right px-5 py-2.5 font-medium">Leva</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="pos in positions" :key="pos.symbol"
                class="border-b border-white/5 last:border-0 hover:bg-white/3 transition-colors"
              >
                <td class="px-5 py-3 font-mono text-white font-semibold text-xs">
                  {{ pos.symbol.replace('/USDT:USDT', '') }}<span class="text-gray-600">/USDT</span>
                </td>
                <td class="px-4 py-3">
                  <span class="text-xs font-bold px-2 py-0.5 rounded"
                    :class="pos.side === 'long' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'"
                  >{{ pos.side === 'long' ? 'LONG' : 'SHORT' }}</span>
                </td>
                <td class="px-4 py-3 text-right font-mono text-gray-300">${{ fmt(pos.notional) }}</td>
                <td class="px-4 py-3 text-right font-mono text-gray-300">{{ fmtPrice(pos.entryPrice) }}</td>
                <td class="px-4 py-3 text-right font-mono text-white font-medium">{{ fmtPrice(pos.markPrice) }}</td>
                <td class="px-4 py-3 text-right font-mono text-red-400/80 text-xs">{{ fmtPrice(pos.liquidationPrice) }}</td>
                <td class="px-4 py-3 text-right font-mono font-semibold"
                  :class="pos.unrealizedPnl >= 0 ? 'text-profit' : 'text-loss'"
                >
                  {{ pos.unrealizedPnl >= 0 ? '+' : '' }}{{ fmt(pos.unrealizedPnl) }}
                </td>
                <td class="px-4 py-3 text-right font-mono text-xs"
                  :class="pos.unrealizedPnlPct >= 0 ? 'text-profit' : 'text-loss'"
                >
                  {{ pos.unrealizedPnlPct >= 0 ? '+' : '' }}{{ pos.unrealizedPnlPct.toFixed(2) }}%
                </td>
                <td class="px-4 py-3 text-right font-mono text-gray-400 text-xs">${{ fmt(pos.collateral) }}</td>
                <td class="px-5 py-3 text-right">
                  <span class="text-xs font-bold font-mono text-indigo-300">{{ pos.leverage }}×</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- ── 3. Live Bot Trades ─────────────────────────────────────────── -->
      <div class="stat-card !p-0 overflow-hidden">
        <div class="flex items-center justify-between px-5 py-3 border-b border-white/5">
          <div class="flex items-center gap-2">
            <span class="font-semibold text-white text-sm">Trade Live VCB</span>
            <span class="text-xs font-mono px-1.5 py-0.5 rounded"
              :class="openTrades.length > 0 ? 'bg-green-500/20 text-green-400' : 'bg-surface-200 text-gray-500'"
            >{{ openTrades.length }} aperti</span>
            <span class="text-xs text-gray-600">/ {{ trades.length }} totali</span>
          </div>
        </div>

        <div v-if="!trades.length" class="flex flex-col items-center py-10 text-gray-600">
          <i class="pi pi-inbox text-3xl mb-3 text-gray-700" />
          <div class="text-sm">Nessun trade ancora</div>
          <div class="text-xs mt-1">
            {{ config?.enabled ? 'Aspettando segnali…' : 'Abilita il bot per iniziare' }}
          </div>
        </div>

        <div v-else class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-xs text-gray-500 border-b border-white/5">
                <th class="text-left px-5 py-2.5 font-medium">Coppia</th>
                <th class="text-left px-4 py-2.5 font-medium">Grade</th>
                <th class="text-left px-4 py-2.5 font-medium">Dir.</th>
                <th class="text-right px-4 py-2.5 font-medium">Entry</th>
                <th class="text-right px-4 py-2.5 font-medium">SL</th>
                <th class="text-right px-4 py-2.5 font-medium">TP</th>
                <th class="text-right px-4 py-2.5 font-medium">Leva</th>
                <th class="text-right px-4 py-2.5 font-medium">Margine</th>
                <th class="text-right px-4 py-2.5 font-medium">PnL</th>
                <th class="text-right px-4 py-2.5 font-medium">Fee ap.</th>
                <th class="text-right px-4 py-2.5 font-medium">Fee ch.</th>
                <th class="text-center px-4 py-2.5 font-medium">Status</th>
                <th class="text-right px-5 py-2.5 font-medium">Ora</th>
                <th class="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              <tr v-for="trade in trades" :key="trade.id"
                class="border-b border-white/5 last:border-0 hover:bg-white/3 transition-colors"
                :class="trade.status === 'open' ? 'bg-green-500/3' : ''"
              >
                <td class="px-5 py-2.5 font-mono text-white font-semibold text-xs">
                  {{ trade.symbol.replace('/USDT:USDT', '') }}<span class="text-gray-600">/USDT</span>
                </td>
                <td class="px-4 py-2.5">
                  <span class="text-xs font-bold font-mono" :class="gradeColor(trade.grade)">{{ trade.grade }}</span>
                </td>
                <td class="px-4 py-2.5">
                  <span class="text-xs font-bold px-2 py-0.5 rounded"
                    :class="trade.direction === 'LONG' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'"
                  >{{ trade.direction }}</span>
                </td>
                <td class="px-4 py-2.5 text-right font-mono text-gray-300 text-xs">{{ fmtPrice(trade.entry) }}</td>
                <td class="px-4 py-2.5 text-right font-mono text-red-400/80 text-xs">{{ fmtPrice(trade.stopLoss) }}</td>
                <td class="px-4 py-2.5 text-right font-mono text-green-400/80 text-xs">{{ fmtPrice(trade.takeProfit) }}</td>
                <td class="px-4 py-2.5 text-right font-mono text-indigo-300 text-xs font-bold">{{ trade.leverage }}×</td>
                <td class="px-4 py-2.5 text-right font-mono text-gray-400 text-xs">${{ trade.marginEur.toFixed(2) }}</td>
                <td class="px-4 py-2.5 text-right font-mono font-semibold text-xs"
                  :class="trade.pnl == null ? 'text-gray-600' : trade.pnl >= 0 ? 'text-profit' : 'text-loss'"
                >
                  {{ trade.pnl == null ? '—' : (trade.pnl >= 0 ? '+' : '') + fmt(trade.pnl) }}
                </td>
                <td class="px-4 py-2.5 text-right font-mono text-yellow-400/80 text-xs">
                  {{ trade.feesOpen ? fmt(trade.feesOpen) : '—' }}
                </td>
                <td class="px-4 py-2.5 text-right font-mono text-yellow-400/80 text-xs">
                  {{ trade.feesClose != null ? fmt(trade.feesClose) : '—' }}
                </td>
                <td class="px-4 py-2.5 text-center">
                  <span class="text-xs font-semibold px-2 py-0.5 rounded" :class="tradeStatusClass(trade.status)">
                    {{ tradeStatusLabel(trade.status) }}
                  </span>
                </td>
                <td class="px-5 py-2.5 text-right text-xs font-mono text-gray-600">{{ fmtTime(trade.openedAt) }}</td>
                <td class="px-4 py-2.5">
                  <Button v-if="trade.status === 'open'"
                    size="small" icon="pi pi-times" severity="danger" text rounded
                    v-tooltip="'Chiudi manualmente'"
                    :loading="closingId === trade.id"
                    @click="closeManual(trade.id)"
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- ── 4. Analytics ──────────────────────────────────────────────── -->
      <div class="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3">
        <div class="stat-card col-span-2 md:col-span-1">
          <div class="text-xs text-gray-500 mb-1">Trade Chiusi</div>
          <div class="text-2xl font-bold font-mono text-white">{{ analytics?.totalTrades ?? 0 }}</div>
          <div class="text-xs text-gray-600 mt-0.5">
            <span class="text-green-400">{{ analytics?.openTrades ?? 0 }} aperti</span>
          </div>
        </div>
        <div class="stat-card">
          <div class="text-xs text-gray-500 mb-1">PnL Realizzato</div>
          <div class="text-xl font-bold font-mono"
            :class="(analytics?.totalPnl ?? 0) >= 0 ? 'text-profit' : 'text-loss'"
          >
            {{ (analytics?.totalPnl ?? 0) >= 0 ? '+' : '' }}{{ fmt(analytics?.totalPnl ?? 0) }}
          </div>
          <div class="text-xs text-gray-600 font-mono mt-0.5">USDT</div>
        </div>
        <div class="stat-card">
          <div class="text-xs text-gray-500 mb-1">Fee Totali</div>
          <div class="text-xl font-bold font-mono text-red-400">-{{ fmt(analytics?.totalFees ?? 0) }}</div>
          <div class="text-xs text-gray-600 font-mono mt-0.5">USDT</div>
        </div>
        <div class="stat-card">
          <div class="text-xs text-gray-500 mb-1">Win Rate</div>
          <div class="text-xl font-bold font-mono text-indigo-300">
            {{ analytics?.totalTrades ? (analytics.winRate ?? 0).toFixed(1) + '%' : '—' }}
          </div>
          <div class="text-xs text-gray-600 mt-0.5">trade chiusi</div>
        </div>
        <div class="stat-card">
          <div class="text-xs text-gray-500 mb-1">Fee Ap. media</div>
          <div class="text-xl font-bold font-mono text-yellow-400">{{ fmt(analytics?.avgFeeOpen ?? 0) }}</div>
          <div class="text-xs text-gray-600 font-mono mt-0.5">USDT</div>
        </div>
        <div class="stat-card">
          <div class="text-xs text-gray-500 mb-1">Fee Ch. media</div>
          <div class="text-xl font-bold font-mono text-yellow-400">
            {{ analytics?.avgFeeClose ? fmt(analytics.avgFeeClose) : '—' }}
          </div>
          <div class="text-xs text-gray-600 font-mono mt-0.5">USDT</div>
        </div>
        <div class="stat-card">
          <div class="text-xs text-gray-500 mb-1">Fee RT%</div>
          <div class="text-xl font-bold font-mono text-orange-400">
            {{ analytics?.feeRatePct ? (analytics.feeRatePct).toFixed(4) + '%' : '—' }}
          </div>
          <div class="text-xs text-gray-600 mt-0.5">round-trip</div>
        </div>
      </div>

      <!-- ── 5. Bot Config ──────────────────────────────────────────────── -->
      <div class="stat-card">
        <div class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Configurazione Bot VCB</div>

        <div v-if="config?.enabled"
          class="flex items-start gap-2 rounded-lg border border-orange-500/30 bg-orange-500/5 p-3 mb-4 text-xs"
        >
          <i class="pi pi-exclamation-triangle text-orange-400 mt-0.5 flex-shrink-0" />
          <span class="text-orange-300">
            Bot attivo — ogni segnale VCB grade {{ config?.minGrade }}+ aprirà una posizione da
            ${{ config?.marginPerTrade }} con leva automatica.
          </span>
        </div>

        <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div>
            <div class="text-xs text-gray-500 mb-1.5">Margine per trade ($)</div>
            <InputNumber
              v-model="draft.marginPerTrade"
              :min="1" :max="100" :step="1"
              :disabled="configLoading"
              size="small" fluid
            />
          </div>
          <div>
            <div class="text-xs text-gray-500 mb-1.5">Grade minima</div>
            <Select
              v-model="draft.minGrade"
              :options="['A+', 'A', 'B']"
              :disabled="configLoading"
              size="small" fluid
            />
          </div>
          <div>
            <div class="text-xs text-gray-500 mb-1.5">Max trade concurrent</div>
            <InputNumber
              v-model="draft.maxConcurrent"
              :min="1" :max="10" :step="1"
              :disabled="configLoading"
              size="small" fluid
            />
          </div>
          <div>
            <div class="text-xs text-gray-500 mb-1.5">Auto-chiusura SL/TP</div>
            <div class="flex items-center gap-2 h-[30px]">
              <ToggleSwitch
                v-model="draft.autoClose"
                :disabled="configLoading"
                @update:model-value="(v: boolean) => saveConfig({ autoClose: v })"
              />
              <span class="text-xs text-gray-400">{{ draft.autoClose ? 'Sì' : 'No' }}</span>
            </div>
          </div>
        </div>
        <div class="flex justify-end mt-3">
          <Button
            size="small" icon="pi pi-check" label="Salva Config"
            severity="secondary" :loading="configLoading"
            @click="saveConfig({ marginPerTrade: draft.marginPerTrade, minGrade: draft.minGrade, maxConcurrent: draft.maxConcurrent })"
          />
        </div>
      </div>

      <!-- ── 6. Strategia VCB ─────────────────────────────────────────────── -->
      <details class="stat-card" open>
        <summary class="text-xs font-semibold text-gray-400 uppercase tracking-wider cursor-pointer select-none">
          Strategia · VCB v1 — Volatility Contraction Breakout
        </summary>

        <div class="mt-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 text-xs text-gray-400">

          <div class="space-y-2">
            <div class="text-[11px] font-semibold text-gray-300 uppercase tracking-wider mb-1">Logica di entrata</div>
            <p>
              Lo scanner analizza le top-60 coppie MEXC ogni 10 secondi su 1m + 5m.
              Il segnale si attiva solo quando tre condizioni simultanee sono soddisfatte:
            </p>
            <ul class="space-y-1 pl-3 border-l border-white/10">
              <li><span class="text-indigo-300 font-semibold">L1 – Squeeze:</span> le ultime candele 1m sono contenute in un range compresso (volatilità ridotta = molla caricata).</li>
              <li><span class="text-indigo-300 font-semibold">L2 – Breakout:</span> l'ultima candela 1m rompe il range con corpo ≥ 60%, volume ≥ 1.5× la media, e senza inseguire il prezzo già lontano.</li>
              <li><span class="text-indigo-300 font-semibold">L3 – Conferma:</span> RSI 1m non in ipercomprato/ipervenduto + EMA34 5m allineata con la direzione.</li>
            </ul>
          </div>

          <div class="space-y-2">
            <div class="text-[11px] font-semibold text-gray-300 uppercase tracking-wider mb-1">Gestione del rischio</div>
            <ul class="space-y-1.5">
              <li>
                <span class="text-yellow-400 font-semibold">SL:</span>
                calcolato sull'ATR 1m — distanza adattiva alla volatilità reale del momento.
              </li>
              <li>
                <span class="text-green-400 font-semibold">TP:</span>
                sempre 1.8× la distanza dello SL (R:R = 1:1.8). Entrambi ancorati al fill reale, non al prezzo del segnale.
              </li>
              <li>
                <span class="text-indigo-300 font-semibold">Leva:</span>
                auto-calcolata (max 20×) in base all'ATR — più volatile = meno leva.
              </li>
              <li>
                <span class="text-gray-300 font-semibold">Cooldown:</span>
                5 minuti per coppia dopo ogni segnale emesso.
              </li>
              <li>
                <span class="text-gray-300 font-semibold">Fee RT:</span>
                0.038% per lato (taker futures MEXC) = 0.076% round-trip.
              </li>
            </ul>
          </div>

          <div class="space-y-2">
            <div class="text-[11px] font-semibold text-gray-300 uppercase tracking-wider mb-1">Grading del segnale</div>
            <ul class="space-y-1.5">
              <li><span class="text-yellow-400 font-bold">A+</span> — Score ≥ 90: squeeze perfetto, volume esplosivo, tutti i filtri verdi.</li>
              <li><span class="text-green-400 font-bold">A</span>&nbsp; — Score ≥ 75: segnale solido con qualche margine su volume o RSI.</li>
              <li><span class="text-blue-400 font-bold">B</span>&nbsp; — Score ≥ 60: setup valido ma con compressione o conferme meno nette.</li>
              <li><span class="text-gray-400 font-bold">C</span>&nbsp; — Score &lt; 60: filtrato, non inviato al bot (solo visualizzato).</li>
            </ul>
            <div class="mt-2 p-2 rounded-lg bg-white/3 border border-white/5 text-gray-500 text-[11px]">
              Il bot prende solo i grade ≥ <span class="text-white font-semibold">{{ config?.minGrade ?? 'A+' }}</span> (configurabile).
              Ogni trade usa <span class="text-white font-semibold">${{ config?.marginPerTrade ?? 10 }}</span> di margine,
              max <span class="text-white font-semibold">{{ config?.maxConcurrent ?? 2 }}</span> posizioni contemporanee.
            </div>
          </div>

        </div>
      </details>

    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, reactive, watch, onMounted, onUnmounted } from 'vue'
import { useLiveStore } from '@/stores/live'
import Button from 'primevue/button'
import ToggleSwitch from 'primevue/toggleswitch'
import Select from 'primevue/select'
import InputNumber from 'primevue/inputnumber'
import ProgressSpinner from 'primevue/progressspinner'

const store      = useLiveStore()
const account    = computed(() => store.account)
const positions  = computed(() => store.positions)
const trades     = computed(() => store.trades)
const openTrades = computed(() => store.openTrades)
const config     = computed(() => store.config)
const analytics  = computed(() => store.analytics)
const loading    = computed(() => store.loading)
const configLoading = computed(() => store.configLoading)

const draft = reactive({ marginPerTrade: 5, minGrade: 'A+', maxConcurrent: 2, autoClose: true })
watch(config, (cfg) => {
  if (!cfg) return
  draft.marginPerTrade = cfg.marginPerTrade
  draft.minGrade       = cfg.minGrade
  draft.maxConcurrent  = cfg.maxConcurrent
  draft.autoClose      = cfg.autoClose
}, { immediate: true })

const closingId = ref<string | null>(null)
const tick      = ref(0)
let tickTimer:    ReturnType<typeof setInterval> | null = null
let refreshTimer: ReturnType<typeof setInterval> | null = null

const secondsAgo = computed(() => {
  void tick.value
  if (!store.lastUpdate) return '—'
  return Math.round((Date.now() - store.lastUpdate.getTime()) / 1000)
})

const marginRatioClass = computed(() => {
  const r = account.value?.marginRatio ?? 0
  if (r > 80) return 'text-loss'
  if (r > 50) return 'text-yellow-400'
  return 'text-profit'
})
const marginRatioLabel = computed(() => {
  const r = account.value?.marginRatio ?? 0
  if (r > 80) return 'Rischio alto'
  if (r > 50) return 'Attenzione'
  return 'Normale'
})

function fmt(n: number): string { return n.toFixed(2) }

function fmtPrice(n: number): string {
  if (!n || n === 0) return '—'
  if (n < 0.001) return n.toPrecision(4)
  if (n < 1)     return n.toFixed(6)
  if (n < 100)   return n.toFixed(4)
  return n.toFixed(2)
}

function fmtTime(ts: number | string): string {
  if (!ts) return '—'
  const d = new Date(ts)
  return d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' }) + ' ' +
         d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })
}

function tradeStatusClass(status: string) {
  switch (status) {
    case 'open':   return 'bg-green-500/20 text-green-400'
    case 'tp':     return 'bg-emerald-500/20 text-emerald-400'
    case 'sl':     return 'bg-red-500/20 text-red-400'
    case 'manual': return 'bg-gray-500/20 text-gray-400'
    case 'error':  return 'bg-orange-500/20 text-orange-400'
    default:       return 'bg-gray-500/15 text-gray-500'
  }
}
function tradeStatusLabel(status: string) {
  switch (status) {
    case 'open':   return 'APERTO'
    case 'tp':     return 'TP ✅'
    case 'sl':     return 'SL ❌'
    case 'manual': return 'CHIUSO'
    case 'error':  return 'ERRORE'
    default:       return status.toUpperCase()
  }
}
function gradeColor(grade: string) {
  switch (grade) {
    case 'A+': return 'text-yellow-400'
    case 'A':  return 'text-green-400'
    case 'B':  return 'text-blue-400'
    default:   return 'text-gray-400'
  }
}

async function toggleEnabled(val: boolean) { await store.updateConfig({ enabled: val }) }
async function saveConfig(patch: Record<string, any>) { await store.updateConfig(patch) }

async function closeManual(id: string) {
  closingId.value = id
  try {
    await store.closeTrade(id)
    await store.fetchAll()
  } finally {
    closingId.value = null
  }
}

async function refresh() { await store.fetchAll() }

onMounted(async () => {
  await store.fetchAll()
  tickTimer    = setInterval(() => { tick.value++ }, 1_000)
  refreshTimer = setInterval(() => store.fetchAll(), 30_000)
})

onUnmounted(() => {
  if (tickTimer)    clearInterval(tickTimer)
  if (refreshTimer) clearInterval(refreshTimer)
})
</script>
