# Updating to a New OfflineDex Version

The end-to-end runbook for moving your customizations to a newly released
spreadsheet version (e.g. `<old> → <new>`). Assumes the one-time setup in
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
  Each new version is a fresh copy with the creator's code. `update.py` **3-way merges**
  the creator's fresh code with your edits, so the creator's updated functions *and*
  your customizations both survive (see [How `update.py` merges](#how-updatepy-merges)).
- **Your data/customizations** (formatting, hidden sheets, Daily Mode column, cell
  formulas, dex IV highlighting) get carried over by the in-sheet **migration**, which
  reads them out of your previous version's spreadsheet.

So a version update has two distinct halves:
1. **Code reconciliation** (terminal) — get your bound code into the new copy.
2. **Migration** (in the sheet) — port your customizations from the old copy.

---

## Prerequisites for each update

- Your previous version's spreadsheet (e.g. `Offline RogueDex <old>`) still exists in
  Drive, untrashed. The migrator reads your customizations out of it.
- You are on the `main` branch with a **clean working tree** (everything committed).
  `update.py` switches branches and merges, both of which require a clean tree.

---

## Step-by-step (example: `<old> → <new>`)

### 1. Make your copy of the new version

- Open the creator's public spreadsheet for the **new version** → **File → Make a copy** into your Drive.
- Rename the copy to **exactly** `Offline RogueDex <new>` — no `PUBLIC_` prefix.
  The migrator finds both the source and destination files by this exact name.

### 2. Point clasp at the new copy

> **Important:** `update.py` reads the creator's *pristine* code from whatever
> `.clasp.json` points at. Point it at the **fresh, just-made copy** *before* you push
> any of your own edits to it — otherwise the `creator` branch records your customized
> code as the "creator baseline" and future merges will be wrong.

- In the new copy: **Extensions → Apps Script → Project Settings** → copy the **Script ID**.
- Edit [bound/.clasp.json](bound/.clasp.json) (gitignored; create if missing):

  ```json
  {
    "scriptId": "NEW_SHEET_SCRIPT_ID",
    "rootDir": "."
  }
  ```

### 3. Reconcile the bound code

```bash
cd bound
python3 update.py <new>      # the version label is used in the creator commit message
```

This pulls the creator's fresh code onto the `creator` branch, commits it, then
**3-way merges** it into `main`. Creator changes to functions you never touched merge
in silently; your custom functions the creator never touched are preserved. If you and
the creator edited the **same lines**, the merge stops with a conflict — resolve it
keeping *both* sides, then `git add` + `git commit` to finish (the script prints the
exact commands). See [How `update.py` merges](#how-updatepy-merges) for the model.

**First time only:** there is no `creator` branch yet, so `update.py` bootstraps one
(orphan branch + a single reconciling merge). That first merge conflicts on the whole
of each file you customize — combine the creator's current code with your edits once,
commit, and every future update is a clean line-level merge. See
[First-run bootstrap](#first-run-bootstrap).

### 4. Push the reconciled bound code

```bash
clasp push -f
```

(Run this only after the merge is complete — i.e. no unresolved conflicts.)

### 5. Run the migration (in the sheet)

- Reload the new spreadsheet tab so the menu rebuilds.
- **RogueDex Functions → Migrate from Previous Version**.
- At the prompt *"Version you are migrating from:"*, enter `<old>`.
  (The destination `<new>` is auto-derived from the filename.)
- Wait ~2 minutes. A toast tracks each step and ends with *"Migration complete in Ns"*.

### 6. Load your latest save

- **RogueDex Functions → Upload Data** → upload your latest save file.
- The save tracker highlights cells that changed versus the migrated state.

### 7. Commit the merge

The merge commit on `main` *is* your record of this version's reconciled bound code —
nothing extra to commit. (`bound/.clasp.json` is gitignored and never committed.) If
the merge had conflicts, the commit you make to finish the merge covers it.

---

## How `update.py` merges

The repo keeps a **`creator` branch** that holds the creator's *pristine* bound code —
one commit per version, exactly as `clasp pull` delivers it, with none of your edits.
`main` holds your customized code. Each update is a 3-way merge:

```
creator:  v<old>-pristine ──► v<new>-pristine      (clasp pull, committed by update.py)
                │                  │
main:    ...your <old> edits ─────► merge ─────►   (git merge creator)
```

Git's 3-way merge compares the **previous** creator commit (the merge base), the **new**
creator commit (theirs), and **your** code (ours):

- Creator changed a function, you didn't → creator's version is taken automatically.
- You customized a function, creator didn't → your version is kept automatically.
- You **both** changed the same lines → conflict; you resolve it keeping both intents.

This is why the stale-`checkVersion` problem can't recur: a creator change to
`checkVersion` is now a real diff against the baseline and merges in, instead of being
silently discarded.

Only the files git tracks in `bound/` participate — `onOpen.js`, `LoadPlayerData.js`,
`UploadPlayerData.html`, `appsscript.json`. The creator files you never touch
(`ImportDB.js`, `Sheet Status Generator.js`) are gitignored, so `clasp pull` just
refreshes them in place on each new copy; they need no merge.

### First-run bootstrap

No commit in this repo's history was ever pristine creator code, so the first run has
nothing to use as a merge base. `update.py` handles this by creating the `creator`
branch as an **orphan** (unrelated history) and doing one
`git merge --allow-unrelated-histories`. With no common ancestor, git conflicts on the
*entire* contents of each customized file — you reconcile once by hand (combine the
creator's current functions with your customizations). After that commit, the `creator`
branch is a shared ancestor and all later merges are clean line-level 3-way merges.

The bootstrap run **must** have `.clasp.json` pointing at a fresh, unmodified copy of
the creator's current version — `update.py` asks you to confirm this before it records
the baseline.

---

## Verify it worked

- **Execution log**: Extensions → Apps Script → Executions. Each migration step is
  wrapped in `safeRun`, so failures are non-fatal — check the `OK/ERR` summary in the
  log for any `ERR` lines.
- **Daily Mode sheet**: confirm your custom column L looks right (see caveat below).
- **Highlights**: after the save upload, changed Pokemon should be filled with the
  highlight colors.

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
- **Merge conflict on a file I customized** — expected when you and the creator edited
  the same lines. Open the file, keep *both* the creator's change and your edit, remove
  the `<<<<<<< ======= >>>>>>>` markers, then `git add <file>` and `git commit`.
  To start the merge over: `git merge --abort`.
- **`update.py` left me on the `creator` branch** — only if it errored mid-run. Get
  back with `git checkout main`; the pristine pull is safely committed on `creator`.
- **The whole file conflicted, not just a few lines** — that's the one-time first-run
  bootstrap (orphan branch, no merge base). Normal after the `creator` branch exists.
- **`creator` branch recorded my edits as the baseline** — you pointed `.clasp.json` at
  a copy you'd already pushed to. Delete the bad baseline commit and re-run pointed at a
  truly fresh copy: `git checkout main && git branch -D creator` (first-run only).
- **Library changes not taking effect** — because the bound manifest uses
  `developmentMode: true`, pushing `library/` (via `clasp push` from `library/`, or
  automatically on `git push` thanks to the pre-push hook) is enough; no redeploy needed.

---

## Quick reference

```bash
# 0. Old version's sheet still in Drive; new copy renamed "Offline RogueDex <new>"
# 0. New copy's Script ID set in bound/.clasp.json (point at the FRESH copy)
# 0. On main, working tree clean

cd bound
python3 update.py <new>   # pull creator code onto `creator`, 3-way merge into main
# resolve any conflicts (keep both sides), then git add + git commit
clasp push -f            # upload reconciled bound code

# Then in the sheet:
#   RogueDex Functions → Migrate from Previous Version → enter old version (`<old>`)
#   RogueDex Functions → Upload Data → upload latest save
```
