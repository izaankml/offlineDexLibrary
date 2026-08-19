/**
 * SETUP — the Google-side half of a version update.
 *
 *   prepareNextVersion()      from your CURRENT sheet: copy the creator's
 *                             public sheet into Drive under the right name and
 *                             hand you the one terminal command.
 *   finishSetup()             from the NEW sheet: confirm the previous version
 *                             (auto-detected), run the migration, mark migrated.
 *                             Returns true when the migration ran cleanly so
 *                             the bound wrapper can open the upload dialog.
 *   nudgeFinishSetupIfFresh() on open: toast a pointer to Finish Setup when
 *                             this copy has never been migrated.
 *   detectPreviousVersion()   newest of your copies older than a version.
 */

import {
  COPY_NAME_RE,
  PUBLIC_SHEET_FILE_ID,
  compareVersions,
  copyName,
  versionFromName,
} from '../shared/naming.ts'
import {
  applyPlanWithProgress,
  describePlan,
  findSpreadsheetsNamed,
  formatResults,
  planForVersions,
} from './migrator.ts'
import { finishFlow, resetToastProgress, startStep } from './progress.ts'
import { TRACKER_SPECS, snapshotSheetName } from './saveTracker.ts'

/** Set once Finish Setup has run cleanly in a copy; holds the source version. */
export const MIGRATED_FROM_PROPERTY = 'OFFLINEDEX_MIGRATED_FROM'

/**
 * Menu (run from your CURRENT sheet). Copies the creator's public sheet into
 * your Drive as "Offline RogueDex <new>" and shows a dialog that turns the
 * copy's Apps Script editor URL into the exact terminal command to run next.
 */
export function prepareNextVersion(): void {
  const ui = SpreadsheetApp.getUi()
  const ss = SpreadsheetApp.getActiveSpreadsheet()

  let publicFile: GoogleAppsScript.Drive.File
  try {
    publicFile = DriveApp.getFileById(PUBLIC_SHEET_FILE_ID)
  } catch (e) {
    ui.alert(
      `Couldn't open the creator's public sheet (${PUBLIC_SHEET_FILE_ID}). If the creator moved it, update PUBLIC_SHEET_FILE_ID in src/shared/naming.ts.\n\n${e instanceof Error ? e.message : e}`,
    )
    return
  }

  const publicName = publicFile.getName()
  const newVersion = versionFromName(publicName)
  if (!newVersion) {
    ui.alert(
      `The public sheet is named "${publicName}" — no version number in it, so I can't name your copy. Copy it by hand and name it "Offline RogueDex X.YY".`,
    )
    return
  }
  const newCopyName = copyName(newVersion)

  const currentVersion = versionFromName(ss.getName())
  if (currentVersion && compareVersions(currentVersion, newVersion) >= 0) {
    const go = ui.alert(
      'Prepare Next Version',
      `The public sheet is still on ${newVersion} and this sheet is ${currentVersion} — nothing newer to prepare.\n\nMake a copy of ${newVersion} anyway?`,
      ui.ButtonSet.YES_NO,
    )
    if (go !== ui.Button.YES) return
  }

  let copy: GoogleAppsScript.Drive.File | null = null
  const existing = findExistingCopies(newCopyName)
  if (existing.length > 0) {
    const choice = ui.alert(
      'Prepare Next Version',
      `You already have a sheet named "${newCopyName}" (created ${existing[0]!.getDateCreated().toLocaleString()}).\n\n` +
        'YES — use it (only if you have NOT pushed your code to it yet)\n' +
        'NO — make a brand-new copy alongside it\n' +
        'CANCEL — stop',
      ui.ButtonSet.YES_NO_CANCEL,
    )
    if (choice === ui.Button.CANCEL || choice === ui.Button.CLOSE) return
    if (choice === ui.Button.YES) copy = existing[0]!
  }

  if (!copy) {
    ss.toast(`Copying "${publicName}"…`, 'Prepare Next Version', -1)
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
function firstParentFolder(
  fileId: string,
): GoogleAppsScript.Drive.Folder | null {
  try {
    const parents = DriveApp.getFileById(fileId).getParents()
    return parents.hasNext() ? parents.next() : null
  } catch (e) {
    Logger.log('firstParentFolder: ' + (e instanceof Error ? e.message : e))
    return null
  }
}

/** Non-trashed spreadsheets with exactly this name (newest-created first). */
function findExistingCopies(name: string): GoogleAppsScript.Drive.File[] {
  const out = findSpreadsheetsNamed(name)
  out.sort(
    (a, b) => b.getDateCreated().getTime() - a.getDateCreated().getTime(),
  )
  return out
}

/** HTML for the hand-off dialog (pure; tested for the Script-ID extraction). */
export function prepareDialogHtml(info: {
  copyName: string
  copyUrl: string
  version: string
}): string {
  const esc = (s: string): string =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/"/g, '&quot;')
  return (
    '<style>' +
    'body{font:14px/1.5 Roboto,Arial,sans-serif;margin:16px;color:#202124}' +
    'h3{margin:0 0 6px;font-size:15px}p{margin:6px 0}ol{padding-left:20px;margin:6px 0}li{margin:3px 0}' +
    'input{width:100%;box-sizing:border-box;font:13px Menlo,Consolas,monospace;padding:6px 8px;border:1px solid #dadce0;border-radius:4px}' +
    '.row{display:flex;gap:6px;align-items:center;margin:8px 0}.row input{flex:1}' +
    'button{font:13px Roboto,Arial,sans-serif;padding:6px 12px;border-radius:4px;border:1px solid #dadce0;background:#fff;cursor:pointer;white-space:nowrap}' +
    'button.primary{background:#1a73e8;color:#fff;border-color:#1a73e8}button:disabled{opacity:.5;cursor:default}' +
    '.muted{color:#5f6368;font-size:12px}' +
    '</style>' +
    `<h3>Copy ready: ${esc(info.copyName)}</h3>` +
    '<ol>' +
    `<li><a href="${esc(info.copyUrl)}" target="_blank">Open the new sheet</a>, then <b>Extensions → Apps Script</b>.</li>` +
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
  )
}

function showPrepareDialog(
  ui: GoogleAppsScript.Base.Ui,
  info: { copyName: string; copyUrl: string; version: string },
): void {
  ui.showModalDialog(
    HtmlService.createHtmlOutput(prepareDialogHtml(info))
      .setWidth(560)
      .setHeight(330),
    'Prepare Next Version',
  )
}

/**
 * On open: if this copy has never been migrated and has no snapshot sheets
 * yet, toast a pointer to Finish Setup. Silent otherwise.
 */
export function nudgeFinishSetupIfFresh(): void {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet()
    const props = PropertiesService.getDocumentProperties()
    if (props.getProperty(MIGRATED_FROM_PROPERTY)) return
    if (ss.getSheetByName(snapshotSheetName(TRACKER_SPECS[0]!.key))) return
    ss.toast(
      'This looks like a fresh copy. Run RogueDex Functions → Finish Setup to bring over your customizations and load your save.',
      'New version',
      15,
    )
  } catch (e) {
    Logger.log(
      'nudgeFinishSetupIfFresh: ' + (e instanceof Error ? e.message : e),
    )
  }
}

/**
 * Menu (run in the NEW sheet): migrate customizations from the previous
 * version — auto-detected from your Drive, one confirm — and mark this copy
 * as migrated. Returns true only when every migration step succeeded (so the
 * bound wrapper opens the upload dialog); on any ERR the steps are shown in an
 * alert, the copy is NOT marked migrated, and false is returned.
 */
export function finishSetup(): boolean {
  const ui = SpreadsheetApp.getUi()
  const ss = SpreadsheetApp.getActiveSpreadsheet()

  const destVersion = versionFromName(ss.getName())
  if (!destVersion) {
    ui.alert(
      `Could not determine this sheet's version from its name "${ss.getName()}". Expected "${copyName('X.YY')}".`,
    )
    return false
  }

  const props = PropertiesService.getDocumentProperties()
  const already = props.getProperty(MIGRATED_FROM_PROPERTY)
  if (already) {
    const again = ui.alert(
      'Finish Setup',
      `This sheet was already migrated from ${already}. Run the migration again?`,
      ui.ButtonSet.YES_NO,
    )
    if (again !== ui.Button.YES) return false
  }

  let sourceVersion: string | null = detectPreviousVersion(destVersion)
  if (sourceVersion) {
    const choice = ui.alert(
      'Finish Setup',
      `Migrate your customizations from ${copyName(sourceVersion)} into this ${destVersion} sheet?\n\n` +
        "You'll see the exact list of changes before anything is applied.\n(NO to type a different source version.)",
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
        `"${sourceVersion}" doesn't look like a version number. Expected format: X.YY`,
      )
      return false
    }
  }

  // Plan first (reads only). A layout that doesn't fit stops here, before anything is written.
  resetToastProgress('migration')
  startStep(ss, 'Planning migration')
  let plan
  try {
    plan = planForVersions(sourceVersion, destVersion)
  } catch (e) {
    finishFlow(ss, 'Migration not started', 10)
    ui.alert(
      'Finish Setup: cannot migrate',
      `The layout check failed, so nothing was changed:\n\n${e instanceof Error ? e.message : e}\n\nSee UPDATING.md → Caveats.`,
      ui.ButtonSet.OK,
    )
    return false
  }
  const go = ui.alert(
    `Finish Setup: ${copyName(sourceVersion)} → ${destVersion}`,
    `These changes will be applied in one atomic update:\n\n${describePlan(plan)}\n\nProceed?`,
    ui.ButtonSet.YES_NO,
  )
  if (go !== ui.Button.YES) {
    finishFlow(ss, 'Migration cancelled', 5)
    return false
  }

  const results = applyPlanWithProgress(plan)
  const failed = results.filter((r) => !r.ok)
  if (failed.length) {
    ui.alert(
      'Finish Setup: migration failed',
      `The update was rejected as a whole, so the sheet is unchanged. This copy has NOT been marked as migrated.\n\n${failed[0]!.error}\n\n${formatResults(results)}`,
      ui.ButtonSet.OK,
    )
    return false
  }
  props.setProperty(MIGRATED_FROM_PROPERTY, sourceVersion)
  return true
}

/**
 * The newest of your "Offline RogueDex X.YY" copies whose version is lower
 * than `destVersion`. Ignores the creator's PUBLIC_ file and trashed files.
 */
export function detectPreviousVersion(destVersion: string): string | null {
  const it = DriveApp.searchFiles(
    "title contains 'Offline RogueDex' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false",
  )
  const names: string[] = []
  while (it.hasNext()) names.push(it.next().getName())
  return newestVersionBelow(names, destVersion)
}

/** Pure core of detectPreviousVersion (tested). */
export function newestVersionBelow(
  names: string[],
  destVersion: string,
): string | null {
  let best: string | null = null
  for (const name of names) {
    const m = name.match(COPY_NAME_RE)
    if (!m) continue
    const v = m[1]!
    if (compareVersions(v, destVersion) >= 0) continue
    if (!best || compareVersions(v, best) > 0) best = v
  }
  return best
}
