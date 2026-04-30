# OfflineDex Scripts

Automation on top of the OfflineDex spreadsheet: save-change highlighting and per-version migration. See `CONTEXT.md` for full design notes.

## Repo layout

```
├── library/          OfflineDex Library — standalone Apps Script project
│   ├── appsscript.json
│   ├── SaveTracker.js
│   └── Migrator.js
├── bound/            Bound script — per-version, lives inside each spreadsheet copy
│   ├── appsscript.json
│   ├── onOpen.js
│   ├── LoadPlayerData.js
│   └── UploadPlayerData.html
├── CONTEXT.md        Full design and decision log
└── README.md         This file
```

`.clasp.json` files are gitignored (contain Script IDs). Each project directory needs one locally — see formats below.

---

## Prerequisites

- Node.js v20+
- clasp: `npm install -g @google/clasp`
- `clasp login` (one-time OAuth flow)
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

In the Apps Script editor: Deploy → New deployment → type: Library → description "v1" → Deploy.

Note the deployment version number (starts at 1). You'll need this in the bound script's `appsscript.json`.

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
  "timeZone": "America/New_York",
  "dependencies": {
    "libraries": [
      {
        "userSymbol": "OfflineDexLib",
        "libraryId": "YOUR_LIBRARY_SCRIPT_ID",
        "version": "1",
        "developmentMode": false
      },
      {
        "userSymbol": "cCryptoGS",
        "libraryId": "ACTUAL_CCRYPTOGS_SCRIPT_ID",
        "version": "3",
        "developmentMode": false
      }
    ]
  },
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8"
}
```

Commit this filled-in `appsscript.json` to git. You only need to do this once — subsequent version setups restore it via `git restore`.

---

## Per-version setup (e.g., 5.07 → 5.08)

**1. Copy the new spreadsheet**

Make a fresh copy of the creator's new public spreadsheet into your Drive.

**2. Get the new Script ID**

Open the copy → Extensions → Apps Script → Project Settings → Script ID.

**3. Update `.clasp.json`**

```bash
cd bound
```

Edit (or create) `bound/.clasp.json`:

```json
{
  "scriptId": "NEW_SPREADSHEETS_SCRIPT_ID",
  "rootDir": "."
}
```

**4. Pull the creator's files**

This fetches ALL files from the fresh bound script, including `ImportDB.js` and `StatusSheetGenerator.js` that you don't modify but that must be present for `clasp push` to not delete them.

```bash
clasp pull
```

**5. Restore your files**

`clasp pull` overwrites your edits with the creator's originals. Restore your versions:

```bash
git restore .
```

This brings back `onOpen.js`, `LoadPlayerData.js`, `UploadPlayerData.html`, and `appsscript.json` (with both library dependencies).

**6. Update `PREVIOUS_VERSION`**

In `bound/onOpen.js`, update the constant at the top:

```javascript
const PREVIOUS_VERSION = '5.07';  // the version you're migrating FROM
```

**7. Push**

```bash
clasp push -f
```

**8. Run the migration**

- Reload the spreadsheet tab
- Menu: Upload PokeRogue Data → Migrate from previous version
- Wait for the completion alert (~2 minutes)

**9. Upload your save**

- Menu: Upload PokeRogue Data → Upload Data

---

## Updating the library (when you change SaveTracker.js or Migrator.js)

```bash
cd library
# edit files
clasp push
```

Then in the Apps Script editor: Deploy → Manage deployments → pencil on the existing deployment → Version: New version → Deploy.

Finally, bump the version number in `bound/appsscript.json` and run through the next version's setup (or update in-place via the Apps Script UI on each active spreadsheet).

---

## Timezone note

Both `appsscript.json` files use `America/Los_Angeles`. Change if needed — it affects how Apps Script formats dates in logs.
