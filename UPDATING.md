# Updating to a New OfflineDex Version

The end-to-end runbook for moving your customizations to a newly released
spreadsheet version (e.g. `5.07 → 6.01`). Assumes the one-time setup in
[README.md](README.md) is already done (clasp installed + logged in, the
`OfflineDex Library` project deployed, your committed `bound/appsscript.json`
in place).

---

## Mental model: what changes vs. what doesn't

- **The library** (`library/` — `SaveTracker.js`, `Migrator.js`) is **version-independent**.
  The bound manifest references it with `developmentMode: true`, so every spreadsheet
  copy automatically runs the latest code you've pushed. You do **not** redeploy or
  bump a library version when adopting a new spreadsheet version.
- **The bound script** (`bound/` — `onOpen.js`, `LoadPlayerData.js`,
  `UploadPlayerData.html`, `appsscript.json`) lives **inside each spreadsheet copy**.
  Each new version is a fresh copy with the creator's code, so you re-apply your four
  edited files on top — that's what `update.py` automates.
- **Your data/customizations** (formatting, hidden sheets, Daily Mode column, cell
  formulas, filter views) get carried over by the in-sheet **migration**, which reads
  them out of your previous version's spreadsheet.

So a version update has two distinct halves:
1. **Code reconciliation** (terminal) — get your bound code into the new copy.
2. **Migration** (in the sheet) — port your customizations from the old copy.

---

## Prerequisites for each update

- Your previous version's spreadsheet (e.g. `Offline RogueDex 5.07`) still exists in
  Drive, untrashed. The migrator reads your customizations out of it.
- Your `bound/` tracked files are **committed** (clean git state). `update.py` runs a
  hard `git restore bound/`, which discards uncommitted changes to those files.

---

## Step-by-step (example: 5.07 → 6.01)

### 1. Make your copy of the new version

- Open the creator's public **6.01** spreadsheet → **File → Make a copy** into your Drive.
- Rename the copy to **exactly** `Offline RogueDex 6.01` — no `PUBLIC_` prefix.
  The migrator finds both the source and destination files by this exact name.

### 2. Point clasp at the new copy

- In the 6.01 sheet: **Extensions → Apps Script → Project Settings** → copy the **Script ID**.
- Edit [bound/.clasp.json](bound/.clasp.json) (gitignored; create if missing):

  ```json
  {
    "scriptId": "NEW_6.01_SCRIPT_ID",
    "rootDir": "."
  }
  ```

### 3. Reconcile the bound code

```bash
cd bound
python3 update.py
```

This pulls the creator's fresh files, restores your four edited files via
`git restore`, and merges the creator's `sheets` (macro) manifest block into your
`appsscript.json`. It prints what it merged and **warns** if `oauthScopes` or
`runtimeVersion` changed (those need a manual look). If it reports a manifest change,
review `bound/appsscript.json` before pushing.

### 4. Push the reconciled bound code

```bash
clasp push -f
```

### 5. Run the migration (in the sheet)

- Reload the 6.01 spreadsheet tab so the menu rebuilds.
- **RogueDex Functions → Migrate from Previous Version**.
- At the prompt *"Version you are migrating from:"*, enter `5.07`.
  (The destination `6.01` is auto-derived from the filename.)
- Wait ~2 minutes. A toast tracks each step and ends with *"Migration complete in Ns"*.

### 6. Load your latest save

- **RogueDex Functions → Upload Data** → upload your latest save file.
- The save tracker highlights cells that changed versus the migrated state.

### 7. (Optional) Commit manifest changes

If `update.py` merged creator manifest changes you want to keep, commit
`bound/appsscript.json`. `bound/.clasp.json` is gitignored and is **not** committed.

---

## Verify it worked

- **Execution log**: Extensions → Apps Script → Executions. Each migration step is
  wrapped in `safeRun`, so failures are non-fatal — check the `OK/ERR` summary in the
  log for any `ERR` lines.
- **Daily Mode sheet**: confirm your custom column L looks right (see caveat below).
- **Highlights**: after the save upload, changed Pokemon should be filled with the
  highlight colors, and each tracked sheet should have a **"View Changes"** filter view.

---

## Caveats & troubleshooting

- **Daily Mode column L** — porting the custom column is gated on the library constant
  `INSERT_COLUMN_L_IN_DAILY_MODE` (`true`) plus a width check
  (`dest max columns < source max columns`). A major version jump that reshuffles Daily
  Mode can make this misfire — eyeball that sheet after migrating.
- **"No file found named ..."** — the source/destination filenames don't match
  `Offline RogueDex {v}` exactly, or the file is trashed. Rename to match.
- **Multiple matches** — if several files share the name, the migrator uses the most
  recently updated and logs the rest. Trash stale duplicates to avoid surprises.
- **`update.py` wiped my edits** — it does `git restore bound/`. Commit your bound
  changes *before* running it.
- **Library changes not taking effect** — because the bound manifest uses
  `developmentMode: true`, pushing `library/` (via `clasp push` from `library/`, or
  automatically on `git push` thanks to the pre-push hook) is enough; no redeploy needed.

---

## Quick reference

```bash
# 0. Old version's sheet still in Drive; new copy renamed "Offline RogueDex <new>"
# 0. New copy's Script ID set in bound/.clasp.json; bound/ committed clean

cd bound
python3 update.py     # pull creator code, restore your edits, merge manifest
clasp push -f         # upload reconciled bound code

# Then in the sheet:
#   RogueDex Functions → Migrate from Previous Version → enter old version (e.g. 5.07)
#   RogueDex Functions → Upload Data → upload latest save
```
