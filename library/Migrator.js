// ============================================================
// MIGRATOR MODULE (library file)
//
// Ports your customizations from an old OfflineDex spreadsheet
// to a new one. Called from the destination spreadsheet's bound
// script via OfflineDexLib.portAll(sourceVersion, destVersion).
// ============================================================

const FILE_NAME_PATTERN = 'Offline RogueDex {v}';

const INSERT_COLUMN_L_IN_DAILY_MODE = true;
const B16_MERGE_RANGE = 'B16:M131';

function portAll(sourceVersion, destVersion) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  resetToastProgress();

  const srcId = findFileIdByVersion(sourceVersion);
  const dstId = findFileIdByVersion(destVersion);
  Logger.log('Source: ' + sourceVersion + ' -> ' + srcId);
  Logger.log('Dest:   ' + destVersion + ' -> ' + dstId);

  const src = SpreadsheetApp.openById(srcId);
  const dst = SpreadsheetApp.openById(dstId);

  const log = [];
  const safeRun = (label, fn) => {
    startStep(ss, label);
    try {
      fn();
      finishStep();
      log.push('OK  ' + label);
    } catch (e) {
      finishStep();
      log.push('ERR ' + label + ': ' + e.message);
    }
  };

  safeRun('Formatting Quick Checklist', () => portQuickChecklistHeader(src, dst));
  safeRun('Formatting Form Checklist',  () => sortFormChecklistByDone(dst));
  safeRun('Formatting Daily Mode',      () => portDailyModeFormatting(src, dst));
  safeRun('Updating Daily Mode Cells',  () => portDailyModeCells(src, dst));
  safeRun('Hiding sheets',              () => portHiddenSheets(src, dst));

  const totalElapsed = ((Date.now() - FLOW_START) / 1000).toFixed(1);
  const body = LAST_STEP_LABEL
    ? LAST_STEP_LABEL + ' completed in ' + LAST_STEP_ELAPSED + 's'
    : '';
  ss.toast(body, 'Migration complete in ' + totalElapsed + 's', 10);
  FLOW_START = 0;

  Logger.log(log.join('\n'));
}

function portQuickChecklistHeader(src, dst) {
  const sName = 'Quick Checklist';
  const sSheet = src.getSheetByName(sName);
  const dSheet = dst.getSheetByName(sName);
  if (!sSheet || !dSheet) throw new Error('Quick Checklist not found');

  const tempSheet = sSheet.copyTo(dst);
  try {
    const cols = Math.max(tempSheet.getMaxColumns(), dSheet.getMaxColumns());

    const srcRange = tempSheet.getRange(1, 1, 10, cols);
    const dstRange = dSheet.getRange(1, 1, 10, cols);
    srcRange.copyTo(dstRange, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);

    for (let r = 1; r <= 10; r++) {
      dSheet.setRowHeight(r, tempSheet.getRowHeight(r));
      if (tempSheet.isRowHiddenByUser(r)) {
        dSheet.hideRows(r);
      } else {
        dSheet.showRows(r);
      }
    }
    for (let c = 1; c <= cols; c++) {
      dSheet.setColumnWidth(c, tempSheet.getColumnWidth(c));
      if (tempSheet.isColumnHiddenByUser(c)) {
        dSheet.hideColumns(c);
      } else {
        dSheet.showColumns(c);
      }
    }

    const portRowSlice = (rowNum, startCol, endCol) => {
      const numCols = endCol - startCol + 1;
      const srcRow = tempSheet.getRange(rowNum, startCol, 1, numCols);
      const formulas = srcRow.getFormulas();
      const values   = srcRow.getValues();
      const merged   = formulas.map((row, i) =>
        row.map((f, j) => f ? f : values[i][j])
      );
      dSheet.getRange(rowNum, startCol, 1, numCols).setValues(merged);
    };
    portRowSlice(1, 8, 15);
    portRowSlice(10, 1, cols);
  } finally {
    dst.deleteSheet(tempSheet);
  }
}

function sortFormChecklistByDone(dst) {
  const sheet = dst.getSheetByName('Form Checklist');
  if (!sheet) throw new Error('Form Checklist not found in destination');

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2) return;

  const range = sheet.getRange(2, 1, lastRow - 1, lastCol);
  range.sort({ column: 3, ascending: true });
}

function portDailyModeFormatting(src, dst) {
  const name = 'Daily Mode';
  const sSheet = src.getSheetByName(name);
  const dSheet = dst.getSheetByName(name);
  if (!sSheet || !dSheet) throw new Error('Daily Mode not found');

  if (INSERT_COLUMN_L_IN_DAILY_MODE && dSheet.getMaxColumns() < sSheet.getMaxColumns()) {
    dSheet.insertColumnBefore(12);
  }

  const tempSheet = sSheet.copyTo(dst);
  try {
    const rows = Math.min(tempSheet.getMaxRows(), dSheet.getMaxRows());
    const cols = Math.min(tempSheet.getMaxColumns(), dSheet.getMaxColumns());
    const srcRange = tempSheet.getRange(1, 1, rows, cols);
    const dstRange = dSheet.getRange(1, 1, rows, cols);

    srcRange.copyTo(dstRange, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);

    dSheet.setColumnWidth(12, tempSheet.getColumnWidth(12));
    dSheet.setColumnWidth(13, tempSheet.getColumnWidth(13));

    const remappedRules = tempSheet.getConditionalFormatRules().map(rule => {
      const newRanges = rule.getRanges().map(r =>
        dSheet.getRange(r.getRow(), r.getColumn(), r.getNumRows(), r.getNumColumns())
      );
      return rule.copy().setRanges(newRanges).build();
    });
    dSheet.setConditionalFormatRules(remappedRules);
  } finally {
    dst.deleteSheet(tempSheet);
  }
}

function portDailyModeCells(src, dst) {
  const name = 'Daily Mode';
  const sSheet = src.getSheetByName(name);
  const dSheet = dst.getSheetByName(name);
  if (!sSheet || !dSheet) throw new Error('Daily Mode not found');

  const mergeRange = dSheet.getRange(B16_MERGE_RANGE);
  mergeRange.breakApart();
  mergeRange.merge();

  const b16Formula = sSheet.getRange('B16').getFormula();
  if (b16Formula) {
    dSheet.getRange('B16').setFormula(b16Formula);
  } else {
    dSheet.getRange('B16').setValue(sSheet.getRange('B16').getValue());
  }

  const srcBlock = sSheet.getRange('L12:M14');
  const formulas = srcBlock.getFormulas();
  const values   = srcBlock.getValues();
  const merged   = formulas.map((row, i) =>
    row.map((f, j) => f ? f : values[i][j])
  );
  dSheet.getRange('L12:M14').setValues(merged);
}

function portHiddenSheets(src, dst) {
  const srcSheets = src.getSheets();
  const dstByName = {};
  dst.getSheets().forEach(s => { dstByName[s.getName()] = s; });

  const hiddenList = [];
  srcSheets.forEach(s => {
    if (s.isSheetHidden() && dstByName[s.getName()]) {
      dstByName[s.getName()].hideSheet();
      hiddenList.push(s.getName());
    }
  });
  Logger.log('Hidden in dst: ' + (hiddenList.join(', ') || '(none)'));
}

function findFileIdByVersion(version) {
  const targetName = FILE_NAME_PATTERN.replace('{v}', version);
  const query =
    "title = '" + targetName.replace(/'/g, "\\'") + "' " +
    "and mimeType = 'application/vnd.google-apps.spreadsheet' " +
    "and trashed = false";

  const files = DriveApp.searchFiles(query);
  const matches = [];
  while (files.hasNext()) {
    const f = files.next();
    if (f.getName().indexOf('PUBLIC_') === 0) continue;
    matches.push(f);
  }

  if (matches.length === 0) {
    throw new Error(
      'No file found named "' + targetName + '". ' +
      'Check the version number, or rename your copy to match.'
    );
  }
  if (matches.length > 1) {
    matches.sort((a, b) => b.getLastUpdated() - a.getLastUpdated());
    Logger.log(
      'Multiple files named "' + targetName + '" found. Using newest: ' +
      matches[0].getId() + '. Others ignored: ' +
      matches.slice(1).map(f => f.getId()).join(', ')
    );
  }
  return matches[0].getId();
}
