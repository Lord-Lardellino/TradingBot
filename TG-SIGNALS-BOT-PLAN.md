# Piano: Bot segnali Telegram → Gemini → ordini MEXC

> Documento di lavoro. Cosa dobbiamo costruire: un bot che legge in tempo reale i
> messaggi dei canali Telegram di segnali a cui sono iscritto, li interpreta con
> Gemini e piazza ordini su MEXC appena escono.

## Contesto / Stack esistente
- Repo: `c:\Personale\web-apps\trading-bot` — backend **NestJS** + **ccxt MEXC swap**, modulo **`gemma`** (Gemini già integrato), **Prisma**, frontend **Vue**.
- Modulo nuovo da creare: `backend/src/tg-signals/`.
- Riusare il motore ordini/SL-TP nativi già scritto nel modulo `daily-sniper`
  (ccxt MEXC, `contractPrivatePostStoporderPlace` con `positionId`, sizing % capitale,
  `getCapital()` = saldo futures massimo del conto).

## Decisione tecnica CHIAVE: come leggere i canali
- **Bot API Telegram = NO** → un bot legge solo i canali dove è ADMIN. I canali di
  segnali altrui non lo permettono.
- **Client utente MTProto = SÌ** → login col proprio account Telegram
  (`api_id`/`api_hash` da my.telegram.org + numero). Legge QUALSIASI canale a cui sono
  iscritto, come l'app. In Node = **GramJS**, gira dentro il backend NestJS.
  Event-driven (push realtime, niente polling) → "appena escono" davvero.
  Sessione salvata (StringSession) dopo login una tantum.
- ⚠️ ToS: automazione con account utente è zona grigia; per sola **lettura passiva**
  rischio ban basso ma esistente.

## Flusso
1. GramJS (account utente) → evento nuovo messaggio su canale monitorato.
2. **Gemini multimodale** legge TESTO e IMMAGINI (molti canali postano screenshot →
   niente OCR separato). Prompt che ritorna JSON strutturato.
3. Gemini classifica il tipo messaggio:
   `NEW` (nuovo segnale) | `UPDATE` (sposta SL/BE, chiudi parziale) | `CLOSE` (chiudi tutto) | `RUMORE`.
   Ed estrae: `symbol, side (long/short), entry, sl, tp[] (più TP), leva, confidenza`.
4. Normalizzazione/Risk: mappa symbol → simbolo MEXC (`BTC` → `BTC/USDT:USDT`),
   sizing % capitale, cap leva, dedup (segnale ripostato), soglia di confidenza.
5. ccxt MEXC: apre ordine (market o limit all'entry) + SL/TP nativi.
   TP multipli = chiusure parziali.
6. DB: trade + link al messaggio + canale.

## Punti difficili (da gestire)
1. Parsing MAI affidabile al 100% (testo informale + immagini) → soglia di confidenza
   + modalità **conferma manuale** iniziale (bot propone, io approvo) finché non ci si fida.
2. Collegare UPDATE/CLOSE al trade giusto → legare i follow-up all'ultimo segnale aperto
   DI QUEL canale (di norma 1 trade/volta per canale).
3. Segnali contrastanti tra canali (long vs short su stesso symbol) → regola:
   per-canale separato / priorità / no hedge.
4. Canali gratuiti = qualità spesso scarsa. Il bot esegue, non giudica → **risk per-canale**:
   solo i canali fidati vanno live, gli altri in SIM per validarli.
5. Mapping simboli + specifiche MEXC (contractSize, leva max).

## Architettura modulo `tg-signals`
- Client GramJS in background (login una volta, StringSession salvata in .env/DB).
- **Config PER CANALE** (tabella Prisma): `channelId/username`, `enabled`,
  `mode` (sim/live), `riskPct`, `levaMax`, `autoExecute` vs `confirm`.
- Tabella segnali/trade: messaggio grezzo, JSON estratto da Gemini, tipo, stato ordine,
  link al trade MEXC.
- Servizio ordini: riuso motore daily-sniper (apertura + SL/TP nativi + sizing su saldo max).
- Frontend Vue (pagina dedicata + voce menu): lista canali, ultimi messaggi grezzi +
  JSON interpretato da Gemini (per verificare l'interpretazione), trade aperti,
  toggle live per-canale.
- **Partenza in SIM + conferma manuale** per i primi giorni → validare interpretazione e
  qualità canali → poi live SOLO i migliori (regola: prima validare, poi soldi veri).

## Cosa serve PRIMA di scrivere codice
1. Quanti/quali canali e se postano testo, immagini o entrambi (cambia il prompt Gemini).
2. `api_id`/`api_hash` Telegram (my.telegram.org) + numero telefono → login GramJS.
3. Conferma: partenza SIM + conferma manuale, poi live per-canale.

## Note deploy (VPS 144.91.101.42)
- Registrare il modulo in `backend/src/app.module.ts` → `npx prisma db push` →
  `npm run build` → restart `npm run start:dev`.
- Frontend: build + scp + estrai e **copia in `/var/www/tradingbot/frontend/` ROOT**
  (NON in `dist/`).
- API porta **3000**, proxata da nginx su `/api/`.

## Checklist implementazione
- [ ] Installare GramJS nel backend, modulo `tg-signals` (service/controller/module)
- [ ] Login MTProto + salvataggio StringSession
- [ ] Listener nuovi messaggi sui canali configurati
- [ ] Parser Gemini (testo + immagini) → JSON + classificazione tipo
- [ ] Normalizzazione symbol/risk + dedup
- [ ] Esecuzione ordini MEXC (riuso daily-sniper) — prima SIM
- [ ] Tabelle Prisma (config canali + segnali/trade)
- [ ] Pagina frontend + voce menu
- [ ] Modalità conferma manuale → poi toggle live per-canale
- [ ] Deploy VPS
