/**
 * SAVE TRACKER
 *
 * Tracks changes in source-of-truth data sheets and highlights the
 * corresponding cells in display sheets after each save upload.
 *
 * Public (exposed as OfflineDexLib.<name> via index.ts):
 *   processChanges()                 full flow used by uploadFileTracked
 *   processChangesWithoutSnapshot()  same, but keeps the existing baseline
 *   snapshot()                       capture current values as the baseline
 *   highlightChanges()               paint cells that differ from the baseline
 *   clearHighlights()                clear highlight backgrounds
 *   describeLayout()                 what the layout probe resolves to (dry run)
 *
 * All bulk I/O goes through the Sheets API, because in this workbook every
 * SpreadsheetApp call costs ~1 s (formula-heavy) and 145k-cell reads/writes
 * cost 15–25 s. Per upload:
 *   1 spreadsheets.get   (sheet ids / sizes)
 *   1 values.batchGet    (header bands, display key columns, all data blocks,
 *                         all snapshots — one HTTP call)
 *   1 batchUpdate        (clear last upload's highlighted rows, paint the
 *                         changed rows — only those rows travel)
 *   1 values.batchUpdate (snapshots as compact JSON in a few cells)
 * plus the Form Checklist sort and, only if a slicer moved rows, a display sort.
 *
 * Snapshot format v3: `_snapshot_<key>` holds JSON — A1 = metadata (rows,
 * columns, which display rows are currently highlighted), A2… = chunks of
 * rows. Older grid snapshots (v1: data from row headerRows+1; v2: data at the
 * data sheet's own row numbers) are still read once and converted.
 */

import {
  type ResolvedTracker,
  type TrackerSpec,
  describeResolved,
  resolveFromBands,
} from './layout.ts'
import {
  failFlow,
  finishFlow,
  finishStep,
  runStandaloneIfNeeded,
  startStep,
} from './progress.ts'
import {
  type Request,
  type SheetsClient,
  type SpreadsheetInfo,
  a1,
  hexToColor,
  liveSheets,
  padValues,
  sheetRange,
} from './sheetsApi.ts'

type Spreadsheet = GoogleAppsScript.Spreadsheet.Spreadsheet
type CellValue = string | number | boolean | null

export const QUICK_CHECKLIST_HIGHLIGHT_COLOR = '#ffff00' // yellow
export const DEX_HIGHLIGHT_COLOR = '#93c47d' // light green 1
export const INCREMENT_HIGHLIGHT_COLOR = '#b4a7d6' // light purple 2

// Form Checklist: kept sorted so unchecked forms (column C "Done" = ☐) sit
// above checked ones (☑). Re-applied after every upload.
export const FORM_CHECKLIST_SHEET = 'Form Checklist'
export const FORM_CHECKLIST_DONE_COLUMN = 3

/** Which snapshot layout is on disk: '3' = JSON cells; '2' = grid at data rows; unset = v1 grid. */
export const SNAPSHOT_FORMAT_PROPERTY = 'OFFLINEDEX_SNAPSHOT_FORMAT'
export const SNAPSHOT_FORMAT_V3 = '3'
const V1_HEADER_ROWS: Record<string, number> = {
  QuickChecklist: 1,
  StarterDex: 2,
  FullDex: 2,
}
/** Max characters per snapshot cell (Sheets allows 50,000). */
const SNAPSHOT_CELL_CHARS = 45000

/** Columns the old marker workflow wrote `●` into (Quick Checklist Q, dex sheets EF); cleared once. */
export const LEGACY_MARKERS_PROPERTY = 'OFFLINEDEX_LEGACY_MARKERS_CLEARED'
const LEGACY_MARKER_COLUMNS: Record<string, number> = {
  QuickChecklist: 17,
  StarterDex: 136,
  FullDex: 136,
}

/** Rows of the header band read for the layout probe. */
const HEADER_BAND_ROWS = 10

// ---------------------------------------------------------------------------
// Tracker specs — header labels, not column numbers. See src/lib/layout.ts.
// ---------------------------------------------------------------------------

function dexSpec(
  key: string,
  dataSheet: string,
  displaySheet: string,
): TrackerSpec {
  return {
    key,
    dataSheet,
    displaySheet,
    dataFirstRow: 3,
    displayFirstRow: 4,
    dataBlockAnchor: 'Fought Flag',
    displayAnchor: { kind: 'label', text: 'Fought Flag' },
    trackFrom: 'Fought Flag',
    trackTo: null,
    exclude: ['Fought Count', 'Candy Count', 'Friendship'],
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

export function snapshotSheetName(key: string): string {
  return '_snapshot_' + key
}

// ---------------------------------------------------------------------------
// Snapshot encoding (pure)
// ---------------------------------------------------------------------------

export type Run = { start: number; count: number }

export type SnapshotMeta = {
  v: 3
  /** Data sheet row of rows[0] and the tracked column span, as they were when written. */
  firstRow: number
  minCol: number
  maxCol: number
  rows: number
  /** Number of chunk cells below A1 (so leftovers can be blanked on rewrite). */
  cells: number
  /** Header label of each tracked column, in order — lets a later upload realign after a creator column insert. */
  labels: string[]
  /** Display rows currently highlighted, as {start,count} offsets from displayFirstRow. */
  painted: Run[]
}

/** Split rows into JSON strings each under the per-cell limit. */
export function encodeSnapshotChunks(rows: CellValue[][]): string[] {
  const chunks: string[] = []
  let buf: CellValue[][] = []
  let size = 2
  for (const row of rows) {
    const s = JSON.stringify(row)
    if (buf.length && size + s.length + 1 > SNAPSHOT_CELL_CHARS) {
      chunks.push(JSON.stringify(buf))
      buf = []
      size = 2
    }
    buf.push(row)
    size += s.length + 1
  }
  if (buf.length || chunks.length === 0) chunks.push(JSON.stringify(buf))
  return chunks
}

export function decodeSnapshotChunks(cells: unknown[]): CellValue[][] {
  const rows: CellValue[][] = []
  for (const c of cells) {
    if (c === '' || c === null || c === undefined) continue
    const parsed = JSON.parse(String(c)) as CellValue[][]
    for (const r of parsed) rows.push(r)
  }
  return rows
}

/** Collapse sorted row offsets into contiguous runs. */
export function toRuns(sortedOffsets: number[]): Run[] {
  const runs: Run[] = []
  let i = 0
  while (i < sortedOffsets.length) {
    const start = sortedOffsets[i]!
    let end = start
    while (
      i + 1 < sortedOffsets.length &&
      sortedOffsets[i + 1] === sortedOffsets[i]! + 1
    ) {
      i++
      end = sortedOffsets[i]!
    }
    runs.push({ start, count: end - start + 1 })
    i++
  }
  return runs
}

// ---------------------------------------------------------------------------
// Diff (pure)
// ---------------------------------------------------------------------------

/**
 * For each data row that has a change, the colour of every tracked display
 * column (null = no highlight). Excluded columns are never coloured. Rows
 * beyond the snapshot compare against blanks.
 */
export function diffBlocks(
  r: ResolvedTracker,
  snapValues: CellValue[][],
  currentValues: CellValue[][],
): { rowColors: Map<number, (string | null)[]>; changed: number } {
  const width = r.maxDisplayCol - r.minDisplayCol + 1
  const rowColors = new Map<number, (string | null)[]>()
  let changed = 0
  for (let i = 0; i < currentValues.length; i++) {
    const cur = currentValues[i] ?? []
    const old = snapValues[i] ?? []
    let row: (string | null)[] | null = null
    for (const cell of r.cells) {
      if (cell.color === null) continue
      const k = cell.dataCol - r.minDataCol
      if (String(old[k] ?? '') !== String(cur[k] ?? '')) {
        if (!row) row = new Array<string | null>(width).fill(null)
        row[cell.displayCol - r.minDisplayCol] = cell.color
        changed++
      }
    }
    if (row) rowColors.set(i, row)
  }
  return { rowColors, changed }
}

/** True when the key column is not in ascending (numbers first, then text) order. */
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

// ---------------------------------------------------------------------------
// Reading the workbook (one metadata GET + one values.batchGet)
// ---------------------------------------------------------------------------

export type Loaded = {
  r: ResolvedTracker
  sheetId: number
  keys: CellValue[]
  current: CellValue[][]
  /** Baseline rows aligned to `current` (index 0 = dataFirstRow), or null when none exists yet. */
  previous: CellValue[][] | null
  /** Metadata of the v3 snapshot on disk, or null (none / legacy). */
  meta: SnapshotMeta | null
  /** Legacy grid snapshot that must be converted on the next write. */
  legacy: boolean
}

export type Workbook = { info: SpreadsheetInfo; loaded: Loaded[] }

function sheetIdByTitle(info: SpreadsheetInfo, title: string): number {
  const s = info.sheets?.find((x) => x.properties.title === title)
  if (!s) throw new Error(`Sheet "${title}" not found`)
  return s.properties.sheetId
}
function sheetExists(info: SpreadsheetInfo, title: string): boolean {
  return !!info.sheets?.find((x) => x.properties.title === title)
}
function rowCountOf(info: SpreadsheetInfo, title: string): number {
  return (
    info.sheets?.find((x) => x.properties.title === title)?.properties
      .gridProperties?.rowCount ?? 1000
  )
}

/**
 * Read everything the flow needs in one metadata GET and one values.batchGet:
 * the whole data sheets (header band + values), the display header bands and
 * key columns, and the v3 snapshots. Legacy snapshots are read through
 * SpreadsheetApp (once; they're converted on the next write).
 */
export function loadWorkbook(ss: Spreadsheet, client: SheetsClient): Workbook {
  const info = client.get(ss.getId(), {
    fields: 'sheets(properties(sheetId,title,hidden,gridProperties))',
  })
  for (const spec of TRACKER_SPECS) {
    if (!sheetExists(info, spec.dataSheet))
      throw new Error(`${spec.dataSheet} not found (needed by ${spec.key})`)
    if (!sheetExists(info, spec.displaySheet))
      throw new Error(`${spec.displaySheet} not found (needed by ${spec.key})`)
  }
  const v3 =
    PropertiesService.getDocumentProperties().getProperty(
      SNAPSHOT_FORMAT_PROPERTY,
    ) === SNAPSHOT_FORMAT_V3

  const ranges: string[] = []
  for (const spec of TRACKER_SPECS) {
    ranges.push(
      sheetRange(spec.dataSheet, `1:${rowCountOf(info, spec.dataSheet)}`),
    )
    ranges.push(sheetRange(spec.displaySheet, `1:${HEADER_BAND_ROWS}`))
    ranges.push(
      sheetRange(
        spec.displaySheet,
        `${a1(spec.displayFirstRow, spec.sortDisplayColumn)}:${a1(rowCountOf(info, spec.displaySheet), spec.sortDisplayColumn)}`,
      ),
    )
    const snapName = snapshotSheetName(spec.key)
    ranges.push(
      v3 && sheetExists(info, snapName)
        ? sheetRange(snapName, `A1:A${rowCountOf(info, snapName)}`)
        : '',
    )
  }
  const wanted = ranges.filter((x) => x !== '')
  const got = client.valuesBatchGet(ss.getId(), wanted, 'UNFORMATTED_VALUE')
  if (got.length !== wanted.length) {
    throw new Error(
      `values.batchGet returned ${got.length} ranges for ${wanted.length}`,
    )
  }
  let gi = 0
  const take = (present: boolean): unknown[][] =>
    present ? (got[gi++]?.values ?? []) : []

  const loaded: Loaded[] = []
  for (const spec of TRACKER_SPECS) {
    const dataAll = take(true)
    const displayBand = take(true)
    const keyCol = take(true)
    const snapName = snapshotSheetName(spec.key)
    const snapCells = take(v3 && sheetExists(info, snapName))

    const dataBand = padValues(
      dataAll.slice(0, HEADER_BAND_ROWS),
      HEADER_BAND_ROWS,
      Math.max(...dataAll.slice(0, HEADER_BAND_ROWS).map((r) => r.length), 1),
    )
    const r = resolveFromBands(spec, dataBand, displayBand)
    Logger.log(describeResolved(r))

    // Data block: rows from dataFirstRow to the last returned row, tracked columns only.
    const dataRows = Math.max(0, dataAll.length - (spec.dataFirstRow - 1))
    const width = r.maxDataCol - r.minDataCol + 1
    const current = padValues(
      dataAll
        .slice(spec.dataFirstRow - 1)
        .map((row) => row.slice(r.minDataCol - 1, r.maxDataCol)),
      dataRows,
      width,
    ) as CellValue[][]
    const keys = padValues(keyCol, keyCol.length, 1).map(
      (row) => row[0] as CellValue,
    )

    let previous: CellValue[][] | null = null
    let meta: SnapshotMeta | null = null
    let legacy = false
    if (v3) {
      if (snapCells.length) {
        const flat = snapCells.map((row) => row[0])
        meta = parseMeta(flat[0])
        if (meta) {
          previous = realign(decodeSnapshotChunks(flat.slice(1)), meta, r)
        } else {
          legacy = true // a grid left over from an older format: clear it on the next write
        }
      }
    } else {
      const legacyRows = readLegacySnapshot(ss, r)
      if (legacyRows) {
        previous = legacyRows
        legacy = true
      }
    }
    loaded.push({
      r,
      sheetId: sheetIdByTitle(info, spec.displaySheet),
      keys,
      current,
      previous,
      meta,
      legacy,
    })
  }
  return { info, loaded }
}

/** A1 of a v3 snapshot sheet holds the JSON metadata; anything else is not a v3 snapshot. */
function parseMeta(cell: unknown): SnapshotMeta | null {
  const text = String(cell ?? '')
  if (!text.startsWith('{')) return null
  try {
    const m = JSON.parse(text) as Partial<SnapshotMeta>
    return m.v === 3 && Array.isArray(m.painted) ? (m as SnapshotMeta) : null
  } catch {
    return null
  }
}

/**
 * Re-map a v3 snapshot onto the current tracked span when the creator moved
 * columns between uploads: columns are matched by header label (the k-th
 * occurrence of a label maps to the k-th occurrence — "SHINY" and
 * "Friendship" repeat), unmatched columns compare against blank.
 */
export function realign(
  rows: CellValue[][],
  meta: SnapshotMeta,
  r: ResolvedTracker,
): CellValue[][] {
  const newLabels = r.dataCols.map((c) => normalize(r.labels[c] ?? ''))
  const oldLabels = (meta.labels ?? []).map(normalize)
  const sameCols =
    meta.minCol === r.minDataCol &&
    meta.maxCol === r.maxDataCol &&
    (oldLabels.length === 0 ||
      oldLabels.join('\u0000') === newLabels.join('\u0000'))
  const rowShift = r.spec.dataFirstRow - meta.firstRow
  if (sameCols && rowShift === 0) return rows

  // Column map: new index -> old index (or -1), by k-th occurrence of the label.
  const seen = new Map<string, number>()
  const colMap = newLabels.map((label) => {
    const k = seen.get(label) ?? 0
    seen.set(label, k + 1)
    if (!oldLabels.length) return -1
    let n = 0
    for (let i = 0; i < oldLabels.length; i++) {
      if (oldLabels[i] === label && n++ === k) return i
    }
    return -1
  })
  const out: CellValue[][] = []
  for (let i = 0; i + rowShift < rows.length; i++) {
    const src = rows[i + rowShift] ?? []
    out.push(colMap.map((j) => (j >= 0 ? (src[j] ?? '') : '')))
  }
  return out
}

function normalize(s: unknown): string {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** v1/v2 grid snapshots via SpreadsheetApp; null when there is none. */
function readLegacySnapshot(
  ss: Spreadsheet,
  r: ResolvedTracker,
): CellValue[][] | null {
  const snap = ss.getSheetByName(snapshotSheetName(r.spec.key))
  if (!snap) return null
  const format = PropertiesService.getDocumentProperties().getProperty(
    SNAPSHOT_FORMAT_PROPERTY,
  )
  const firstRow =
    format === '2' ? r.spec.dataFirstRow : (V1_HEADER_ROWS[r.spec.key] ?? 1) + 1
  const lastRow = snap.getLastRow()
  const numRows = lastRow - firstRow + 1
  if (numRows <= 0) return null
  return snap
    .getRange(firstRow, r.minDataCol, numRows, r.maxDataCol - r.minDataCol + 1)
    .getValues() as CellValue[][]
}

// ---------------------------------------------------------------------------
// Painting (one batchUpdate) and snapshot writing (one values.batchUpdate)
// ---------------------------------------------------------------------------

/**
 * Requests that clear last time's highlighted rows and paint this time's.
 * With no metadata (first v3 run) the whole tracked block is cleared once.
 */
export function paintRequests(
  l: Loaded,
  rowColors: Map<number, (string | null)[]>,
): { requests: Request[]; painted: Run[] } {
  const { r, sheetId } = l
  const startCol = r.minDisplayCol - 1
  const endCol = r.maxDisplayCol
  const requests: Request[] = []
  const rowRange = (run: Run): Record<string, number> => ({
    sheetId,
    startRowIndex: r.spec.displayFirstRow - 1 + run.start,
    endRowIndex: r.spec.displayFirstRow - 1 + run.start + run.count,
    startColumnIndex: startCol,
    endColumnIndex: endCol,
  })
  const oldRuns: Run[] = l.meta
    ? l.meta.painted
    : [
        {
          start: 0,
          count: Math.max(
            l.current.length,
            l.previous?.length ?? 0,
            l.keys.length,
          ),
        },
      ]
  for (const run of oldRuns) {
    if (run.count <= 0) continue
    requests.push({
      repeatCell: {
        range: rowRange(run),
        cell: { userEnteredFormat: {} },
        fields: 'userEnteredFormat.backgroundColor',
      },
    })
  }

  const offsets = [...rowColors.keys()].sort((x, y) => x - y)
  const painted = toRuns(offsets)
  for (const run of painted) {
    requests.push({
      updateCells: {
        range: rowRange(run),
        rows: Array.from({ length: run.count }, (_, k) => ({
          values: rowColors
            .get(run.start + k)!
            .map((color) =>
              color
                ? { userEnteredFormat: { backgroundColor: hexToColor(color) } }
                : {},
            ),
        })),
        fields: 'userEnteredFormat.backgroundColor',
      },
    })
  }
  return { requests, painted }
}

/** The values.batchUpdate entries that store `rows` (+ meta) as the v3 snapshot of a tracker. */
export function snapshotWrites(
  l: Loaded,
  rows: CellValue[][],
  painted: Run[],
): { range: string; values: unknown[][] }[] {
  const chunks = encodeSnapshotChunks(rows)
  const meta: SnapshotMeta = {
    v: 3,
    firstRow: l.r.spec.dataFirstRow,
    minCol: l.r.minDataCol,
    maxCol: l.r.maxDataCol,
    rows: rows.length,
    cells: chunks.length,
    labels: l.r.dataCols.map((c) => l.r.labels[c] ?? ''),
    painted,
  }
  const column: unknown[][] = [
    [JSON.stringify(meta)],
    ...chunks.map((c) => [c]),
  ]
  const leftover = Math.max(0, (l.meta?.cells ?? 0) - chunks.length)
  for (let i = 0; i < leftover; i++) column.push([''])
  return [
    {
      range: sheetRange(
        snapshotSheetName(l.r.spec.key),
        `A1:A${column.length}`,
      ),
      values: column,
    },
  ]
}

/** Just the metadata cell (used when highlights change but the baseline must stay). */
function metaWrite(
  l: Loaded,
  painted: Run[],
): { range: string; values: unknown[][] } {
  const meta: SnapshotMeta = { ...(l.meta as SnapshotMeta), painted }
  return {
    range: sheetRange(snapshotSheetName(l.r.spec.key), 'A1'),
    values: [[JSON.stringify(meta)]],
  }
}

/** Make sure each of these trackers' snapshot sheets exists (hidden) and, for legacy grids, is emptied. */
function prepareSnapshotSheets(ss: Spreadsheet, loaded: Loaded[]): void {
  for (const l of loaded) {
    const name = snapshotSheetName(l.r.spec.key)
    const sheet = ss.getSheetByName(name)
    if (!sheet) {
      ss.insertSheet(name).hideSheet()
    } else if (l.legacy) {
      sheet.clear()
    }
  }
}

/**
 * Re-sort the display's data rows by the key column, but only when they are
 * actually out of order (a slicer or manual sort moved them). Painting is by
 * row offset, so the display must be in the data sheet's canonical order.
 */
export function ensureDisplayOrder(ss: Spreadsheet, l: Loaded): boolean {
  if (l.keys.length <= 1 || !outOfOrder(l.keys)) return false
  const display = ss.getSheetByName(l.r.spec.displaySheet)!
  const lastCol = display.getLastColumn()
  display
    .getRange(l.r.spec.displayFirstRow, 1, l.keys.length, lastCol)
    .sort({ column: l.r.spec.sortDisplayColumn, ascending: true })
  Logger.log(
    `${l.r.spec.key}: display was out of order; re-sorted by column ${l.r.spec.sortDisplayColumn}`,
  )
  return true
}

// ---------------------------------------------------------------------------
// Public flow
// ---------------------------------------------------------------------------

/**
 * Full save-upload flow: read everything, diff, paint the changed rows (and
 * clear last time's), re-sort the Form Checklist, write the new snapshots.
 * Assumes the caller (uploadFileTracked) already reset toast state. On
 * failure the user gets an error toast and the error is rethrown.
 */
export function processChanges(
  options?: { skipSnapshot?: boolean },
  client: SheetsClient = liveSheets,
): void {
  const ss = SpreadsheetApp.getActiveSpreadsheet()
  const skipSnapshot = !!(options && options.skipSnapshot)
  try {
    startStep(ss, 'Reading sheets')
    const wb = loadWorkbook(ss, client)
    clearLegacyMarkers(ss)

    startStep(ss, 'Highlighting changes')
    const paint: Request[] = []
    const painted: Run[][] = []
    for (const l of wb.loaded) {
      if (!l.previous) {
        Logger.log(`${l.r.spec.key}: no snapshot yet, nothing to highlight`)
        painted.push([])
        continue
      }
      ensureDisplayOrder(ss, l)
      const { rowColors, changed } = diffBlocks(l.r, l.previous, l.current)
      const p = paintRequests(l, rowColors)
      paint.push(...p.requests)
      painted.push(p.painted)
      Logger.log(
        `${l.r.spec.key}: highlighted ${changed} changed cells in ${rowColors.size} rows over ${l.current.length} rows`,
      )
    }
    if (paint.length) client.batchUpdate(ss.getId(), paint)

    try {
      sortFormChecklistByDone(ss)
    } catch (e) {
      Logger.log(
        'Form Checklist sort failed: ' + (e instanceof Error ? e.message : e),
      )
    }

    startStep(ss, skipSnapshot ? 'Saving highlight state' : 'Snapshotting')
    const writes: { range: string; values: unknown[][] }[] = []
    const touched: Loaded[] = []
    wb.loaded.forEach((l, i) => {
      if (!skipSnapshot) {
        writes.push(...snapshotWrites(l, l.current, painted[i]!))
      } else if (!l.previous) {
        return // no baseline yet and we were asked not to create one
      } else if (l.legacy || !l.meta) {
        writes.push(...snapshotWrites(l, l.previous, painted[i]!)) // convert; baseline kept
      } else {
        writes.push(metaWrite(l, painted[i]!))
      }
      touched.push(l)
    })
    prepareSnapshotSheets(ss, touched)
    if (writes.length) client.valuesBatchUpdate(ss.getId(), writes)
    // Every snapshot on disk is now v3 (converted above) or absent.
    PropertiesService.getDocumentProperties().setProperty(
      SNAPSHOT_FORMAT_PROPERTY,
      SNAPSHOT_FORMAT_V3,
    )
    finishStep()
  } catch (e) {
    failFlow(ss, e)
    throw e
  }
  finishFlow(
    ss,
    skipSnapshot
      ? 'All sheets processed (baseline kept)'
      : 'All sheets processed',
  )
}

/** Same as processChanges, but the current snapshot stays the diff baseline. */
export function processChangesWithoutSnapshot(): void {
  processChanges({ skipSnapshot: true })
}

/** Public entry: capture the current values as the baseline (highlights untouched). */
export function snapshot(client: SheetsClient = liveSheets): void {
  const ss = SpreadsheetApp.getActiveSpreadsheet()
  runStandaloneIfNeeded(ss, 'Snapshot', () => {
    startStep(ss, 'Reading sheets')
    const wb = loadWorkbook(ss, client)
    startStep(ss, 'Snapshotting')
    prepareSnapshotSheets(ss, wb.loaded)
    client.valuesBatchUpdate(
      ss.getId(),
      wb.loaded.flatMap((l) =>
        snapshotWrites(l, l.current, l.meta?.painted ?? []),
      ),
    )
    PropertiesService.getDocumentProperties().setProperty(
      SNAPSHOT_FORMAT_PROPERTY,
      SNAPSHOT_FORMAT_V3,
    )
    finishStep()
  })
}

/** Public entry: diff against the baseline and paint; the baseline is kept. */
export function highlightChanges(): void {
  processChanges({ skipSnapshot: true })
}

/** Public entry: clear every highlight (last painted rows, or the whole block if unknown). */
export function clearHighlights(client: SheetsClient = liveSheets): void {
  const ss = SpreadsheetApp.getActiveSpreadsheet()
  runStandaloneIfNeeded(ss, 'Clear highlights', () => {
    startStep(ss, 'Reading sheets')
    const wb = loadWorkbook(ss, client)
    startStep(ss, 'Clearing highlights')
    const requests: Request[] = []
    for (const l of wb.loaded)
      requests.push(...paintRequests(l, new Map()).requests)
    if (requests.length) client.batchUpdate(ss.getId(), requests)
    const writes = wb.loaded
      .filter((l) => l.meta && !l.legacy)
      .map((l) => metaWrite(l, []))
    if (writes.length) client.valuesBatchUpdate(ss.getId(), writes)
    finishStep()
  })
}

/** Dry run: what the layout probe finds in this workbook, one line per tracker (or the error). */
export function describeLayout(client: SheetsClient = liveSheets): string {
  const ss = SpreadsheetApp.getActiveSpreadsheet()
  try {
    return loadWorkbook(ss, client)
      .loaded.map((l) => describeResolved(l.r))
      .join('\n')
  } catch (e) {
    return 'ERROR ' + (e instanceof Error ? e.message : String(e))
  }
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
    sheet
      .getRange(2, 1, lastRow - 1, lastCol)
      .sort({ column: FORM_CHECKLIST_DONE_COLUMN, ascending: true })
  }
  finishStep()
}

/**
 * One-time cleanup after the marker-column workflow was removed: blank the
 * `●` markers the old code left in the (hidden) columns past each display
 * block — only if that column holds nothing else. Idempotent via a property.
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
    const values = range.getValues()
    if (!values.every((row) => row[0] === '' || row[0] === '●')) continue
    if (values.some((row) => row[0] === '●')) range.clearContent()
  }
  props.setProperty(LEGACY_MARKERS_PROPERTY, 'true')
  Logger.log('Legacy marker columns cleared')
}
