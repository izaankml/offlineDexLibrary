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

### SaveTracker.js

Tracks changes between save data uploads and highlights changed cells.

**Key concept: trackers.** A tracker is a config object that pairs a "data sheet" (raw 0/1/empty values) with a "display sheet" (visual checklist with formulas/conditional formatting that pulls from the data sheet). Each tracker has its own column mapping.

**The TRACKERS array:**

```javascript
const TRACKERS = [
  {
    key: 'QuickChecklist',
    dataSheet: 'STARTER_CHECKLIST.data',
    displaySheet: 'Quick Checklist',
    dataFirstRow: 12,
    displayFirstRow: 12,
    columnMap: buildShiftMap(4, 11, 4), // D-K -> H-O (+4 shift; creator 6.03 layout with hidden junk E)
    includeHeaders: true,
    headerRows: 1,
    highlightColor: QUICK_CHECKLIST_HIGHLIGHT_COLOR, // yellow
    useFilter: true,
  },
  {
    key: 'StarterDex',
    dataSheet: 'STARTER_DEX.data',
    displaySheet: 'Starter Dex Checklist',
    dataFirstRow: 3,
    displayFirstRow: 4,
    columnMap: buildShiftMap(12, 143, -8), // L-EM -> D-EE (-8 shift)
    includeHeaders: true,
    headerRows: 2,
    // E, AH, AI — auto-calculated columns, never highlight
    excludeDisplayColumns: new Set([5, 34, 35]),
    // N (caught), AB (hatched), AO (wins) — counts that increment on an
    // already-unlocked entry, so they get the purple increment highlight
    columnHighlightColors: {
      14: INCREMENT_HIGHLIGHT_COLOR,
      28: INCREMENT_HIGHLIGHT_COLOR,
      41: INCREMENT_HIGHLIGHT_COLOR,
    },
    useFilter: true,
  },
  {
    key: 'FullDex',
    dataSheet: 'FULL_DEX.data',
    displaySheet: 'Full Dex Checklist',
    dataFirstRow: 3,
    displayFirstRow: 4,
    columnMap: buildShiftMap(8, 139, -4), // H-EI -> D-EE (-4 shift)
    includeHeaders: true,
    headerRows: 2,
    // E, AH, AI — auto-calculated columns, never highlight (display now matches Starter Dex)
    excludeDisplayColumns: new Set([5, 34, 35]),
    // N (caught), AB (hatched), AO (wins) — counts that increment on an
    // already-unlocked entry, so they get the purple increment highlight
    columnHighlightColors: {
      14: INCREMENT_HIGHLIGHT_COLOR,
      28: INCREMENT_HIGHLIGHT_COLOR,
      41: INCREMENT_HIGHLIGHT_COLOR,
    },
    useFilter: true,
  },
]
```

Why these column shifts: the display sheets have extra leading columns (dex#, name, etc.) that the data sheets don't have. The shift between data column and display column is consistent within a sheet but varies per tracker because each display sheet has a different number of leading columns.

**Highlight colors** (module constants at the top of SaveTracker.js):

- `QUICK_CHECKLIST_HIGHLIGHT_COLOR = '#FFFF00'` (yellow) — Quick Checklist
- `DEX_HIGHLIGHT_COLOR = '#93c47d'` (light green 1) — default for the dex sheets
- `INCREMENT_HIGHLIGHT_COLOR = '#b4a7d6'` (light purple 2) — counter columns that increment on an already-unlocked entry (caught, hatched, wins) rather than marking a new unlock; applied per-column via `columnHighlightColors`

**Per-tracker highlight controls:**

- `highlightColor` — the default fill for changed cells in this tracker; falls back to `DEX_HIGHLIGHT_COLOR` when omitted.
- `columnHighlightColors` — `{displayCol: color}` overrides for specific columns (the counter columns get the purple increment color instead of the default).
- `excludeDisplayColumns` — display columns that are auto-calculated (e.g. totals derived from other cells) and must never be highlighted even when their value changes. Note the egg-move total column was removed from these sets so it now *does* highlight.
- `useFilter` — enables the hidden marker-column workflow used for fast highlight-clearing (see below). (The name is historical: it once also drove "View Changes" filter views, which the Migrator no longer creates.)
- `sortDisplayColumn` — a 1-based display column to re-sort the display sheet by (ascending) at the start of highlighting, before any cell is painted. Set to `1` (column A) on all three trackers. Highlights are painted onto the display **by row offset**, so the display must be in the same order as the data sheet; if you've re-sorted the display (e.g. via the column-A slicers), the paint would otherwise land on the wrong rows. Sorting back to column A undoes that and also leaves the sheet in the order the slicers expect. Omit the option to skip the sort. **Assumes column-A-ascending reproduces the data sheet's canonical row order** — true because column A is the dex#/name key the data sheets are ordered by.

**The flow on each save upload:**

1. `clearHighlights()` - wipe background fills from the previous run (using the marker column to clear only rows that were actually highlighted, when `useFilter`)
2. `highlightChanges()` - for each tracker: first re-sort the display by `sortDisplayColumn` (column A) so its rows line up with the data sheet, then compare current data values to snapshot, paint the highlight color as the cell **background** on changed cells, and write a `●` marker in the row's marker column
2b. `sortFormChecklistByDone()` - re-sort the Form Checklist's data rows by column C ("Done") ascending so unchecked forms stay above checked ones (a ported customization; it lives here rather than in the Migrator because the checkmarks only exist once a save has been loaded)
3. `snapshot()` - save current data to hidden snapshot sheets so the NEXT upload can diff against it

**Uploading without re-snapshotting:** `processChangesWithoutSnapshot()` runs steps 1-2 and skips step 3, so the existing snapshot stays the baseline. Highlights then keep accumulating against that baseline across uploads instead of each upload resetting what "changed since last time" means — useful for a mid-run save, or a re-upload after a run you don't want to bank yet. It's exposed through the **Upload Data (Keep Baseline)** menu item; the regular **Upload Data** item still snapshots.

**Background colors, not borders:** changed cells are painted with `setBackgrounds()`. (An earlier design used thick green borders to dodge conditional formatting, but the current approach relies on background fills with per-column color overrides; the chosen highlight colors sit alongside, rather than fighting, the sheets' conditional formatting.)

**Marker column:** for trackers with `useFilter: true`, the highlighter writes a `●` into the marker column — by default the first column past the tracked range (`max(columnMap values) + 1`), or `markerColumn` when set (QuickChecklist uses Q/17, because P is the creator's Ribbons column in the 6.03 layout; the default would blank it on every upload) — on every changed row, and hides that column. This drives fast clearing — only marked rows get their backgrounds reset. (It previously also fed a Migrator-created "View Changes" filter view; that filter-view step has since been removed.)

**Snapshot storage:** hidden sheets named `_snapshot_<key>` (e.g., `_snapshot_QuickChecklist`). Each snapshot has the data sheet's tracked column range plus a header row (or two for the dex sheets). Empty leading columns are hidden for readability.

**Chunking:** all the heavy operations (read, write, clear, highlight) chunk in 200-row batches. Without chunking, "Service error: Spreadsheets" hits on the larger sheets (Full Dex tracks 132 columns × ~1100 rows). No explicit `flush()` is needed between chunks — Apps Script handles batching the writes itself, and per-chunk flushes added several round-trips of latency for no correctness benefit.

**Toast progress UI:** a single replacing toast shows what's currently running. Title = current step, body = previous step's elapsed time. State variables: `LAST_STEP_LABEL`, `LAST_STEP_ELAPSED`, `CURRENT_STEP_START`, `FLOW_START`. The `runStandaloneIfNeeded` helper makes individual functions self-managing if called directly, but skips reset/finalize when called as part of a larger flow.

### Migrator.js

Ports customizations from an old version of the spreadsheet to a new one. Called as `OfflineDexLib.portAll(sourceVersion, destVersion)` from the bound script's "Migrate from previous version" menu.

**Looks up files by name pattern:** `Offline RogueDex {v}` (e.g., "Offline RogueDex <version>"). Excludes any file starting with `PUBLIC_` to avoid grabbing the creator's master.

**Five migration steps:**

1. **Quick Checklist header rows 1-10:** adopts the creator's column layout as-is (so consecutive versions port 1:1). Each sheet's data block ("Caught?" … "Ribbons", 11 columns) is located by the first non-blank cell in row 10 right of the fixed A-D block — the creator's stats row on a fresh copy, my "Stats:" row on a migrated one. If the destination's block starts further right (6.03 added a hidden junk column E: block at F instead of E), the same number of blank columns is inserted into the *temp copy of the source* in front of its block, which shifts its own same-sheet formula references but not cross-sheet ones — exactly the adjustment needed — and from there everything is a same-position copy: cell formatting + column widths + row hidden states for rows 1-10, formulas/values for row 1's data block and row 10 in full, hide the Ribbons column (last of the block), and stamp `POKEROGUE DEX <destVersion>` into A1 (skipped if A1 is a formula). Reads use the source's width and the destination is padded to match. Column hidden states are otherwise the creator's (junk E stays hidden), not the source's (whose hidden columns include the SaveTracker marker column). An earlier design deleted E instead; dropped so that 6.03→6.04 needs no shifting.

1b. **Quick Checklist image banding:** extends the sheet's alternating-colour banding to cover the Pokemon image column B (the creator's banding starts at C); clears B's cell fills over the banded rows so it shows. Falls back to widening row-parity CF rules if the stripes turn out to be conditional formatting; logs which path ran.

2. **Daily Mode formatting:** copies cell formatting only for the cells I customized (`DAILY_MODE_FORMAT_RANGES` — `B16:M131` and `L12:M14`) plus the column L and M widths. Inserts the custom blank column L into the destination when it's missing — detected by a landmark, not a column count: the creator's "Missing Gym Leader Voucher…" label is at N2 in the source (`DAILY_MODE_LANDMARK_WITH_L`) and at M2 in a fresh copy (`DAILY_MODE_LANDMARK_WITHOUT_L`); anywhere else throws so a reshuffled layout fails loudly. It deliberately does **not** touch conditional formatting: inserting column L auto-shifts the destination's own CF ranges to match, so the new version's rules already line up — copying the old version's CF over them would overwrite the new version's.

3. **Daily Mode cells:** unmerges any existing merge at B16, re-merges to `B16:M131`, copies B16 formula. Also copies L12:M14 formulas/values from source. Refuses to run if the landmark says column L is still missing (otherwise the merge would swallow the creator's column M).

(The Form Checklist "unchecked first" sort used to be a migration step; it now runs in the SaveTracker after every upload — see the upload flow above — because on a fresh copy every row is unchecked and sorting before the save load did nothing.)

4. **Hidden sheets:** any sheet hidden in source is also hidden in destination if it exists by name.

5. **Dex IV highlights:** on the Starter Dex and Full Dex checklists, finds the "perfect IV" conditional-format rule the new version ships with (fills yellow when a cell equals 31) and replaces it in place with a rule that fills red (`#ea9999`) when the cell is NOT 31, over the same range. Detection is by condition (text/number equals `31`), so it auto-adapts to each sheet's range and column layout; all other CF rules are left untouched. If no matching rule is found, the sheet is left unchanged and a note is logged.

(The Migrator no longer creates "View Changes" filter views — that step was removed. The marker column described below still exists for fast highlight-clearing.)

**Cross-spreadsheet trick:** Apps Script's `Range.copyTo()` doesn't work across spreadsheets. So the migrator copies the source sheet INTO the destination spreadsheet as a temp sheet, does the local copyTo, then deletes the temp.

**Conditional formatting is intentionally left alone:** the Migrator no longer copies CF rules across sheets. For Daily Mode, inserting column L auto-shifts the destination's existing CF ranges, so the new version's rules stay correct without any remap. For the dex checklists, the IV step (step 5) edits the *existing* destination rules in place rather than importing the old sheet's.

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

Lives inside each spreadsheet copy. Has the creator's original code plus my modifications. Three files I modify:

### onOpen.js

The creator provides `onOpen()`, `checkVersion()`, and `htmlmodalDialog()`. I:

- Add menu items: Upload Data (Keep Baseline), Snapshot Data, Highlight Changes, Clear Highlights, Finish Setup (migrate + upload), Prepare Next Version
- Add wrapper functions that delegate to the library: `snapshot()`, `highlightChanges()`, `clearHighlights()`, `prepareNextVersion()`, and `finishSetup()` (which opens the upload dialog when the library reports the migration ran)
- Point the two Upload Data items at my own `openUploadDialog()` / `openUploadDialogKeepBaseline()` wrappers instead of the creator's `openAttachmentDialog()` directly
- Call `OfflineDexLib.nudgeFinishSetupIfFresh()` from `onOpen` (fresh-copy toast pointing at Finish Setup)

**How the "keep baseline" choice reaches `uploadFile`:** the creator's dialog (`UploadPlayerData.html`) always dispatches `google.script.run.uploadFile(obj)`, and it's a separate server execution, so module state can't carry the choice across. Instead each menu wrapper writes (or deletes) the `OFFLINEDEX_SKIP_SNAPSHOT` document property before opening the dialog, and `uploadFile` reads and clears it. Both entry points always set it, so it can't go stale. This keeps `openAttachmentDialog()` and the dialog HTML unmodified — one less thing to reconcile on each version merge.

The wrapper functions are needed because Apps Script menu items can't directly call library functions. They have to call top-level functions in the bound script that then forward to the library.

All of the Finish Setup logic lives in the library (`Setup.js`); the bound file is kept to thin wrappers so there's as little as possible to reconcile with the creator's `onOpen.js` on each version merge.

### LoadPlayerData.js

The creator provides `uploadFile()`, `decryptFile()`, `parseJsonContent()`, `writeJsonToSheet()`, `openAttachmentDialog()`, and crypto helpers (using a `cCryptoGS` library for AES decrypt of the save file). The save file is an encrypted blob; the spreadsheet's bound script decrypts it and writes the decoded JSON into a sheet called `newJSON`. From there, the spreadsheet's formulas pull from `newJSON` to populate the various data sheets.

I only modify `uploadFile()` to wrap the import in toast tracking and trigger `processChanges()` after:

```javascript
function uploadFile(obj) {
  const ss = SpreadsheetApp.getActiveSpreadsheet()
  const props = PropertiesService.getDocumentProperties()
  const skipSnapshot = props.getProperty(SKIP_SNAPSHOT_PROPERTY) === 'true'
  props.deleteProperty(SKIP_SNAPSHOT_PROPERTY)

  OfflineDexLib.resetToastProgress()
  OfflineDexLib.startStep(ss, 'Importing save data')

  var blob = createBlob(obj)
  var plaintext = decryptFile(blob)
  var jsonContent = parseJsonContent(plaintext)
  writeJsonToSheet(jsonContent)
  SpreadsheetApp.flush()
  Utilities.sleep(2000) // give formulas time to recalculate

  OfflineDexLib.finishStep()

  try {
    if (skipSnapshot) {
      OfflineDexLib.processChangesWithoutSnapshot()
    } else {
      OfflineDexLib.processChanges()
    }
  } catch (e) {
    Logger.log('processChanges failed: ' + e.message)
  }
}
```

The 2-second sleep is important: after `writeJsonToSheet` fills in `newJSON`, formulas pulling from it need a moment to recalculate before the snapshot can read post-update values.

### UploadPlayerData.html

The creator's dialog. I modify `fr.onload` to dispatch `uploadFile` and close the dialog after a 500ms delay so the dialog dismisses while server-side processing continues. Without the delay, closing too fast cancels the request.

```javascript
google.script.run.uploadFile(obj)
setTimeout(() => google.script.host.close(), 500)
```

### Files I don't modify

- `ImportDB.js` (forceUpdate, copyDBList, copyDailyList) - creator's database import logic
- `Sheet Status Generator.js` (listImportSheetsWithGID) - creator's status helper

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

- **Cross-spreadsheet operations:** `Range.copyTo()` only works within one spreadsheet. Workaround: copy source SHEET into destination spreadsheet as a temp, do local copyTo, delete temp.
- **Highlights as background fills:** changed cells are painted with `setBackgrounds()`, using per-column color overrides (`columnHighlightColors`) so the highlight colors coexist with the sheets' conditional formatting rather than being hidden by them. (An earlier iteration used thick borders specifically to dodge CF overriding backgrounds; that's no longer the approach.)
- **Marker column for cheap clearing:** because re-reading every display cell's background to find what to clear is slow, the highlighter stamps a `●` into a hidden marker column on changed rows. Clearing then resets only the marked rows.
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
