# TradingBot Setup Script
Write-Host "`n=== TradingBot Setup ===" -ForegroundColor Cyan

# ── Backend ─────────────────────────────────────────────────────────────────
Write-Host "`n[1/4] Installing backend dependencies..." -ForegroundColor Yellow
Set-Location backend
npm install

Write-Host "`n[2/4] Generating Prisma client and creating SQLite database..." -ForegroundColor Yellow
npx prisma generate
npx prisma db push

Set-Location ..

# ── Frontend ─────────────────────────────────────────────────────────────────
Write-Host "`n[3/4] Installing frontend dependencies..." -ForegroundColor Yellow
Set-Location frontend
npm install
Set-Location ..

Write-Host "`n[4/4] Done!" -ForegroundColor Green
Write-Host @"

 Start the project with TWO terminals:

   Terminal 1 (Backend):   cd backend  && npm run start:dev
   Terminal 2 (Frontend):  cd frontend && npm run dev

 Then open: http://localhost:5173

 API docs:  http://localhost:3000/api
 DB studio: cd backend && npx prisma studio

 NOTE: Set your MEXC API keys in backend\.env
       Leave TEST_MODE=true for paper trading!
"@ -ForegroundColor Cyan
