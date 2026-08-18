/**
 * SAVE TRACKER
 *
 * Tracks changes in source-of-truth data sheets and highlights the
 * corresponding cells in display sheets after each save upload.
 *
 * Public (exposed as OfflineDexLib.<name> via index.ts):
 *   processChanges()                 full flow used by uploadFile
 *   processChangesWithoutSnapshot()  same, but keeps the existing baseline
 *   snapshot()                       capture current values to snapshots
 *   highlightChanges()               paint cells that differ from snapshot
 *   clearHighlights()                clear highlight backgrounds
 */

import {
  failFlow,
  finishFlow,
  finishStep,
  runStandaloneIfNeeded,
  startStep,
} from './progress.ts'

type Spreadsheet = GoogleAppsScript.Spreadsheet.Spreadsheet
type Sheet = GoogleAppsScript.Spreadsheet.Sheet

export const QUICK_CHECKLIST_HIGHLIGHT_COLOR = '#FFFF00' // yellow
export const DEX_HIGHLIGHT_COLOR = '#93c47d' // light green 1
export const INCREMENT_HIGHLIGHT_COLOR = '#b4a7d6' // light purple 2
export const CHUNK_ROWS = 200

// Form Checklist: kept sorted so unchecked forms (column C "Done" = ☐) sit
// above checked ones (☑). Re-applied after every upload.
export const FORM_CHECKLIST_SHEET = 'Form Checklist'
export const FORM_CHECKLIST_DONE_COLUMN = 3

export type ColumnMap = Record<number, number>

export type Tracker = {
  key: string
  dataSheet: string
  displaySheet: string
  dataFirstRow: number
  displayFirstRow: number
  /** dataCol -> displayCol (both 1-based). */
  columnMap: ColumnMap
  includeHeaders: boolean
  headerRows: number
  highlightColor?: string
  /** Display columns that are auto-calculated and must never be highlighted. */
  excludeDisplayColumns?: Set<number>
  /** {displayCol: color} overrides (e.g. counters get the increment colour). */
  columnHighlightColors?: Record<number, string>
  /** Enables the hidden marker-column workflow used for fast clearing. */
  useFilter: boolean
  /** Re-sort the display by this 1-based column before painting. */
  sortDisplayColumn?: number
  /** Marker column override (default: first column past the tracked range). */
  markerColumn?: number
}

/**
 * Build a column map for a contiguous range of data columns shifted to
 * display columns: `{dataCol: dataCol + shift}` for every col in [start, end].
 */
export function buildShiftMap(dataStart: number, dataEnd: number, shift: number): ColumnMap {
  const map: ColumnMap = {}
  for (let c = dataStart; c <= dataEnd; c++) map[c] = c + shift
  return map
}

/**
 * The two dex checklists share every setting except their sheet names and
 * column map: display starts one row below the data (two header rows), the
 * auto-calculated columns E/AH/AI are never highlighted, and the count columns
 * N (caught), AB (hatched), AO (wins) get the purple increment highlight since
 * they change on entries that were already unlocked.
 */
function dexTracker(key: string, dataSheet: string, displaySheet: string, columnMap: ColumnMap): Tracker {
  return {
    key,
    dataSheet,
    displaySheet,
    dataFirstRow: 3,
    displayFirstRow: 4,
    columnMap,
    includeHeaders: true,
    headerRows: 2,
    excludeDisplayColumns: new Set([5, 34, 35]),
    columnHighlightColors: {
      14: INCREMENT_HIGHLIGHT_COLOR,
      28: INCREMENT_HIGHLIGHT_COLOR,
      41: INCREMENT_HIGHLIGHT_COLOR,
    },
    useFilter: true,
    sortDisplayColumn: 1,
  }
}

export const TRACKERS: Tracker[] = [
  {
    key: 'QuickChecklist',
    dataSheet: 'STARTER_CHECKLIST.data',
    displaySheet: 'Quick Checklist',
    dataFirstRow: 12,
    displayFirstRow: 12,
    // Data D-K (SHINY … Max IVs) -> display H-O. Creator 6.03 layout: A-D
    // fixed, hidden junk E, then Caught? F, Classic G, Shiny H … Max IVs O,
    // Ribbons P. (6.01 had no column E: shift was 3, D-K -> G-N.)
    columnMap: buildShiftMap(4, 11, 4),
    includeHeaders: true,
    headerRows: 1,
    highlightColor: QUICK_CHECKLIST_HIGHLIGHT_COLOR,
    useFilter: true,
    sortDisplayColumn: 1,
    // P is the creator's Ribbons column (kept hidden by the Migrator), so the
    // marker goes one further, to Q.
    markerColumn: 17,
  },
  dexTracker('StarterDex', 'STARTER_DEX.data', 'Starter Dex Checklist', buildShiftMap(12, 143, -8)),
  dexTracker('FullDex', 'FULL_DEX.data', 'Full Dex Checklist', buildShiftMap(8, 139, -4)),
]

/** Snapshot sheet name for a tracker key. */
export function snapshotSheetName(key: string): string {
  return '_snapshot_' + key
}

/**
 * The display column that receives the per-row `●` marker for a tracker, or
 * null when the tracker doesn't use markers.
 */
export function markerColumnFor(t: Tracker): number | null {
  if (!t.useFilter) return null
  if (t.markerColumn) return t.markerColumn
  return Math.max(...Object.values(t.columnMap)) + 1
}

function dataColumnSpan(t: Tracker): { dataCols: number[]; minDataCol: number; maxDataCol: number; count: number } {
  const dataCols = Object.keys(t.columnMap).map((n) => parseInt(n, 10))
  if (dataCols.length === 0) throw new Error('Empty columnMap for ' + t.key)
  const minDataCol = Math.min(...dataCols)
  const maxDataCol = Math.max(...dataCols)
  return { dataCols, minDataCol, maxDataCol, count: maxDataCol - minDataCol + 1 }
}

// ---------------------------------------------------------------------------
// Public flow
// ---------------------------------------------------------------------------

/**
 * Full save-upload flow: clear stale highlights, paint cells that changed
 * since the last snapshot, then capture a new snapshot for next time.
 * Assumes the caller (uploadFile) already reset toast state. On failure the
 * user gets an error toast (not a stuck "Highlighting…" one) and the error is
 * rethrown for the caller's log.
 */
export function processChanges(options?: { skipSnapshot?: boolean }): void {
  const ss = SpreadsheetApp.getActiveSpreadsheet()
  const skipSnapshot = !!(options && options.skipSnapshot)
  try {
    clearHighlights()
    highlightChanges()
    try {
      sortFormChecklistByDone(ss)
    } catch (e) {
      // Cosmetic; never let it block the snapshot.
      Logger.log('Form Checklist sort failed: ' + (e instanceof Error ? e.message : e))
    }
    if (!skipSnapshot) snapshot()
  } catch (e) {
    failFlow(ss, e)
    throw e
  }
  finishFlow(ss, skipSnapshot ? 'All sheets processed (baseline kept)' : 'All sheets processed')
}

/** Same as processChanges, but the current snapshot stays the diff baseline. */
export function processChangesWithoutSnapshot(): void {
  processChanges({ skipSnapshot: true })
}

/** Public entry: capture every tracker's data sheet into its hidden snapshot. */
export function snapshot(): void {
  const ss = SpreadsheetApp.getActiveSpreadsheet()
  runStandaloneIfNeeded(ss, 'Snapshot', () => {
    TRACKERS.forEach((t) => {
      try {
        captureSnapshotForTracker(ss, t)
      } catch (e) {
        Logger.log('Snapshot failed for ' + t.key + ': ' + (e instanceof Error ? e.message : e))
        throw e
      }
    })
  })
}

/** Public entry: diff each tracker against its snapshot and paint the display. */
export function highlightChanges(): void {
  const ss = SpreadsheetApp.getActiveSpreadsheet()
  runStandaloneIfNeeded(ss, 'Highlight changes', () => {
    TRACKERS.forEach((t) => {
      try {
        applyHighlightsForTracker(ss, t)
      } catch (e) {
        Logger.log('Highlight failed for ' + t.key + ': ' + (e instanceof Error ? e.message : e))
        throw e
      }
    })
  })
}

/** Public entry: clear highlight backgrounds (and markers) on every tracker. */
export function clearHighlights(): void {
  const ss = SpreadsheetApp.getActiveSpreadsheet()
  runStandaloneIfNeeded(ss, 'Clear highlights', () => {
    TRACKERS.forEach((t) => clearHighlightsForTracker(ss, t))
  })
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/**
 * Write a single tracker's current data values into its hidden snapshot sheet,
 * creating the sheet on first run. Reads/writes in CHUNK_ROWS-sized batches.
 */
export function captureSnapshotForTracker(ss: Spreadsheet, t: Tracker): void {
  startStep(ss, 'Snapshotting ' + t.displaySheet)
  const data = ss.getSheetByName(t.dataSheet)
  const display = ss.getSheetByName(t.displaySheet)
  if (!data) throw new Error(t.dataSheet + ' not found')
  if (!display) throw new Error(t.displaySheet + ' not found')

  const { minDataCol, maxDataCol, count } = dataColumnSpan(t)

  const lastRow = data.getLastRow()
  if (lastRow < t.dataFirstRow) {
    Logger.log(t.key + ': no data to snapshot')
    return
  }
  const numRows = lastRow - t.dataFirstRow + 1

  const snapName = snapshotSheetName(t.key)
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
    const headers = data.getRange(1, minDataCol, numHeaderRows, count).getValues()
    snap.getRange(1, minDataCol, numHeaderRows, count).setValues(headers)
    snapDataStartRow = numHeaderRows + 1
  }

  for (let offset = 0; offset < numRows; offset += CHUNK_ROWS) {
    const chunkSize = Math.min(CHUNK_ROWS, numRows - offset)
    const values = data.getRange(t.dataFirstRow + offset, minDataCol, chunkSize, count).getValues()
    snap.getRange(snapDataStartRow + offset, minDataCol, chunkSize, count).setValues(values)
  }

  if (minDataCol > 1) snap.hideColumns(1, minDataCol - 1)

  finishStep()
  Logger.log(`${t.key}: snapshot captured, ${numRows} rows, cols ${minDataCol}-${maxDataCol}`)
}

// ---------------------------------------------------------------------------
// Highlight
// ---------------------------------------------------------------------------

/**
 * Sort a display sheet's data rows in place, ascending, by one column so its
 * row order matches the data sheet's canonical order. Header rows stay put.
 */
export function sortDisplayByColumn(display: Sheet, t: Tracker): void {
  if (!t.sortDisplayColumn) return
  const lastRow = display.getLastRow()
  if (lastRow <= t.displayFirstRow) return
  const lastCol = display.getLastColumn()
  const numRows = lastRow - t.displayFirstRow + 1
  display
    .getRange(t.displayFirstRow, 1, numRows, lastCol)
    .sort({ column: t.sortDisplayColumn, ascending: true })
}

export type CellMapping = { idx: number; displayIdx: number; color: string }

/** Precompute, per tracked data column, where it paints and in what colour. */
export function cellMappingsFor(t: Tracker): CellMapping[] {
  const { dataCols, minDataCol } = dataColumnSpan(t)
  const highlightColor = t.highlightColor || DEX_HIGHLIGHT_COLOR
  const out: CellMapping[] = []
  for (const dataCol of dataCols) {
    const displayCol = t.columnMap[dataCol]!
    if (t.excludeDisplayColumns && t.excludeDisplayColumns.has(displayCol)) continue
    out.push({
      idx: dataCol - minDataCol,
      displayIdx: displayCol - 1,
      color: (t.columnHighlightColors && t.columnHighlightColors[displayCol]) || highlightColor,
    })
  }
  return out
}

/**
 * Pure diff of one chunk: for each row, which display cells changed and in
 * what colour. `backgrounds` is `width` wide starting at display column 1.
 */
export function diffChunk(
  snapValues: unknown[][],
  currentValues: unknown[][],
  mappings: CellMapping[],
  width: number,
): { backgrounds: (string | null)[][]; rowChanged: boolean[]; changed: number } {
  const backgrounds: (string | null)[][] = []
  const rowChanged: boolean[] = []
  let changed = 0
  for (let r = 0; r < snapValues.length; r++) {
    const row: (string | null)[] = new Array<string | null>(width).fill(null)
    let any = false
    const snapRow = snapValues[r] ?? []
    const currentRow = currentValues[r] ?? []
    for (const m of mappings) {
      if (String(snapRow[m.idx]) !== String(currentRow[m.idx])) {
        row[m.displayIdx] = m.color
        any = true
        changed++
      }
    }
    backgrounds.push(row)
    rowChanged.push(any)
  }
  return { backgrounds, rowChanged, changed }
}

/**
 * Diff a single tracker's snapshot against current data and paint changed
 * cells on the display sheet; write a per-row marker when `useFilter`.
 */
export function applyHighlightsForTracker(ss: Spreadsheet, t: Tracker): void {
  startStep(ss, 'Highlighting ' + t.displaySheet)
  const data = ss.getSheetByName(t.dataSheet)
  const display = ss.getSheetByName(t.displaySheet)
  const snap = ss.getSheetByName(snapshotSheetName(t.key))
  if (!data || !display) throw new Error('Required sheet not found for ' + t.key)

  // Hide the marker column even on the very first (snapshot-less) upload.
  const markerCol = markerColumnFor(t)
  if (markerCol) display.hideColumns(markerCol)

  if (!snap) {
    Logger.log(t.key + ': no snapshot exists, skipping')
    return
  }

  sortDisplayByColumn(display, t)

  const { minDataCol, count } = dataColumnSpan(t)
  const snapDataStartRow = t.includeHeaders ? (t.headerRows || 1) + 1 : 1
  const snapLastRow = snap.getLastRow()
  if (snapLastRow < snapDataStartRow) {
    Logger.log(t.key + ': snapshot is empty')
    return
  }
  const snapDataRows = snapLastRow - snapDataStartRow + 1
  const displayMaxCol = Math.max(...Object.values(t.columnMap))
  const mappings = cellMappingsFor(t)

  let totalChanged = 0
  for (let offset = 0; offset < snapDataRows; offset += CHUNK_ROWS) {
    const chunkSize = Math.min(CHUNK_ROWS, snapDataRows - offset)
    const dataRow = t.dataFirstRow + offset
    const displayRow = t.displayFirstRow + offset

    const snapValues = snap.getRange(snapDataStartRow + offset, minDataCol, chunkSize, count).getValues()
    const currentValues = data.getRange(dataRow, minDataCol, chunkSize, count).getValues()
    const { backgrounds, rowChanged, changed } = diffChunk(snapValues, currentValues, mappings, displayMaxCol)
    totalChanged += changed

    display.getRange(displayRow, 1, chunkSize, displayMaxCol).setBackgrounds(backgrounds)
    if (markerCol) {
      display
        .getRange(displayRow, markerCol, chunkSize, 1)
        .setValues(rowChanged.map((c) => [c ? '●' : '']))
    }
  }

  finishStep()
  Logger.log(`${t.key}: highlighted ${totalChanged} changed cells`)
}

/**
 * Sort the Form Checklist's data rows by column C ("Done") ascending so
 * unchecked forms (☐) sit above checked ones (☑); the header row stays put.
 */
export function sortFormChecklistByDone(ss: Spreadsheet): void {
  const sheet = ss.getSheetByName(FORM_CHECKLIST_SHEET)
  if (!sheet) {
    Logger.log(FORM_CHECKLIST_SHEET + ' not found, skipping sort')
    return
  }
  startStep(ss, 'Sorting ' + FORM_CHECKLIST_SHEET)
  const lastRow = sheet.getLastRow()
  const lastCol = sheet.getLastColumn()
  if (lastRow > 2) {
    sheet.getRange(2, 1, lastRow - 1, lastCol).sort({ column: FORM_CHECKLIST_DONE_COLUMN, ascending: true })
  }
  finishStep()
}

// ---------------------------------------------------------------------------
// Clear
// ---------------------------------------------------------------------------

/** Collapse sorted row offsets into contiguous {start, count} runs. */
export function toRuns(sortedOffsets: number[]): { start: number; count: number }[] {
  const runs: { start: number; count: number }[] = []
  let i = 0
  while (i < sortedOffsets.length) {
    const start = sortedOffsets[i]!
    let end = start
    while (i + 1 < sortedOffsets.length && sortedOffsets[i + 1] === sortedOffsets[i]! + 1) {
      i++
      end = sortedOffsets[i]!
    }
    runs.push({ start, count: end - start + 1 })
    i++
  }
  return runs
}

/**
 * Clear highlight backgrounds for one tracker. With `useFilter`, reads the
 * marker column to clear only the rows that were highlighted; otherwise
 * clears in chunks.
 */
export function clearHighlightsForTracker(ss: Spreadsheet, t: Tracker): void {
  startStep(ss, 'Clearing ' + t.displaySheet)
  const display = ss.getSheetByName(t.displaySheet)
  if (!display) return
  const lastRow = display.getLastRow()
  if (lastRow < t.displayFirstRow) return

  const maxCol = Math.max(...Object.values(t.columnMap))
  const markerCol = markerColumnFor(t)
  const numRows = lastRow - t.displayFirstRow + 1

  if (markerCol) {
    const markerValues = display.getRange(t.displayFirstRow, markerCol, numRows, 1).getValues()
    const changedOffsets: number[] = []
    for (let r = 0; r < numRows; r++) {
      if (markerValues[r]![0] !== '') changedOffsets.push(r)
    }
    if (changedOffsets.length > 0) {
      toRuns(changedOffsets).forEach(({ start, count }) => {
        display.getRange(t.displayFirstRow + start, 1, count, maxCol).setBackground(null)
      })
    }
    display.getRange(t.displayFirstRow, markerCol, numRows, 1).clearContent()
  } else {
    for (let offset = 0; offset < numRows; offset += CHUNK_ROWS) {
      const chunkSize = Math.min(CHUNK_ROWS, numRows - offset)
      display.getRange(t.displayFirstRow + offset, 1, chunkSize, maxCol).setBackground(null)
    }
  }

  finishStep()
  Logger.log(t.key + ': highlights cleared')
}
