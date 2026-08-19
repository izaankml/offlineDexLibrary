// ============================================================
// OFFLINEDEX BOUND GLUE — the only bound file that is ours.
//
// Everything the OfflineDex Library needs from inside the spreadsheet lives
// here: the menu, the tracked upload path, and thin wrappers for menu items
// (Apps Script menus can't call library functions directly). The creator's
// files (onOpen.js, LoadPlayerData.js, UploadPlayerData.html, ...) stay
// pristine except for the single `offlineDexOnOpen()` call in onOpen, so the
// per-version 3-way merge has (almost) nothing to conflict on.
//
// Every function here is prefixed `offlineDex` so it can never collide with
// a function the creator adds later.
// ============================================================

/**
 * Which post-upload flow the dialog should run. The upload dialog always
 * calls uploadFileTracked(), and it's a separate server execution, so the
 * choice is stashed in a document property by the menu item and consumed by
 * uploadFileTracked. Both entry points set it, so it can't go stale.
 */
const OFFLINEDEX_SKIP_SNAPSHOT_PROPERTY = 'OFFLINEDEX_SKIP_SNAPSHOT'

/** Called from onOpen(): build the menu, then nudge if this is a fresh copy. */
function offlineDexOnOpen() {
  SpreadsheetApp.getUi()
    .createMenu('RogueDex Functions')
    .addItem('Upload Data', 'offlineDexOpenUploadDialog')
    .addItem(
      'Upload Data (Keep Baseline)',
      'offlineDexOpenUploadDialogKeepBaseline',
    )
    .addSeparator()
    .addItem('Snapshot Data', 'offlineDexSnapshot')
    .addItem('Highlight Changes', 'offlineDexHighlightChanges')
    .addItem('Clear Highlights', 'offlineDexClearHighlights')
    .addItem('Check Layout', 'offlineDexCheckLayout')
    .addSeparator()
    .addItem('Finish Setup (Migrate + Upload)', 'offlineDexFinishSetup')
    .addItem('Prepare Next Version', 'offlineDexPrepareNextVersion')
    .addToUi()

  OfflineDexLib.nudgeFinishSetupIfFresh()
}

// ------------------------------------------------------------
// Upload
// ------------------------------------------------------------

/** Normal upload: highlight changes, then snapshot as the new baseline. */
function offlineDexOpenUploadDialog() {
  PropertiesService.getDocumentProperties().deleteProperty(
    OFFLINEDEX_SKIP_SNAPSHOT_PROPERTY,
  )
  offlineDexShowUploadDialog()
}

/**
 * Upload without the trailing snapshot: changes are highlighted against the
 * current baseline, which stays in place so the next upload still diffs
 * against it.
 */
function offlineDexOpenUploadDialogKeepBaseline() {
  PropertiesService.getDocumentProperties().setProperty(
    OFFLINEDEX_SKIP_SNAPSHOT_PROPERTY,
    'true',
  )
  offlineDexShowUploadDialog()
}

function offlineDexShowUploadDialog() {
  const dialog = HtmlService.createHtmlOutputFromFile('OfflineDexUpload')
  SpreadsheetApp.getUi().showModalDialog(dialog, 'Upload File')
}

/**
 * The tracked upload: the creator's own import steps (createBlob → decryptFile
 * → parseJsonContent → writeJsonToSheet, all in LoadPlayerData.js), then the
 * library's highlight/snapshot flow. Called by OfflineDexUpload.html; the
 * creator's uploadFile() is left untouched.
 * @param {{fileName: string, mimeType: string, data: string}} uploadedFile
 */
function uploadFileTracked(uploadedFile) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet()
  const docProps = PropertiesService.getDocumentProperties()
  const skipSnapshot =
    docProps.getProperty(OFFLINEDEX_SKIP_SNAPSHOT_PROPERTY) === 'true'
  docProps.deleteProperty(OFFLINEDEX_SKIP_SNAPSHOT_PROPERTY)

  OfflineDexLib.resetToastProgress('upload')
  OfflineDexLib.startStep(spreadsheet, 'Importing Save Data')

  const blob = createBlob(uploadedFile)
  const plaintext = decryptFile(blob)
  const jsonContent = parseJsonContent(plaintext)
  writeJsonToSheet(jsonContent)
  SpreadsheetApp.flush()
  Utilities.sleep(2000) // let the formulas that read newJSON settle before the diff

  OfflineDexLib.finishStep()

  try {
    if (skipSnapshot) {
      OfflineDexLib.processChangesWithoutSnapshot()
    } else {
      OfflineDexLib.processChanges()
    }
  } catch (error) {
    // The library has already shown the error toast and logged the timings.
    Logger.log('processChanges failed: ' + error.message)
  }
}

// ------------------------------------------------------------
// Menu wrappers
// ------------------------------------------------------------

function offlineDexSnapshot() {
  OfflineDexLib.snapshot()
}
function offlineDexHighlightChanges() {
  OfflineDexLib.highlightChanges()
}
function offlineDexClearHighlights() {
  OfflineDexLib.clearHighlights()
}

/** Dry run: show what the layout probe resolves to in this copy. */
function offlineDexCheckLayout() {
  SpreadsheetApp.getUi().alert(
    'OfflineDex layout check',
    OfflineDexLib.describeLayout(),
    SpreadsheetApp.getUi().ButtonSet.OK,
  )
}

/** Menu (run in the OLD sheet): copy the public sheet + hand off to the CLI. */
function offlineDexPrepareNextVersion() {
  OfflineDexLib.prepareNextVersion()
}

/**
 * Menu (run in the NEW sheet): migrate from the previous version (the library
 * shows the plan first), then open the upload dialog so the save load happens
 * in the same sitting. The dialog is opened here because the HTML lives in
 * this bound project.
 */
function offlineDexFinishSetup() {
  if (OfflineDexLib.finishSetup()) offlineDexOpenUploadDialog()
}
