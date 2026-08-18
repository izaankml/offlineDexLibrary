# OfflineDex: efficiency & structure review (2026-08-18)

A codebase-wide pass over the upload (SaveTracker), migration (Migrator/Setup) and
update-CLI flows, looking for shorter wait times, a structure that is easier to keep
right, and less breakage when the creator changes the base spreadsheet. Nothing here
is implemented; each item says what to change, why, and what it costs.

Evidence used: every file in `library/`, `bound/`, `scripts/`, the docs, git history,
and the actual header rows of the 6.03 copy and the creator's PUBLIC 6.03 sheet
(read via Drive). I could not run the flows, so timings below are call-count
models, not measurements — see "Measure first" at the end.

---

## Status (2026-08-18, end of day)

Implemented and pushed (library + bound + GitHub): items 0–7 of §8 — timing log, error
surfacing, TypeScript library with tests, header-keyed layout probe with preflight,
single-read SaveTracker without marker column or clear pass, Sheets-API migration with
preview + atomic apply, bound-surface shrink. Not started: §3.5 CF live diff prototype and
§4.2 spec-driven customizations (both gated on the first measured timings).

---

## 1. Headline findings

1. **`clearHighlights` is redundant inside the upload flow.** `applyHighlightsForTracker`
   already writes a `null` background into *every* cell of columns 1..displayMaxCol for
   every tracked row (`SaveTracker.js:462-480`), which wipes previous highlights. The
   whole clear step (3 marker reads, one `setBackground(null)` per contiguous run of
   changed rows, 3 `clearContent`, 3 toasts) does work that is immediately redone.
   Removing it also removes the only consumer of the **marker column** — the source of
   the 6.03 "marker overwrote Ribbons/Max IVs" bug class.
2. **The upload flow reads every data sheet twice** (once to diff, once to snapshot;
   `SaveTracker.js:455-457` and `:314-316`) and reads it in 200-row chunks. One read per
   sheet, reused for both, is enough; chunking is only needed for the *writes* that
   caused "Service error: Spreadsheets".
3. **Migration does two full-sheet `Sheet.copyTo()`s (+ deletes) to move a handful of
   formats**, then ~50 single-cell dimension calls (`Migrator.js:127,146-159,401`). The
   Sheets advanced service can read formats cross-spreadsheet and apply everything
   (formats, widths, hidden state, merges, banding, CF) in one `batchUpdate` — no temp
   sheets, no `openById` of the old 4 MB workbook.
4. **Every layout fact is a hard-coded index** (`buildShiftMap(4, 11, 4)`, `markerColumn: 17`,
   `excludeDisplayColumns {5,34,35}`, `columnHighlightColors {14,28,41}`, `insertColumnBefore(12)`,
   `B16:M131`). The data and display sheets carry *identical* sub-header text
   ("Fought Flag", "Caught Count", "Hatched Count", "Classic Wins" …), so every one of these
   can be located by header at runtime and verified before anything is painted. Both
   6.01 and 6.03 breakages were index drift.
5. **Errors don't reach the user.** `portAll` swallows per-step errors into a `Logger`
   line (`Migrator.js:73-100`); `finishSetup` still marks the copy migrated
   (`Setup.js:320-322`); `uploadFile` catches `processChanges` failures and leaves a sticky
   "Highlighting…" toast (`bound/LoadPlayerData.js`). The 6.03 mis-migration was only
   visible in Executions.
6. **A genuinely different upload strategy exists that removes the paint loop entirely:**
   let conditional formatting compare `data` vs `_snapshot_` live (via `INDIRECT`), and make
   "upload" = *snapshot then write JSON*. Per-upload sheet work drops to one read + one write
   per tracker. Worth a prototype on Quick Checklist before committing (INDIRECT cost on the
   145k-cell Full Dex is the open question).

---

## 2. Where the time goes today (call-count model)

Assumptions: Quick Checklist ≈ 570 rows × 8 tracked cols, Starter Dex ≈ 570 × 132,
Full Dex ≈ 1100 × 132, `CHUNK_ROWS = 200` → 3 + 3 + 6 = 12 chunks. Each Sheets call from
Apps Script is roughly 0.1–0.5 s; a full-sheet `sort()` on a formula-heavy 1100×140 sheet
is seconds.

### Upload (`uploadFile` → `processChanges`)

| Step | Calls (approx.) | Notes |
|---|---|---|
| Import + `flush` + `sleep(2000)` | 1 write + 2 s | sleep is probably unnecessary (see §3.6) |
| `clearHighlights` | 3 reads + *R* `setBackground(null)` + 3 clears + 3 toasts + 3 `hideColumns` | *R* = number of contiguous changed-row runs — after a long run this can be dozens |
| `highlightChanges` | 3 sorts + 12 × (2 reads + 1 `setBackgrounds` + 1 marker write) = 48 + 3 toasts | the three sorts rewrite the whole display sheets |
| `sortFormChecklistByDone` | 1 sort + toast | small sheet, fine |
| `snapshot` | 3 × (clear + header read + header write + `hideColumns`) + 12 × (read + write) = 36 + 3 toasts | re-reads what highlight just read |
| **Total** | **≈ 100 + R calls, 4 sorts, ~15 toasts** | |

### Migration (`portAll`)

| Step | Cost drivers |
|---|---|
| Lookup + `openById(src)` | Drive search + opening a 4 MB workbook |
| Quick Checklist header | full-sheet `copyTo` (≈600 rows × 17 cols with IMAGE formulas), `insertColumnsBefore`, 10 `getRowHeight` + 10 `setRowHeight` + 10 `isRowHiddenByUser` + 10 hide/show + 17 `getColumnWidth` + 17 `setColumnWidth`, 2 formula copies, `deleteSheet` |
| Banding | cheap |
| Daily Mode formatting | full-sheet `copyTo` again for two ranges + 2 widths, `deleteSheet` |
| Daily Mode cells | cheap |
| Hidden sheets | `getSheets()` on both + one `hideSheet` per hidden sheet |
| IV CF | cheap |

The two `copyTo`s and the ~75 dimension calls dominate; everything else is noise.

---

## 3. Upload flow

### 3.1 Drop the clear step and the marker column *(small change, large win)*
- In `processChanges`, remove `clearHighlights()`; keep the menu item for manual use but
  implement it as "write `null` backgrounds over the tracked block" (same cost as one paint,
  no marker needed).
- Delete `markerColumnFor`, `markerColumn`, `useFilter`, `toRuns`, the marker
  writes and the per-upload `hideColumns`. The Migrator's "hide Ribbons" step stays; the
  hidden extra column at Q / EF disappears from the display sheets.
- **Conformance win:** there is no longer a column that must sit "just past the block"
  and can collide with a creator column.

### 3.2 Paint only the tracked block, not columns 1..max
`backgrounds` is `displayMaxCol` wide starting at column 1 (`SaveTracker.js:462,478`),
so every upload nulls the fills of A–G on Quick Checklist and A–C on the dex sheets
(creator columns; also the image column B whose fills the Migrator separately clears).
Write `getRange(row, minDisplayCol, n, maxDisplayCol-minDisplayCol+1)` instead. Same
call count, no side effects on creator formatting.

### 3.3 One read per sheet; snapshot from the same values
Read `data` once (whole tracked block; 145k cells is fine for `getValues`), read the
snapshot once, diff in memory, then write the snapshot from the `currentValues` you already
hold. Chunk only the `setBackgrounds` writes, and try 500–1000 rows before settling on 200.
Result: **3 × (2 reads + ⌈rows/500⌉ background writes + 1 snapshot write) ≈ 15 calls**
instead of ≈ 100 + R.

Also: write the snapshot at the *same row/column numbers as the data sheet* (not
header-rows+1, not offset by `minDataCol` with hidden leading columns). It removes the
`hideColumns`, the `snapDataStartRow` arithmetic, and is a prerequisite for §3.5.

### 3.4 Stop sorting the display sheet every upload; paint by key
`sortDisplayByColumn` exists because painting is by row offset. The display sheets have a
key column (A = dex #) and so do the data sheets. Read both key columns (2 tiny reads),
build `displayRowFor[key]`, and place highlights by key. Then:
- no full-sheet sort (the single most expensive call in the flow),
- correct even when a slicer has reordered the display,
- no reliance on "column-A-ascending == data order".
If you *want* the sort as a UX reset (slicers), keep it as an explicit menu action, not a
per-upload cost.

### 3.5 Alternative strategy: live diff via conditional formatting *(prototype first)*
Instead of painting, install CF rules on the display block once (Migrator/Finish Setup):

```
=INDIRECT("STARTER_CHECKLIST.data!R"&ROW()&"C"&(COLUMN()-4), FALSE)
   <> INDIRECT("_snapshot_QuickChecklist!R"&ROW()&"C"&(COLUMN()-4), FALSE)
```

(one rule per colour group: default, "increment" columns, excluded columns get none).
Then the upload flow becomes **snapshot → write JSON**, i.e. one read + one write per
tracker (~6 calls total) plus the import itself. Highlights are live and always correct;
"Keep Baseline" = skip the snapshot; "Clear Highlights" = snapshot now; "Highlight Changes"
menu item goes away. CF fills also win over the creator's own CF if placed first.

Open questions to settle with a prototype on Quick Checklist (≈5k cells):
- INDIRECT-in-CF cost on the dex sheets (≈145k cells each). If sluggish, a hidden
  `_diff_<key>` sheet with a single `ARRAYFORMULA(data<>snapshot)` reduces the CF to one
  INDIRECT per cell; if still too slow, stay with §3.1–3.4 painting.
- Row alignment: CF by `ROW()` needs display row = data row (keep the sort, or accept
  slicer-order mismatch), or a MATCH-by-key formula which is heavier.

### 3.6 Small things
- `Utilities.sleep(2000)` after `flush()`: values read after a flush are already
  recalculated in Apps Script; try removing it and compare the diff counts on a
  re-upload of the same save (should be 0).
- Toasts are calls too (~15 per upload). Keep one at start, one per tracker, one at end.
- Surface failures: on any exception in `processChanges`, toast the error and log it;
  never leave the sticky `-1` toast up.
- `LockService.getDocumentLock()` around the upload so two dialogs can't interleave.

---

## 4. Migration flow

### 4.1 Use the Sheets advanced service instead of temp-sheet `copyTo` *(largest single speed-up)*
Enable `Sheets` (advanced service) in `library/appsscript.json`. Then:
- **Read** the source formats cross-spreadsheet in one call:
  `Sheets.Spreadsheets.get(srcId, {ranges: ['Quick Checklist!A1:Q10','Daily Mode!B16:M131','Daily Mode!L12:M14'], includeGridData: true, fields: 'sheets(properties,data(rowData(values(userEnteredFormat,userEnteredValue)),rowMetadata,columnMetadata))'})`
  — gives formats, formulas, row heights/hidden, column widths/hidden.
- **Write** everything to the destination in one `Sheets.Spreadsheets.batchUpdate` with
  `updateCells` (formats + formulas), `updateDimensionProperties` (widths/heights/hidden),
  `insertDimension` (Daily Mode column L), `mergeCells`, `updateBanding`, and CF requests.
No `openById(src)`, no `copyTo`, no `deleteSheet`, no per-row/column loops. Migration
should drop from ~2 min to a few seconds, and the code becomes a list of request objects
(easy to log as a dry run — see 4.3).

The `insertColumnsBefore` trick that shifts same-sheet references (`alignQuickChecklistTemp`)
is replaced by reading formulas as R1C1 (`getFormulasR1C1` / write with `setFormulasR1C1`),
which keeps relative refs correct at the new position; cross-sheet refs are untouched.

### 4.2 Alternative strategy: spec-driven customizations, no source sheet needed
Today "migrate" = *copy whatever the previous copy has*. That propagates drift (e.g. the
old sheet's hidden marker column), depends on the old copy existing and being correct, and
can't be re-run safely. Almost every customization is already declarative in code:
insert Daily Mode L, merge B16:M131, B16 formula, L12:M14 inputs, hide Ribbons, hidden-sheet
list, IV CF swap, banding to B, title stamp. Only two things are "whatever the old sheet
had": Quick Checklist rows 1–10 formats/formulas and Daily Mode B16:M131 / L12:M14 formats.

Proposal: a `Customizations.js` in the library holding a spec (list of ops with landmark
anchors), plus a one-off **Export customizations** menu item that dumps the two format
blocks (via the same `Sheets.Spreadsheets.get … includeGridData`) as JSON to paste into
the spec. Finish Setup then applies the spec to a fresh copy — idempotent (each op checks
before acting), re-runnable, no Drive lookup of the previous version, and reviewable in
git. Keep "port from previous version" as a fallback for one release while you trust it.

### 4.3 Preflight / dry run
Before touching anything, resolve every landmark and print a plan (dialog or log):
"Quick Checklist: block at F–P (Caught?…Ribbons), will hide P; Daily Mode: landmark at M2 →
insert L; SaveTracker maps: Shiny→H … Max IVs→O; dex: Fought Flag D↔L (shift −8)…". Refuse
if any landmark is missing. This alone would have caught both 6.03 bugs before the
"trash the copy and re-copy" cycle.

### 4.4 Make every step idempotent
Each op checks its own precondition (column L present? merge exists? Ribbons already
hidden? title already stamped?) so Finish Setup can be re-run on the same copy after a
fix instead of starting from a fresh copy.

### 4.5 Report `ERR` lines to the user
`portAll` should return its OK/ERR log; `finishSetup` shows an alert with the ERR lines and
should **not** set `OFFLINEDEX_MIGRATED_FROM` if any step failed (or set it with a
"partial" marker). Currently the only trace is in Executions.

---

## 5. Conforming to creator layout changes: a header-keyed layout probe

What the sheets actually contain (6.03):

| Sheet | Row | Header text (excerpt) |
|---|---|---|
| `STARTER_CHECKLIST.data` | 1 | Dex #, Caught flag, Classic Wins, **SHINY**, VARIANT_2, VARIANT_3, Hidden Ability, Passive Attribute, Value Reduction, Egg flag, **Max IVs**, Ribbons |
| `Quick Checklist` | 1 | …, (junk E), **Caught?**, Classic Ribbon, Shiny Tier 1 … Max IVs, **Ribbons** |
| `STARTER_DEX.data` / `FULL_DEX.data` | 2 | **Fought Flag**, Fought Count, NON SHINY, SHINY, …, Caught flag, **Caught Count**, …, **Hatched Count**, …, Candy Count, Friendship, …, **Classic Wins**, Total Natures, HARDY … |
| `Starter Dex Checklist` / `Full Dex Checklist` | 2 | DEX #, Starter, Starter Cost, **Fought Flag**, Fought Count, … *(identical sub-header text from here on)* |

So a single `Layout.js` can replace every index constant:

```js
const TRACKER_SPECS = [
  { key: 'QuickChecklist', dataSheet: 'STARTER_CHECKLIST.data', displaySheet: 'Quick Checklist',
    dataAnchor: { row: 1, text: 'SHINY' }, displayAnchor: { row: 1, text: 'Shiny Tier 1' },
    width: 8, color: YELLOW },
  { key: 'StarterDex', …, dataAnchor: { row: 2, text: 'Fought Flag' }, displayAnchor: { row: 2, text: 'Fought Flag' },
    width: 132, exclude: ['Fought Count', 'Candy Count', 'Friendship'],
    increment: ['Caught Count', 'Hatched Count', 'Classic Wins'] },
  …
]
```

`resolveLayout(ss)` finds anchors by text (case/space-insensitive), computes the shift,
maps `exclude`/`increment` names to columns, and **fails loudly** with the header it found
instead. Run it at upload time too (one header read per sheet — you already read headers
for the snapshot) so a creator reshuffle stops the paint rather than mis-painting.
The Migrator's Quick Checklist locator (`quickChecklistFirstDataColumn`, row 10) and the
Daily Mode landmark become entries in the same module — one place to fix per release.

Bonus: `nudgeFinishSetupIfFresh` and the update CLI could run the probe as a
"does 6.0X still fit my assumptions?" check the moment a copy exists.

---

## 6. Structure & maintainability

### 6.1 Shrink the surface that has to merge with the creator's code
Today three creator files are edited (`onOpen.js` menu+wrappers, `LoadPlayerData.js`
`uploadFile`, `UploadPlayerData.html`). Reduce to near-zero conflict surface:
- Put all wrappers (`snapshot`, `highlightChanges`, `finishSetup`, `openUploadDialog`, a new
  `uploadFileTracked`) in a **new** bound file `OfflineDexBound.js` (yours, never merged).
- `uploadFileTracked(obj)` calls the creator's `createBlob/decryptFile/parseJsonContent/writeJsonToSheet`
  and then `processChanges` — `LoadPlayerData.js` goes back to pristine.
- The dialog: keep the creator's HTML pristine and ship your own `OfflineDexUpload.html`
  (opened by your menu items) — or keep the 2-line edit; either way it's the only touch.
- `onOpen.js`: the menu block can be built by the library (`OfflineDexLib.buildMenu()`; menu
  function names resolve in the bound project), leaving a 1-line diff in the creator's file.
Net: the per-version 3-way merge almost never conflicts.

### 6.2 Tests for the pure logic
Nothing is tested. The diff (`snap vs current → cells`), `toRuns`, `compareVersions`,
`versionFromName`, header anchoring, and the batchUpdate request builders are all pure.
Two cheap routes:
- Keep GAS-style JS, add `test/` under `node:test` that loads `library/*.js` in a `vm`
  context with a tiny fake `SpreadsheetApp` (2-D arrays); or
- Move `library/` to TypeScript bundled with esbuild into one `Code.js` (clasp 3.3 no
  longer transpiles TS itself), which also lets `scripts/update.ts` and the library share
  `naming.ts` (`copyName`, `versionFromName`, `PUBLIC_SHEET_FILE_ID`, script-ID regex —
  currently duplicated by hand in `Setup.js` and `update.ts`).
Given your TypeScript preference, the second is the better long-term shape; the first is
an afternoon.

### 6.3 Persistent timing log
Each step already measures itself for the toast. Append `{version, flow, step, ms}` to a
hidden `_timings` sheet or a document property so speed-ups are measurable and regressions
visible in the next release. Do this *before* any of §3/§4 so the wins are proven.

### 6.4 Smaller items
- `finishSetup` opens the upload dialog after `portAll` — with §4.5 it should stop on ERR.
- `Prettier` from global PATH (`update.ts:417`): make it a devDependency and call
  `node_modules/.bin/prettier` so the baseline normalisation is reproducible.
- `developmentMode: true` on the library means a bad `clasp push` breaks *every* sheet at
  once. Consider pinning the previous sheet's manifest to a numbered deployment once a
  version is stable, keeping HEAD only for the current copy.
- `.claspignore` in `bound/` only lists itself — harmless, but if you adopt 6.1 add the
  creator-only files there so `clasp push -f` never overwrites them with a stale pull.

---

## 7. Update CLI (`scripts/update.ts`)
It's in good shape; the wait is dominated by `clasp pull/push` and the manual
"open the copy → Extensions → Apps Script → paste URL" step, which really can't be automated
(bound scripts aren't enumerable; creating a *second* bound project via the Apps Script API
would leave the creator's `onOpen` running alongside yours). Two small improvements:
- accept the **sheet URL** too and print the `script.google.com/home/projects` search hint;
- after `clasp push`, run the layout probe (§5) through `clasp run` (needs the executable
  API enabled once) so "does my config fit this version?" is answered in the terminal
  before you ever open the sheet.

---

## 8. Suggested order

| # | Change | Effort | Wait-time impact | Robustness impact |
|---|---|---|---|---|
| 0 | Timing log (§6.3) | 1 h | — | measures everything below |
| 1 | Drop clear step + marker column; paint tracked block only; single read; snapshot from held values (§3.1–3.3) | ½ day | upload ≈ 100+R calls → ≈ 15 | removes marker-collision bug class |
| 2 | Header-keyed layout probe used by tracker + migrator, with preflight (§5, §4.3) | 1 day | — | catches creator reshuffles before painting/migrating |
| 3 | Surface errors; don't mark migrated on ERR (§4.5, §3.6) | 1 h | — | no more silent mis-migrations |
| 4 | Sheets API batchUpdate migration (§4.1) | 1 day | migration ~2 min → seconds | no temp sheets, idempotent ops |
| 5 | Paint by key, drop per-upload sort (§3.4) | ½ day | removes 3 heavy sorts | correct under slicers |
| 6 | Bound-surface shrink (§6.1) | ½ day | — | near-conflict-free merges |
| 7 | Tests / TS bundle / shared naming (§6.2) | 1–2 days | — | long-term maintainability |
| 8 | Prototype CF live diff on Quick Checklist (§3.5) | ½ day | if it holds up: upload ≈ 6 calls | live, always-correct highlights |
| 9 | Spec-driven customizations (§4.2) | 1–2 days | — | no dependency on the previous copy |

---

## Measure first
I could not execute anything in Apps Script from here, so the counts above are derived from
the code paths, not stopwatch numbers. Item 0 (timing log) turns them into numbers; the
per-step toast timings you already have in Executions are enough to sanity-check the
proportions before starting.

Observations that are *not* our bugs but worth knowing: column E of the creator's Quick
Checklist shows `#REF!` from row 12 down in the PUBLIC 6.03 sheet itself (hidden, harmless);
the display dex sheets now render ☑/☐ as text glyphs, not images (so `getDisplayValues` on
them would work — irrelevant if we keep diffing the data sheets, which is still the right
source of truth).
