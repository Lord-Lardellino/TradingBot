/**
 * Login MTProto una-tantum (GramJS).
 *   1) my.telegram.org → api_id / api_hash → mettili in .env (TG_API_ID, TG_API_HASH)
 *   2) npm run tg:login → inserisci numero, codice SMS (e password 2FA se presente)
 *   3) copia la StringSession stampata in .env come TG_SESSION
 *
 * Eseguibile in locale: la sessione salvata vale anche sul VPS (basta copiare TG_SESSION).
 */
import 'dotenv/config';
import * as readline from 'readline';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';

function ask(q: string, hide = false): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(q, (a) => { rl.close(); resolve(a.trim()); });
    if (hide) (rl as any)._writeToOutput = () => (rl as any).output.write('*');
  });
}

async function main() {
  const apiId = Number(process.env.TG_API_ID);
  const apiHash = process.env.TG_API_HASH ?? '';
  if (!apiId || !apiHash) {
    console.error('❌ Imposta prima TG_API_ID e TG_API_HASH in .env (da my.telegram.org).');
    process.exit(1);
  }

  const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });
  await client.start({
    phoneNumber: async () => ask('📱 Numero (con prefisso, es +39...): '),
    password: async () => ask('🔑 Password 2FA (se impostata, altrimenti invio): ', true),
    phoneCode: async () => ask('💬 Codice ricevuto su Telegram: '),
    onError: (err) => console.error('Errore:', err),
  });

  const session = (client.session.save() as unknown) as string;
  console.log('\n✅ Login riuscito. Copia questa riga in backend/.env:\n');
  console.log(`TG_SESSION=${session}\n`);
  await client.disconnect();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
