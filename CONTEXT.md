# OfflineDex Scripts: Project Context

This doc summarizes the design and decisions behind this repo so that any future work (in Claude Code or otherwise) has the full picture without needing to dig through commit history or external chats.

## What this is

I track my Pokemon collection in a Google Sheets spreadsheet called "Offline RogueDex" maintained by a third-party creator. The creator publishes new versions every so often as a public read-only spreadsheet. To use a new version I make a copy into my Drive, which gives me a fresh spreadsheet with the creator's bound Apps Script attached.

This repo contains two pieces of automation I've added on top of the creator's spreadsheet:

1. **A save tracker** that highlights cells in the spreadsheet that changed since my last save data upload. Lets me see at a glance which Pokemon got newly caught/shiny/etc.
2. **A version migrator** that ports my customizations (formatting, hidden sheets, custom column, specific cell formulas) from an old version of the spreadsheet to a new one.

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
- The sections below describe the modules by their pre-TypeScript file names
  (`SaveTracker.js` → `saveTracker.ts`, etc.); the behaviour is unchanged.

## The library: OfflineDexLib

A standalone Apps Script project. Deployed as a library and imported into each version's bound script with the identifier `OfflineDexLib`.

### saveTracker.ts (+ layout.ts, progress.ts)

Tracks changes between save data uploads and highlights changed cells.

**Key concept: trackers.** A tracker pairs a "data sheet" (raw 0/1/count values the
creator's formulas derive from the save) with a "display sheet" (the visual checklist).
Since 2026-08 a tracker is a **spec of header labels, not column numbers**
(`TRACKER_SPECS` in `saveTracker.ts`, resolved by `layout.ts`):

```ts
{ key: 'StarterDex', dataSheet: 'STARTER_DEX.data', displaySheet: 'Starter Dex Checklist',
  dataFirstRow: 3, displayFirstRow: 4,
  dataBlockAnchor: 'Fought Flag', displayAnchor: { kind: 'label', text: 'Fought Flag' },
  trackFrom: 'Fought Flag', trackTo: null,            // through the last labelled column
  exclude: ['Fought Count', 'Candy Count', 'Friendship'],   // auto-calculated, never painted
  increment: ['Caught Count', 'Hatched Count', 'Classic Wins'], // purple: counters
  crossCheck: 'Classic Wins', sortDisplayColumn: 1, ... }
```

`resolveTracker()` reads the first 10 rows of both sheets once, finds the anchors by
text (case/space-insensitive; first occurrence — labels like "Friendship" repeat further
right), derives `shift = displayCol − dataCol`, maps exclude/increment names to columns,
cross-checks a second label, and **throws a precise message** ("could not find the header
'Fought Flag' in the first 10 rows of 'Starter Dex Checklist'") if the creator's layout
no longer fits — so a reshuffle stops the paint instead of mis-painting. The Quick
Checklist display block is located the way the Migrator does it (first non-blank cell of
row 10 right of the fixed A–D columns), because after migration its row-1 labels are
replaced by your stat formulas. Verified layouts: 6.01 (shift +3), 6.03 (shift +4);
`test/fixtures/headers-6.03.json` holds the real header rows and `golden-mappings.json`
pins the exact per-column mapping the old index-based config produced.
`describeLayout()` returns the resolved layout as text (dry run).

**Highlight colors:** yellow (`#FFFF00`) on the Quick Checklist, light green (`#93c47d`)
on the dex sheets, light purple (`#b4a7d6`) for the increment counters.

**The flow on each save upload (`processChanges`):**

1. *Checking layout* — resolve every tracker (2 small header reads each); one-time cleanup
   of the legacy marker columns.
2. *Highlighting X* — for each tracker: ONE read of the data block, ONE read of the
   snapshot block, in-memory diff, then `setBackgrounds` over the tracked display block
   only (500-row chunks). Unchanged cells get `null`, which is what clears the previous
   upload's highlights — there is no separate clear pass and **no marker column** any
   more. Before painting, the display's key column (A) is read; only if it is out of
   order (a slicer sort) is the display physically re-sorted.
3. *Sorting Form Checklist* — unchecked forms above checked ones.
4. *Snapshotting X* — the values already in memory are written to the hidden
   `_snapshot_<key>` sheet at the **same row/column numbers as the data sheet** (v2
   layout; the header band is copied above for readability). No re-read. The old v1
   layout (data starting at row headerRows+1) is still read correctly once — the
   `OFFLINEDEX_SNAPSHOT_FORMAT` document property records which is on disk.

Per upload that is ≈ 40 Sheets calls total (was ≈ 100 + one call per run of changed rows,
plus three full-sheet sorts). **Upload Data (Keep Baseline)** runs steps 1–3 only.

**Standalone menu items:** *Snapshot Data*, *Highlight Changes*, *Clear Highlights* (null
backgrounds over the tracked block, chunked) run the same code paths as their own flows.

**Toast progress + timing log (`progress.ts`):** a single replacing toast shows the current
step; on finish (or failure — `failFlow` shows a non-sticky error toast) every step's
duration is appended to the hidden `_timings` sheet in one write.

**Why the data sheets, not the display:** the display cells are formulas resolving through
`STARTER_CHECKLIST.sorted` etc.; the data sheets hold the raw values in the canonical row
order the display is painted against.

### migrator.ts (+ sheetsApi.ts, formulaShift.ts)

Ports customizations from an old version of the spreadsheet to a new one. Since 2026-08 it
is a **plan → preview → apply** pipeline on the Sheets advanced service (Sheets API v4):

1. **Read** — 2 GETs on the source (sheet list; formats/formulas of the customized ranges:
   `Quick Checklist!1:10`, `Daily Mode!B16:M131`, `L12:M14`, the `N2` landmark) and 2 on
   the destination (sheet list + banding + CF rules + merges; the Quick Checklist header
   and the `M2:N2` landmark cells). No `openById`, no temp sheets, no `copyTo`.
2. **Plan** (`buildPlan`, pure, tested with hand-built API responses) — a list of `Op`s
   (label + batchUpdate requests). Planning **throws** when a landmark doesn't fit
   (Daily Mode landmark at neither M2 nor N2; Quick Checklist row 10 blank; destination
   block left of the source's), so nothing is touched on an unknown layout.
3. **Preview** — Finish Setup shows `describePlan()` in the confirm dialog.
4. **Apply** — ONE `batchUpdate`; the API applies it atomically (all steps or none).

**The ops:**

- *Quick Checklist header (rows 1–10)*: `updateCells` with the source's `userEnteredFormat`
  for every column (two segments when the destination block starts further right — 6.03's
  hidden junk column E), `updateDimensionProperties` for row heights/hidden rows and column
  widths, row 1 (data block) and row 10 formulas/values with same-sheet references shifted
  by `shiftFormulaColumns` (cross-sheet refs, `$A$10`-style refs left of the block, strings
  and function names untouched), hide Ribbons, stamp `POKEROGUE DEX <dest>` into A1 unless
  A1 is a formula.
- *Banding over the image column*: `updateBanding` stretches the C-start banding to B (merging
  an A-only banding), `repeatCell` clears B's fills; falls back to widening row-parity CF.
- *Daily Mode*: `insertDimension` for column L when the landmark says it's missing;
  `updateCells` formats for B16:M131 and L12:M14; widths of L/M; `unmergeCells` for every
  existing merge overlapping B16:M131 (in post-insert coordinates) then `mergeCells`;
  B16 formula/value top-aligned; L12:M14 inputs.
- *Hide sheets* hidden in the source; *IV highlight*: replace `= 31` boolean rules on the dex
  checklists with `=TO_TEXT(topLeft)<>"31"` → red, one rule per range, highest index first.

Everything is idempotent (re-running on a migrated copy plans no insert/no CF change and
notes what was already done), and `previewMigration()` returns the plan as text.

### Setup.js

The Google-side half of a version update (the terminal half is `scripts/update.ts`).

- `prepareNextVersion()` — run from the *current* sheet's menu. The creator publishes
  every version as **the same Drive file**, renamed per release
  (`PUBLIC_Offline RogueDex 6.03`; ID in `PUBLIC_SHEET_FILE_ID`). It reads the version
  from that title, `makeCopy()`s it as `Offline RogueDex <new>` into the current sheet's
  folder (reusing an existing same-named copy if you say so), and shows a dialog: open the
  copy → Extensions → Apps Script → paste the editor URL → the dialog builds
  `npm run update -- <scriptId>` with a Copy button.
  **Bound scripts are not enumerable through Drive** (verified 2026-08: v3 `files.list`
  with `'<sheetId>' in parents`, v2 `files.list`, and v2 `children.list` all return
  nothing even with full Drive scope inside Apps Script), so no lookup is attempted —
  it was removed to keep the library's permissions to `DriveApp` only (no Drive advanced
  service, no `UrlFetchApp`).
- `finishSetup()` — run from the *new* sheet's menu. Reads the destination version from
  the sheet's name, asks `detectPreviousVersion` for the source, shows one YES/NO/CANCEL
  confirm (NO falls back to a typed prompt), calls `portAll(source, dest)`, and records
  `OFFLINEDEX_MIGRATED_FROM` in document properties. Returns `true` when the migration
  ran; the bound wrapper then opens the upload dialog (the dialog HTML lives in the bound
  project, so the library can't open it).
- `nudgeFinishSetupIfFresh()` — called from `onOpen`: if `OFFLINEDEX_MIGRATED_FROM` is
  unset *and* no `_snapshot_*` sheet exists (a fresh copy that just received the code),
  toasts a pointer to Finish Setup.
- `detectPreviousVersion(dest)` — newest `Offline RogueDex X.YY` in Drive with a version
  lower than `dest`; used by Finish Setup so you never type the source version.
- `copyName(v)` / `versionFromName(name)` — the one place the `Offline RogueDex X.YY`
  naming rule lives on the Apps Script side (Migrator's `findFileIdByVersion` uses it too;
  `scripts/update.ts` mirrors it for Node).

Why the copy/lookup happen in Apps Script and not the CLI: `drive` / `drive.readonly` are
Google-*restricted* scopes and clasp's built-in OAuth client isn't verified for them, so
a local tool reusing clasp's login can't copy sheets or list bound scripts (they're
invisible under `drive.metadata.readonly`). Inside Apps Script, `DriveApp` / the Drive
service get full scope with no verification hurdle. The CLI *can* (and does) use clasp's
login for `projects.get` (script → parent sheet) and Drive metadata (sheet name → version).

## The bound script (per-version)

Lives inside each spreadsheet copy. Has the creator's original code plus two files of ours.
Since 2026-08 the creator's files are **pristine except one line**, so the per-version
3-way merge has almost nothing to conflict on:

- `onOpen.js` — creator's, with the "Upload PokeRogue Data" menu block replaced by a single
  `offlineDexOnOpen()` call.
- `LoadPlayerData.js`, `UploadPlayerData.html`, `ImportDB.js`, `Sheet Status Generator.js`
  — creator's, untouched. The creator's `uploadFile()` still exists (untracked upload);
  we never call it.
- **`OfflineDexBound.js`** (ours; every function prefixed `offlineDex…` so it can't collide
  with a future creator function): builds the *RogueDex Functions* menu, calls
  `OfflineDexLib.nudgeFinishSetupIfFresh()`, holds the menu wrappers (Apps Script menu
  items can't call library functions directly), and `uploadFileTracked(obj)` — the tracked
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

The full runbook lives in [UPDATING.md](UPDATING.md). Three touches:

1. **Old sheet** → RogueDex Functions → **Prepare Next Version**: copies the creator's
   public sheet into Drive as `Offline RogueDex <new>`, finds the copy's bound Script ID,
   hands me `npm run update -- <scriptId>` with a Copy button.
2. **Terminal** → `npm run update -- <scriptId>` (`scripts/update.ts`, TypeScript on Node
   24, no dependencies): resolves the ID → sheet → version via clasp's stored login,
   writes `bound/.clasp.json`, pulls the pristine code into a temporary git *worktree* of
   the `creator` branch (my checkout stays on `main`), Prettier-normalizes with the repo's
   `.prettierrc.json`, commits `creator <new>`, `git merge`s into `main`, and on a clean
   merge runs `clasp push -f`. Conflicts → resolve → `npm run update -- --continue`.
   Guards: refuses a non-`main`/dirty tree, an in-progress merge, a sheet not named
   `Offline RogueDex X.YY`, an already-recorded baseline for that version, and pulled code
   containing `OfflineDexLib` (= not a pristine copy). `npm run update` with no args reads
   the public sheet's title and says whether a new version is out.
3. **New sheet** → reload → RogueDex Functions → **Finish Setup**: confirms the
   auto-detected previous version, runs `portAll`, marks the copy migrated, opens the
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

## Things that took some figuring out

- **Cross-spreadsheet operations:** `Range.copyTo()` only works within one spreadsheet. The old workaround (copy the source SHEET into the destination as a temp, copyTo, delete) was replaced in 2026-08 by reading formats through the Sheets API and writing them with `updateCells` — one read, one atomic write, no temp sheets.
- **Highlights as background fills:** changed cells are painted with `setBackgrounds()`, using per-column color overrides (`columnHighlightColors`) so the highlight colors coexist with the sheets' conditional formatting rather than being hidden by them. (An earlier iteration used thick borders specifically to dodge CF overriding backgrounds; that's no longer the approach.)
- **No marker column (since 2026-08):** an earlier design stamped `●` into a hidden marker column to clear only highlighted rows; it turned out the paint step already writes `null` into every unchanged tracked cell, so the clear pass and the marker column were redundant — and the marker column collided with creator columns (6.03 Ribbons). `clearLegacyMarkers` blanks the old markers once.
- **`getDisplayValues()` returns empty for image cells:** the display sheets use formulas that resolve to inserted images. Apps Script can't read those as text. So we track the upstream data sheets (raw integers) instead.
- **Service errors on big ranges:** chunking in 200-row batches is required for the Full Dex sheet (132 cols × 1100 rows). An explicit `flush()` per chunk is not — it just adds latency.
- **Dialog closing too fast cancels the request:** need a 500ms `setTimeout` between dispatching `google.script.run` and calling `host.close()`.
- **Apps Script library scope:** library functions are accessed as `OfflineDexLib.functionName(...)`. Library top-level constants/functions all share scope within the library.
- **Menu items can't call library functions directly:** must go through bound-script wrapper functions.

## Setup requirements

- Node.js (via Homebrew or direct download), v24+ (the update CLI relies on native TypeScript type stripping)
- Prettier on PATH (`npm i -g prettier`)
- clasp: `npm install -g @google/clasp`
- `clasp login` once for OAuth
- Apps Script API enabled in Google account settings (https://script.google.com/home/usersettings)

## Future enhancements that have come up

- Track timing per migration in the version history at the top of Migrator.js
- If Google ever exposes bound scripts via Drive, Prepare Next Version could look up the copy's Script ID itself (a `Drive.Files.list` `'<sheetId>' in parents` query) and prefill the command
