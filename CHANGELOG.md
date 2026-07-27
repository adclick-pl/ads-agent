# Changelog

Zmiany w pakiecie Ads-Agent. Najnowsze na górze.

Po `git pull` **zrestartuj Claude Code** — nowe skille pojawiają się dopiero po
restarcie sesji. Szczegóły każdego skilla: `.claude/skills/<skill>/SKILL.md`.

---

## 2026-07-27

### Dodane

- **Nowy skill `gads-wykluczenia-hasel`** — znajduje wyszukiwane hasła przepalające
  budżet i generuje raport HTML z dwiema listami per kampania („Pewne — do wykluczenia"
  i „Do sprawdzenia") oraz listami gotowymi do wklejenia w Google Ads. Łączy cztery
  sygnały: wydajność z 30 dni, rok bez konwersji, dopasowanie do słów kluczowych
  i ocenę AI znającą ofertę klienta. Obejmuje Search, DSA, AI Max, Shopping i PMax.
  Tylko odczyt — niczego nie zmienia na koncie. Wymaga skonfigurowanego `gads-connector`.

  ```bash
  node ".claude/skills/gads-wykluczenia-hasel/scripts/wykluczenia-hasel.js" --account=1234567890 --open
  ```

  Przepływ jest **dwuprzebiegowy**: pierwszy przebieg zapisuje hasła do oceny, Claude je
  ocenia znając ofertę, drugi przebieg wciąga werdykty. W folderze raportu powstają
  `kontekst.md` (opis oferty — wypełnij, to najmocniej podnosi jakość) i
  `status-kierowanie.md` (pamięć między rundami). Test offline, bez API:
  `node ".claude/skills/gads-wykluczenia-hasel/scripts/smoke-test.js"`.

- **`CHANGELOG.md`** — ten plik.

### Zmienione

- `README.md` — skill dopisany do drzewa katalogów i tabeli Skills.
