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
 *   describeLayout()                 what the layout probe resolves to (dry run)
 *
 * Per upload, each tracker costs: 2 header reads (layout probe), 1 read of
 * the display key column, 1 read of the data block, 1 read of the snapshot,
 * ⌈rows/WRITE_CHUNK_ROWS⌉ background writes, and ⌈rows/WRITE_CHUNK_ROWS⌉
 * snapshot writes (from the values already in memory). No marker column, no
 * separate clear pass (painting writes null into every unchanged tracked cell),
 * and the display is only re-sorted when its key column is actually out of
 * order.
 */

import {
  type ResolvedTracker,
  type TrackerSpec,
  describeResolved,
  resolveTracker,
} from './layout.ts'
import {
  failFlow,
  finishFlow,
  finishStep,
  runStandaloneIfNeeded,
  startStep,
} from './progress.ts'

type Spreadsheet = GoogleAppsScript.Spreadsheet.Spreadsheet
type Sheet = GoogleAppsScript.Spreadsheet.Sheet
type CellValue = string | number | boolean | Date | null

export const QUICK_CHECKLIST_HIGHLIGHT_COLOR = '#FFFF00' // yellow
export const DEX_HIGHLIGHT_COLOR = '#93c47d' // light green 1
export const INCREMENT_HIGHLIGHT_COLOR = '#b4a7d6' // light purple 2

/** Row batch for the heavy writes (setBackgrounds / snapshot setValues). */
export const WRITE_CHUNK_ROWS = 500

// Form Checklist: kept sorted so unchecked forms (column C "Done" = ☐) sit
// above checked ones (☑). Re-applied after every upload.
export const FORM_CHECKLIST_SHEET = 'Form Checklist'
export const FORM_CHECKLIST_DONE_COLUMN = 3

/**
 * Snapshot format. v2 stores values at the SAME row/column numbers as the
 * data sheet (plus the header band above), so a diff is a plain same-index
 * compare and nothing needs re-mapping. v1 (before 2026-08) stored the data
 * starting at row headerRows+1. The property records which one is on disk so
 * the first upload after the upgrade still diffs correctly.
 */
export const SNAPSHOT_FORMAT_PROPERTY = 'OFFLINEDEX_SNAPSHOT_FORMAT'
export const SNAPSHOT_FORMAT_V2 = '2'
/** v1 header rows per tracker key (how far down the old data started). */
const V1_HEADER_ROWS: Record<string, number> = { QuickChecklist: 1, StarterDex: 2, FullDex: 2 }

/**
 * Columns the old marker workflow wrote `●` into (Quick Checklist Q, dex
 * sheets EF). Cleared once after the upgrade; see clearLegacyMarkers.
 */
export const LEGACY_MARKERS_PROPERTY = 'OFFLINEDEX_LEGACY_MARKERS_CLEARED'
const LEGACY_MARKER_COLUMNS: Record<string, number> = { QuickChecklist: 17, StarterDex: 136, FullDex: 136 }

// ---------------------------------------------------------------------------
// Tracker specs — header labels, not column numbers. See src/lib/layout.ts.
// ---------------------------------------------------------------------------

function dexSpec(key: string, dataSheet: string, displaySheet: string): TrackerSpec {
  return {
    key,
    dataSheet,
    displaySheet,
    dataFirstRow: 3,
    displayFirstRow: 4,
    // Both sheets label the first data column "Fought Flag" in their row 2.
    dataBlockAnchor: 'Fought Flag',
    displayAnchor: { kind: 'label', text: 'Fought Flag' },
    trackFrom: 'Fought Flag',
    trackTo: null, // through the last labelled column (natures)
    // Auto-calculated columns: never highlight.
    exclude: ['Fought Count', 'Candy Count', 'Friendship'],
    // Counters that increment on an already-unlocked entry: purple.
    increment: ['Caught Count', 'Hatched Count', 'Classic Wins'],
    color: DEX_HIGHLIGHT_COLOR,
    incrementColor: INCREMENT_HIGHLIGHT_COLOR,
    crossCheck: 'Classic Wins',
    sortDisplayColumn: 1,
  }
}

export const TRACKER_SPECS: TrackerSpec[] = [
  {
    key: 'QuickChecklist',
    dataSheet: 'STARTER_CHECKLIST.data',
    displaySheet: 'Quick Checklist',
    dataFirstRow: 12,
    displayFirstRow: 12,
    // Data block "Caught flag … Ribbons" (row 1 of the data sheet) lines up
    // with the display block that starts at the first non-blank cell of row
    // 10 right of the fixed A-D columns (the same rule the Migrator uses; the
    // display's own labels are replaced by stat formulas after migration).
    dataBlockAnchor: 'Caught flag',
    displayAnchor: { kind: 'firstNonBlank', locatorRow: 10, fixedColumns: 4 },
    trackFrom: 'SHINY',
    trackTo: 'Max IVs',
    exclude: [],
    increment: [],
    color: QUICK_CHECKLIST_HIGHLIGHT_COLOR,
    incrementColor: INCREMENT_HIGHLIGHT_COLOR,
    crossCheck: null,
    sortDisplayColumn: 1,
  },
  dexSpec('StarterDex', 'STARTER_DEX.data', 'Starter Dex Checklist'),
  dexSpec('FullDex', 'FULL_DEX.data', 'Full Dex Checklist'),
]

/** Snapshot sheet name for a tracker key. */
export function snapshotSheetName(key: string): string {
  return '_snapshot_' + key
}

type Sheets = { data: Sheet; display: Sheet }

function sheetsFor(ss: Spreadsheet, spec: TrackerSpec): Sheets {
  const data = ss.getSheetByName(spec.dataSheet)
  const display = ss.getSheetByName(spec.displaySheet)
  if (!data) throw new Error(`${spec.dataSheet} not found (needed by ${spec.key})`)
  if (!display) throw new Error(`${spec.displaySheet} not found (needed by ${spec.key})`)
  return { data, display }
}

/** Resolve every tracker against this workbook; throws with a precise message on layout drift. */
export function resolveAll(ss: Spreadsheet): { r: ResolvedTracker; sheets: Sheets }[] {
  return TRACKER_SPECS.map((spec) => {
    const sheets = sheetsFor(ss, spec)
    const r = resolveTracker(spec, sheets.data, sheets.display)
    Logger.log(describeResolved(r))
    return { r, sheets }
  })
}

/** Dry run: what the layout probe finds in this workbook, one line per tracker (or the error). */
export function describeLayout(): string {
  const ss = SpreadsheetApp.getActiveSpreadsheet()
  return TRACKER_SPECS.map((spec) => {
    try {
      const sheets = sheetsFor(ss, spec)
      return describeResolved(resolveTracker(spec, sheets.data, sheets.display))
    } catch (e) {
      return `${spec.key}: ERROR ${e instanceof Error ? e.message : e}`
    }
  }).join('\n')
}

// ---------------------------------------------------------------------------
// Public flow
// ---------------------------------------------------------------------------

/**
 * Full save-upload flow: paint cells that changed since the last snapshot
 * (which also clears stale highlights), re-sort the Form Checklist, then
 * write the new snapshot from the values already read. Assumes the caller
 * (uploadFile) already reset toast state. On failure the user gets an error
 * toast and the error is rethrown for the caller's log.
 */
export function processChanges(options?: { skipSnapshot?: boolean }): void {
  const ss = SpreadsheetApp.getActiveSpreadsheet()
  const skipSnapshot = !!(options && options.skipSnapshot)
  try {
    startStep(ss, 'Checking layout')
    const trackers = resolveAll(ss)
    clearLegacyMarkers(ss)
    finishStep()

    const held: Held[] = []
    for (const { r, sheets } of trackers) {
      held.push(highlightTracker(ss, r, sheets))
    }
    try {
      sortFormChecklistByDone(ss)
    } catch (e) {
      // Cosmetic; never let it block the snapshot.
      Logger.log('Form Checklist sort failed: ' + (e instanceof Error ? e.message : e))
    }
    if (!skipSnapshot) {
      for (const h of held) writeSnapshot(ss, h)
      markSnapshotFormatV2()
    }
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
    for (const { r, sheets } of resolveAll(ss)) {
      startStep(ss, 'Reading ' + r.spec.displaySheet)
      const current = readDataBlock(r, sheets.data)
      const snap = ss.getSheetByName(snapshotSheetName(r.spec.key))
      finishStep()
      // Standalone: we haven't read the old snapshot, so always clear it.
      writeSnapshot(ss, { r, snap, current, previousLastRow: Number.MAX_SAFE_INTEGER, previousIsV2: false })
    }
    markSnapshotFormatV2()
  })
}

/** Public entry: diff each tracker against its snapshot and paint the display. */
export function highlightChanges(): void {
  const ss = SpreadsheetApp.getActiveSpreadsheet()
  runStandaloneIfNeeded(ss, 'Highlight changes', () => {
    const trackers = resolveAll(ss)
    clearLegacyMarkers(ss)
    for (const { r, sheets } of trackers) highlightTracker(ss, r, sheets)
  })
}

/** Public entry: clear highlight backgrounds on every tracker's tracked block. */
export function clearHighlights(): void {
  const ss = SpreadsheetApp.getActiveSpreadsheet()
  runStandaloneIfNeeded(ss, 'Clear highlights', () => {
    for (const { r, sheets } of resolveAll(ss)) {
      startStep(ss, 'Clearing ' + r.spec.displaySheet)
      const numRows = displayRowCount(sheets.display, r)
      const width = r.maxDisplayCol - r.minDisplayCol + 1
      for (let offset = 0; offset < numRows; offset += WRITE_CHUNK_ROWS) {
        const n = Math.min(WRITE_CHUNK_ROWS, numRows - offset)
        sheets.display.getRange(r.spec.displayFirstRow + offset, r.minDisplayCol, n, width).setBackground(null)
      }
      finishStep()
    }
  })
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function displayRowCount(display: Sheet, r: ResolvedTracker): number {
  return Math.max(0, display.getLastRow() - r.spec.displayFirstRow + 1)
}

/** The whole tracked block of the data sheet, from dataFirstRow to the last row. One read. */
export function readDataBlock(r: ResolvedTracker, data: Sheet): CellValue[][] {
  const lastRow = data.getLastRow()
  const numRows = lastRow - r.spec.dataFirstRow + 1
  if (numRows <= 0) return []
  return data
    .getRange(r.spec.dataFirstRow, r.minDataCol, numRows, r.maxDataCol - r.minDataCol + 1)
    .getValues() as CellValue[][]
}

/**
 * The snapshot's rows for this tracker, aligned so that index i is data row
 * dataFirstRow + i — regardless of whether the sheet holds a v1 or v2 layout.
 * Returns null when there is no usable snapshot yet.
 */
export function readSnapshotBlock(r: ResolvedTracker, snap: Sheet | null): { rows: CellValue[][]; lastRow: number; isV2: boolean } | null {
  if (!snap) return null
  const isV2 = snapshotFormatOnDisk() === SNAPSHOT_FORMAT_V2
  const firstRow = isV2 ? r.spec.dataFirstRow : (V1_HEADER_ROWS[r.spec.key] ?? 1) + 1
  const lastRow = snap.getLastRow()
  const numRows = lastRow - firstRow + 1
  if (numRows <= 0) return null
  const rows = snap.getRange(firstRow, r.minDataCol, numRows, r.maxDataCol - r.minDataCol + 1).getValues() as CellValue[][]
  return { rows, lastRow, isV2 }
}

function snapshotFormatOnDisk(): string | null {
  return PropertiesService.getDocumentProperties().getProperty(SNAPSHOT_FORMAT_PROPERTY)
}
function markSnapshotFormatV2(): void {
  PropertiesService.getDocumentProperties().setProperty(SNAPSHOT_FORMAT_PROPERTY, SNAPSHOT_FORMAT_V2)
}

// ---------------------------------------------------------------------------
// Diff + paint
// ---------------------------------------------------------------------------

/**
 * Pure diff: for each data row, the background of every display column in
 * [minDisplayCol, maxDisplayCol] (null = clear), and the count of changed
 * cells. Excluded columns are always null. Rows beyond the snapshot compare
 * against blanks (new Pokémon show as changed).
 */
export function diffBlocks(
  r: ResolvedTracker,
  snapValues: CellValue[][],
  currentValues: CellValue[][],
): { backgrounds: (string | null)[][]; changed: number } {
  const width = r.maxDisplayCol - r.minDisplayCol + 1
  const backgrounds: (string | null)[][] = []
  let changed = 0
  for (let i = 0; i < currentValues.length; i++) {
    const row = new Array<string | null>(width).fill(null)
    const cur = currentValues[i] ?? []
    const old = snapValues[i] ?? []
    for (const cell of r.cells) {
      if (cell.color === null) continue
      const k = cell.dataCol - r.minDataCol
      if (String(old[k] ?? '') !== String(cur[k] ?? '')) {
        row[cell.displayCol - r.minDisplayCol] = cell.color
        changed++
      }
    }
    backgrounds.push(row)
  }
  return { backgrounds, changed }
}

/**
 * The permutation that sorts `keys` ascending the way Sheets does for a
 * mixed numeric/text key column (numbers first, ascending; then text,
 * case-insensitive; blanks last; stable). Returns null when already sorted.
 */
export function outOfOrder(keys: CellValue[]): boolean {
  for (let i = 1; i < keys.length; i++) {
    if (compareKeys(keys[i - 1]!, keys[i]!) > 0) return true
  }
  return false
}

function compareKeys(a: CellValue, b: CellValue): number {
  const an = typeof a === 'number' ? a : Number(a)
  const bn = typeof b === 'number' ? b : Number(b)
  const aNum = a !== '' && a !== null && !Number.isNaN(an)
  const bNum = b !== '' && b !== null && !Number.isNaN(bn)
  if (aNum && bNum) return an - bn
  if (aNum) return -1
  if (bNum) return 1
  const as = a === null ? '' : String(a)
  const bs = b === null ? '' : String(b)
  if (as === '' && bs !== '') return 1
  if (bs === '' && as !== '') return -1
  return as.localeCompare(bs, undefined, { sensitivity: 'base' })
}

/**
 * Re-sort the display's data rows by the key column, but only when they are
 * actually out of order (a slicer or manual sort moved them). Painting is by
 * row offset, so the display must be in the data sheet's canonical order.
 */
export function ensureDisplayOrder(display: Sheet, r: ResolvedTracker): boolean {
  const numRows = displayRowCount(display, r)
  if (numRows <= 1) return false
  const keys = display
    .getRange(r.spec.displayFirstRow, r.spec.sortDisplayColumn, numRows, 1)
    .getValues()
    .map((row) => row[0] as CellValue)
  if (!outOfOrder(keys)) return false
  const lastCol = display.getLastColumn()
  display
    .getRange(r.spec.displayFirstRow, 1, numRows, lastCol)
    .sort({ column: r.spec.sortDisplayColumn, ascending: true })
  Logger.log(`${r.spec.key}: display was out of order; re-sorted by column ${r.spec.sortDisplayColumn}`)
  return true
}

/**
 * One tracker: read data + snapshot, diff, paint the tracked block (null
 * backgrounds clear old highlights), and return the values for the snapshot
 * step so nothing is read twice.
 */
export type Held = {
  r: ResolvedTracker
  snap: Sheet | null
  current: CellValue[][]
  /** Last row of the snapshot sheet as found (0 = none) and whether it was already v2. */
  previousLastRow: number
  previousIsV2: boolean
}

export function highlightTracker(ss: Spreadsheet, r: ResolvedTracker, sheets: Sheets): Held {
  startStep(ss, 'Highlighting ' + r.spec.displaySheet)
  const snap = ss.getSheetByName(snapshotSheetName(r.spec.key))
  const current = readDataBlock(r, sheets.data)
  const previous = readSnapshotBlock(r, snap)
  const held = { r, snap, current, previousLastRow: previous?.lastRow ?? 0, previousIsV2: previous?.isV2 ?? true }

  if (!previous) {
    Logger.log(`${r.spec.key}: no snapshot yet, nothing to highlight`)
    finishStep()
    return held
  }

  ensureDisplayOrder(sheets.display, r)

  const { backgrounds, changed } = diffBlocks(r, previous.rows, current)
  const width = r.maxDisplayCol - r.minDisplayCol + 1
  for (let offset = 0; offset < backgrounds.length; offset += WRITE_CHUNK_ROWS) {
    const chunk = backgrounds.slice(offset, offset + WRITE_CHUNK_ROWS)
    sheets.display
      .getRange(r.spec.displayFirstRow + offset, r.minDisplayCol, chunk.length, width)
      .setBackgrounds(chunk)
  }
  finishStep()
  Logger.log(`${r.spec.key}: highlighted ${changed} changed cells over ${current.length} rows`)
  return held
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/**
 * Write the tracker's current values into its hidden snapshot sheet (v2
 * layout: same rows/columns as the data sheet, header band copied above for
 * readability). Creates the sheet on first run. The old contents are only
 * cleared when they could leave stale rows behind (upgrade from v1, or the
 * data shrank) — otherwise the writes simply overwrite in place.
 */
export function writeSnapshot(ss: Spreadsheet, h: Held): void {
  const { r, current } = h
  startStep(ss, 'Snapshotting ' + r.spec.displaySheet)
  let snap = h.snap
  const newLastRow = r.spec.dataFirstRow + current.length - 1
  if (!snap) {
    snap = ss.insertSheet(snapshotSheetName(r.spec.key))
    snap.hideSheet()
  } else if (!h.previousIsV2 || h.previousLastRow > newLastRow) {
    snap.clear()
  }
  const width = r.maxDataCol - r.minDataCol + 1
  const headerRows = Math.min(r.spec.dataFirstRow - 1, r.dataBand.length)
  if (headerRows > 0) {
    const band = r.dataBand.slice(0, headerRows).map((row) => {
      const out: CellValue[] = []
      for (let c = r.minDataCol; c <= r.maxDataCol; c++) out.push((row[c - 1] as CellValue) ?? '')
      return out
    })
    snap.getRange(1, r.minDataCol, headerRows, width).setValues(band)
  }
  for (let offset = 0; offset < current.length; offset += WRITE_CHUNK_ROWS) {
    const chunk = current.slice(offset, offset + WRITE_CHUNK_ROWS)
    snap.getRange(r.spec.dataFirstRow + offset, r.minDataCol, chunk.length, width).setValues(chunk)
  }
  finishStep()
  Logger.log(`${r.spec.key}: snapshot written, ${current.length} rows`)
}

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

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

/**
 * One-time cleanup after the marker-column workflow was removed: blank the
 * `●` markers the old code left in the (hidden) columns past each display
 * block. Idempotent via a document property; costs one clearContent per
 * tracker, once.
 */
export function clearLegacyMarkers(ss: Spreadsheet): void {
  const props = PropertiesService.getDocumentProperties()
  if (props.getProperty(LEGACY_MARKERS_PROPERTY)) return
  for (const spec of TRACKER_SPECS) {
    const col = LEGACY_MARKER_COLUMNS[spec.key]
    const display = ss.getSheetByName(spec.displaySheet)
    if (!col || !display) continue
    const numRows = display.getLastRow() - spec.displayFirstRow + 1
    if (numRows <= 0) continue
    const range = display.getRange(spec.displayFirstRow, col, numRows, 1)
    // Only ever blank a column that holds nothing but our markers.
    const values = range.getValues()
    if (!values.every((row) => row[0] === '' || row[0] === '●')) continue
    if (values.some((row) => row[0] === '●')) range.clearContent()
  }
  props.setProperty(LEGACY_MARKERS_PROPERTY, 'true')
  Logger.log('Legacy marker columns cleared')
}
