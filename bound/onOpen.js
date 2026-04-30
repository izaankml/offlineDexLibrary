const PREVIOUS_VERSION = '5.06';

function onOpen() {

  ScriptApp.requireAllScopes(ScriptApp.AuthMode.FULL);

  SpreadsheetApp.getUi()
    .createMenu('Upload PokeRogue Data')
    .addItem('Upload Data', 'openAttachmentDialog')
    .addSeparator()
    .addItem('Snapshot Data', 'snapshot')
    .addItem('Highlight Changes', 'highlightChanges')
    .addItem('Clear Highlights', 'clearHighlights')
    .addSeparator()
    .addItem('Migrate from previous version', 'runMigration')
    .addToUi();

  forceUpdate(true);
}

// ============================================================
// LIBRARY WRAPPERS - menu items can't call library functions
// directly, so these forward to OfflineDexLib.
// ============================================================
function snapshot()         { OfflineDexLib.snapshot(); }
function highlightChanges() { OfflineDexLib.highlightChanges(); }
function clearHighlights()  { OfflineDexLib.clearHighlights(); }

function runMigration() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const match = ss.getName().match(/\d+\.\d+/);
  if (!match) {
    SpreadsheetApp.getUi().alert(
      'Could not determine current version from spreadsheet name "' +
      ss.getName() + '". Expected format: "Offline RogueDex X.YY".'
    );
    return;
  }
  const destVersion = match[0];
  OfflineDexLib.portAll(PREVIOUS_VERSION, destVersion);
}

// ============================================================
// EXISTING FUNCTIONS (unchanged from creator's original)
// ============================================================
function checkVersion() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const quickSheet = ss.getSheetByName("Quick Checklist");
  const quickValue = quickSheet.getRange("A1").getValue();

  const versionSheet = ss.getSheetByName("STATIC:VERSION.data");
  const versionValue = versionSheet.getRange("A1").getValue();
  const loadedValue = versionSheet.getRange("A6").getValue();
  if ("POKEROGUE DEX " + loadedValue === versionValue) {
    Logger.log("loaded");
    if (quickValue !== versionValue) {
      Logger.log("message");
      Browser.msgBox(`There is a new version available.\\n
Go to the original link and re-copy the PUBLIC sheet.\\n
Your version: ${quickValue}\\n
New Version: ${versionValue}`);
    }
  }

  Logger.log("end");
}

function htmlmodalDialog(title, text, close){
  var htmlText = '<div>' + text + '</div>';
  htmlText += '<style type="text/css">';
  htmlText += 'body{text-align: center; font-family: Roboto, Arial, sans-serif; font-size: 14px;}';
  htmlText += 'div{margin: auto;}';
  htmlText += '</style>';
  if(close){htmlText += '<script>google.script.host.close();</script>';}
  var htmlOutput = HtmlService
    .createHtmlOutput(htmlText)
    .setHeight(60)
    .setWidth(200);
  try {
    SpreadsheetApp.getUi().showModalDialog(htmlOutput, title);
  } catch(e){
    Logger.log('function htmlmodalDialog(title, text, close)');
    Logger.log(e);
  }
}
