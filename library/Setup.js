// ============================================================
// SETUP MODULE (library file)
//
// The Google-side half of a version update:
//
//   prepareNextVersion()      — from your CURRENT sheet: copy the creator's
//                               public sheet into Drive under the right name
//                               and walk you to the one terminal command that
//                               finishes the job.
//   finishSetup()             — from the NEW sheet: confirm the previous
//                               version (auto-detected from Drive), run the
//                               migration, and mark this copy as migrated.
//                               Returns true when the migration ran so the
//                               bound wrapper can open the upload dialog.
//   nudgeFinishSetupIfFresh() — on open: toast a pointer to Finish Setup when
//                               this copy has never been migrated.
//   detectPreviousVersion()   — newest of your copies older than a version.
//
// Also the single home of the "Offline RogueDex X.YY" naming rules
// (copyName / versionFromName) used by Migrator and the bound script.
//
// Called via OfflineDexLib.<name> from the bound script's menu wrappers.
// ============================================================

/**
 * The creator publishes every version as the SAME Drive file, renamed on each
 * release (e.g. "PUBLIC_Offline RogueDex 6.03"). Reading its title tells us the
 * newest version; copying it gives a fresh copy with the creator's bound code.
 * Mirrors PUBLIC_SHEET_FILE_ID in scripts/update.ts.
 */
const PUBLIC_SHEET_FILE_ID = '1peZNMRqicwfGAMYYJq6aeA13_1ZFVKvl--_gVQOdfv0'

// ---------------------------------------------------------------------------
// Naming: your copies are "Offline RogueDex X.YY". These are mirrored (for a
// different runtime) by SHEET_NAME_RE / VERSION_RE in scripts/update.ts.
// ---------------------------------------------------------------------------
const COPY_NAME_PREFIX = 'Offline RogueDex '
const COPY_NAME_RE = /^Offline RogueDex (\d+\.\d+)$/
const VERSION_RE = /\d+\.\d+/

/** Set once Finish Setup has run in a copy; holds the source version. */
const MIGRATED_FROM_PROPERTY = 'OFFLINEDEX_MIGRATED_FROM'

/** "Offline RogueDex 6.03" for '6.03'. */
function copyName(version) {
  return COPY_NAME_PREFIX + version
}

/** The first "X.YY" in a sheet/file name, or null if there isn't one. */
function versionFromName(name) {
  const m = String(name).match(VERSION_RE)
  return m ? m[0] : null
}

/**
 * Menu (run from your CURRENT sheet). Copies the creator's public sheet into
 * your Drive as "Offline RogueDex <new>" and shows a dialog that turns the
 * copy's Apps Script editor URL into the exact terminal command to run next.
 */
function prepareNextVersion() {
  const ui = SpreadsheetApp.getUi()
  const ss = SpreadsheetApp.getActiveSpreadsheet()

  let publicFile
  try {
    publicFile = DriveApp.getFileById(PUBLIC_SHEET_FILE_ID)
  } catch (e) {
    ui.alert(
      "Couldn't open the creator's public sheet (" +
        PUBLIC_SHEET_FILE_ID +
        '). ' +
        'If the creator moved it, update PUBLIC_SHEET_FILE_ID in library/Setup.js.\n\n' +
        e.message,
    )
    return
  }

  const publicName = publicFile.getName()
  const newVersion = versionFromName(publicName)
  if (!newVersion) {
    ui.alert(
      'The public sheet is named "' +
        publicName +
        '" — no version number in it, so I can\'t name your copy. ' +
        'Copy it by hand and name it "Offline RogueDex X.YY".',
    )
    return
  }
  const newCopyName = copyName(newVersion)

  const currentVersion = versionFromName(ss.getName())
  if (currentVersion && compareVersions(currentVersion, newVersion) >= 0) {
    const go = ui.alert(
      'Prepare Next Version',
      'The public sheet is still on ' +
        newVersion +
        ' and this sheet is ' +
        currentVersion +
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
  const existing = findExistingCopies(newCopyName)
  if (existing.length > 0) {
    const choice = ui.alert(
      'Prepare Next Version',
      'You already have a sheet named "' +
        newCopyName +
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
    // Land the copy next to the sheet this runs from (e.g. your PokeRogue
    // folder) rather than in My Drive root.
    const folder = firstParentFolder(ss.getId())
    copy = folder
      ? publicFile.makeCopy(newCopyName, folder)
      : publicFile.makeCopy(newCopyName)
  }

  ss.toast('', 'Ready', 3)

  showPrepareDialog(ui, {
    copyName: newCopyName,
    copyUrl: copy.getUrl(),
    version: newVersion,
  })
}

/** The first Drive folder containing a file, or null if it's in root only. */
function firstParentFolder(fileId) {
  try {
    const parents = DriveApp.getFileById(fileId).getParents()
    return parents.hasNext() ? parents.next() : null
  } catch (e) {
    Logger.log('firstParentFolder: ' + e.message)
    return null
  }
}

/** Non-trashed spreadsheets with exactly this name (newest-created first). */
function findExistingCopies(name) {
  const out = findSpreadsheetsNamed(name)
  out.sort((a, b) => b.getDateCreated() - a.getDateCreated())
  return out
}

/**
 * The dialog that hands off to the terminal. Container-bound scripts are not
 * enumerable through the Drive API (verified 2026: v3/v2 files.list and
 * children.list all return nothing even with full Drive scope), so the copy's
 * Script ID has to come from you: open the copy → Extensions → Apps Script →
 * paste the editor URL here; the dialog turns it into the exact command and
 * copies it.
 */
function showPrepareDialog(ui, info) {
  const esc = (s) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/"/g, '&quot;')

  const html =
    '<style>' +
    'body{font:14px/1.5 Roboto,Arial,sans-serif;margin:16px;color:#202124}' +
    'h3{margin:0 0 6px;font-size:15px}' +
    'p{margin:6px 0}' +
    'ol{padding-left:20px;margin:6px 0}' +
    'li{margin:3px 0}' +
    'input{width:100%;box-sizing:border-box;font:13px Menlo,Consolas,monospace;padding:6px 8px;border:1px solid #dadce0;border-radius:4px}' +
    '.row{display:flex;gap:6px;align-items:center;margin:8px 0}' +
    '.row input{flex:1}' +
    'button{font:13px Roboto,Arial,sans-serif;padding:6px 12px;border-radius:4px;border:1px solid #dadce0;background:#fff;cursor:pointer;white-space:nowrap}' +
    'button.primary{background:#1a73e8;color:#fff;border-color:#1a73e8}' +
    'button:disabled{opacity:.5;cursor:default}' +
    '.muted{color:#5f6368;font-size:12px}' +
    '</style>' +
    '<h3>Copy ready: ' +
    esc(info.copyName) +
    '</h3>' +
    '<ol>' +
    '<li><a href="' +
    esc(info.copyUrl) +
    '" target="_blank">Open the new sheet</a>, then <b>Extensions → Apps Script</b>.</li>' +
    '<li>Copy the browser URL of the script editor and paste it below.</li>' +
    '<li>Copy the command and run it in the repo. When it finishes, open the new sheet and run <b>RogueDex Functions → Finish Setup</b>.</li>' +
    '</ol>' +
    '<div class="row"><input id="url" placeholder="https://script.google.com/…/projects/…/edit" oninput="build()"></div>' +
    '<div class="row"><input id="cmd" readonly placeholder="npm run update -- <script id>"><button class="primary" id="copy" onclick="copyCmd()" disabled>Copy</button></div>' +
    '<p class="muted" id="status">&nbsp;</p>' +
    '<script>' +
    'function build(){var u=document.getElementById("url").value.trim();' +
    'var m=u.match(/\\/projects\\/([A-Za-z0-9_-]{20,})/)||u.match(/[?&]scriptId=([A-Za-z0-9_-]{20,})/)||u.match(/^([A-Za-z0-9_-]{20,})$/);' +
    'var cmd=document.getElementById("cmd"),btn=document.getElementById("copy"),st=document.getElementById("status");' +
    'if(m){cmd.value="npm run update -- "+m[1];btn.disabled=false;st.textContent="Ready to copy.";}' +
    'else{cmd.value="";btn.disabled=true;st.textContent=u?"That doesn\'t contain a Script ID yet.":"";}}' +
    'function copyCmd(){var i=document.getElementById("cmd");i.select();i.setSelectionRange(0,99999);' +
    'var ok=false;try{ok=document.execCommand("copy")}catch(e){}' +
    'if(navigator.clipboard){navigator.clipboard.writeText(i.value).then(function(){done(true)},function(){done(ok)})}else{done(ok)}}' +
    'function done(ok){document.getElementById("status").textContent=ok?"Copied — paste it into your terminal.":"Select the command and copy it manually."}' +
    '</script>'

  ui.showModalDialog(
    HtmlService.createHtmlOutput(html).setWidth(560).setHeight(330),
    'Prepare Next Version',
  )
}

/**
 * On open: if this copy has never been migrated and has no snapshot sheets
 * yet (i.e. it's a fresh copy that just received the code), toast a pointer
 * to Finish Setup. Silent on sheets that are already set up.
 */
function nudgeFinishSetupIfFresh() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet()
    const props = PropertiesService.getDocumentProperties()
    if (props.getProperty(MIGRATED_FROM_PROPERTY)) return
    if (ss.getSheetByName('_snapshot_' + TRACKERS[0].key)) return
    ss.toast(
      'This looks like a fresh copy. Run RogueDex Functions → Finish Setup ' +
        'to bring over your customizations and load your save.',
      'New version',
      15,
    )
  } catch (e) {
    Logger.log('nudgeFinishSetupIfFresh: ' + e.message)
  }
}

/**
 * Menu (run in the NEW sheet): migrate customizations from the previous
 * version — auto-detected from your Drive, one confirm — and mark this copy
 * as migrated. Returns true when the migration ran, so the bound wrapper can
 * open the upload dialog (the dialog HTML lives in the bound project);
 * false when the user cancelled or the sheet name has no version.
 * @return {boolean}
 */
function finishSetup() {
  const ui = SpreadsheetApp.getUi()
  const ss = SpreadsheetApp.getActiveSpreadsheet()

  const destVersion = versionFromName(ss.getName())
  if (!destVersion) {
    ui.alert(
      'Could not determine this sheet\'s version from its name "' +
        ss.getName() +
        '". Expected "' +
        copyName('X.YY') +
        '".',
    )
    return false
  }

  const props = PropertiesService.getDocumentProperties()
  const already = props.getProperty(MIGRATED_FROM_PROPERTY)
  if (already) {
    const again = ui.alert(
      'Finish Setup',
      'This sheet was already migrated from ' +
        already +
        '. Run the migration again?',
      ui.ButtonSet.YES_NO,
    )
    if (again !== ui.Button.YES) return false
  }

  let sourceVersion = detectPreviousVersion(destVersion)
  if (sourceVersion) {
    const choice = ui.alert(
      'Finish Setup',
      'Migrate your customizations from ' +
        copyName(sourceVersion) +
        ' into this ' +
        destVersion +
        ' sheet?\n\n' +
        "Takes a couple of minutes; the upload dialog opens when it's done.\n" +
        '(NO to type a different source version.)',
      ui.ButtonSet.YES_NO_CANCEL,
    )
    if (choice === ui.Button.CANCEL || choice === ui.Button.CLOSE) return false
    if (choice === ui.Button.NO) sourceVersion = null
  }

  if (!sourceVersion) {
    const response = ui.prompt(
      'Finish Setup',
      'Version you are migrating from (e.g. 6.01):',
      ui.ButtonSet.OK_CANCEL,
    )
    if (response.getSelectedButton() !== ui.Button.OK) return false
    sourceVersion = response.getResponseText().trim()
    if (!/^\d+\.\d+$/.test(sourceVersion)) {
      ui.alert(
        '"' +
          sourceVersion +
          '" doesn\'t look like a version number. Expected format: X.YY',
      )
      return false
    }
  }

  portAll(sourceVersion, destVersion)
  props.setProperty(MIGRATED_FROM_PROPERTY, sourceVersion)
  return true
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
