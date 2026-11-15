# OfflineDex Scripts: Project Context

This doc summarizes the design and decisions behind this repo so that future work (in Claude Code or otherwise) has the context without reading commit history or external chats.

## What this is

I track my Pokemon collection in a Google Sheets spreadsheet called "Offline RogueDex" maintained by a third-party creator. The creator publishes new versions every so often as a public read-only spreadsheet. To use a new version I make a copy into my Drive, which gives me a fresh spreadsheet with the creator's bound Apps Script attached.

This repo contains two pieces of automation I've added on top of the creator's spreadsheet:

1. **A save tracker** that highlights cells in the spreadsheet that changed since my last save data upload, so I can see which Pokemon got newly caught/shiny/etc.
2. **A version migrator** that ports my customizations (formatting, hidden sheets, specific cell formulas) from an old version of the spreadsheet to a new one.

Both pieces of logic live in a single shared **OfflineDex Library** Apps Script project. Each version's bound script references this library and exposes its functions via menu items.

## Repo structure

```
offlinedex-scripts/
├── README.md
├── CONTEXT.md                   # this file
├── .gitignore
├── UPDATING.md                  # per-version runbook
├── package.json                 # `npm run build` / `test` / `typecheck` / `update` / `setup`
├── src/
│   ├── lib/                     # library sources (TypeScript); see index.ts for the public surface
│   │   ├── saveTracker.ts, migrator.ts, setup.ts, progress.ts
│   │   ├── trackedFormulas.ts   # our cell formulas in the sheet (AG3, the unlock map)
│   └── shared/naming.ts         # copy-naming rules shared by the library and the CLI
├── scripts/
│   ├── build.ts                 # esbuild: src/lib → library/Code.js (+ forwarding stubs)
│   └── update.ts                # the terminal half of a version update (TypeScript, Node 24)
├── test/                        # node:test + fake SpreadsheetApp; fixtures from the real 6.03 sheets
├── library/                     # OfflineDex Library project (standalone Apps Script)
│   ├── .clasp.json              # has the library's Script ID (gitignored)
│   ├── appsscript.json
│   └── Code.js                  # generated bundle (gitignored); the only code file clasp pushes
└── bound/                       # bound script for the spreadsheet (per-version)
    ├── .clasp.json              # has the current spreadsheet's Script ID (gitignored, written by the CLI)
    ├── appsscript.json
    ├── onOpen.js
    ├── LoadPlayerData.js
    └── UploadPlayerData.html
```

Notes:

- clasp uses `.js` locally; converts to `.gs` on push
- `.clasp.json` is gitignored because it contains Script IDs
- The library is written in TypeScript under `src/lib` and bundled into a single
  `library/Code.js` (`npm run build`). Apps Script libraries expose only top-level function
  declarations, so the build appends one forwarding stub per export of `src/lib/index.ts`.
  The bound project stays plain JS because it is 3-way merged with the creator's code.
- `src/lib/progress.ts` also appends every flow's per-step durations to a hidden `_timings`
  sheet (one write per flow), so wait times are measurable across versions.
- The sections below describe the modules under `src/lib`.

## The library: OfflineDexLib

A standalone Apps Script project. Deployed as a library and imported into each version's bound script with the identifier `OfflineDexLib`.

### saveTracker.ts (+ layout.ts, progress.ts)

Tracks changes between save data uploads and highlights changed cells.

**Key concept: trackers.** A tracker pairs a "data sheet" (raw 0/1/count values the
creator's formulas derive from the save) with a "display sheet" (the visual checklist).
Since 2026-08 a tracker is a **spec of header labels, not column numbers**
(`TRACKER_SPECS` in `saveTracker.ts`, resolved by `layout.ts`):

```ts
{ key: 'StarterDex', dataSheet: 'STARTER_DEX.data', displaySheet: 'Starter DEX Checklist',
  dataFirstRow: 3, displayFirstRow: 4,
  dataBlockAnchor: 'Fought Flag', displayAnchor: { kind: 'label', text: 'Fought Flag' },
  trackFrom: 'Fought Flag', trackTo: null,            // through the last labelled column
  exclude: ['Fought Count', 'Candy Count', 'Friendship'],   // auto-calculated, never painted
  increment: ['Caught Count', 'Hatched Count', 'Last Shiny', 'Last New Variant',
              'Total', 'Classic Wins'],     // purple; a label this copy lacks is skipped
                                            // 'Total' = Egg Move Attributes total
  crossCheck: 'Classic Wins', sortDisplayColumn: 1, ... }
```

`resolveTracker()` reads the first 10 rows of both sheets once, finds the anchors by
text (case/space-insensitive; first occurrence, since labels like "Friendship" repeat
further right), derives `shift = displayCol − dataCol`, maps exclude/increment names to
columns, cross-checks a second label, and **throws a precise message** ("could not find
the header 'Fought Flag' in the first 10 rows of 'Starter DEX Checklist'") if the
creator's layout no longer fits, so a reshuffle stops the paint instead of mis-painting.
The Quick Checklist display block is located the way the Migrator does it (first
non-blank cell of row 10 right of the fixed A–D columns), because after migration its
row-1 labels are replaced by your stat formulas. Verified layouts: 6.01 (shift +3), 6.03
(shift +4); `test/fixtures/headers-6.03.json` holds the real header rows and
`golden-mappings.json` pins the exact per-column mapping the old index-based config
produced. `describeLayout()` returns the resolved layout as text (dry run).

**Highlight colors:** yellow (`#FFFF00`) on the Quick Checklist, light green (`#93c47d`)
on the dex sheets, light purple (`#b4a7d6`) for the increment counters.

**The flow on each save upload (`processChanges`).** Measured on 2026-08-18, every
SpreadsheetApp call in this workbook costs ~1 s (formula-heavy) and a 145k-cell
`getValues`/`setBackgrounds`/`setValues` 15–25 s, so all bulk I/O goes through the Sheets
API instead:

1. *Reading sheets*: one `spreadsheets.get` (sheet ids/sizes) and ONE `values.batchGet`
   returning the whole data sheets (header band + values), the display header bands and
   key columns, and the v3 snapshots. The layout probe runs on the bands from that read.
2. *Highlighting changes*: in-memory diff; then ONE `batchUpdate` that clears last
   upload's highlighted rows (their positions are stored in the snapshot metadata; on the
   first run after an upgrade the whole tracked block is cleared once) and paints only the
   changed rows (`updateCells` with `backgroundColor` per row of the tracked block, `{}`
   for unchanged cells). If the display key column (A) is out of order (a slicer sort),
   the display is physically re-sorted first; otherwise there is no sort. The same batch
   wipes the hand-made highlights on the `CLEAR_ON_UPLOAD` sheets (`Party Checklist` from
   B3: one `repeatCell` blanking the backgrounds from that cell to the grid's end, so the
   creator's header fills above it and the hand-highlighted names in column A stay). A
   missing sheet is logged and skipped; *Check
   Layout* shows whether each one was found. The Daily Unlock Map was on this list until
   2026-09-05; its marked cells are now tinted by a conditional format rule instead.
3. *Snapshotting*: ONE `values.batchUpdate` writes each tracker's baseline as **JSON in a
   few cells** of the hidden `_snapshot_<key>` sheet (A1 = metadata `{v, firstRow,
   minCol, maxCol, rows, cells, labels, painted}`, A2… = row chunks ≤45k chars). A
   snapshot sheet whose A1 is not that metadata counts as "no baseline" and is wiped on
   the first write. `labels` lets a later upload realign the baseline by header label if
   the creator inserts a column between uploads (k-th occurrence to k-th occurrence, since
   "SHINY"/"Friendship" repeat).

That is 4 API calls per upload (was ≈100 SpreadsheetApp calls, 4 sorts). The old Form
Checklist "unchecked first" sort was dropped altogether (2026-08-18): it's one click by hand
and barely needed.
**Upload Data (Keep Baseline)** paints and stores the painted rows but leaves the baseline.

**Standalone menu items:** *Snapshot Data* (baseline ← current, highlights untouched),
*Highlight Changes* (= keep-baseline flow; the hand-made highlights on the `CLEAR_ON_UPLOAD`
sheets are left alone), *Clear Highlights* (clears the whole tracked blocks and the
`CLEAR_ON_UPLOAD` sheets), *Check Layout* (dry run of the probe, plus whether each
`CLEAR_ON_UPLOAD` sheet was found).

**Toast progress + timing log (`progress.ts`):** a single replacing toast shows the current
step; on finish (or failure, where `failFlow` shows a non-sticky error toast) every step's
duration is appended to the hidden `_timings` sheet in one write.

**Why the data sheets, not the display:** the display cells are formulas resolving through
`STARTER_CHECKLIST.sorted` etc.; the data sheets hold the raw values in the canonical row
order the display is painted against.

### migrator.ts (+ sheetsApi.ts, formulaShift.ts)

Ports customizations from an old version of the spreadsheet to a new one. Since 2026-08 it
is a **plan, preview, apply** pipeline on the Sheets advanced service (Sheets API v4):

1. **Read**: 2 GETs on the source (sheet list; formats/formulas of the customized
   ranges: `Quick Checklist!1:10`, `Party Checklist!A2:A`, and the tracked formulas
   `Daily Mode Unlocks!AG3` and `Daily Unlock Map!E2:I2`, only to compare with the
   repo's) and 2 on the destination (sheet list + banding + CF rules; the Quick Checklist
   header, `Daily Mode Unlocks!A1:AG3`, the header rows of the sheets AG3 looks up,
   `Daily Unlock Map!E2:I2`, `Daily Mode!H2:L6` and `Party Checklist!A2:A`). No
   `openById`, no temp sheets, no `copyTo`. The sheet list comes first because it decides
   which optional ranges the second GET asks for.
2. **Plan** (`buildPlan`, pure, tested with hand-built API responses): a list of `MigrationOp`s
   (label + batchUpdate requests). Planning **throws** when a landmark doesn't fit
   (Quick Checklist row 10 blank; destination block left of the source's; a header the
   tracked formulas read has moved), so nothing is touched on an unknown layout.
3. **Preview**: Finish Setup shows `describePlan()` in the confirm dialog.
4. **Apply**: ONE `batchUpdate`; the API applies it atomically (all steps or none).

**The ops:**

- *Quick Checklist header (rows 1–10)*: `updateCells` with the source's `userEnteredFormat`
  for every column (two segments when the destination block starts further right, as with
  6.03's hidden junk column E), `updateDimensionProperties` for row heights/hidden rows and
  column widths, row 1 (data block) and row 10 formulas/values with same-sheet references
  shifted by `shiftFormulaColumns` (cross-sheet refs, `$A$10`-style refs left of the block,
  strings and function names untouched), hide Ribbons, stamp `POKEROGUE DEX <dest>` into A1.
- *Banding over the image column*: `updateBanding` stretches the C-start banding to B (merging
  an A-only banding), `repeatCell` clears B's fills; a banding already spanning B only gets
  the fills cleared.
- *Hide sheets* hidden in the source; *IV highlight*: replace `= 31` boolean rules on the dex
  checklists with `=TO_TEXT(topLeft)<>"31"` → red, one rule per range, highest index first.
- *Sheet order*: the destination's tabs follow the source's order. Sheets in both (matched
  by title) take the source's relative order in the positions such sheets hold in the
  destination; sheets only in the destination (new creator tabs) keep their position.
  Each move is an `updateSheetProperties` index change that moves a tab left, since the
  API counts a rightward move's index before the move.
- *Unlock map highlight*: two custom-formula rules over the Daily Unlock Map's biome grid
  (E2 to the grid's end), `=REGEXMATCH(E2, "\([A-Z]")` → light green 2 for unlocks at
  index 0 and `=REGEXMATCH(E2, "\[[A-Z]")` → light orange 2 for charm-only cells under it,
  so a cell holding both reads as an unlock; each is skipped when already there. The map
  strings carry a parenthesized category marker (`(Shiny)`, `(Caught)`, …) for every
  unlock type except nature, set by the AG3 formula on Daily Mode Unlocks (an IV unlock is
  marked only when a stat rolls 31 that the starter's owned IVs, `DAILY_MODE.data` AA:AF,
  do not already have), and a bracketed
  one (`[Ability Charm]`, `[Shiny Charm]`) for the charm waves, added by the map's own
  E2:I2 formulas from the Daily Mode charm waves (`G3:G6` and `K3:K6`). A default shiny of a
  species with rare and epic variants (`hasVariants` in `STATIC:data.SPECIES`) reads
  `Default Shiny` with no marker, so the cell is tinted only when another unlock applies;
  every other shiny reads `<variant> (Shiny)`. The capital letter after each bracket keeps
  charm counts such as `(3)` from matching.
- *Tracked formulas* (`trackedFormulas.ts`): the repo holds our cell formulas, and these
  ops write the repo's copy, never the source's. A source formula that differs from the
  repo's (compared ignoring layout, sheet-name quoting and case outside string literals,
  since Sheets requotes and recases sheet names) is reported in the plan notes, so a hand
  edit that never reached the repo is visible before it is overwritten.
  - *Daily Mode Unlocks formula*: `AG3`, the map strings, skipped when the destination
    already holds it. Planning throws when the destination lacks the AG3 formula or a
    header label the formula reads is not where expected, since the column references
    would then point at the wrong data. Checked are `DAILY_UNLOCKS_LANDMARKS` (A2 Dex#,
    D1:L1 filters, M2/N2/P2/R2/S2/T2, U2 IVs) and, for the two sheets the formula looks up,
    `AG3_LOOKUP_SHEETS`: `STATIC:data.SPECIES` A1/AK1 and `DAILY_MODE.data` AA1/AF1 (the
    starter's owned IVs) with BY1 (`Species ID`). The owned IVs are joined on species ID
    (Daily Mode Unlocks A ↔ `DAILY_MODE.data` BY): that tab's `Pokemon` column holds the
    enum key for regional forms (`HISUI_ELECTRODE`) where Daily Mode Unlocks has the
    display name, and a species missing from the tab gets no `(IV)` marker. The
    destination read fetches those two header rows.
  - *Unlock map formulas*: `E2:I2` on the Daily Unlock Map, one per column (each lists
    its own `DAILY_MODE_MAP.data` biome column, AF to AJ, and reads its first wave from
    its own header cell, so they cannot be filled across); each cell is written only when
    it differs. Planning throws when a destination cell holds no formula or one that no
    longer lists the same biome column; a destination without the map sheet is skipped
    with a note.
- *Daily Mode Unlocks filters*: every checkbox in `D2:L2` is checked, so the sheet lists
  every unlock category. The nine "New …" headers in D1:L1 (`DAILY_UNLOCKS_FILTER_LABELS`)
  are checked first, and each cell under one must hold a checkbox value; otherwise
  planning throws. Skipped with a note when all nine are already checked.
- *Daily Mode overrides*: the values in `H3:H6` and `L3:L6`, the charm wave overrides under
  the "Override wave numbers" headers in H2 and L2, are cleared (formats kept). Planning
  throws when either header has moved; a column already empty gets no request, and a
  destination without Daily Mode is skipped with a note.
- *Party Checklist names*: column A from row 3, the Pokémon typed in by hand, one per
  two-row merge (A3:A4, A5:A6, …; the rest of each row is looked up from it), takes the
  source's values through the merge of the last name on either side, so leftover
  destination entries are cleared; formats, including hand highlights, are kept.
  Planning throws when A2 is not "Pokemon" on either side, a value sits in the lower row
  of a merge on either side (the names no longer pair up), the destination's column
  holds a formula, or the source's names run past the destination's last row. Skipped
  with a note when already matching or when either side has no Party Checklist.

Everything is idempotent (re-running on a migrated copy plans no CF change and
notes what was already done).

### setup.ts

The Google-side half of a version update (the terminal half is `scripts/update.ts`).

- `prepareNextVersion()`: run from the *current* sheet's menu. The creator publishes
  every version as **the same Drive file**, renamed per release
  (`PUBLIC_Offline RogueDex 6.03`; ID in `PUBLIC_SHEET_FILE_ID`). It reads the version
  from that title, copies it through `SpreadsheetApp` as `Offline RogueDex <new>` into your
  Drive root (reusing an existing same-named copy if you say so), and shows a dialog: open the
  copy → Extensions → Apps Script → paste the editor URL → the dialog builds
  `npm run update -- <scriptId>` with a Copy button.
  **Bound scripts are not enumerable through Drive** (verified 2026-08: v3 `files.list`
  with `'<sheetId>' in parents`, v2 `files.list`, and v2 `children.list` all return
  nothing even with full Drive scope inside Apps Script), so no lookup is attempted. The
  library lists spreadsheets by name through the Drive advanced service (`files.list`,
  wrapped in `src/lib/driveApi.ts`) and edits through the Sheets advanced service; no
  `DriveApp`, no `UrlFetchApp`.
- **OAuth scopes are pinned** in both manifests (`library/appsscript.json`,
  `bound/appsscript.json`): `spreadsheets`, `drive.metadata.readonly`, and
  `script.container.ui`. The metadata-only Drive scope is Google-*sensitive* rather than
  *restricted*, so the consent screen no longer asks for edit/delete access to all Drive
  files and OAuth verification, if ever pursued, needs no paid security assessment.
  `DriveApp` is unusable under this scope: every one of its methods, `searchFiles`
  included, requires `drive.readonly` or `drive`. Drive access goes through the Drive
  advanced service and must stay metadata-only (list, name, ID, dates, URL). A bound
  script inherits its libraries' scopes, and an advanced service the library calls must
  be enabled in both manifests, so both lists must stay in step.
- `finishSetup()`: run from the *new* sheet's menu. Reads the destination version from
  the sheet's name, asks `detectPreviousVersion` for the source, shows one YES/NO/CANCEL
  confirm (NO falls back to a typed prompt), builds the migration plan (`planForVersions`),
  shows it (`describePlan`) in a second confirm, applies it (`applyPlanWithProgress`),
  and records `OFFLINEDEX_MIGRATED_FROM` in document properties. Returns `true` when the migration
  ran; the bound wrapper then opens the upload dialog (the dialog HTML lives in the bound
  project, so the library can't open it).
- `nudgeFinishSetupIfFresh()`: called from `onOpen`. If `OFFLINEDEX_MIGRATED_FROM` is
  unset *and* no `_snapshot_*` sheet exists (a fresh copy that just received the code),
  it toasts a pointer to Finish Setup.
- `detectPreviousVersion(dest)`: newest `Offline RogueDex X.YY` in Drive with a version
  lower than `dest`; used by Finish Setup so you never type the source version.
- Naming (`copyName`, `versionFromName`, `compareVersions`, `PUBLIC_SHEET_FILE_ID`) lives
  once in `src/shared/naming.ts`, bundled into the library and imported by `scripts/update.ts`.

Why the copy/lookup happen in Apps Script and not the CLI: `drive` / `drive.readonly` are
Google-*restricted* scopes and clasp's built-in OAuth client isn't verified for them, so
a local tool reusing clasp's login can't copy sheets or list bound scripts (they're
invisible under `drive.metadata.readonly`). Inside Apps Script, `SpreadsheetApp.copy()`
runs under the spreadsheets scope with no verification hurdle. The CLI *can* (and does) use clasp's
login for `projects.get` (script → parent sheet) and Drive metadata (sheet name → version).

## The bound script (per-version)

Lives inside each spreadsheet copy. Has the creator's original code plus two files of ours.
Since 2026-08 the creator's files are **pristine except one line**, so the per-version
3-way merge has almost nothing to conflict on:

- `onOpen.js`: creator's, with the "Upload PokeRogue Data" menu block replaced by a single
  `offlineDexOnOpen()` call.
- `LoadPlayerData.js`, `UploadPlayerData.html`, `ImportDB.js`, `Sheet Status Generator.js`:
  creator's, untouched. The creator's `uploadFile()` still exists (untracked upload);
  we never call it.
- **`OfflineDexBound.js`** (ours; every function prefixed `offlineDex…` so it can't collide
  with a future creator function): builds the *RogueDex Functions* menu, calls
  `OfflineDexLib.nudgeFinishSetupIfFresh()`, holds the menu wrappers (Apps Script menu
  items can't call library functions directly), and `uploadFileTracked(obj)`, the tracked
  upload path: the creator's `createBlob → decryptFile → parseJsonContent → writeJsonToSheet`,
  `flush`, a 2 s settle, then `OfflineDexLib.processChanges()` (or `…WithoutSnapshot()`
  when the *Keep Baseline* menu item set the `OFFLINEDEX_SKIP_SNAPSHOT` document property).
- **`OfflineDexUpload.html`** (ours): the creator's dialog with `uploadFileTracked` in place
  of `uploadFile`, closing 500 ms after dispatch so the server-side flow continues while the
  toasts report progress (closing immediately cancels the request).

Menu: *Upload Data*, *Upload Data (Keep Baseline)*, *Snapshot Data*, *Highlight Changes*,
*Clear Highlights*, *Check Layout* (dry run of the layout probe), *Finish Setup (Migrate +
Upload)*, *Prepare Next Version*.

## Per-version update workflow

The full runbook lives in [UPDATING.md](UPDATING.md). Three steps:

1. **Old sheet** → RogueDex Functions → **Prepare Next Version**: copies the creator's
   public sheet into Drive as `Offline RogueDex <new>`, then turns the copy's Apps Script
   editor URL (pasted by me) into `npm run update -- <scriptId>` with a Copy button.
2. **Terminal** → `npm run update -- <scriptId>` (`scripts/update.ts`, TypeScript on Node
   24, no dependencies): resolves the ID → sheet → version via clasp's stored login,
   writes `bound/.clasp.json`, pulls the pristine code into a temporary git *worktree* of
   the `creator` branch (my checkout stays on `main`), Prettier-normalizes with the repo's
   `.prettierrc.json`, commits `creator <new>`, `git merge`s into `main`, and on a clean
   merge runs `clasp push -f`. On conflicts, resolve them and run
   `npm run update -- --continue`.
   Guards: refuses a non-`main`/dirty tree, an in-progress merge, a sheet not named
   `Offline RogueDex X.YY`, an already-recorded baseline for that version, and pulled code
   containing `OfflineDexLib` (= not a pristine copy). `npm run update` with no args reads
   the public sheet's title and says whether a new version is out.
3. **New sheet** → reload → RogueDex Functions → **Finish Setup**: confirms the
   auto-detected previous version, shows the plan, applies it, marks the copy migrated, opens the
   upload dialog.

**How the reconcile works:** a `creator` branch holds the creator's *pristine* bound code,
one commit per version, Prettier-normalized to my style. Each update is a 3-way merge of
the creator's delta onto my customizations, so only genuine same-line *content* edits
conflict. This replaced (in 2026) an older `git restore bound/` approach that silently
discarded creator changes; the Python `update.py` that first implemented the branch model
was in turn replaced by `scripts/update.ts` so the whole flow is one command and never
checks out `creator` in the working tree.

## Things to know about the spreadsheet

- The save file is encrypted with AES; the bound script uses `cCryptoGS` (a library) to decrypt
- Pokemon are listed by row in the data sheets and display sheets, with the same row mapping (e.g., row 12 is Bulbasaur in both QuickChecklist data and display)
- The data sheets have raw 0/1/empty integer values; the display sheets have formulas like `=STARTER_CHECKLIST.sorted!H12` that resolve through `STARTER_CHECKLIST.sorted` (which uses ARRAYFORMULA + IFS to map values to icons via cell references like `$A$10` and `G11`)
- This is why we track the data sheets directly: `getDisplayValues()` on the display sheets returns empty for the icon cells because the icons are inserted images, not text

## Our customizations of the creator's sheet

Every change we make to a fresh copy, and where its content lives. "Repo" means the
migrator writes it from code in this repo; "previous sheet" means the migrator copies it
from your previous version, so its content exists only in the sheets.

| Customization | Content lives in |
|---|---|
| Daily Mode Unlocks `AG3` (map strings, unlock markers) | Repo: `DAILY_UNLOCKS_AG3_FORMULA` in `trackedFormulas.ts` |
| Daily Unlock Map `E2:I2` (one formula per column, charm lines) | Repo: `unlockMapColumnFormula` in `trackedFormulas.ts` |
| Daily Unlock Map CF: unlock (green) and charm (orange) rules over E2 onwards | Repo: `UNLOCK_MAP_RULES` in `migrator.ts` |
| Daily Mode Unlocks `D2:L2`: every filter checkbox checked | Repo: `DAILY_UNLOCKS_FILTER_*` and `planDailyUnlocksFilters` in `migrator.ts` |
| Daily Mode `H3:H6` and `L3:L6`: charm wave overrides cleared | Repo: `DAILY_MODE_OVERRIDE_*` and `planDailyModeOverrides` in `migrator.ts` |
| Starter/Full DEX Checklist CF: IVs other than 31 in red, replacing the creator's `= 31` rule | Repo: `DEX_IV_*` and `planDexIvHighlight` in `migrator.ts` |
| Quick Checklist: title in A1, Ribbons hidden, banding stretched over image column B | Repo: `migrator.ts` |
| Quick Checklist rows 1–10: formats, row heights, hidden rows, column widths, row 1 and row 10 formulas | Previous sheet |
| Which sheets are hidden | Previous sheet |
| Tab order | Previous sheet |
| Party Checklist column A: the Pokémon names typed in from A3 | Previous sheet |
| Bound script: `OfflineDexBound.js`, `OfflineDexUpload.html`, one line in `onOpen.js` | Repo: `bound/` |

## Things that took some figuring out

- **Cross-spreadsheet operations:** `Range.copyTo()` only works within one spreadsheet. The old workaround (copy the source SHEET into the destination as a temp, copyTo, delete) was replaced in 2026-08 by reading formats through the Sheets API and writing them with `updateCells`: one read, one atomic write, no temp sheets.
- **Highlights as background fills:** changed cells get a background colour (default per tracker, purple for the increment counters) so the highlights coexist with the sheets' conditional formatting rather than being hidden by them. (An earlier iteration used thick borders specifically to avoid CF overriding backgrounds; that's no longer the approach.)
- **No marker column (since 2026-08):** an earlier design stamped `●` into a hidden marker column to clear only highlighted rows. The painted rows are now remembered in the snapshot metadata instead, and the marker column collided with creator columns (6.03 Ribbons).
- **`getDisplayValues()` returns empty for image cells:** the display sheets use formulas that resolve to inserted images. Apps Script can't read those as text. So we track the upstream data sheets (raw integers) instead.
- **Bulk I/O through SpreadsheetApp is slow in this workbook** (≈1 s per call, 15–25 s per 145k-cell read/write) and its mutations are applied lazily, after any synchronous Sheets API call. Hence: all bulk reads/writes go through the Sheets API, and the API client flushes SpreadsheetApp before every call.
- **Dialog closing too fast cancels the request:** need a 500ms `setTimeout` between dispatching `google.script.run` and calling `host.close()`.
- **Apps Script library scope:** library functions are accessed as `OfflineDexLib.functionName(...)`. Library top-level constants/functions all share scope within the library.
- **Menu items can't call library functions directly:** must go through bound-script wrapper functions.

## Setup requirements

- Node.js (via Homebrew or direct download), v24+ (the update CLI relies on native TypeScript type stripping)
- clasp: `npm install -g @google/clasp`
- `clasp login` once for OAuth
- Apps Script API enabled in Google account settings (https://script.google.com/home/usersettings)

## Future enhancements that have come up

- If Google ever exposes bound scripts via Drive, Prepare Next Version could look up the copy's Script ID itself (a `Drive.Files.list` `'<sheetId>' in parents` query) and prefill the command
