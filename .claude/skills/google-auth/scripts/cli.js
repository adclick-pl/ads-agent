#!/usr/bin/env node
/**
 * google-auth CLI — one place to authorize Google accounts for every connector.
 *
 *   --action=status [--check]                  accounts, their services, health
 *   --action=auth --services=ads,ga4|all [--account=<email>] [--label=<nazwa>]
 *                                              prints the consent link
 *   --action=listen [--timeout=900]            waits for the callback (run in BACKGROUND first)
 *   --action=set-default --account=<email|etykieta>
 *   --action=label --account=<email> --label=<nazwa>
 *   --action=test --service=<usługa> [--account=…]
 *   --action=sync-exports                      rewrite exported copies (~/google-ads.yaml, token.json…)
 *
 * One listener serves every service: whoever logs in, the token lands under the
 * e-mail Google reports. A second `listen` while one is running just says so.
 */

import http from 'http';
import {
  SERVICES,
  REDIRECT_URI,
  storeDir,
  oauthClient,
  listAccounts,
  authUrl,
  exchangeCode,
  setDefault,
  setLabel,
  getAccessToken,
  syncExports,
} from './tokens.js';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split('=').slice(1).join('=');
  return process.argv.includes(`--${name}`) ? true : fallback;
};
const HEALTH = '/__google-auth';

const exportNotes = (list = []) =>
  list
    .filter((e) => ['zaktualizowany', 'inny-klient', 'blad'].includes(e.status))
    .map((e) =>
      e.status === 'zaktualizowany'
        ? `eksport → ${e.file} (konto ${e.email})`
        : e.status === 'inny-klient'
          ? `eksport pominięty: ${e.file} ma innego klienta OAuth`
          : `eksport ${e.type}: błąd ${e.error}`
    );

const actions = {
  async status() {
    const accounts = listAccounts();
    let client = '(brak)';
    try {
      client = oauthClient().source;
    } catch {}
    console.log(`\nMagazyn tokenów: ${storeDir()}`);
    console.log(`Klient OAuth:    ${client}\n`);
    if (!accounts.length) {
      console.log('Brak autoryzowanych kont. Zacznij od: --action=auth --services=all\n');
      return;
    }
    for (const a of accounts) {
      let health = a.invalid_at ? `❌ unieważniony ${a.invalid_at.slice(0, 10)}` : '·';
      if (arg('check') && a.services[0]) {
        try {
          await getAccessToken(a.services[0], a.email);
          health = '✅ działa';
        } catch (e) {
          health = `❌ ${e.code || e.message.split('\n')[0]}`;
        }
      }
      console.log(`${a.default ? '★' : ' '} ${a.email}${a.label ? `  [${a.label}]` : ''}  ${health}`);
      console.log(`    usługi: ${a.services.join(', ') || '(żadne)'}   odnowiony: ${String(a.updated_at || '').slice(0, 10)}`);
      if (a.refresh_expires_at) {
        console.log(`    ⚠️ token wygaśnie ${a.refresh_expires_at.slice(0, 10)} — aplikacja OAuth jest w trybie „Testing”; opublikuj ją (Audience → Publish app)`);
      }
    }
    console.log('\n★ = konto domyślne (gdy kilka kont ma tę samą usługę)\n');
  },

  async auth() {
    const url = authUrl({ services: arg('services', 'all'), account: arg('account'), label: arg('label') });
    console.log('\nNajpierw (w tle, jeśli jeszcze nie działa):');
    console.log(`  node "${process.argv[1]}" --action=listen\n`);
    console.log('Link do kliknięcia:\n');
    console.log(url + '\n');
  },

  async listen() {
    const port = Number(new URL(REDIRECT_URI()).port || 80);
    const timeout = Number(arg('timeout', '900')) * 1000;
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${port}`);
      if (url.pathname === HEALTH) return res.end('google-auth');
      if (url.pathname !== new URL(REDIRECT_URI()).pathname) return res.writeHead(404).end();
      const html = (h) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<body style="font-family:sans-serif;padding:40px">${h}</body>`);
      };
      const error = url.searchParams.get('error');
      if (error) {
        html(`<h2>Autoryzacja odrzucona: ${error}</h2>`);
        console.error(`❌ Google zwróciło błąd: ${error}`);
        return;
      }
      const code = url.searchParams.get('code');
      if (!code) return html('Brak kodu.');
      try {
        const r = await exchangeCode(code, url.searchParams.get('state'));
        const lines = [
          `✓ ${r.email} — token ${r.status}.`,
          r.refreshExpiresAt ? `  ⚠️ token wygaśnie ${r.refreshExpiresAt.slice(0, 10)} (aplikacja OAuth w trybie „Testing”)` : null,
          `  usługi: ${r.services.join(', ')}`,
          r.missing.length ? `  ⚠️ bez zgody na: ${r.missing.join(', ')} (odznaczone przy logowaniu)` : null,
          r.status === 'zachowane'
            ? `  Nowa zgoda obejmowała mniej usług (${(r.granted || []).join(', ') || 'żadne'}) niż dotychczasowy token — zostawiłem stary.`
            : null,
          ...exportNotes(r.exports).map((n) => `  ${n}`),
        ].filter(Boolean);
        console.log(lines.join('\n'));
        html(`<h2>✓ Gotowe — ${r.email}</h2><p>Możesz zamknąć to okno.</p>`);
        if (!arg('keep')) {
          server.close();
          process.exit(0);
        }
      } catch (e) {
        html(`<h2>Błąd</h2><pre>${e.message}</pre>`);
        console.error(`❌ ${e.message}`);
      }
    });
    server.on('error', async (e) => {
      if (e.code !== 'EADDRINUSE') throw e;
      const ours = await fetch(`http://localhost:${port}${HEALTH}`).then((r) => r.text()).catch(() => '');
      if (ours === 'google-auth') {
        console.log(`Nasłuch już działa na porcie ${port} — wystarczy kliknąć link.`);
        process.exit(0);
      }
      console.error(`❌ Port ${port} zajmuje inny program. Zamknij go i spróbuj ponownie.`);
      process.exit(1);
    });
    server.listen(port, () => console.log(`⏳ Czekam na autoryzację na ${REDIRECT_URI()} (max ${timeout / 1000} s)…`));
    setTimeout(() => {
      console.error('❌ Minął czas oczekiwania — token NIE został zapisany.');
      process.exit(1);
    }, timeout).unref?.();
  },

  async 'set-default'() {
    const r = setDefault(arg('account'));
    console.log(`★ Domyślne konto: ${r.email}`);
    exportNotes(r.exports).forEach((n) => console.log(n));
  },

  async label() {
    const r = setLabel(arg('account'), arg('label'));
    console.log(`${r.email} → etykieta: ${r.label || '(brak)'}`);
  },

  async test() {
    const service = arg('service');
    const { email } = await getAccessToken(service, arg('account'));
    console.log(`✅ ${SERVICES[service].name}: token działa (${email})`);
  },

  async 'sync-exports'() {
    for (const e of syncExports()) console.log(`${e.type}: ${e.status}${e.file ? ` (${e.file})` : ''}`);
  },
};

const action = arg('action', 'status');
if (!actions[action]) {
  console.error(`Nieznana akcja „${action}”. Dostępne: ${Object.keys(actions).join(', ')}.`);
  process.exit(1);
}
actions[action]().catch((e) => {
  console.error(`❌ ${e.message}`);
  process.exit(1);
});
