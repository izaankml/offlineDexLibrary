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
├── library/                     # OfflineDex Library project (standalone Apps Script)
│   ├── .clasp.json              # has the library's Script ID (gitignored)
│   ├── appsscript.json
│   ├── SaveTracker.js
│   └── Migrator.js
└── bound/                       # bound script for the spreadsheet (per-version)
    ├── .clasp.json              # has the current spreadsheet's Script ID (gitignored)
    ├── appsscript.json
    ├── onOpen.js
    ├── LoadPlayerData.js
    └── UploadPlayerData.html
```

Notes:

- clasp uses `.js` locally; converts to `.gs` on push
- `.clasp.json` is gitignored because it contains Script IDs

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
    columnMap: buildShiftMap(4, 11, 3), // D-K -> G-N (+3 shift)
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
    // N, AB — caught-hatch columns get the purple highlight
    columnHighlightColors: { 14: CAUGHT_HATCH_HIGHLIGHT_COLOR, 28: CAUGHT_HATCH_HIGHLIGHT_COLOR },
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
    // N, AB — caught-hatch columns get the purple highlight
    columnHighlightColors: { 14: CAUGHT_HATCH_HIGHLIGHT_COLOR, 28: CAUGHT_HATCH_HIGHLIGHT_COLOR },
    useFilter: true,
  },
]
```

Why these column shifts: the display sheets have extra leading columns (dex#, name, etc.) that the data sheets don't have. The shift between data column and display column is consistent within a sheet but varies per tracker because each display sheet has a different number of leading columns.

**Highlight colors** (module constants at the top of SaveTracker.js):

- `QUICK_CHECKLIST_HIGHLIGHT_COLOR = '#FFFF00'` (yellow) — Quick Checklist
- `DEX_HIGHLIGHT_COLOR = '#93c47d'` (light green 1) — default for the dex sheets
- `CAUGHT_HATCH_HIGHLIGHT_COLOR = '#b4a7d6'` (light purple 2) — the caught/hatch columns, applied per-column via `columnHighlightColors`

**Per-tracker highlight controls:**

- `highlightColor` — the default fill for changed cells in this tracker; falls back to `DEX_HIGHLIGHT_COLOR` when omitted.
- `columnHighlightColors` — `{displayCol: color}` overrides for specific columns (the caught/hatch columns get purple instead of the default).
- `excludeDisplayColumns` — display columns that are auto-calculated (e.g. totals derived from other cells) and must never be highlighted even when their value changes. Note the egg-move total column was removed from these sets so it now *does* highlight.
- `useFilter` — enables the hidden marker-column workflow used for fast highlight-clearing (see below). (The name is historical: it once also drove "View Changes" filter views, which the Migrator no longer creates.)

**The flow on each save upload:**

1. `clearHighlights()` - wipe background fills from the previous run (using the marker column to clear only rows that were actually highlighted, when `useFilter`)
2. `highlightChanges()` - compare current data values to snapshot, paint the highlight color as the cell **background** on changed cells, and write a `●` marker in the row's marker column
3. `snapshot()` - save current data to hidden snapshot sheets so the NEXT upload can diff against it

**Background colors, not borders:** changed cells are painted with `setBackgrounds()`. (An earlier design used thick green borders to dodge conditional formatting, but the current approach relies on background fills with per-column color overrides; the chosen highlight colors sit alongside, rather than fighting, the sheets' conditional formatting.)

**Marker column:** for trackers with `useFilter: true`, the highlighter writes a `●` into the first column past the tracked range (`max(columnMap values) + 1`) on every changed row, and hides that column. This drives fast clearing — only marked rows get their backgrounds reset. (It previously also fed a Migrator-created "View Changes" filter view; that filter-view step has since been removed.)

**Snapshot storage:** hidden sheets named `_snapshot_<key>` (e.g., `_snapshot_QuickChecklist`). Each snapshot has the data sheet's tracked column range plus a header row (or two for the dex sheets). Empty leading columns are hidden for readability.

**Chunking:** all the heavy operations (read, write, clear, highlight) chunk in 200-row batches. Without chunking, "Service error: Spreadsheets" hits on the larger sheets (Full Dex tracks 132 columns × ~1100 rows). No explicit `flush()` is needed between chunks — Apps Script handles batching the writes itself, and per-chunk flushes added several round-trips of latency for no correctness benefit.

**Toast progress UI:** a single replacing toast shows what's currently running. Title = current step, body = previous step's elapsed time. State variables: `LAST_STEP_LABEL`, `LAST_STEP_ELAPSED`, `CURRENT_STEP_START`, `FLOW_START`. The `runStandaloneIfNeeded` helper makes individual functions self-managing if called directly, but skips reset/finalize when called as part of a larger flow.

### Migrator.js

Ports customizations from an old version of the spreadsheet to a new one. Called as `OfflineDexLib.portAll(sourceVersion, destVersion)` from the bound script's "Migrate from previous version" menu.

**Looks up files by name pattern:** `Offline RogueDex {v}` (e.g., "Offline RogueDex <version>"). Excludes any file starting with `PUBLIC_` to avoid grabbing the creator's master.

**Six migration steps:**

1. **Quick Checklist header rows 1-10:** first deletes the destination's extra column E (gated by `DELETE_COLUMN_E_IN_QUICK_CHECKLIST` plus a column-count check) so the new version's added column doesn't shift the layout out of alignment. Then copies cell formatting + column widths + row hidden states for rows 1-10 (column hidden states are no longer ported, so columns are never hidden), and ports formulas/values for row 1 columns E-O and row 10 in full.

2. **Form Checklist sort:** sorts rows 2+ by column C ascending so unchecked rows appear before checked rows.

3. **Daily Mode formatting:** copies cell formatting only for the cells I customized (`DAILY_MODE_FORMAT_RANGES` — `B16:M131` and `L12:M14`) plus the column L and M widths. Optionally inserts a blank column L into the destination (controlled by `INSERT_COLUMN_L_IN_DAILY_MODE`) because I had added a custom column there that creator versions don't have. It deliberately does **not** touch conditional formatting: inserting column L auto-shifts the destination's own CF ranges to match, so the new version's rules already line up — copying the old version's CF over them would overwrite the new version's.

4. **Daily Mode cells:** unmerges any existing merge at B16, re-merges to `B16:M131`, copies B16 formula. Also copies L12:M14 formulas/values from source.

5. **Hidden sheets:** any sheet hidden in source is also hidden in destination if it exists by name.

6. **Dex IV highlights:** on the Starter Dex and Full Dex checklists, finds the "perfect IV" conditional-format rule the new version ships with (fills yellow when a cell equals 31) and replaces it in place with a rule that fills red (`#ea9999`) when the cell is NOT 31, over the same range. Detection is by condition (text/number equals `31`), so it auto-adapts to each sheet's range and column layout; all other CF rules are left untouched. If no matching rule is found, the sheet is left unchanged and a note is logged.

(The Migrator no longer creates "View Changes" filter views — that step was removed. The marker column described below still exists for fast highlight-clearing.)

**Cross-spreadsheet trick:** Apps Script's `Range.copyTo()` doesn't work across spreadsheets. So the migrator copies the source sheet INTO the destination spreadsheet as a temp sheet, does the local copyTo, then deletes the temp.

**Conditional formatting is intentionally left alone:** the Migrator no longer copies CF rules across sheets. For Daily Mode, inserting column L auto-shifts the destination's existing CF ranges, so the new version's rules stay correct without any remap. For the dex checklists, the IV step (step 6) edits the *existing* destination rules in place rather than importing the old sheet's.

## The bound script (per-version)

Lives inside each spreadsheet copy. Has the creator's original code plus my modifications. Three files I modify:

### onOpen.js

The creator provides `onOpen()`, `checkVersion()`, and `htmlmodalDialog()`. I:

- Add menu items: Snapshot Data, Highlight Changes, Clear Highlights, Migrate from previous version
- Add wrapper functions that delegate to the library: `snapshot()`, `highlightChanges()`, `clearHighlights()`, `runMigration()`
- The `PREVIOUS_VERSION` constant gets updated each time I migrate to a new version

The wrapper functions are needed because Apps Script menu items can't directly call library functions. They have to call top-level functions in the bound script that then forward to the library.

`runMigration()` extracts the destination version from the spreadsheet's filename via regex match `\d+\.\d+`, then calls `OfflineDexLib.portAll(PREVIOUS_VERSION, destVersion)`.

### LoadPlayerData.js

The creator provides `uploadFile()`, `decryptFile()`, `parseJsonContent()`, `writeJsonToSheet()`, `openAttachmentDialog()`, and crypto helpers (using a `cCryptoGS` library for AES decrypt of the save file). The save file is an encrypted blob; the spreadsheet's bound script decrypts it and writes the decoded JSON into a sheet called `newJSON`. From there, the spreadsheet's formulas pull from `newJSON` to populate the various data sheets.

I only modify `uploadFile()` to wrap the import in toast tracking and trigger `processChanges()` after:

```javascript
function uploadFile(obj) {
  const ss = SpreadsheetApp.getActiveSpreadsheet()
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
    OfflineDexLib.processChanges()
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
- `StatusSheetGenerator.js` (listImportSheetsWithGID) - creator's status helper

## Per-version setup workflow

The full runbook lives in [UPDATING.md](UPDATING.md). The short version when the creator
releases a new version:

1. Make a fresh copy of the new public spreadsheet to my Drive, renamed exactly
   `Offline RogueDex <version>` (this gives me a fresh bound script with the creator's code).
2. From the local repo, point clasp at the **fresh** copy and reconcile the bound code:
   ```bash
   cd bound
   # Update .clasp.json with the new spreadsheet's Script ID (point at the fresh copy)
   python3 update.py <new>   # 3-way merge creator's fresh code with my edits
   # resolve any conflicts (keep both sides), then git add + git commit
   clasp push -f
   ```

   **How the reconcile works (changed in 2026):** a `creator` branch holds the creator's
   *pristine* bound code, one commit per version. `update.py` pulls the fresh code,
   normalizes it through Prettier (`.prettierrc` at the repo root — matching my own
   formatting), commits it on that branch, and `git merge`s it into `main`, so the
   creator's updated functions *and* my customizations both survive — only genuine
   same-line *content* edits conflict (formatting differences are normalized away, so my
   reformatting doesn't manufacture conflicts). This replaced the old `git restore bound/`
   approach, which silently discarded every creator code change (it was a stale
   `checkVersion` from that loss that exposed the problem). Full model and the one-time
   first-run bootstrap are in [UPDATING.md](UPDATING.md).
3. Open the new spreadsheet, reload, click **RogueDex Functions → Migrate from Previous Version**,
   and enter the version I'm migrating FROM when prompted (the destination version is read from
   the filename). The source version is no longer a hardcoded constant.
4. Wait for migration to finish (~2 minutes for the formatting/hidden sheets work).
5. Upload my latest save file via **RogueDex Functions → Upload Data**.
6. The save tracker should highlight cells that changed compared to the migrated state.

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

- Node.js (via Homebrew or direct download), v20+
- clasp: `npm install -g @google/clasp`
- `clasp login` once for OAuth
- Apps Script API enabled in Google account settings (https://script.google.com/home/usersettings)

## Future enhancements that have come up

- Make `INSERT_COLUMN_L_IN_DAILY_MODE` a parameter to `portAll()` instead of a top-level constant, so different version transitions can opt in/out without redeploying the library
- Maybe add a `clasp push` automation via git pre-push hook
- Track timing per migration in the version history at the top of Migrator.js
