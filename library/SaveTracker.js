// ============================================================
// SAVE TRACKER MODULE (library file)
//
// Tracks changes in source-of-truth data sheets and highlights
// the corresponding cells in display sheets after each save upload.
//
// PUBLIC FUNCTIONS (called via OfflineDexLib.<name>):
//   processChanges()    - full flow used by uploadFile
//   runProcessChanges() - standalone full flow with reset
//   snapshot()          - capture current values to snapshots
//   highlightChanges()  - paint cells that differ from snapshot
//   clearHighlights()   - clear highlight borders, redraw structural
//
//   resetToastProgress()- start a toast flow (called by uploadFile)
//   startStep(ss, lbl)  - mark start of a tracked step
//   finishStep()        - mark end of a tracked step
// ============================================================

const HIGHLIGHT_COLOR = '#38761d';   // dark green 1
const CHUNK_ROWS      = 200;

// Module-level state for toast progress tracking.
let LAST_STEP_LABEL = '';
let LAST_STEP_ELAPSED = '';
let CURRENT_STEP_START = 0;
let FLOW_START = 0;

function resetToastProgress() {
  LAST_STEP_LABEL = '';
  LAST_STEP_ELAPSED = '';
  CURRENT_STEP_START = 0;
  FLOW_START = Date.now();
}

function startStep(ss, label) {
  const title = label;
  const body = LAST_STEP_LABEL
    ? LAST_STEP_LABEL + ' completed in ' + LAST_STEP_ELAPSED + 's'
    : '';
  ss.toast(body, title, -1);
  CURRENT_STEP_START = Date.now();
  LAST_STEP_LABEL = label;
}

function finishStep() {
  LAST_STEP_ELAPSED = ((Date.now() - CURRENT_STEP_START) / 1000).toFixed(1);
}

function runStandaloneIfNeeded(ss, label, fn) {
  if (FLOW_START) {
    fn();
    return;
  }
  resetToastProgress();
  fn();
  const totalElapsed = ((Date.now() - FLOW_START) / 1000).toFixed(1);
  const title = label + ' done in ' + totalElapsed + 's';
  const body = LAST_STEP_LABEL
    ? LAST_STEP_LABEL + ' completed in ' + LAST_STEP_ELAPSED + 's'
    : '';
  ss.toast(body, title, 5);
  FLOW_START = 0;
}

const TRACKERS = [
  {
    key: 'QuickChecklist',
    dataSheet: 'STARTER_CHECKLIST.data',
    displaySheet: 'Quick Checklist',
    dataFirstRow: 12,
    displayFirstRow: 12,
    columnMap: buildShiftMap(4, 11, 4),
    includeHeaders: true,
    headerRows: 1,
    borderColumns: [],
  },
  {
    key: 'StarterDex',
    dataSheet: 'STARTER_DEX.data',
    displaySheet: 'Starter Dex Checklist',
    dataFirstRow: 3,
    displayFirstRow: 4,
    columnMap: buildShiftMap(10, 141, -6),
    includeHeaders: true,
    headerRows: 2,
    // L, U, AA, AB, AG, AI, AL, AO, BO, CQ, EE
    borderColumns: [12, 21, 27, 28, 33, 35, 38, 41, 67, 95, 135],
    // E, N, AB, AG, AH — auto-calculated columns, never highlight
    excludeDisplayColumns: new Set([5, 14, 28, 33, 34]),
    useFilter: true,
  },
  {
    key: 'FullDex',
    dataSheet: 'FULL_DEX.data',
    displaySheet: 'Full Dex Checklist',
    dataFirstRow: 3,
    displayFirstRow: 4,
    columnMap: buildShiftMap(7, 138, 0),
    includeHeaders: true,
    headerRows: 2,
    // O, X, AD, AE, AJ, AL, AO, AR, BR, CT, EH (+3 from Starter Dex)
    borderColumns: [15, 24, 30, 31, 36, 38, 41, 44, 70, 98, 138],
    // H, Q, AE, AJ, AK — auto-calculated columns, never highlight (+3 from Starter Dex)
    excludeDisplayColumns: new Set([8, 17, 31, 36, 37]),
    useFilter: true,
  },
];

function buildShiftMap(dataStart, dataEnd, shift) {
  const map = {};
  for (let c = dataStart; c <= dataEnd; c++) {
    map[c] = c + shift;
  }
  return map;
}

function runProcessChanges() {
  resetToastProgress();
  processChanges();
}

function processChanges() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  clearHighlights();
  highlightChanges();
  snapshot();
  const totalElapsed = ((Date.now() - FLOW_START) / 1000).toFixed(1);
  const title = 'All sheets processed in ' + totalElapsed + 's';
  const body = LAST_STEP_LABEL
    ? LAST_STEP_LABEL + ' completed in ' + LAST_STEP_ELAPSED + 's'
    : '';
  ss.toast(body, title, 5);
  FLOW_START = 0;
}

function snapshot() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  runStandaloneIfNeeded(ss, 'Snapshot', () => {
    TRACKERS.forEach(t => {
      try {
        captureSnapshotForTracker(ss, t);
      } catch (e) {
        Logger.log('Snapshot failed for ' + t.key + ': ' + e.message);
        throw e;
      }
    });
  });
}

function highlightChanges() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  runStandaloneIfNeeded(ss, 'Highlight changes', () => {
    TRACKERS.forEach(t => {
      try {
        applyHighlightsForTracker(ss, t);
      } catch (e) {
        Logger.log('Highlight failed for ' + t.key + ': ' + e.message);
        throw e;
      }
    });
  });
}

function clearHighlights() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  runStandaloneIfNeeded(ss, 'Clear highlights', () => {
    TRACKERS.forEach(t => clearHighlightsForTracker(ss, t));
  });
}

function captureSnapshotForTracker(ss, t) {
  startStep(ss, 'Snapshotting ' + t.displaySheet);
  const data = ss.getSheetByName(t.dataSheet);
  const display = ss.getSheetByName(t.displaySheet);
  if (!data) throw new Error(t.dataSheet + ' not found');
  if (!display) throw new Error(t.displaySheet + ' not found');

  const dataCols = Object.keys(t.columnMap).map(n => parseInt(n, 10));
  if (dataCols.length === 0) throw new Error('Empty columnMap for ' + t.key);

  const lastRow = data.getLastRow();
  if (lastRow < t.dataFirstRow) {
    Logger.log(t.key + ': no data to snapshot');
    return;
  }
  const numRows = lastRow - t.dataFirstRow + 1;
  const minDataCol = Math.min(...dataCols);
  const maxDataCol = Math.max(...dataCols);
  const dataColCount = maxDataCol - minDataCol + 1;

  const snapName = '_snapshot_' + t.key;
  let snap = ss.getSheetByName(snapName);
  if (!snap) {
    snap = ss.insertSheet(snapName);
    snap.hideSheet();
  } else {
    snap.clear();
  }

  let snapDataStartRow = 1;
  if (t.includeHeaders) {
    const numHeaderRows = t.headerRows || 1;
    const headers = data.getRange(1, minDataCol, numHeaderRows, dataColCount).getValues();
    snap.getRange(1, minDataCol, numHeaderRows, dataColCount).setValues(headers);
    snapDataStartRow = numHeaderRows + 1;
  }

  for (let offset = 0; offset < numRows; offset += CHUNK_ROWS) {
    const chunkSize = Math.min(CHUNK_ROWS, numRows - offset);
    const dataRow = t.dataFirstRow + offset;
    const values = data.getRange(dataRow, minDataCol, chunkSize, dataColCount).getValues();
    snap.getRange(snapDataStartRow + offset, minDataCol, chunkSize, dataColCount).setValues(values);
    SpreadsheetApp.flush();
  }

  if (minDataCol > 1) {
    snap.hideColumns(1, minDataCol - 1);
  }

  finishStep();
  Logger.log(t.key + ': snapshot captured in ' + LAST_STEP_ELAPSED + 's, ' + numRows + ' rows, cols ' +
             minDataCol + '-' + maxDataCol);
}

function applyHighlightsForTracker(ss, t) {
  startStep(ss, 'Highlighting ' + t.displaySheet);
  const data = ss.getSheetByName(t.dataSheet);
  const display = ss.getSheetByName(t.displaySheet);
  const snap = ss.getSheetByName('_snapshot_' + t.key);
  if (!data || !display) throw new Error('Required sheet not found for ' + t.key);
  if (!snap) {
    Logger.log(t.key + ': no snapshot exists, skipping');
    return;
  }

  const dataCols = Object.keys(t.columnMap).map(n => parseInt(n, 10));
  const minDataCol = Math.min(...dataCols);
  const maxDataCol = Math.max(...dataCols);
  const dataColCount = maxDataCol - minDataCol + 1;

  const snapDataStartRow = t.includeHeaders ? ((t.headerRows || 1) + 1) : 1;
  const snapLastRow = snap.getLastRow();
  if (snapLastRow < snapDataStartRow) {
    Logger.log(t.key + ': snapshot is empty');
    return;
  }
  const snapDataRows = snapLastRow - snapDataStartRow + 1;

  const displayCols = Object.values(t.columnMap);
  const displayMaxCol = Math.max(...displayCols);
  const markerCol = t.useFilter ? displayMaxCol + 1 : null;

  let totalChanged = 0;
  for (let offset = 0; offset < snapDataRows; offset += CHUNK_ROWS) {
    const chunkSize = Math.min(CHUNK_ROWS, snapDataRows - offset);
    const dataRow = t.dataFirstRow + offset;
    const displayRow = t.displayFirstRow + offset;

    const snapValues = snap.getRange(snapDataStartRow + offset, minDataCol, chunkSize, dataColCount).getValues();
    const currentValues = data.getRange(dataRow, minDataCol, chunkSize, dataColCount).getValues();

    const backgrounds = [];
    const rowChanged = [];
    for (let r = 0; r < chunkSize; r++) {
      backgrounds.push(new Array(displayMaxCol).fill(null));
      rowChanged.push(false);
    }

    for (let r = 0; r < chunkSize; r++) {
      for (const dataColStr of Object.keys(t.columnMap)) {
        const dataCol = parseInt(dataColStr, 10);
        const displayCol = t.columnMap[dataCol];
        if (t.excludeDisplayColumns && t.excludeDisplayColumns.has(displayCol)) continue;
        const idx = dataCol - minDataCol;
        if (String(snapValues[r][idx]) !== String(currentValues[r][idx])) {
          backgrounds[r][displayCol - 1] = HIGHLIGHT_COLOR;
          rowChanged[r] = true;
          totalChanged++;
        }
      }
    }

    for (let r = 0; r < chunkSize; r++) {
      for (let c = 0; c < displayMaxCol; c++) {
        if (backgrounds[r][c] === HIGHLIGHT_COLOR) {
          display.getRange(displayRow + r, c + 1)
            .setBorder(true, true, true, true, false, false,
                       HIGHLIGHT_COLOR, SpreadsheetApp.BorderStyle.SOLID_THICK);
        }
      }
    }

    if (markerCol) {
      display.getRange(displayRow, markerCol, chunkSize, 1)
        .setValues(rowChanged.map(changed => [changed ? '●' : '']));
    }

    SpreadsheetApp.flush();
  }

  finishStep();
  Logger.log(t.key + ': highlighted ' + totalChanged + ' changed cells in ' + LAST_STEP_ELAPSED + 's');
}

function clearHighlightsForTracker(ss, t) {
  startStep(ss, 'Clearing ' + t.displaySheet);
  const display = ss.getSheetByName(t.displaySheet);
  if (!display) return;
  const lastRow = display.getLastRow();
  if (lastRow < t.displayFirstRow) return;

  const displayCols = Object.values(t.columnMap);
  const maxCol = Math.max(...displayCols);
  const markerCol = t.useFilter ? maxCol + 1 : null;
  const numRows = lastRow - t.displayFirstRow + 1;

  if (markerCol) {
    display.getRange(t.displayFirstRow, markerCol, numRows, 1).clearContent();
    SpreadsheetApp.flush();
  }

  for (let offset = 0; offset < numRows; offset += CHUNK_ROWS) {
    const chunkSize = Math.min(CHUNK_ROWS, numRows - offset);
    const range = display.getRange(t.displayFirstRow + offset, 1, chunkSize, maxCol);
    range.setBackground(null);
    range.setBorder(false, false, false, false, false, false);
    SpreadsheetApp.flush();
  }

  if (t.borderColumns && t.borderColumns.length > 0) {
    t.borderColumns.forEach(col => {
      display.getRange(t.displayFirstRow, col, numRows, 1)
        .setBorder(null, null, null, true, null, null,
                   '#000000', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
    });
  }

  finishStep();
  Logger.log(t.key + ': highlights cleared in ' + LAST_STEP_ELAPSED + 's');
}
