#!/usr/bin/env node
// Usuwanie plików do Kosza systemowego zamiast `rm` — da się je przywrócić.
//
//   node .claude/hooks/kosz.js <ścieżka> [...]   przenosi pliki/foldery do Kosza
//   node .claude/hooks/kosz.js --hook            hook PreToolUse (Bash): blokuje `rm`
//
// Kosz wg systemu: macOS — `trash` (macOS 15+) albo Finder; Windows — Kosz przez
// PowerShell; Linux — `gio trash` albo `trash-put`. Bez zależności npm.

import { execFileSync } from 'node:child_process';
import { existsSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEN_PLIK = fileURLToPath(import.meta.url);
const RM = /(^|[;&|(`]|xargs|-exec)\s*(sudo\s+)?rm(\s|$)/m;

function hook() {
  let polecenie = '';
  try {
    polecenie = JSON.parse(readFileSync(0, 'utf8'))?.tool_input?.command ?? '';
  } catch {
    process.exit(0);
  }
  if (RM.test(polecenie)) {
    console.error(`Nie używaj rm — usuń do Kosza: node "${TEN_PLIK}" <ścieżki> (pliki da się przywrócić).`);
    process.exit(2);
  }
  process.exit(0);
}

function maKomende(komenda) {
  try {
    execFileSync('which', [komenda], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function doKosza(sciezki) {
  switch (process.platform) {
    case 'darwin':
      if (existsSync('/usr/bin/trash')) {
        execFileSync('/usr/bin/trash', sciezki, { stdio: 'inherit' });
      } else {
        execFileSync('osascript', [
          '-e', 'on run argv',
          '-e', 'repeat with p in argv',
          '-e', 'tell application "Finder" to delete (POSIX file (contents of p) as alias)',
          '-e', 'end repeat',
          '-e', 'end run',
          ...sciezki,
        ], { stdio: ['ignore', 'ignore', 'inherit'] });
      }
      return;
    case 'win32': {
      // Ścieżki przez zmienną środowiskową — bez sklejania ich w treść polecenia.
      const skrypt = [
        'Add-Type -AssemblyName Microsoft.VisualBasic',
        '$ErrorActionPreference = "Stop"',
        'foreach ($p in ($env:KOSZ_SCIEZKI -split "`n")) {',
        '  if (Test-Path -LiteralPath $p -PathType Container) {',
        '    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, "OnlyErrorDialogs", "SendToRecycleBin")',
        '  } else {',
        '    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, "OnlyErrorDialogs", "SendToRecycleBin")',
        '  }',
        '}',
      ].join('\n');
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', skrypt], {
        stdio: 'inherit',
        env: { ...process.env, KOSZ_SCIEZKI: sciezki.join('\n') },
      });
      return;
    }
    default:
      if (maKomende('gio')) {
        execFileSync('gio', ['trash', '--', ...sciezki], { stdio: 'inherit' });
      } else if (maKomende('trash-put')) {
        execFileSync('trash-put', ['--', ...sciezki], { stdio: 'inherit' });
      } else {
        throw new Error('Brak narzędzia do Kosza — zainstaluj `gio` (glib) albo `trash-cli`.');
      }
  }
}

function main(argv) {
  if (argv[0] === '--hook') return hook();
  if (!argv.length) {
    console.error('Użycie: node .claude/hooks/kosz.js <ścieżka> [...]');
    process.exit(1);
  }
  const sciezki = argv.map((p) => path.resolve(p));
  const brak = sciezki.filter((p) => !existsSync(p));
  if (brak.length) {
    console.error(`Nie ma takich plików: ${brak.join(', ')}`);
    process.exit(1);
  }
  try {
    doKosza(sciezki);
  } catch (err) {
    console.error(`Nie udało się przenieść do Kosza: ${err.message}`);
    process.exit(1);
  }
  for (const p of sciezki) {
    if (existsSync(p)) {
      console.error(`Plik nadal istnieje: ${p}`);
      process.exit(1);
    }
  }
  console.log(`Przeniesiono do Kosza: ${sciezki.join(', ')}`);
}

main(process.argv.slice(2));
