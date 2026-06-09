import http from 'http';
import url from 'url';
import fs from 'fs';
import path from 'path';
import os from 'os';
import yaml from 'js-yaml';
import { loadConfig } from './config.js';

// Configuration Callback URL
const PORT = 3000;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

async function main() {
  console.log('\n🔐 --- Generator Refresh Tokena Google Ads API --- 🔐\n');

  let client_id, client_secret;

  // 1. Try to load existing configuration
  try {
    const config = loadConfig();
    client_id = config.client_id;
    client_secret = config.client_secret;
  } catch (_) {
    // Config not loaded or incomplete, will prompt below
  }

  // 2. Resolve credentials
  if (!client_id || !client_secret) {
    console.log('⚠️ Brak Client ID lub Client Secret w pliku konfiguracyjnym.');
    console.log('Upewnij się, że masz ustawione zmienne w .env lub ~/google-ads.yaml.');
    console.log('Wpisz je ręcznie poniżej, aby wygenerować refresh token.');
    console.log('');
    process.exit(1);
  }

  console.log(`📋 Używane dane uwierzytelniające:`);
  console.log(`  Client ID: ${client_id.substring(0, 15)}...`);
  console.log(`  Client Secret: ${client_secret.substring(0, 5)}...`);
  console.log('');

  // 3. Construct Google OAuth Authorization URL
  const scopes = 'https://www.googleapis.com/auth/adwords';
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` + 
    `client_id=${encodeURIComponent(client_id)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(scopes)}` +
    `&access_type=offline` +
    `&prompt=consent`;

  console.log('➡️ KROK 1: Otwórz poniższy adres URL w przeglądarce, zaloguj się na konto Google');
  console.log('   powiązane z Twoim kontem Google Ads i zatwierdź uprawnienia:\n');
  console.log(`🔗 \x1b[36m${authUrl}\x1b[0m\n`);

  console.log('⌛ KROK 2: Czekam na autoryzację w przeglądarce...');

  // 4. Start a temporary HTTP server to capture the code
  const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    
    if (parsedUrl.pathname === '/oauth2callback') {
      const code = parsedUrl.query.code;
      const error = parsedUrl.query.error;

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h1>Błąd autoryzacji!</h1><p>Powód: ${error}</p>`);
        console.error(`\n❌ Błąd powrócony z Google OAuth: ${error}`);
        server.close();
        process.exit(1);
      }

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>Autoryzacja pomyślna!</h1><p>Możesz już zamknąć tę kartę i wrócić do konsoli.</p>');
        
        console.log('\n✅ Kod autoryzacyjny odebrany! Wymieniam na Refresh Token...');
        server.close();
        
        try {
          const tokenData = await exchangeCodeForToken(code, client_id, client_secret);
          
          console.log('\n🎉 --- SUKCES! --- 🎉');
          console.log('\n🔑 Twój nowy Refresh Token:');
          console.log(`\x1b[32m${tokenData.refresh_token}\x1b[0m\n`);
          console.log('💡 Zapisz ten token w swoim pliku .env jako:');
          console.log(`GADS_REFRESH_TOKEN="${tokenData.refresh_token}"`);
          console.log('lub zaktualizuj swój ~/google-ads.yaml.\n');
          
          // Ask if they want to save it directly to ~/google-ads.yaml
          const yamlPath = path.join(os.homedir(), 'google-ads.yaml');
          if (fs.existsSync(yamlPath)) {
            try {
              const fileContents = fs.readFileSync(yamlPath, 'utf8');
              const yamlConfig = yaml.load(fileContents) || {};
              yamlConfig.refresh_token = tokenData.refresh_token;
              fs.writeFileSync(yamlPath, yaml.dump(yamlConfig), 'utf8');
              console.log(`💾 Automatycznie zaktualizowano plik ${yamlPath}!`);
            } catch (err) {
              console.log(`⚠️ Nie udało się automatycznie zaktualizować ${yamlPath}: ${err.message}`);
            }
          }
          
          process.exit(0);
        } catch (err) {
          console.error(`\n❌ Błąd podczas wymiany kodu na token:`, err.message);
          process.exit(1);
        }
      }
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(PORT, (err) => {
    if (err) {
      console.error(`Nie udało się uruchomić serwera na porcie ${PORT}:`, err);
      process.exit(1);
    }
  });
}

/**
 * Exchange Authorization Code for Access & Refresh tokens via API call
 */
async function exchangeCodeForToken(code, clientId, clientSecret) {
  const params = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code'
  });

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error_description || data.error || 'Failed to exchange token');
  }

  return data;
}

main().catch(err => {
  console.error('Nieoczekiwany błąd:', err);
  process.exit(1);
});
