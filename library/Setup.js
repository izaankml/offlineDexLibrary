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
 * Mirrors PUBLIC_SHEET_FILE_ID in scripts/update.ts.
 */
const PUBLIC_SHEET_FILE_ID = '1peZNMRqicwfGAMYYJq6aeA13_1ZFVKvl--_gVQOdfv0'

/** Your copies: "Offline RogueDex X.YY". Same pattern as FILE_NAME_PATTERN. */
const COPY_NAME_RE = /^Offline RogueDex (\d+\.\d+)$/
const VERSION_IN_NAME_RE = /\d+\.\d+/

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
    // Land the copy next to the sheet this runs from (e.g. your PokeRogue
    // folder) rather than in My Drive root.
    const folder = firstParentFolder(ss.getId())
    copy = folder
      ? publicFile.makeCopy(copyName, folder)
      : publicFile.makeCopy(copyName)
  }

  ss.toast("Finding the copy's script…", 'Prepare Next Version', -1)
  const lookup = findBoundScriptId(copy.getId())
  ss.toast('', 'Ready', 3)

  showPrepareDialog(ui, {
    copyName: copyName,
    copyUrl: copy.getUrl(),
    scriptId: lookup.id,
    diag: lookup.diag,
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
 * The Script ID of the container-bound script inside a spreadsheet. Bound
 * scripts are hidden Drive files whose parent is the container; which Drive
 * API surface exposes them has changed over the years, so try several:
 *   1. Drive v3 files.list, `'<sheetId>' in parents`
 *   2. Drive v2 files.list, same query (REST via UrlFetch)
 *   3. Drive v2 children.list on the sheet
 * Returns {id, diag} — id null if nothing worked; diag is a short log of what
 * each attempt returned, shown in the dialog fallback so the failure is
 * self-explaining.
 * @param {string} sheetId
 * @return {{id: (string|null), diag: string}}
 */
function findBoundScriptId(sheetId) {
  const SCRIPT_MIME = 'application/vnd.google-apps.script'
  const q = "'" + sheetId + "' in parents and mimeType = '" + SCRIPT_MIME + "'"
  const diag = []
  const pick = (files, label) => {
    if (!files || files.length === 0) {
      diag.push(label + ': 0 results')
      return null
    }
    diag.push(
      label + ': ' + files.length + ' → ' + files.map((f) => f.id).join(','),
    )
    return files[0].id
  }

  // 1. Advanced Drive service (v3)
  try {
    const res = Drive.Files.list({
      q: q,
      fields: 'files(id,name)',
      pageSize: 10,
    })
    const id = pick(res && res.files, 'v3 files.list')
    if (id) return { id: id, diag: diag.join('; ') }
  } catch (e) {
    diag.push('v3 files.list: ERR ' + e.message)
  }

  // 2 + 3. Drive v2 via REST with this script's OAuth token
  const token = ScriptApp.getOAuthToken()
  const restGet = (url, label) => {
    try {
      const resp = UrlFetchApp.fetch(url, {
        headers: { Authorization: 'Bearer ' + token },
        muteHttpExceptions: true,
      })
      const code = resp.getResponseCode()
      if (code !== 200) {
        diag.push(label + ': HTTP ' + code)
        return null
      }
      return JSON.parse(resp.getContentText())
    } catch (e) {
      diag.push(label + ': ERR ' + e.message)
      return null
    }
  }

  const v2 = restGet(
    'https://www.googleapis.com/drive/v2/files?q=' +
      encodeURIComponent(q) +
      '&fields=items(id,title)&maxResults=10',
    'v2 files.list',
  )
  if (v2) {
    const id = pick(v2.items, 'v2 files.list')
    if (id) return { id: id, diag: diag.join('; ') }
  }

  const children = restGet(
    'https://www.googleapis.com/drive/v2/files/' +
      encodeURIComponent(sheetId) +
      '/children?maxResults=100&fields=items(id)',
    'v2 children.list',
  )
  if (children && children.items && children.items.length) {
    // children.list gives bare IDs; check each one's mimeType.
    const scripts = []
    children.items.forEach((c) => {
      const meta = restGet(
        'https://www.googleapis.com/drive/v2/files/' +
          encodeURIComponent(c.id) +
          '?fields=id,title,mimeType',
        'v2 files.get ' + c.id,
      )
      if (meta && meta.mimeType === SCRIPT_MIME) scripts.push(meta)
    })
    const id = pick(scripts, 'v2 children.list')
    if (id) return { id: id, diag: diag.join('; ') }
  } else if (children) {
    diag.push('v2 children.list: 0 results')
  }

  Logger.log('findBoundScriptId(' + sheetId + '): ' + diag.join('; '))
  return { id: null, diag: diag.join('; ') }
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
        'and paste it in place of the placeholder — the command extracts the ID from it.' +
        '<div class="muted" style="margin-top:6px">Lookup details: ' +
        esc(info.diag || '(none)') +
        '</div></div>') +
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
    HtmlService.createHtmlOutput(html).setWidth(520).setHeight(320),
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
