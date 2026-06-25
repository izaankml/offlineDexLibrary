function onOpen() {
  ScriptApp.requireAllScopes(ScriptApp.AuthMode.FULL)

  //SpreadsheetApp.getUi()
  //  .createMenu('Update Database')
  //  .addItem('Update static pokemon information', 'forceUpdate')
  //  .addToUi();

  SpreadsheetApp.getUi()
    .createMenu('Upload PokeRogue Data')
    .addItem('Upload Data', 'openAttachmentDialog')
    .addToUi()

  forceUpdate(true)
}

function checkVersion() {
  const ss = SpreadsheetApp.getActiveSpreadsheet()
  const quickSheet = ss.getSheetByName('Quick Checklist')
  const quickValue = quickSheet.getRange('A1').getValue()

  const versionSheet = ss.getSheetByName('STATIC:VERSION')
  const versionValue = versionSheet.getRange('A1').getValue()
  const loadedValue = versionSheet.getRange('A6').getValue()
  if ('POKEROGUE DEX ' + loadedValue === versionValue) {
    // loaded correctly
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

/**
 * HELPER FUNCTION : TO OPEN & CLOSE MODAL DIALOGUE
 */
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
