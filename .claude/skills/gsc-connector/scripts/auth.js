/**
 * Search Console authorization — a thin wrapper over the shared google-auth store
 * (one token per Google account, see ../../google-auth/SKILL.md).
 *
 *   node scripts/auth.js --step=listen                       # FIRST, in the background
 *   node scripts/auth.js --step=url [--profile=<e-mail|etykieta>]   # link for the user
 *
 * --profile = an already authorized account (extends its token with Search Console) or
 * a new label for the next login. Whoever logs in, the token lands under the
 * e-mail Google reports — a second account never overwrites the first.
 */

import { spawn } from 'child_process';
import { authUrl, findAccount, CLI } from '../../google-auth/scripts/tokens.js';

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : undefined;
};

if (arg('step') === 'listen') {
  const extra = arg('timeout') ? [`--timeout=${arg('timeout')}`] : [];
  spawn(process.execPath, [CLI, '--action=listen', ...extra], { stdio: 'inherit' }).on('exit', (c) => process.exit(c ?? 1));
} else {
  const profile = arg('profile') || arg('account');
  const known = profile ? findAccount(profile) : null;
  const email = known?.email || (/@/.test(profile || '') ? profile : undefined);
  const label = !known && profile && !/@/.test(profile) ? profile : undefined;
  console.log('\n🔐 Autoryzacja Search Console (webmasters.readonly — tylko odczyt)\n');
  if (known) console.log(`Konto: ${known.email} — zgoda zostanie rozszerzona, poprzednie usługi zostają.\n`);
  else if (label) console.log(`Nowe konto dostanie etykietę „${label}”.\n`);
  console.log('1. W tle musi działać nasłuch: node scripts/auth.js --step=listen');
  console.log('2. Link:\n');
  console.log(authUrl({ services: 'gsc', account: email, label }) + '\n');
  console.log('Jeśli Google powie, że API jest wyłączone — włącz w tym samym projekcie GCP:');
  console.log('  https://console.cloud.google.com/apis/library/searchconsole.googleapis.com\n');
}
