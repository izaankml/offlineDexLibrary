# Updating to a New OfflineDex Version

The runbook for moving your customizations to a newly released spreadsheet
version. Assumes the one-time setup in [README.md](README.md) is done (clasp
logged in, `npm install`, the `OfflineDex Library` project pushed, your
`bound/appsscript.json` committed).

---

## The three touches

```
 ┌── old sheet ──────────────┐   ┌── terminal ───────────────────┐   ┌── new sheet ─────────────┐
 │ RogueDex Functions →      │   │ npm run update -- <scriptId>  │   │ RogueDex Functions →     │
 │   Prepare Next Version    │ → │   (paste from the dialog)     │ → │   Finish Setup           │
 │ copies the public sheet,  │   │ merges creator code w/ yours, │   │ migrates from previous   │
 │ hands you the command     │   │ pushes it to the copy         │   │ version, opens upload    │
 └───────────────────────────┘   └───────────────────────────────┘   └──────────────────────────┘
```

### 1. Old sheet → **Prepare Next Version**

In the sheet you're currently using: **RogueDex Functions → Prepare Next Version**.

- It reads the creator's public sheet (a single Drive file the creator renames each
  release, e.g. `PUBLIC_Offline RogueDex 6.03`), copies it into your Drive as
  **`Offline RogueDex 6.03`**, looks up the copy's bound Script ID, and shows a dialog
  with the exact command to run next. Click **Copy**.
- If a sheet with that name already exists it asks whether to reuse it (only say yes if
  you have *not* pushed your code to it) or make a fresh copy.
- First run only: Google will ask you to re-authorize (the library now uses the Drive
  advanced service to find the Script ID). Accept and re-run the menu item.

### 2. Terminal → paste the command

```bash
npm run update -- 1AbC…ScriptId
```

What it does (from `main`, clean tree — it checks):

1. Resolves the Script ID → its parent spreadsheet → the sheet's name → the version,
   using your existing clasp login. Refuses if the sheet isn't named
   `Offline RogueDex X.YY`, if that version's baseline is already recorded, or if the
   pulled code already contains your customizations (i.e. not a fresh copy).
2. Writes `bound/.clasp.json` for you.
3. Pulls the creator's pristine code into a **temporary git worktree** of the
   `creator` branch (your checkout never leaves `main`), Prettier-normalizes it, and
   commits it as `creator 6.03`.
4. `git merge creator` into `main`.
5. On a clean merge, runs `clasp push -f` so the copy has your code.

If you and the creator edited the **same lines**, it stops and lists the files:

```bash
# resolve each file keeping BOTH sides, then
git add <files>
npm run update -- --continue     # commits the merge and pushes
# or throw it away:
npm run update -- --abort
```

Useful variants:

```bash
npm run update                              # is a new version out? (reads the public sheet's title)
npm run update -- <editor URL>              # paste the Apps Script editor URL instead of the ID
npm run update -- <id> --version 6.03       # skip the Google lookup (offline / fallback)
npm run update -- <id> --no-push            # everything except clasp push
```

### 3. New sheet → **Finish Setup**

Open the new copy (the CLI prints the link), reload once so the menu rebuilds — a
toast will point you at Finish Setup — then **RogueDex Functions → Finish Setup**.

- It auto-detects your previous version (newest `Offline RogueDex X.YY` in Drive
  below this one) and asks one confirm: *Migrate from 6.01 → 6.03?* (NO lets you
  type a different source.)
- Runs the migration (~2 min, toast tracks each step), records that this copy has
  been migrated, then opens the **Upload Data** dialog so you can load your save
  straight away.

That's it. The merge commit on `main` is your record of this version's reconciled
bound code; `bound/.clasp.json` is gitignored.

---

## Prerequisites for each update

- Your previous version's spreadsheet still exists in Drive, untrashed (Finish Setup
  reads your customizations out of it).
- On `main` with a clean working tree (the CLI refuses otherwise).
- `clasp login` still valid (the CLI reuses it for the Google lookups).

---

## How the merge works

The repo keeps a **`creator` branch** holding the creator's *pristine* bound code —
one commit per version, exactly as `clasp pull` delivers it (after Prettier), with
none of your edits. `main` holds your customized code. Each update is a 3-way merge:

```
creator:  v<old>-pristine ──► v<new>-pristine      (clasp pull, committed by the CLI)
                │                  │
main:    ...your <old> edits ─────► merge ─────►   (git merge creator)
```

Git compares the **previous** creator commit (merge base), the **new** creator commit
(theirs), and **your** code (ours):

- Creator changed a function, you didn't → creator's version is taken automatically.
- You customized a function, creator didn't → your version is kept automatically.
- You **both** changed the same lines → conflict; you resolve it keeping both intents.

**Prettier normalization.** Right after `clasp pull`, the CLI runs Prettier over the
pulled bound files with the repo's `.prettierrc.json` (`semi: false`,
`singleQuote: true`, `trailingComma: all`) *before* committing the baseline. Your
`main` files use the same config, so formatting-only differences collapse to identical
bytes and a creator edit only conflicts when it touches code you customized *in
substance*.

Only the files git tracks in `bound/` take part — `onOpen.js`, `LoadPlayerData.js`,
`UploadPlayerData.html`, `appsscript.json`. Creator files you never touch
(`ImportDB.js`, `Sheet Status Generator.js`) are gitignored; `clasp pull` just
refreshes them.

### First-run bootstrap (fresh clone only)

If there is no `creator` branch (a fresh clone that never fetched it), the CLI
creates it as an **orphan** from the pulled code and merges with
`--allow-unrelated-histories`. With no common ancestor git conflicts on the whole of
each customized file — reconcile once by hand, `--continue`, and every later update
is a clean line-level merge. (This repo's `creator` branch already exists; `git fetch`
brings it along.)

---

## Verify it worked

- **Execution log**: Extensions → Apps Script → Executions. Each migration step is
  wrapped in `safeRun`; check the `OK/ERR` summary for any `ERR` lines.
- **Daily Mode sheet**: confirm your custom column L looks right (see caveat below).
- **Highlights**: after the save upload, changed Pokemon should be filled with the
  highlight colors.

---

## Caveats & troubleshooting

- **The dialog says it couldn't find the Script ID** — the Drive lookup came back
  empty. Open the new sheet → Extensions → Apps Script, copy the browser URL of the
  editor, and run `npm run update -- <that URL>`; the CLI extracts the ID.
- **"This copy already has your code pushed to it"** — the CLI found `OfflineDexLib`
  in the pulled code, so it isn't a pristine copy and can't become the baseline. Run
  Prepare Next Version again and choose NO to make a fresh copy.
- **"A creator baseline for X is already recorded"** — you already ran the update for
  this version. If you only need to re-push: `cd bound && clasp push -f`. To redo the
  baseline deliberately: `git branch -f creator creator~1` and re-run.
- **Daily Mode column L** — porting the custom column is gated on the library constant
  `INSERT_COLUMN_L_IN_DAILY_MODE` (`true`) plus a width check. A major version jump
  that reshuffles Daily Mode can make this misfire — eyeball that sheet after migrating.
- **"No file found named ..."** — the source/destination filenames don't match
  `Offline RogueDex {v}` exactly, or the file is trashed. Rename to match.
- **Finish Setup picked the wrong previous version** — it takes the newest copy older
  than this one; answer NO to the confirm and type the version you want. Trash stale
  duplicates to avoid surprises.
- **Merge conflict on a file I customized** — expected when you and the creator edited
  the same lines. Keep both, remove the `<<<<<<< ======= >>>>>>>` markers,
  `git add`, `npm run update -- --continue`.
- **Suddenly lots of formatting-only conflicts** — Prettier didn't run. The CLI
  refuses to start without it; `npm i -g prettier` (or add it locally) and re-run.
- **The creator moved the public sheet** — RogueDex Functions → Change Public
  Sheet… and paste the new URL (stored per user; the CLI's no-arg check uses the
  built-in ID, update `PUBLIC_SHEET_FILE_ID` in `scripts/update.ts` and
  `library/Setup.js` when that happens for good).
- **Library changes not taking effect** — the bound manifest uses
  `developmentMode: true`, so pushing `library/` (`clasp push` from `library/`, or
  automatically on `git push` via the pre-push hook) is enough; no redeploy needed.

---

## Quick reference

```
old sheet:  RogueDex Functions → Prepare Next Version   → Copy
terminal:   npm run update -- <scriptId>                 (resolve conflicts → --continue)
new sheet:  reload → RogueDex Functions → Finish Setup   → confirm → upload save
```
