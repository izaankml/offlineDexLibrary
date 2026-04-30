# OfflineDex Scripts: Project Context

This doc summarizes the design and decisions behind this repo so that any future work (in Claude Code or otherwise) has the full picture without needing to dig through commit history or external chats.

## What this is

I track my Pokemon collection in a Google Sheets spreadsheet called "Offline RogueDex" maintained by a third-party creator. The creator publishes new versions every so often (5.06, 5.07, 5.08, ...) as a public read-only spreadsheet. To use a new version I make a copy into my Drive, which gives me a fresh spreadsheet with the creator's bound Apps Script attached.

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
    columnMap: buildShiftMap(4, 11, 4),     // D-K -> H-O (+4 shift)
    includeHeaders: true,
    headerRows: 1,
    borderColumns: [],
  },
  {
    key: 'StarterDex',
    dataSheet: 'STARTER_DEX.data',
    displaySheet: 'Starter Dex Checklist',
    dataFirstRow: 3,
    displayFirstRow: 4,
    columnMap: buildShiftMap(10, 141, -6),  // J-EK -> D-EE (-6 shift)
    includeHeaders: true,
    headerRows: 2,
    // L, U, AA, AB, AG, AI, AL, AO, BO, CQ, EE
    borderColumns: [12, 21, 27, 28, 33, 35, 38, 41, 67, 95, 135],
  },
  {
    key: 'FullDex',
    dataSheet: 'FULL_DEX.data',
    displaySheet: 'Full Dex Checklist',
    dataFirstRow: 3,
    displayFirstRow: 4,
    columnMap: buildShiftMap(7, 138, 0),    // G-EH -> G-EH (no shift)
    includeHeaders: true,
    headerRows: 2,
    // O, X, AD, AE, AJ, AL, AO, AR, BR, CT, EH (+3 from Starter Dex)
    borderColumns: [15, 24, 30, 31, 36, 38, 41, 44, 70, 98, 138],
  },
];
```

Why these column shifts: the display sheets have extra leading columns (dex#, name, etc.) that the data sheets don't have. The shift between data column and display column is consistent within a sheet but varies per tracker because each display sheet has a different number of leading columns.

**The flow on each save upload:**
1. `clearHighlights()` - wipe orange borders from previous run, redraw structural black borders
2. `highlightChanges()` - compare current data values to snapshot, paint thick green borders on changed cells
3. `snapshot()` - save current data to hidden snapshot sheets so the NEXT upload can diff against it

**Why borders not background colors:** the display cells often have conditional formatting that overrides background colors. Borders are not affected by conditional formatting and therefore are reliably visible. Color is `#38761d` (Google's "Dark green 1"), `SOLID_THICK` weight.

**Why structural black borders are re-applied during clearing:** when we clear the green highlight borders, we accidentally wipe the spreadsheet's design borders too. So the clear step also redraws them. Each tracker has a `borderColumns` list of right-borders to draw. They use `SOLID_MEDIUM` black.

**Snapshot storage:** hidden sheets named `_snapshot_<key>` (e.g., `_snapshot_QuickChecklist`). Each snapshot has the data sheet's tracked column range plus a header row (or two for the dex sheets). Empty leading columns are hidden for readability.

**Chunking:** all the heavy operations (read, write, clear, highlight) chunk in 200-row batches with a `flush()` between chunks. Without chunking, "Service error: Spreadsheets" hits on the larger sheets (Full Dex tracks 132 columns × ~1100 rows).

**Toast progress UI:** a single replacing toast shows what's currently running. Title = current step, body = previous step's elapsed time. State variables: `LAST_STEP_LABEL`, `LAST_STEP_ELAPSED`, `CURRENT_STEP_START`, `FLOW_START`. The `runStandaloneIfNeeded` helper makes individual functions self-managing if called directly, but skips reset/finalize when called as part of a larger flow.

### Migrator.js

Ports customizations from an old version of the spreadsheet to a new one. Called as `OfflineDexLib.portAll(sourceVersion, destVersion)` from the bound script's "Migrate from previous version" menu.

**Looks up files by name pattern:** `Offline RogueDex {v}` (e.g., "Offline RogueDex 5.07"). Excludes any file starting with `PUBLIC_` to avoid grabbing the creator's master.

**Five migration steps:**

1. **Quick Checklist header rows 1-10:** copies cell formatting + column widths + hidden states for rows 1-10. Ports formulas/values for row 1 columns H-O only (skip the merged title at A1:D1) and row 10 in full.

2. **Form Checklist sort:** sorts rows 2+ by column C ascending so unchecked rows appear before checked rows.

3. **Daily Mode formatting:** copies cell formatting, conditional formatting, and column widths for columns L+M only. Optionally inserts a blank column L into the destination (controlled by `INSERT_COLUMN_L_IN_DAILY_MODE`) because I had added a custom column there in 5.06 that creator versions don't have.

4. **Daily Mode cells:** unmerges any existing merge at B16, re-merges to `B16:M131`, copies B16 formula. Also copies L12:M14 formulas/values from source.

5. **Hidden sheets:** any sheet hidden in source is also hidden in destination if it exists by name.

**Cross-spreadsheet trick:** Apps Script's `Range.copyTo()` doesn't work across spreadsheets. So the migrator copies the source sheet INTO the destination spreadsheet as a temp sheet, does the local copyTo, then deletes the temp.

**Conditional formatting remap:** when copying CF rules from temp sheet to dest sheet, the rules' ranges still reference the temp's parent. So we extract each rule's range coords and rebuild new ranges on the destination sheet.

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
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  OfflineDexLib.resetToastProgress();
  OfflineDexLib.startStep(ss, 'Importing save data');

  var blob = createBlob(obj);
  var plaintext = decryptFile(blob);
  var jsonContent = parseJsonContent(plaintext);
  writeJsonToSheet(jsonContent);
  SpreadsheetApp.flush();
  Utilities.sleep(2000);  // give formulas time to recalculate

  OfflineDexLib.finishStep();

  try {
    OfflineDexLib.processChanges();
  } catch (e) {
    Logger.log('processChanges failed: ' + e.message);
  }
}
```

The 2-second sleep is important: after `writeJsonToSheet` fills in `newJSON`, formulas pulling from it need a moment to recalculate before the snapshot can read post-update values.

### UploadPlayerData.html

The creator's dialog. I modify `fr.onload` to dispatch `uploadFile` and close the dialog after a 500ms delay so the dialog dismisses while server-side processing continues. Without the delay, closing too fast cancels the request.

```javascript
google.script.run.uploadFile(obj);
setTimeout(() => google.script.host.close(), 500);
```

### Files I don't modify

- `ImportDB.js` (forceUpdate, copyDBList, copyDailyList) - creator's database import logic
- `StatusSheetGenerator.js` (listImportSheetsWithGID) - creator's status helper

## Per-version setup workflow

When the creator releases a new version (e.g., 5.08):

1. Make a fresh copy of the new public spreadsheet to my Drive (this gives me a fresh bound script with the creator's original code)
2. From the local repo:
   ```bash
   cd bound
   # Update .clasp.json with the new spreadsheet's Script ID
   # Update PREVIOUS_VERSION constant in onOpen.js to match what I'm migrating from
   clasp push -f
   ```
3. Open the new spreadsheet, reload the page, click "Upload PokeRogue Data > Migrate from previous version"
4. Wait for migration to finish (~2 minutes for the formatting/hidden sheets work)
5. Upload my latest save file via "Upload PokeRogue Data > Upload Data"
6. The save tracker should highlight cells that changed compared to the migrated state

## Things to know about the spreadsheet

- The save file is encrypted with AES; the bound script uses `cCryptoGS` (a library) to decrypt
- Pokemon are listed by row in the data sheets and display sheets, with the same row mapping (e.g., row 12 is Bulbasaur in both QuickChecklist data and display)
- The data sheets have raw 0/1/empty integer values; the display sheets have formulas like `=STARTER_CHECKLIST.sorted!H12` that resolve through `STARTER_CHECKLIST.sorted` (which uses ARRAYFORMULA + IFS to map values to icons via cell references like `$A$10` and `G11`)
- This is why we track the data sheets directly: `getDisplayValues()` on the display sheets returns empty for the icon cells because the icons are inserted images, not text

## Things that took some figuring out

- **Cross-spreadsheet operations:** `Range.copyTo()` only works within one spreadsheet. Workaround: copy source SHEET into destination spreadsheet as a temp, do local copyTo, delete temp.
- **Conditional formatting overrides backgrounds:** changed-cell highlights couldn't use background colors because conditional formatting wins. Borders work because CF can't change borders.
- **Apps Script can't read borders:** there's no `getBorder()` method. So we can't restore original borders after clearing. Solution: re-apply known structural borders explicitly.
- **`getDisplayValues()` returns empty for image cells:** the display sheets use formulas that resolve to inserted images. Apps Script can't read those as text. So we track the upstream data sheets (raw integers) instead.
- **Service errors on big ranges:** chunking in 200-row batches with `flush()` between is required for the Full Dex sheet (132 cols × 1100 rows).
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
