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
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet()

  let publicFile: GoogleAppsScript.Drive.File
  try {
    publicFile = DriveApp.getFileById(PUBLIC_SHEET_FILE_ID)
  } catch (error) {
    ui.alert(
      `Couldn't open the creator's public sheet (${PUBLIC_SHEET_FILE_ID}). If the creator moved it, update PUBLIC_SHEET_FILE_ID in src/shared/naming.ts.\n\n${error instanceof Error ? error.message : error}`,
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

  const currentVersion = versionFromName(spreadsheet.getName())
  if (currentVersion && compareVersions(currentVersion, newVersion) >= 0) {
    const copyAnyway = ui.alert(
      'Prepare Next Version',
      `The public sheet is still on ${newVersion} and this sheet is ${currentVersion} — nothing newer to prepare.\n\nMake a copy of ${newVersion} anyway?`,
      ui.ButtonSet.YES_NO,
    )
    if (copyAnyway !== ui.Button.YES) return
  }

  let copy: GoogleAppsScript.Drive.File | null = null
  const existingCopies = findExistingCopies(newCopyName)
  if (existingCopies.length > 0) {
    const choice = ui.alert(
      'Prepare Next Version',
      `You already have a sheet named "${newCopyName}" (created ${existingCopies[0]!.getDateCreated().toLocaleString()}).\n\n` +
        'YES — use it (only if you have NOT pushed your code to it yet)\n' +
        'NO — make a brand-new copy alongside it\n' +
        'CANCEL — stop',
      ui.ButtonSet.YES_NO_CANCEL,
    )
    if (choice === ui.Button.CANCEL || choice === ui.Button.CLOSE) return
    if (choice === ui.Button.YES) copy = existingCopies[0]!
  }

  if (!copy) {
    spreadsheet.toast(`Copying "${publicName}"…`, 'Prepare Next Version', -1)
    const folder = firstParentFolder(spreadsheet.getId())
    copy = folder
      ? publicFile.makeCopy(newCopyName, folder)
      : publicFile.makeCopy(newCopyName)
  }

  spreadsheet.toast('', 'Ready', 3)
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
  } catch (error) {
    Logger.log(
      'firstParentFolder: ' + (error instanceof Error ? error.message : error),
    )
    return null
  }
}

/** Non-trashed spreadsheets with exactly this name (newest-created first). */
function findExistingCopies(name: string): GoogleAppsScript.Drive.File[] {
  const copies = findSpreadsheetsNamed(name)
  copies.sort(
    (fileA, fileB) =>
      fileB.getDateCreated().getTime() - fileA.getDateCreated().getTime(),
  )
  return copies
}

/** HTML for the hand-off dialog (pure; tested for the Script-ID extraction). */
export function prepareDialogHtml(info: {
  copyName: string
  copyUrl: string
  version: string
}): string {
  const escapeHtml = (text: string): string =>
    String(text)
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
    `<h3>Copy ready: ${escapeHtml(info.copyName)}</h3>` +
    '<ol>' +
    `<li><a href="${escapeHtml(info.copyUrl)}" target="_blank">Open the new sheet</a>, then <b>Extensions → Apps Script</b>.</li>` +
    '<li>Copy the browser URL of the script editor and paste it below.</li>' +
    '<li>Copy the command and run it in the repo. When it finishes, open the new sheet and run <b>RogueDex Functions → Finish Setup</b>.</li>' +
    '</ol>' +
    '<div class="row"><input id="url" placeholder="https://script.google.com/…/projects/…/edit" oninput="build()"></div>' +
    '<div class="row"><input id="cmd" readonly placeholder="npm run update -- <script id>"><button class="primary" id="copy" onclick="copyCmd()" disabled>Copy</button></div>' +
    '<p class="muted" id="status">&nbsp;</p>' +
    '<script>' +
    'function build(){var url=document.getElementById("url").value.trim();' +
    'var match=url.match(/\\/projects\\/([A-Za-z0-9_-]{20,})/)||url.match(/[?&]scriptId=([A-Za-z0-9_-]{20,})/)||url.match(/^([A-Za-z0-9_-]{20,})$/);' +
    'var cmd=document.getElementById("cmd"),copyButton=document.getElementById("copy"),status=document.getElementById("status");' +
    'if(match){cmd.value="npm run update -- "+match[1];copyButton.disabled=false;status.textContent="Ready to copy.";}' +
    'else{cmd.value="";copyButton.disabled=true;status.textContent=url?"That doesn\'t contain a Script ID yet.":"";}}' +
    'function copyCmd(){var cmd=document.getElementById("cmd");cmd.select();cmd.setSelectionRange(0,99999);' +
    'var copied=false;try{copied=document.execCommand("copy")}catch(e){}' +
    'if(navigator.clipboard){navigator.clipboard.writeText(cmd.value).then(function(){done(true)},function(){done(copied)})}else{done(copied)}}' +
    'function done(copied){document.getElementById("status").textContent=copied?"Copied — paste it into your terminal.":"Select the command and copy it manually."}' +
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
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet()
    const docProps = PropertiesService.getDocumentProperties()
    if (docProps.getProperty(MIGRATED_FROM_PROPERTY)) return
    if (spreadsheet.getSheetByName(snapshotSheetName(TRACKER_SPECS[0]!.key)))
      return
    spreadsheet.toast(
      'This looks like a fresh copy. Run RogueDex Functions → Finish Setup to bring over your customizations and load your save.',
      'New version',
      15,
    )
  } catch (error) {
    Logger.log(
      'nudgeFinishSetupIfFresh: ' +
        (error instanceof Error ? error.message : error),
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
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet()

  const destVersion = versionFromName(spreadsheet.getName())
  if (!destVersion) {
    ui.alert(
      `Could not determine this sheet's version from its name "${spreadsheet.getName()}". Expected "${copyName('X.YY')}".`,
    )
    return false
  }

  const docProps = PropertiesService.getDocumentProperties()
  const alreadyMigratedFrom = docProps.getProperty(MIGRATED_FROM_PROPERTY)
  if (alreadyMigratedFrom) {
    const runAgain = ui.alert(
      'Finish Setup',
      `This sheet was already migrated from ${alreadyMigratedFrom}. Run the migration again?`,
      ui.ButtonSet.YES_NO,
    )
    if (runAgain !== ui.Button.YES) return false
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
  startStep(spreadsheet, 'Planning migration')
  let plan
  try {
    plan = planForVersions(sourceVersion, destVersion)
  } catch (error) {
    finishFlow(spreadsheet, 'Migration not started', 10)
    ui.alert(
      'Finish Setup: cannot migrate',
      `The layout check failed, so nothing was changed:\n\n${error instanceof Error ? error.message : error}\n\nSee UPDATING.md → Caveats.`,
      ui.ButtonSet.OK,
    )
    return false
  }
  const proceed = ui.alert(
    `Finish Setup: ${copyName(sourceVersion)} → ${destVersion}`,
    `These changes will be applied in one atomic update:\n\n${describePlan(plan)}\n\nProceed?`,
    ui.ButtonSet.YES_NO,
  )
  if (proceed !== ui.Button.YES) {
    finishFlow(spreadsheet, 'Migration cancelled', 5)
    return false
  }

  const stepResults = applyPlanWithProgress(plan)
  const failedSteps = stepResults.filter((result) => !result.ok)
  if (failedSteps.length) {
    ui.alert(
      'Finish Setup: migration failed',
      `The update was rejected as a whole, so the sheet is unchanged. This copy has NOT been marked as migrated.\n\n${failedSteps[0]!.error}\n\n${formatResults(stepResults)}`,
      ui.ButtonSet.OK,
    )
    return false
  }
  docProps.setProperty(MIGRATED_FROM_PROPERTY, sourceVersion)
  return true
}

/**
 * The newest of your "Offline RogueDex X.YY" copies whose version is lower
 * than `destVersion`. Ignores the creator's PUBLIC_ file and trashed files.
 */
export function detectPreviousVersion(destVersion: string): string | null {
  const fileIterator = DriveApp.searchFiles(
    "title contains 'Offline RogueDex' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false",
  )
  const fileNames: string[] = []
  while (fileIterator.hasNext()) fileNames.push(fileIterator.next().getName())
  return newestVersionBelow(fileNames, destVersion)
}

/** Pure core of detectPreviousVersion (tested). */
export function newestVersionBelow(
  names: string[],
  destVersion: string,
): string | null {
  let newest: string | null = null
  for (const name of names) {
    const match = name.match(COPY_NAME_RE)
    if (!match) continue
    const version = match[1]!
    if (compareVersions(version, destVersion) >= 0) continue
    if (!newest || compareVersions(version, newest) > 0) newest = version
  }
  return newest
}
