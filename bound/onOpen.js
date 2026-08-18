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

  OfflineDexLib.nudgeFinishSetupIfFresh()

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

/** Menu (run in the OLD sheet): copy the public sheet + hand off to the CLI. */
function prepareNextVersion() {
  OfflineDexLib.prepareNextVersion()
}

/**
 * Menu (run in the NEW sheet): migrate from the previous version, then open
 * the upload dialog so the save load happens in the same sitting. The dialog
 * is opened here (not in the library) because UploadPlayerData.html lives in
 * this bound project.
 */
function finishSetup() {
  if (OfflineDexLib.finishSetup()) openUploadDialog()
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
