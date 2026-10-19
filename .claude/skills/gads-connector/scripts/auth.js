/**
 * Google Ads authorization — a thin wrapper over the shared google-auth store
 * (one token per Google account, see ../../google-auth/SKILL.md). Prints the
 * consent link and waits for the callback in the same process.
 *
 *   node scripts/auth.js [--account=<e-mail|etykieta>] [--label=<nazwa>]
 *
 * The token lands under the e-mail Google reports; ~/google-ads.yaml (if you
 * have one) gets the default account's refresh token as an export.
 */

import { spawn } from 'child_process';
import { authUrl, findAccount, CLI } from '../../google-auth/scripts/tokens.js';

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : undefined;
};

const account = arg('account');
const known = account ? findAccount(account) : null;
console.log('\n🔐 Autoryzacja Google Ads\n');
console.log('Otwórz link, zaloguj się kontem z dostępem do Google Ads i zatwierdź:\n');
console.log(authUrl({ services: 'ads', account: known?.email || account, label: arg('label') }) + '\n');
spawn(process.execPath, [CLI, '--action=listen'], { stdio: 'inherit' }).on('exit', (c) => process.exit(c ?? 1));
