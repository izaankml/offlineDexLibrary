function onOpen() {
  ScriptApp.requireAllScopes(ScriptApp.AuthMode.FULL)

  SpreadsheetApp.getUi()
    .createMenu('RogueDex Functions')
    .addItem('Upload Data', 'openUploadDialog')
    .addItem('Upload Data (Keep Baseline)', 'openUploadDialogKeepBaseline')
    .addSeparator()
    .addItem('Snapshot Data', 'snapshot')
    .addItem('Highlight Changes', 'highlightChanges')
    .addItem('Clear Highlights', 'clearHighlights')
    .addSeparator()
    .addItem('Finish Setup (Migrate + Upload)', 'finishSetup')
    .addItem('Prepare Next Version', 'prepareNextVersion')
    .addToUi()

  SpreadsheetApp.getUi()
    .createMenu('Manually Update Database')
    .addItem('Update the sheet manually', 'forceUpdate')
    .addToUi()

  nudgeFinishSetupIfFresh()

  const ss = SpreadsheetApp.getActiveSpreadsheet()
  const directions = ss.getSheetByName('DIRECTIONS')
  const autoupdate = directions.getRange('D51').getValue()

  if (autoupdate) {
    forceUpdate(true)
  }
}

// ============================================================
// VERSION UPDATE ENTRY POINTS
//
// A version update is three touches — see UPDATING.md:
//   1. old sheet:  Prepare Next Version  → copies the public sheet, hands you
//                  the `npm run update -- <scriptId>` command
//   2. terminal:   that command merges creator code with yours and pushes it
//   3. new sheet:  Finish Setup → migrates from the previous version, then
//                  opens the upload dialog
// ============================================================

/** Set once Finish Setup has run in this copy; keyed to the source version. */
const MIGRATED_FROM_PROPERTY = 'OFFLINEDEX_MIGRATED_FROM'

/**
 * On open: if this copy has never been migrated and has no snapshot sheets
 * yet (i.e. it's a fresh copy that just received the code), point at Finish
 * Setup. Silent on sheets that are already set up.
 */
function nudgeFinishSetupIfFresh() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet()
    const props = PropertiesService.getDocumentProperties()
    if (props.getProperty(MIGRATED_FROM_PROPERTY)) return
    if (ss.getSheetByName('_snapshot_QuickChecklist')) return
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

/** Menu (run in the OLD sheet): copy the public sheet + hand off to the CLI. */
function prepareNextVersion() {
  OfflineDexLib.prepareNextVersion()
}

/**
 * Menu (run in the NEW sheet): migrate customizations from the previous
 * version — auto-detected from your Drive, one confirm — then open the
 * upload dialog so the save load happens in the same sitting.
 */
function finishSetup() {
  const ui = SpreadsheetApp.getUi()
  const ss = SpreadsheetApp.getActiveSpreadsheet()

  const destMatch = ss.getName().match(/\d+\.\d+/)
  if (!destMatch) {
    ui.alert(
      'Could not determine this sheet\'s version from its name "' +
        ss.getName() +
        '". Expected "Offline RogueDex X.YY".',
    )
    return
  }
  const destVersion = destMatch[0]

  const already = PropertiesService.getDocumentProperties().getProperty(
    MIGRATED_FROM_PROPERTY,
  )
  if (already) {
    const again = ui.alert(
      'Finish Setup',
      'This sheet was already migrated from ' +
        already +
        '. Run the migration again?',
      ui.ButtonSet.YES_NO,
    )
    if (again !== ui.Button.YES) return
  }

  let sourceVersion = OfflineDexLib.detectPreviousVersion(destVersion)
  if (sourceVersion) {
    const choice = ui.alert(
      'Finish Setup',
      'Migrate your customizations from Offline RogueDex ' +
        sourceVersion +
        ' into this ' +
        destVersion +
        ' sheet?\n\n' +
        "Takes a couple of minutes; the upload dialog opens when it's done.\n" +
        '(NO to type a different source version.)',
      ui.ButtonSet.YES_NO_CANCEL,
    )
    if (choice === ui.Button.CANCEL || choice === ui.Button.CLOSE) return
    if (choice === ui.Button.NO) sourceVersion = null
  }

  if (!sourceVersion) {
    const response = ui.prompt(
      'Finish Setup',
      'Version you are migrating from (e.g. 6.01):',
      ui.ButtonSet.OK_CANCEL,
    )
    if (response.getSelectedButton() !== ui.Button.OK) return
    sourceVersion = response.getResponseText().trim()
    if (!sourceVersion.match(/^\d+\.\d+$/)) {
      ui.alert(
        '"' +
          sourceVersion +
          '" doesn\'t look like a version number. Expected format: X.YY',
      )
      return
    }
  }

  OfflineDexLib.portAll(sourceVersion, destVersion)
  PropertiesService.getDocumentProperties().setProperty(
    MIGRATED_FROM_PROPERTY,
    sourceVersion,
  )
  openUploadDialog()
}

// ============================================================
// UPLOAD ENTRY POINTS
//
// The upload dialog (UploadPlayerData.html) always calls uploadFile(), so the
// choice of post-upload flow is stashed in a document property here and read
// back in uploadFile. Both menu items set it, so it can't go stale.
// ============================================================
const SKIP_SNAPSHOT_PROPERTY = 'OFFLINEDEX_SKIP_SNAPSHOT'

/** Normal upload: highlight changes, then snapshot as the new baseline. */
function openUploadDialog() {
  PropertiesService.getDocumentProperties().deleteProperty(
    SKIP_SNAPSHOT_PROPERTY,
  )
  openAttachmentDialog()
}

/**
 * Upload without the trailing snapshot: changes are highlighted against the
 * current baseline, which stays in place so the next upload still diffs
 * against it.
 */
function openUploadDialogKeepBaseline() {
  PropertiesService.getDocumentProperties().setProperty(
    SKIP_SNAPSHOT_PROPERTY,
    'true',
  )
  openAttachmentDialog()
}

// ============================================================
// LIBRARY WRAPPERS - menu items can't call library functions
// directly, so these forward to OfflineDexLib.
// ============================================================
function snapshot() {
  OfflineDexLib.snapshot()
}
function highlightChanges() {
  OfflineDexLib.highlightChanges()
}
function clearHighlights() {
  OfflineDexLib.clearHighlights()
}

// ============================================================
// EXISTING FUNCTIONS (unchanged from creator's original)
// ============================================================
function checkVersion() {
  const ss = SpreadsheetApp.getActiveSpreadsheet()
  const quickSheet = ss.getSheetByName('Quick Checklist')
  const quickValue = quickSheet.getRange('A1').getValue()

  const versionSheet = ss.getSheetByName('STATIC:VERSION')
  const versionValue = versionSheet.getRange('A1').getValue()
  const loadedValue = versionSheet.getRange('A6').getValue()

  if ('POKEROGUE DEX ' + loadedValue === versionValue) {
    Logger.log('loaded')
    if (quickValue !== versionValue) {
      Logger.log('message')
      Browser.msgBox(`There is a new version available.\\n
        Go to the original link and re-copy the PUBLIC sheet.\\n
        Your version: ${quickValue}\\n
        New Version: ${versionValue}`)
    }
  }

  Logger.log('end')
}

function htmlmodalDialog(title, text, close) {
  var htmlText = '<div>' + text + '</div>'
  htmlText += '<style type="text/css">'
  htmlText +=
    'body{text-align: center; font-family: Roboto, Arial, sans-serif; font-size: 14px;}'
  htmlText += 'div{margin: auto;}'
  htmlText += '</style>'
  if (close) {
    htmlText += '<script>google.script.host.close();</script>'
  }
  var htmlOutput = HtmlService.createHtmlOutput(htmlText)
    .setHeight(60)
    .setWidth(200)
  try {
    SpreadsheetApp.getUi().showModalDialog(htmlOutput, title)
  } catch (e) {
    Logger.log('function htmlmodalDialog(title, text, close)')
    Logger.log(e)
  }
}
