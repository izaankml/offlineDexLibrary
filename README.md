# OfflineDex Scripts

Automation on top of the OfflineDex spreadsheet: save-change highlighting, per-version migration, and a three-touch update flow for new creator releases. See `CONTEXT.md` for full design notes and `UPDATING.md` for the update runbook.

## Repo layout

```
├── library/          OfflineDex Library — standalone Apps Script project
│   ├── appsscript.json
│   ├── SaveTracker.js
│   ├── Migrator.js
│   └── Setup.js          Prepare Next Version / previous-version detection
├── bound/            Bound script — per-version, lives inside each spreadsheet copy
│   ├── appsscript.json
│   ├── onOpen.js
│   ├── LoadPlayerData.js
│   └── UploadPlayerData.html
├── scripts/
│   └── update.ts     `npm run update` — the terminal half of a version update
├── hooks/pre-push    clasp push on git push
├── UPDATING.md       Per-version runbook
├── CONTEXT.md        Full design and decision log
└── README.md         This file
```

`.clasp.json` files are gitignored (contain Script IDs). Each project directory needs one locally — see formats below.

---

## First-time setup (after cloning)

```bash
npm install        # typescript + @types/node for `npm run typecheck`
npm run setup      # wires up the git hooks (git push → clasp push)
```

---

## Prerequisites

- Node.js v24+ (the update CLI is TypeScript run directly via Node's type stripping)
- clasp: `npm install -g @google/clasp`, then `clasp login` (one-time OAuth flow)
- Prettier on your PATH: `npm install -g prettier` (the update CLI normalizes the
  creator's code with it before merging)
- Apps Script API enabled: https://script.google.com/home/usersettings

---

## One-time library setup

Do this once. The library project is stable across all spreadsheet versions.

**1. Create the Apps Script project**

Go to [script.google.com](https://script.google.com), create a new standalone project named "OfflineDex Library".

**2. Wire up clasp**

```bash
cd library
```

Create `library/.clasp.json` with the library's Script ID (from Project Settings > Script ID in the Apps Script editor):

```json
{
  "scriptId": "YOUR_LIBRARY_SCRIPT_ID",
  "rootDir": "."
}
```

**3. Push the library**

```bash
clasp push
```

**4. Deploy as a library**

In the Apps Script editor: Deploy → New deployment → type: Library → add a description → Deploy.

Note the deployment version number. You'll need this in the bound script's `appsscript.json`.

**5. Fill in the manifest placeholder**

In `bound/appsscript.json`, replace `FILL_IN_LIBRARY_SCRIPT_ID` with the library's Script ID and confirm the `version` number matches what you deployed.

---

## One-time bound manifest setup

The bound `appsscript.json` needs two libraries: your `OfflineDexLib` (above) and the creator's `cCryptoGS`. You need to get `cCryptoGS`'s Script ID from the creator's project.

**How to get the cCryptoGS Script ID:**

1. Open any existing OfflineDex spreadsheet copy (one you've already been using)
2. Extensions → Apps Script → Libraries (left sidebar)
3. Click `cCryptoGS` → copy the Script ID and note the version

Fill both into `bound/appsscript.json`:

```json
{
  "timeZone": "America/Los_Angeles",
  "dependencies": {
    "libraries": [
      {
        "userSymbol": "OfflineDexLib",
        "libraryId": "YOUR_LIBRARY_SCRIPT_ID",
        "version": "YOUR_LIBRARY_VERSION",
        "developmentMode": true
      },
      {
        "userSymbol": "cCryptoGS",
        "libraryId": "ACTUAL_CCRYPTOGS_SCRIPT_ID",
        "version": "CCRYPTOGS_VERSION",
        "developmentMode": false
      }
    ]
  },
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8"
}
```

Commit this filled-in `appsscript.json` to git. You only need to do this once — on each
subsequent version update, `npm run update` 3-way merges the creator's manifest into
yours, so your library dependencies are preserved automatically.

---

## Per-version update (e.g., `<old> → <new>`)

Three touches — see **[UPDATING.md](UPDATING.md)**:

1. Old sheet: **RogueDex Functions → Prepare Next Version** (copies the public sheet,
   hands you a command).
2. Terminal: `npm run update -- <scriptId>` (merges creator code with yours, pushes).
3. New sheet: **RogueDex Functions → Finish Setup** (migrates, then opens the upload
   dialog).

---

## Updating the library (when you change SaveTracker.js or Migrator.js)

```bash
cd library
# edit files
clasp push          # or just `git push` — the pre-push hook runs clasp push for you
```

That's it. The bound manifest references the library with `developmentMode: true`, so
every spreadsheet copy automatically runs the latest pushed code — **no redeployment or
version bump required**.

---

## Timezone note

Both `appsscript.json` files use `America/Los_Angeles`. Change if needed — it affects how Apps Script formats dates in logs.
