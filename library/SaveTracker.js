// ============================================================
// SAVE TRACKER MODULE (library file)
//
// Tracks changes in source-of-truth data sheets and highlights
// the corresponding cells in display sheets after each save upload.
//
// PUBLIC FUNCTIONS (called via OfflineDexLib.<name>):
//   processChanges()    - full flow used by uploadFile
//   processChangesWithoutSnapshot()
//                       - same, but keeps the existing snapshot as the baseline
//   runProcessChanges() - standalone full flow with reset
//   snapshot()          - capture current values to snapshots
//   highlightChanges()  - paint cells that differ from snapshot
//   clearHighlights()   - clear highlight backgrounds
//
//   resetToastProgress()- start a toast flow (called by uploadFile)
//   startStep(ss, lbl)  - mark start of a tracked step
//   finishStep()        - mark end of a tracked step
// ============================================================

const QUICK_CHECKLIST_HIGHLIGHT_COLOR = '#FFFF00' // yellow
const DEX_HIGHLIGHT_COLOR = '#93c47d' // light green 1
const INCREMENT_HIGHLIGHT_COLOR = '#b4a7d6' // light purple 2
const CHUNK_ROWS = 200

// Module-level state for toast progress tracking.
let LAST_STEP_LABEL = ''
let LAST_STEP_ELAPSED = ''
let CURRENT_STEP_START = 0
let FLOW_START = 0

/**
 * Start a new toast-tracked flow. Call once at the top of a multi-step
 * operation (e.g., uploadFile) before the first startStep.
 */
function resetToastProgress() {
  LAST_STEP_LABEL = ''
  LAST_STEP_ELAPSED = ''
  CURRENT_STEP_START = 0
  FLOW_START = Date.now()
}

/**
 * Mark the start of a tracked step. Shows a sticky toast whose title is the
 * new step's label and whose body summarizes the previous step's timing.
 * @param {Spreadsheet} ss
 * @param {string} label
 */
function startStep(ss, label) {
  const title = label
  const body = LAST_STEP_LABEL
    ? LAST_STEP_LABEL + ' completed in ' + LAST_STEP_ELAPSED + 's'
    : ''
  ss.toast(body, title, -1)
  CURRENT_STEP_START = Date.now()
  LAST_STEP_LABEL = label
}

/** Record how long the in-progress step took, in seconds (one decimal). */
function finishStep() {
  LAST_STEP_ELAPSED = ((Date.now() - CURRENT_STEP_START) / 1000).toFixed(1)
}

/**
 * Run `fn` as part of an outer flow if one exists, otherwise as a self-managed
 * standalone flow: reset toast state before, show a completion toast after.
 * Lets the public snapshot/highlight/clear entry points be usable either way.
 * @param {Spreadsheet} ss
 * @param {string} label - used in the standalone completion toast
 * @param {function():void} fn
 */
function runStandaloneIfNeeded(ss, label, fn) {
  if (FLOW_START) {
    fn()
    return
  }
  resetToastProgress()
  fn()
  finishFlow(ss, label + ' done')
}

/**
 * Show the final "X in Ns" toast for the current flow and clear FLOW_START
 * so the next entry point starts a fresh flow.
 * @param {Spreadsheet} ss
 * @param {string} title - the leading phrase; total elapsed is appended
 */
function finishFlow(ss, title) {
  const totalElapsed = ((Date.now() - FLOW_START) / 1000).toFixed(1)
  const body = LAST_STEP_LABEL
    ? LAST_STEP_LABEL + ' completed in ' + LAST_STEP_ELAPSED + 's'
    : ''
  ss.toast(body, title + ' in ' + totalElapsed + 's', 5)
  FLOW_START = 0
}

const TRACKERS = [
  {
    key: 'QuickChecklist',
    dataSheet: 'STARTER_CHECKLIST.data',
    displaySheet: 'Quick Checklist',
    dataFirstRow: 12,
    displayFirstRow: 12,
    columnMap: buildShiftMap(4, 11, 3),
    includeHeaders: true,
    headerRows: 1,
    highlightColor: QUICK_CHECKLIST_HIGHLIGHT_COLOR,
    useFilter: true,
    // Re-sort the display by column A before painting so its row order matches
    // the data sheet (highlights paint by row offset) and the column-A slicers
    // line up. See sortDisplayByColumn.
    sortDisplayColumn: 1,
  },
  {
    key: 'StarterDex',
    dataSheet: 'STARTER_DEX.data',
    displaySheet: 'Starter Dex Checklist',
    dataFirstRow: 3,
    displayFirstRow: 4,
    columnMap: buildShiftMap(12, 143, -8),
    includeHeaders: true,
    headerRows: 2,
    // E, AH, AI — auto-calculated columns, never highlight
    excludeDisplayColumns: new Set([5, 34, 35]),
    // N (caught), AB (hatched), AO (wins) — counts that increment on an
    // already-unlocked entry, so they get the purple increment highlight
    columnHighlightColors: {
      14: INCREMENT_HIGHLIGHT_COLOR,
      28: INCREMENT_HIGHLIGHT_COLOR,
      41: INCREMENT_HIGHLIGHT_COLOR,
    },
    useFilter: true,
    // Re-sort the display by column A before painting so its row order matches
    // the data sheet (highlights paint by row offset) and the column-A slicers
    // line up. See sortDisplayByColumn.
    sortDisplayColumn: 1,
  },
  {
    key: 'FullDex',
    dataSheet: 'FULL_DEX.data',
    displaySheet: 'Full Dex Checklist',
    dataFirstRow: 3,
    displayFirstRow: 4,
    columnMap: buildShiftMap(8, 139, -4),
    includeHeaders: true,
    headerRows: 2,
    // E, AH, AI — auto-calculated columns, never highlight (display now matches Starter Dex)
    excludeDisplayColumns: new Set([5, 34, 35]),
    // N (caught), AB (hatched), AO (wins) — counts that increment on an
    // already-unlocked entry, so they get the purple increment highlight
    columnHighlightColors: {
      14: INCREMENT_HIGHLIGHT_COLOR,
      28: INCREMENT_HIGHLIGHT_COLOR,
      41: INCREMENT_HIGHLIGHT_COLOR,
    },
    useFilter: true,
    // Re-sort the display by column A before painting so its row order matches
    // the data sheet (highlights paint by row offset) and the column-A slicers
    // line up. See sortDisplayByColumn.
    sortDisplayColumn: 1,
  },
]

/**
 * Build a column map for a contiguous range of data columns shifted to
 * display columns. `{dataCol: dataCol + shift}` for every col in [start, end].
 * @param {number} dataStart - first data column (1-based)
 * @param {number} dataEnd - last data column (1-based, inclusive)
 * @param {number} shift - displayCol - dataCol
 * @return {Object<number, number>}
 */
function buildShiftMap(dataStart, dataEnd, shift) {
  const map = {}
  for (let c = dataStart; c <= dataEnd; c++) {
    map[c] = c + shift
  }
  return map
}

/** Standalone entry point: resets toast state, then runs the full flow. */
function runProcessChanges() {
  resetToastProgress()
  processChanges()
}

/** Standalone entry point: full flow, but keeps the current snapshot baseline. */
function runProcessChangesWithoutSnapshot() {
  resetToastProgress()
  processChangesWithoutSnapshot()
}

/**
 * Full save-upload flow: clear stale highlights, paint cells that changed
 * since the last snapshot, then capture a new snapshot for next time.
 * Assumes the caller (uploadFile or runProcessChanges) already reset toast state.
 * @param {{skipSnapshot: boolean}} [options] - when skipSnapshot is set, the
 *   existing snapshot is left in place, so it stays the baseline for the next
 *   upload and highlights accumulate against it.
 */
function processChanges(options) {
  const ss = SpreadsheetApp.getActiveSpreadsheet()
  const skipSnapshot = !!(options && options.skipSnapshot)
  clearHighlights()
  highlightChanges()
  if (!skipSnapshot) snapshot()
  finishFlow(
    ss,
    skipSnapshot
      ? 'All sheets processed (baseline kept)'
      : 'All sheets processed',
  )
}

/**
 * Same as processChanges, but does not re-snapshot afterwards: the current
 * snapshot stays the diff baseline. Use when an upload shouldn't reset what
 * "changed since last time" means — e.g. uploading a mid-run save, or
 * re-uploading after a failed run — so the next upload still highlights
 * everything that happened since the last baseline.
 */
function processChangesWithoutSnapshot() {
  processChanges({ skipSnapshot: true })
}

/**
 * Public entry: capture the current values of every tracker's data sheet into
 * its hidden `_snapshot_<key>` sheet. Used as the baseline for the next diff.
 */
function snapshot() {
  const ss = SpreadsheetApp.getActiveSpreadsheet()
  runStandaloneIfNeeded(ss, 'Snapshot', () => {
    TRACKERS.forEach((t) => {
      try {
        captureSnapshotForTracker(ss, t)
      } catch (e) {
        Logger.log('Snapshot failed for ' + t.key + ': ' + e.message)
        throw e
      }
    })
  })
}

/**
 * Write a single tracker's current data values into its hidden snapshot sheet,
 * creating the sheet on first run. Reads/writes in CHUNK_ROWS-sized batches.
 * @param {Spreadsheet} ss
 * @param {Object} t - a TRACKERS entry
 */
function captureSnapshotForTracker(ss, t) {
  startStep(ss, 'Snapshotting ' + t.displaySheet)
  const data = ss.getSheetByName(t.dataSheet)
  const display = ss.getSheetByName(t.displaySheet)
  if (!data) throw new Error(t.dataSheet + ' not found')
  if (!display) throw new Error(t.displaySheet + ' not found')

  const dataCols = Object.keys(t.columnMap).map((n) => parseInt(n, 10))
  if (dataCols.length === 0) throw new Error('Empty columnMap for ' + t.key)

  const lastRow = data.getLastRow()
  if (lastRow < t.dataFirstRow) {
    Logger.log(t.key + ': no data to snapshot')
    return
  }
  const numRows = lastRow - t.dataFirstRow + 1
  const minDataCol = Math.min(...dataCols)
  const maxDataCol = Math.max(...dataCols)
  const dataColCount = maxDataCol - minDataCol + 1

  const snapName = '_snapshot_' + t.key
  let snap = ss.getSheetByName(snapName)
  if (!snap) {
    snap = ss.insertSheet(snapName)
    snap.hideSheet()
  } else {
    snap.clear()
  }

  let snapDataStartRow = 1
  if (t.includeHeaders) {
    const numHeaderRows = t.headerRows || 1
    const headers = data
      .getRange(1, minDataCol, numHeaderRows, dataColCount)
      .getValues()
    snap.getRange(1, minDataCol, numHeaderRows, dataColCount).setValues(headers)
    snapDataStartRow = numHeaderRows + 1
  }

  for (let offset = 0; offset < numRows; offset += CHUNK_ROWS) {
    const chunkSize = Math.min(CHUNK_ROWS, numRows - offset)
    const dataRow = t.dataFirstRow + offset
    const values = data
      .getRange(dataRow, minDataCol, chunkSize, dataColCount)
      .getValues()
    snap
      .getRange(snapDataStartRow + offset, minDataCol, chunkSize, dataColCount)
      .setValues(values)
  }

  if (minDataCol > 1) {
    snap.hideColumns(1, minDataCol - 1)
  }

  finishStep()
  Logger.log(
    t.key +
      ': snapshot captured in ' +
      LAST_STEP_ELAPSED +
      's, ' +
      numRows +
      ' rows, cols ' +
      minDataCol +
      '-' +
      maxDataCol,
  )
}

/**
 * Public entry: diff each tracker's data sheet against its snapshot and paint
 * the highlight color onto the matching display cells. Also writes a marker
 * column ('●') on changed rows, used for fast highlight-clearing.
 */
function highlightChanges() {
  const ss = SpreadsheetApp.getActiveSpreadsheet()
  runStandaloneIfNeeded(ss, 'Highlight changes', () => {
    TRACKERS.forEach((t) => {
      try {
        applyHighlightsForTracker(ss, t)
      } catch (e) {
        Logger.log('Highlight failed for ' + t.key + ': ' + e.message)
        throw e
      }
    })
  })
}

/**
 * Sort a display sheet's data rows in place, ascending, by one column so its
 * row order matches the data sheet's canonical order. Only rows at/after
 * `displayFirstRow` are sorted; the header rows above stay put. The whole used
 * width is sorted so every column (icons and any trailing columns) travels with
 * its row. The hidden marker column need not be in range — it's cleared before
 * highlighting and fully rewritten by the paint loop afterwards.
 * @param {Sheet} display
 * @param {Object} t - a TRACKERS entry; uses t.sortDisplayColumn, t.displayFirstRow
 */
function sortDisplayByColumn(display, t) {
  const lastRow = display.getLastRow()
  if (lastRow <= t.displayFirstRow) return // 0 or 1 data rows: nothing to sort
  const lastCol = display.getLastColumn()
  const numRows = lastRow - t.displayFirstRow + 1
  display
    .getRange(t.displayFirstRow, 1, numRows, lastCol)
    .sort({ column: t.sortDisplayColumn, ascending: true })
}

/**
 * Diff a single tracker's snapshot against current data and paint changed
 * cells on the display sheet. Skips columns in `excludeDisplayColumns` and
 * writes a per-row marker in the column after `displayMaxCol` when `useFilter`.
 * @param {Spreadsheet} ss
 * @param {Object} t - a TRACKERS entry
 */
function applyHighlightsForTracker(ss, t) {
  const highlightColor = t.highlightColor || DEX_HIGHLIGHT_COLOR
  startStep(ss, 'Highlighting ' + t.displaySheet)
  const data = ss.getSheetByName(t.dataSheet)
  const display = ss.getSheetByName(t.displaySheet)
  const snap = ss.getSheetByName('_snapshot_' + t.key)
  if (!data || !display)
    throw new Error('Required sheet not found for ' + t.key)
  if (!snap) {
    Logger.log(t.key + ': no snapshot exists, skipping')
    return
  }

  // Highlights are painted onto the display by row offset, so the display must
  // be in the same order as the data sheet. Re-sort it to canonical (column A)
  // order first, undoing any slicer/manual sort, so the paint lands on the
  // right rows and the column-A slicers stay usable.
  if (t.sortDisplayColumn) {
    sortDisplayByColumn(display, t)
  }

  const dataCols = Object.keys(t.columnMap).map((n) => parseInt(n, 10))
  const minDataCol = Math.min(...dataCols)
  const maxDataCol = Math.max(...dataCols)
  const dataColCount = maxDataCol - minDataCol + 1

  const snapDataStartRow = t.includeHeaders ? (t.headerRows || 1) + 1 : 1
  const snapLastRow = snap.getLastRow()
  if (snapLastRow < snapDataStartRow) {
    Logger.log(t.key + ': snapshot is empty')
    return
  }
  const snapDataRows = snapLastRow - snapDataStartRow + 1

  const displayCols = Object.values(t.columnMap)
  const displayMaxCol = Math.max(...displayCols)
  const markerCol = t.useFilter ? displayMaxCol + 1 : null

  if (markerCol) {
    display.hideColumns(markerCol)
  }

  const cellMappings = []
  for (const dataCol of dataCols) {
    const displayCol = t.columnMap[dataCol]
    if (t.excludeDisplayColumns && t.excludeDisplayColumns.has(displayCol)) {
      continue
    }
    cellMappings.push({
      idx: dataCol - minDataCol,
      displayIdx: displayCol - 1,
      color:
        (t.columnHighlightColors && t.columnHighlightColors[displayCol]) ||
        highlightColor,
    })
  }

  let totalChanged = 0
  for (let offset = 0; offset < snapDataRows; offset += CHUNK_ROWS) {
    const chunkSize = Math.min(CHUNK_ROWS, snapDataRows - offset)
    const dataRow = t.dataFirstRow + offset
    const displayRow = t.displayFirstRow + offset

    const snapValues = snap
      .getRange(snapDataStartRow + offset, minDataCol, chunkSize, dataColCount)
      .getValues()
    const currentValues = data
      .getRange(dataRow, minDataCol, chunkSize, dataColCount)
      .getValues()

    const backgrounds = []
    const rowChanged = []
    for (let r = 0; r < chunkSize; r++) {
      backgrounds.push(new Array(displayMaxCol).fill(null))
      rowChanged.push(false)
    }

    for (let r = 0; r < chunkSize; r++) {
      const snapRow = snapValues[r]
      const currentRow = currentValues[r]
      for (const m of cellMappings) {
        if (String(snapRow[m.idx]) !== String(currentRow[m.idx])) {
          backgrounds[r][m.displayIdx] = m.color
          rowChanged[r] = true
          totalChanged++
        }
      }
    }

    display
      .getRange(displayRow, 1, chunkSize, displayMaxCol)
      .setBackgrounds(backgrounds)

    if (markerCol) {
      display
        .getRange(displayRow, markerCol, chunkSize, 1)
        .setValues(rowChanged.map((changed) => [changed ? '●' : '']))
    }
  }

  finishStep()
  Logger.log(
    t.key +
      ': highlighted ' +
      totalChanged +
      ' changed cells in ' +
      LAST_STEP_ELAPSED +
      's',
  )
}

/** Public entry: clear highlight backgrounds (and markers) on every tracker. */
function clearHighlights() {
  const ss = SpreadsheetApp.getActiveSpreadsheet()
  runStandaloneIfNeeded(ss, 'Clear highlights', () => {
    TRACKERS.forEach((t) => clearHighlightsForTracker(ss, t))
  })
}

/**
 * Collapse a sorted list of row offsets into contiguous {start, count} runs,
 * so we can clear them in a few large ranges instead of one call per row.
 * @param {number[]} sortedOffsets
 * @return {{start: number, count: number}[]}
 */
function toRuns(sortedOffsets) {
  const runs = []
  let i = 0
  while (i < sortedOffsets.length) {
    const start = sortedOffsets[i]
    let end = start
    while (
      i + 1 < sortedOffsets.length &&
      sortedOffsets[i + 1] === sortedOffsets[i] + 1
    ) {
      i++
      end = sortedOffsets[i]
    }
    runs.push({ start, count: end - start + 1 })
    i++
  }
  return runs
}

/**
 * Clear highlight backgrounds for one tracker. When `useFilter` is set, reads
 * the marker column to clear only the rows that were actually highlighted
 * (much faster than blanking every row); otherwise clears in chunks.
 * @param {Spreadsheet} ss
 * @param {Object} t - a TRACKERS entry
 */
function clearHighlightsForTracker(ss, t) {
  startStep(ss, 'Clearing ' + t.displaySheet)
  const display = ss.getSheetByName(t.displaySheet)
  if (!display) return
  const lastRow = display.getLastRow()
  if (lastRow < t.displayFirstRow) return

  const displayCols = Object.values(t.columnMap)
  const maxCol = Math.max(...displayCols)
  const markerCol = t.useFilter ? maxCol + 1 : null
  const numRows = lastRow - t.displayFirstRow + 1

  if (markerCol) {
    const markerValues = display
      .getRange(t.displayFirstRow, markerCol, numRows, 1)
      .getValues()

    const changedOffsets = []
    for (let r = 0; r < numRows; r++) {
      if (markerValues[r][0] !== '') changedOffsets.push(r)
    }

    if (changedOffsets.length > 0) {
      const runs = toRuns(changedOffsets)
      runs.forEach(({ start, count }) => {
        display
          .getRange(t.displayFirstRow + start, 1, count, maxCol)
          .setBackground(null)
      })
    }

    display.getRange(t.displayFirstRow, markerCol, numRows, 1).clearContent()
  } else {
    for (let offset = 0; offset < numRows; offset += CHUNK_ROWS) {
      const chunkSize = Math.min(CHUNK_ROWS, numRows - offset)
      display
        .getRange(t.displayFirstRow + offset, 1, chunkSize, maxCol)
        .setBackground(null)
    }
  }

  finishStep()
  Logger.log(t.key + ': highlights cleared in ' + LAST_STEP_ELAPSED + 's')
}
