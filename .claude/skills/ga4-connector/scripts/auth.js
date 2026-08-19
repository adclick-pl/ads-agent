/**
 * GA4 OAuth — two explicit foreground steps.
 *
 *   node scripts/auth.js --step=url      # prints the link for the user to click
 *   node scripts/auth.js --step=listen   # waits on localhost:3000 for the callback
 *
 * Two steps rather than one, because the agent must show the link and WAIT for a
 * human. Start --step=listen in the BACKGROUND before handing over the link: it
 * has to outlive the turn, and the redirect needs an open port to land on.
 *
 * --profile=<nazwa> keeps a second Google login in its own token file.
 */

import http from 'http';
import { authUrl, exchangeCode } from './api.js';
import { oauthClient, tokenPath, assertProfileName, listProfiles, REDIRECT_URI } from './config.js';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};

const step = arg('step', 'url');
// A named profile keeps this login's token in its own file, so several Google
// accounts coexist instead of overwriting each other.
const profile = assertProfileName(arg('profile'));
const timeout = Number(arg('timeout', '300')) * 1000;
const PORT = Number(new URL(REDIRECT_URI).port || 3000);

if (step === 'url') {
  const { source } = oauthClient();
  console.log('\n🔐 Autoryzacja GA4 (zakres: analytics.readonly — tylko odczyt)\n');
  console.log(`Klient OAuth: ${source}`);
  console.log(`Profil:       ${profile || '(domyślny)'}`);
  console.log(`Token trafi do: ${tokenPath(profile)}\n`);
  if (!profile && listProfiles().some((p) => p.profile === null)) {
    console.log('⚠️  Profil domyślny jest już autoryzowany — ta zgoda NADPISZE jego token.');
    console.log('   Dla drugiego konta Google użyj --profile=<nazwa>, np. --profile=firma2.\n');
  }
  console.log('1. Otwórz ten link i zaloguj się kontem, które ma dostęp do usług GA4 klientów:\n');
  console.log(authUrl());
  console.log(`\n2. Potem uruchom: node scripts/auth.js --step=listen${profile ? ` --profile=${profile}` : ''}\n`);
  console.log('Jeśli Google powie, że API jest wyłączone — włącz w tym samym projekcie GCP:');
  console.log('  https://console.cloud.google.com/apis/library/analyticsdata.googleapis.com');
  console.log('  https://console.cloud.google.com/apis/library/analyticsadmin.googleapis.com\n');
  process.exit(0);
}

if (step !== 'listen') {
  console.error(`Nieznany --step=${step}. Dozwolone: url, listen.`);
  process.exit(1);
}

console.log(`\n⏳ Czekam na callback na ${REDIRECT_URI} (profil: ${profile || 'domyślny'}, max ${timeout / 1000} s)...\n`);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (!url.pathname.startsWith('/oauth2callback')) {
    res.writeHead(404).end('Not found');
    return;
  }

  const error = url.searchParams.get('error');
  const code = url.searchParams.get('code');

  if (error) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<h2>Autoryzacja odrzucona: ${error}</h2><p>Wróć do terminala.</p>`);
    server.close();
    console.error(`\n❌ Google zwróciło błąd: ${error}\n`);
    process.exit(1);
  }
  if (!code) return;

  try {
    const { path } = await exchangeCode(code, profile);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h2>✓ Gotowe</h2><p>Token GA4 zapisany. Możesz zamknąć to okno.</p>');
    server.close();
    console.log(`\n✓ Token zapisany: ${path}`);
    console.log(
      `\nSprawdź połączenie: node scripts/cli.js --action=test-connection${profile ? ` --profile=${profile}` : ''}\n`
    );
    process.exit(0);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<h2>Błąd</h2><pre>${e.message}</pre>`);
    server.close();
    console.error(`\n❌ ${e.message}\n`);
    process.exit(1);
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(
      `\n❌ Port ${PORT} jest zajęty — najczęściej przez inny nasłuch autoryzacji.\n` +
        `Zamknij tamten proces i spróbuj ponownie.\n`
    );
  } else {
    console.error(`\n❌ ${e.message}\n`);
  }
  process.exit(1);
});

server.listen(PORT);

setTimeout(() => {
  console.error(`\n❌ Minęło ${timeout / 1000} s bez callbacku. Token NIE został zapisany (${tokenPath(profile)}).`);
  console.error('Uruchom ponownie --step=url i kliknij link.\n');
  server.close();
  process.exit(1);
}, timeout);
