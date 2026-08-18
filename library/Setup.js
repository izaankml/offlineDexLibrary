// ============================================================
// SETUP MODULE (library file)
//
// The Google-side half of a version update:
//
//   prepareNextVersion()   — from your CURRENT sheet: copy the creator's
//                            public sheet into Drive under the right name,
//                            find the copy's bound Script ID, and hand back
//                            the one terminal command that finishes the job.
//   detectPreviousVersion  — from the NEW sheet: which of your copies is the
//                            newest one older than this, so Finish Setup can
//                            migrate from it without asking you to type it.
//
// Called via OfflineDexLib.<name> from the bound script's menu wrappers.
// ============================================================

/**
 * The creator publishes every version as the SAME Drive file, renamed on each
 * release (e.g. "PUBLIC_Offline RogueDex 6.03"). Reading its title tells us the
 * newest version; copying it gives a fresh copy with the creator's bound code.
 * Override without redeploying via the user property below (Change Public
 * Sheet… menu item), in case the creator ever publishes under a new file.
 * Mirrors PUBLIC_SHEET_FILE_ID in scripts/update.ts.
 */
const PUBLIC_SHEET_FILE_ID = '1peZNMRqicwfGAMYYJq6aeA13_1ZFVKvl--_gVQOdfv0'
const PUBLIC_SHEET_ID_PROPERTY = 'OFFLINEDEX_PUBLIC_SHEET_ID'

/** Your copies: "Offline RogueDex X.YY". Same pattern as FILE_NAME_PATTERN. */
const COPY_NAME_RE = /^Offline RogueDex (\d+\.\d+)$/
const VERSION_IN_NAME_RE = /\d+\.\d+/

/** The public sheet's Drive file ID, honoring any user override. */
function getPublicSheetId() {
  return (
    PropertiesService.getUserProperties().getProperty(
      PUBLIC_SHEET_ID_PROPERTY,
    ) || PUBLIC_SHEET_FILE_ID
  )
}

/**
 * Menu: let the user point at a different public sheet (URL or ID). Stored per
 * user so it survives across every spreadsheet copy.
 */
function changePublicSheet() {
  const ui = SpreadsheetApp.getUi()
  const current = getPublicSheetId()
  const resp = ui.prompt(
    'Change Public Sheet',
    "Paste the creator's public spreadsheet URL (or its file ID).\n" +
      'Current: ' +
      current +
      '\n\nLeave blank to reset to the built-in default.',
    ui.ButtonSet.OK_CANCEL,
  )
  if (resp.getSelectedButton() !== ui.Button.OK) return
  const text = resp.getResponseText().trim()
  const props = PropertiesService.getUserProperties()
  if (!text) {
    props.deleteProperty(PUBLIC_SHEET_ID_PROPERTY)
    ui.alert('Reset to the built-in public sheet.')
    return
  }
  const id = extractDriveId(text)
  if (!id) {
    ui.alert("That doesn't look like a Drive URL or file ID.")
    return
  }
  try {
    const name = DriveApp.getFileById(id).getName()
    props.setProperty(PUBLIC_SHEET_ID_PROPERTY, id)
    ui.alert('Public sheet set to "' + name + '".')
  } catch (e) {
    ui.alert("Couldn't open that file: " + e.message)
  }
}

/** Pull a Drive file ID out of a docs/drive URL, or accept a bare ID. */
function extractDriveId(text) {
  const m =
    text.match(/\/d\/([A-Za-z0-9_-]{20,})/) ||
    text.match(/[?&]id=([A-Za-z0-9_-]{20,})/) ||
    text.match(/^([A-Za-z0-9_-]{20,})$/)
  return m ? m[1] : null
}

/**
 * Menu (run from your CURRENT sheet). Copies the creator's public sheet into
 * your Drive as "Offline RogueDex <new>", looks up the copy's bound Script ID,
 * and shows a dialog with the exact terminal command to run next.
 */
function prepareNextVersion() {
  const ui = SpreadsheetApp.getUi()
  const ss = SpreadsheetApp.getActiveSpreadsheet()

  let publicFile
  try {
    publicFile = DriveApp.getFileById(getPublicSheetId())
  } catch (e) {
    ui.alert(
      "Couldn't open the creator's public sheet (" +
        getPublicSheetId() +
        '). ' +
        'If the creator moved it, use RogueDex Functions → Change Public Sheet…\n\n' +
        e.message,
    )
    return
  }

  const publicName = publicFile.getName()
  const versionMatch = publicName.match(VERSION_IN_NAME_RE)
  if (!versionMatch) {
    ui.alert(
      'The public sheet is named "' +
        publicName +
        '" — no version number in it, so I can\'t name your copy. ' +
        'Copy it by hand and name it "Offline RogueDex X.YY".',
    )
    return
  }
  const newVersion = versionMatch[0]
  const copyName = FILE_NAME_PATTERN.replace('{v}', newVersion)

  const currentMatch = ss.getName().match(VERSION_IN_NAME_RE)
  if (currentMatch && compareVersions(currentMatch[0], newVersion) >= 0) {
    const go = ui.alert(
      'Prepare Next Version',
      'The public sheet is still on ' +
        newVersion +
        ' and this sheet is ' +
        currentMatch[0] +
        ' — nothing newer to prepare.\n\nMake a copy of ' +
        newVersion +
        ' anyway?',
      ui.ButtonSet.YES_NO,
    )
    if (go !== ui.Button.YES) return
  }

  // Reuse an existing copy of that name if there is one (e.g. re-running after
  // a hiccup), unless the user wants a fresh one.
  let copy = null
  const existing = findExistingCopies(copyName)
  if (existing.length > 0) {
    const choice = ui.alert(
      'Prepare Next Version',
      'You already have a sheet named "' +
        copyName +
        '" (created ' +
        existing[0].getDateCreated().toLocaleString() +
        ').\n\n' +
        'YES — use it (only if you have NOT pushed your code to it yet)\n' +
        'NO — make a brand-new copy alongside it\n' +
        'CANCEL — stop',
      ui.ButtonSet.YES_NO_CANCEL,
    )
    if (choice === ui.Button.CANCEL || choice === ui.Button.CLOSE) return
    if (choice === ui.Button.YES) copy = existing[0]
  }

  if (!copy) {
    ss.toast('Copying "' + publicName + '"…', 'Prepare Next Version', -1)
    copy = publicFile.makeCopy(copyName)
  }

  ss.toast("Finding the copy's script…", 'Prepare Next Version', -1)
  const scriptId = findBoundScriptId(copy.getId())
  ss.toast('', 'Ready', 3)

  showPrepareDialog(ui, {
    copyName: copyName,
    copyUrl: copy.getUrl(),
    scriptId: scriptId,
    version: newVersion,
  })
}

/** Non-trashed spreadsheets with exactly this name (newest first). */
function findExistingCopies(name) {
  const it = DriveApp.searchFiles(
    "title = '" +
      name.replace(/'/g, "\\'") +
      "' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false",
  )
  const out = []
  while (it.hasNext()) out.push(it.next())
  out.sort((a, b) => b.getDateCreated() - a.getDateCreated())
  return out
}

/**
 * The Script ID of the container-bound script inside a spreadsheet, via the
 * Drive advanced service (bound scripts are hidden Drive files whose parent is
 * the container). Returns null if none is visible, in which case the dialog
 * falls back to asking for the editor URL.
 * @param {string} sheetId
 * @return {string|null}
 */
function findBoundScriptId(sheetId) {
  try {
    const res = Drive.Files.list({
      q:
        "'" +
        sheetId +
        "' in parents and mimeType = 'application/vnd.google-apps.script' and trashed = false",
      fields: 'files(id,name,createdTime)',
      pageSize: 10,
    })
    const files = (res && res.files) || []
    if (files.length === 0) {
      Logger.log('findBoundScriptId: no bound script visible for ' + sheetId)
      return null
    }
    if (files.length > 1) {
      Logger.log(
        'findBoundScriptId: several scripts on ' +
          sheetId +
          ': ' +
          files.map((f) => f.id + ' (' + f.name + ')').join(', ') +
          ' — using the first',
      )
    }
    return files[0].id
  } catch (e) {
    Logger.log('findBoundScriptId failed: ' + e.message)
    return null
  }
}

/**
 * The dialog that hands off to the terminal. Shows the command with a copy
 * button when the Script ID was found; otherwise links the copy and explains
 * how to get the ID (paste the editor URL — the CLI extracts it).
 */
function showPrepareDialog(ui, info) {
  const esc = (s) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/"/g, '&quot;')
  const command = info.scriptId
    ? 'npm run update -- ' + info.scriptId
    : 'npm run update -- <paste the Apps Script editor URL here>'

  const html =
    '<style>' +
    'body{font:14px/1.5 Roboto,Arial,sans-serif;margin:16px;color:#202124}' +
    'h3{margin:0 0 6px;font-size:15px}' +
    'p{margin:6px 0}' +
    '.cmd{display:flex;gap:6px;margin:10px 0}' +
    '.cmd input{flex:1;font:13px Menlo,Consolas,monospace;padding:6px 8px;border:1px solid #dadce0;border-radius:4px}' +
    'button{font:13px Roboto,Arial,sans-serif;padding:6px 12px;border-radius:4px;border:1px solid #dadce0;background:#fff;cursor:pointer}' +
    'button.primary{background:#1a73e8;color:#fff;border-color:#1a73e8}' +
    '.warn{background:#fef7e0;border-left:3px solid #f9ab00;padding:8px 10px;margin:10px 0}' +
    'ol{padding-left:20px;margin:6px 0}' +
    '.muted{color:#5f6368;font-size:12px}' +
    '</style>' +
    '<h3>Copy made: ' +
    esc(info.copyName) +
    '</h3>' +
    '<p><a href="' +
    esc(info.copyUrl) +
    '" target="_blank">Open the new sheet</a> · version ' +
    esc(info.version) +
    '</p>' +
    (info.scriptId
      ? '<p>Now run this in the repo:</p>'
      : '<div class="warn">Couldn\'t look up the copy\'s Script ID automatically. ' +
        'Open the new sheet → <b>Extensions → Apps Script</b>, copy the browser URL of the editor, ' +
        'and paste it in place of the placeholder — the command extracts the ID from it.</div>') +
    '<div class="cmd"><input id="cmd" readonly value="' +
    esc(command) +
    '"><button class="primary" onclick="copyCmd()">Copy</button></div>' +
    '<p class="muted" id="status">&nbsp;</p>' +
    "<p>That command merges the creator's new code with yours and pushes it to the copy. " +
    'When it finishes, open the new sheet and run <b>RogueDex Functions → Finish Setup</b>.</p>' +
    '<script>' +
    'function copyCmd(){var i=document.getElementById("cmd");i.select();i.setSelectionRange(0,99999);' +
    'var ok=false;try{ok=document.execCommand("copy")}catch(e){}' +
    'if(navigator.clipboard){navigator.clipboard.writeText(i.value).then(function(){done(true)},function(){done(ok)})}else{done(ok)}}' +
    'function done(ok){document.getElementById("status").textContent=ok?"Copied — paste it into your terminal.":"Select the text and copy it manually."}' +
    '</script>'

  ui.showModalDialog(
    HtmlService.createHtmlOutput(html).setWidth(520).setHeight(280),
    'Prepare Next Version',
  )
}

/**
 * The newest of your "Offline RogueDex X.YY" copies whose version is lower
 * than `destVersion` — i.e. the sheet Finish Setup should migrate from.
 * Ignores the creator's PUBLIC_ file and trashed files.
 * @param {string} destVersion
 * @return {string|null}
 */
function detectPreviousVersion(destVersion) {
  const it = DriveApp.searchFiles(
    "title contains 'Offline RogueDex' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false",
  )
  let best = null
  while (it.hasNext()) {
    const m = it.next().getName().match(COPY_NAME_RE)
    if (!m) continue
    const v = m[1]
    if (compareVersions(v, destVersion) >= 0) continue
    if (!best || compareVersions(v, best) > 0) best = v
  }
  return best
}

/** Numeric compare of "major.minor" strings: negative, zero, positive. */
function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d !== 0) return d
  }
  return 0
}
