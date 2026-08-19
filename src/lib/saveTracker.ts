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
 * plus, only if a slicer moved rows, a display sort.
 *
 * Snapshot format: `_snapshot_<key>` holds JSON — A1 = metadata (rows,
 * columns, which display rows are currently highlighted), A2… = chunks of
 * rows. A sheet whose A1 is not that metadata is treated as "no baseline".
 */

import {
  HEADER_BAND_ROWS,
  type ResolvedTracker,
  type TrackerSpec,
  describeResolved,
  normalizeLabel,
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

/** Max characters per snapshot cell (Sheets allows 50,000). */
const SNAPSHOT_CELL_CHARS = 45000

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
  dexSpec('StarterDex', 'STARTER_DEX.data', 'Starter DEX Checklist'),
  dexSpec('FullDex', 'FULL_DEX.data', 'Full DEX Checklist'),
]

export function snapshotSheetName(key: string): string {
  return '_snapshot_' + key
}

// ---------------------------------------------------------------------------
// Snapshot encoding (pure)
// ---------------------------------------------------------------------------

/** A contiguous run of display rows, as offsets from displayFirstRow. */
export type Run = { start: number; count: number }

/** Persisted in A1 of each snapshot sheet — field names are part of the on-disk format. */
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
  let pendingRows: CellValue[][] = []
  let pendingChars = 2 // the enclosing "[]"
  for (const row of rows) {
    const rowJson = JSON.stringify(row)
    if (
      pendingRows.length &&
      pendingChars + rowJson.length + 1 > SNAPSHOT_CELL_CHARS
    ) {
      chunks.push(JSON.stringify(pendingRows))
      pendingRows = []
      pendingChars = 2
    }
    pendingRows.push(row)
    pendingChars += rowJson.length + 1
  }
  if (pendingRows.length || chunks.length === 0)
    chunks.push(JSON.stringify(pendingRows))
  return chunks
}

export function decodeSnapshotChunks(cells: unknown[]): CellValue[][] {
  const rows: CellValue[][] = []
  for (const cell of cells) {
    if (cell === '' || cell === null || cell === undefined) continue
    const chunkRows = JSON.parse(String(cell)) as CellValue[][]
    for (const row of chunkRows) rows.push(row)
  }
  return rows
}

/** Collapse sorted row offsets into contiguous runs. */
export function toRuns(sortedOffsets: number[]): Run[] {
  const runs: Run[] = []
  let index = 0
  while (index < sortedOffsets.length) {
    const start = sortedOffsets[index]!
    let end = start
    while (
      index + 1 < sortedOffsets.length &&
      sortedOffsets[index + 1] === sortedOffsets[index]! + 1
    ) {
      index++
      end = sortedOffsets[index]!
    }
    runs.push({ start, count: end - start + 1 })
    index++
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
  layout: ResolvedTracker,
  snapshotValues: CellValue[][],
  currentValues: CellValue[][],
): { rowColors: Map<number, (string | null)[]>; changedCells: number } {
  const displayWidth = layout.maxDisplayCol - layout.minDisplayCol + 1
  const rowColors = new Map<number, (string | null)[]>()
  let changedCells = 0
  for (let rowOffset = 0; rowOffset < currentValues.length; rowOffset++) {
    const currentRow = currentValues[rowOffset] ?? []
    const snapshotRow = snapshotValues[rowOffset] ?? []
    let colorsForRow: (string | null)[] | null = null
    for (const cell of layout.cells) {
      if (cell.color === null) continue
      const dataOffset = cell.dataCol - layout.minDataCol
      if (
        String(snapshotRow[dataOffset] ?? '') !==
        String(currentRow[dataOffset] ?? '')
      ) {
        if (!colorsForRow)
          colorsForRow = new Array<string | null>(displayWidth).fill(null)
        colorsForRow[cell.displayCol - layout.minDisplayCol] = cell.color
        changedCells++
      }
    }
    if (colorsForRow) rowColors.set(rowOffset, colorsForRow)
  }
  return { rowColors, changedCells }
}

/** True when the key column is not in ascending (numbers first, then text) order. */
export function outOfOrder(keys: CellValue[]): boolean {
  for (let index = 1; index < keys.length; index++) {
    if (compareKeys(keys[index - 1]!, keys[index]!) > 0) return true
  }
  return false
}

/**
 * Sheets' ascending sort order: real numbers first (ascending), then text
 * (case-insensitive; numeric-looking TEXT sorts as text, e.g. "10" < "2"),
 * blanks last. Must match what Range.sort() would produce, or we'd re-sort
 * every upload.
 */
function compareKeys(left: CellValue, right: CellValue): number {
  const leftBlank = left === '' || left === null
  const rightBlank = right === '' || right === null
  if (leftBlank || rightBlank)
    return leftBlank && rightBlank ? 0 : leftBlank ? 1 : -1
  const leftIsNumber = typeof left === 'number'
  const rightIsNumber = typeof right === 'number'
  if (leftIsNumber && rightIsNumber) return (left as number) - (right as number)
  if (leftIsNumber) return -1
  if (rightIsNumber) return 1
  return String(left).localeCompare(String(right), undefined, {
    sensitivity: 'base',
  })
}

// ---------------------------------------------------------------------------
// Reading the workbook (one metadata GET + one values.batchGet)
// ---------------------------------------------------------------------------

/** Everything the flow needs for one tracker, read in a single batch. */
export type LoadedTracker = {
  layout: ResolvedTracker
  displaySheetId: number
  /** The display's key column (sortDisplayColumn) from displayFirstRow down. */
  displayKeys: CellValue[]
  /** Tracked block of the data sheet, index 0 = dataFirstRow. */
  currentValues: CellValue[][]
  /** Baseline rows aligned to `currentValues`, or null when none exists yet. */
  snapshotValues: CellValue[][] | null
  /** Metadata of the snapshot on disk, or null when there is none. */
  snapshotMeta: SnapshotMeta | null
  /** The snapshot sheet exists but holds no usable metadata: wipe it before writing. */
  snapshotSheetStale: boolean
}

export type Workbook = { info: SpreadsheetInfo; trackers: LoadedTracker[] }

type SheetInfoLite = NonNullable<SpreadsheetInfo['sheets']>[number]

/**
 * Sheet lookup by title. Exact match first, then a whitespace/case-tolerant
 * match, then — because SpreadsheetApp and the API can spell a title
 * differently (non-breaking spaces etc.) — the sheet SpreadsheetApp finds
 * under that name, matched back to the API list by sheetId.
 */
function findSheet(
  info: SpreadsheetInfo,
  title: string,
  spreadsheet?: Spreadsheet,
): SheetInfoLite | null {
  const sheets = info.sheets ?? []
  const exactMatch = sheets.find((sheet) => sheet.properties.title === title)
  if (exactMatch) return exactMatch
  const wantedTitle = normalizeLabel(title)
  const looseMatch = sheets.find(
    (sheet) => normalizeLabel(sheet.properties.title) === wantedTitle,
  )
  if (looseMatch) return looseMatch
  const sheetViaApp = spreadsheet?.getSheetByName(title)
  if (sheetViaApp) {
    const sheetId = sheetViaApp.getSheetId()
    return sheets.find((sheet) => sheet.properties.sheetId === sheetId) ?? null
  }
  return null
}

function requireSheet(
  info: SpreadsheetInfo,
  title: string,
  purpose: string,
  spreadsheet?: Spreadsheet,
): SheetInfoLite {
  const sheet = findSheet(info, title, spreadsheet)
  if (!sheet) {
    const knownTitles = (info.sheets ?? [])
      .map((known) => JSON.stringify(known.properties.title))
      .join(', ')
    throw new Error(
      `${title} not found (${purpose}). Sheets reported by the API: ${knownTitles}`,
    )
  }
  return sheet
}
function sheetIdByTitle(
  info: SpreadsheetInfo,
  title: string,
  spreadsheet?: Spreadsheet,
): number {
  return requireSheet(info, title, 'display sheet', spreadsheet).properties
    .sheetId
}
function sheetExists(
  info: SpreadsheetInfo,
  title: string,
  spreadsheet?: Spreadsheet,
): boolean {
  return findSheet(info, title, spreadsheet) !== null
}
/** The title as the API spells it (used to build A1 ranges that the API will accept). */
function apiTitle(
  info: SpreadsheetInfo,
  title: string,
  spreadsheet?: Spreadsheet,
): string {
  return findSheet(info, title, spreadsheet)?.properties.title ?? title
}
function rowCountOf(
  info: SpreadsheetInfo,
  title: string,
  spreadsheet?: Spreadsheet,
): number {
  return (
    findSheet(info, title, spreadsheet)?.properties.gridProperties?.rowCount ??
    1000
  )
}

/**
 * Read everything the flow needs in one metadata GET and one values.batchGet:
 * the whole data sheets (header band + values), the display header bands and
 * key columns, and the snapshots.
 */
export function loadWorkbook(
  spreadsheet: Spreadsheet,
  client: SheetsClient,
): Workbook {
  const info = client.get(spreadsheet.getId(), {
    fields: 'sheets(properties(sheetId,title,hidden,gridProperties))',
  })
  // Resolve every sheet up front (with the SpreadsheetApp fallback) and pin
  // the API's own spelling of each title into the info list for later lookups.
  for (const spec of TRACKER_SPECS) {
    for (const title of [spec.dataSheet, spec.displaySheet]) {
      const found = requireSheet(
        info,
        title,
        `needed by ${spec.key}`,
        spreadsheet,
      )
      if (found.properties.title !== title) {
        Logger.log(
          `Note: "${title}" is titled ${JSON.stringify(found.properties.title)} in the API; using that`,
        )
      }
    }
  }
  const ranges: string[] = []
  for (const spec of TRACKER_SPECS) {
    const dataTitle = apiTitle(info, spec.dataSheet, spreadsheet)
    const displayTitle = apiTitle(info, spec.displaySheet, spreadsheet)
    ranges.push(
      sheetRange(
        dataTitle,
        `1:${rowCountOf(info, spec.dataSheet, spreadsheet)}`,
      ),
    )
    ranges.push(sheetRange(displayTitle, `1:${HEADER_BAND_ROWS}`))
    ranges.push(
      sheetRange(
        displayTitle,
        `${a1(spec.displayFirstRow, spec.sortDisplayColumn)}:${a1(rowCountOf(info, spec.displaySheet, spreadsheet), spec.sortDisplayColumn)}`,
      ),
    )
    const snapshotName = snapshotSheetName(spec.key)
    ranges.push(
      sheetExists(info, snapshotName)
        ? sheetRange(snapshotName, `A1:A${rowCountOf(info, snapshotName)}`)
        : '',
    )
  }
  const requestedRanges = ranges.filter((range) => range !== '')
  const valueRanges = client.valuesBatchGet(
    spreadsheet.getId(),
    requestedRanges,
    'UNFORMATTED_VALUE',
  )
  if (valueRanges.length !== requestedRanges.length) {
    throw new Error(
      `values.batchGet returned ${valueRanges.length} ranges for ${requestedRanges.length}`,
    )
  }
  let nextRangeIndex = 0
  const takeNext = (wasRequested: boolean): unknown[][] =>
    wasRequested ? (valueRanges[nextRangeIndex++]?.values ?? []) : []

  const trackers: LoadedTracker[] = []
  for (const spec of TRACKER_SPECS) {
    const dataSheetValues = takeNext(true)
    const displayBand = takeNext(true)
    const keyColumnValues = takeNext(true)
    const snapshotName = snapshotSheetName(spec.key)
    const snapshotCells = takeNext(sheetExists(info, snapshotName))

    const dataBand = padValues(
      dataSheetValues.slice(0, HEADER_BAND_ROWS),
      HEADER_BAND_ROWS,
      Math.max(
        ...dataSheetValues.slice(0, HEADER_BAND_ROWS).map((row) => row.length),
        1,
      ),
    )
    const layout = resolveFromBands(spec, dataBand, displayBand)
    Logger.log(describeResolved(layout))

    // Data block: rows from dataFirstRow to the last returned row, tracked columns only.
    const dataRowCount = Math.max(
      0,
      dataSheetValues.length - (spec.dataFirstRow - 1),
    )
    const trackedWidth = layout.maxDataCol - layout.minDataCol + 1
    const currentValues = padValues(
      dataSheetValues
        .slice(spec.dataFirstRow - 1)
        .map((row) => row.slice(layout.minDataCol - 1, layout.maxDataCol)),
      dataRowCount,
      trackedWidth,
    ) as CellValue[][]
    const displayKeys = padValues(
      keyColumnValues,
      keyColumnValues.length,
      1,
    ).map((row) => row[0] as CellValue)

    let snapshotValues: CellValue[][] | null = null
    let snapshotMeta: SnapshotMeta | null = null
    if (snapshotCells.length) {
      const snapshotColumn = snapshotCells.map((row) => row[0])
      snapshotMeta = parseMeta(snapshotColumn[0])
      if (snapshotMeta)
        snapshotValues = realign(
          decodeSnapshotChunks(snapshotColumn.slice(1)),
          snapshotMeta,
          layout,
        )
    }
    // A snapshot sheet that exists but carries no metadata holds something
    // else (e.g. an older layout): wipe it before the first write.
    const snapshotSheetStale = sheetExists(info, snapshotName) && !snapshotMeta
    trackers.push({
      layout,
      displaySheetId: sheetIdByTitle(info, spec.displaySheet, spreadsheet),
      displayKeys,
      currentValues,
      snapshotValues,
      snapshotMeta,
      snapshotSheetStale,
    })
  }
  return { info, trackers }
}

/** A1 of a snapshot sheet holds the JSON metadata; anything else is not a snapshot. */
function parseMeta(cell: unknown): SnapshotMeta | null {
  const text = String(cell ?? '')
  if (!text.startsWith('{')) return null
  try {
    const parsed = JSON.parse(text) as Partial<SnapshotMeta>
    return parsed.v === 3 && Array.isArray(parsed.painted)
      ? (parsed as SnapshotMeta)
      : null
  } catch {
    return null
  }
}

/**
 * Re-map a snapshot onto the current tracked span when the creator moved
 * columns between uploads: columns are matched by header label (the k-th
 * occurrence of a label maps to the k-th occurrence — "SHINY" and
 * "Friendship" repeat), unmatched columns compare against blank.
 */
export function realign(
  rows: CellValue[][],
  meta: SnapshotMeta,
  layout: ResolvedTracker,
): CellValue[][] {
  const currentLabels = layout.dataCols.map((column) =>
    normalizeLabel(layout.labels[column] ?? ''),
  )
  const snapshotLabels = (meta.labels ?? []).map(normalizeLabel)
  const sameColumns =
    meta.minCol === layout.minDataCol &&
    meta.maxCol === layout.maxDataCol &&
    (snapshotLabels.length === 0 ||
      snapshotLabels.join('\u0000') === currentLabels.join('\u0000'))
  const rowShift = layout.spec.dataFirstRow - meta.firstRow
  if (sameColumns && rowShift === 0) return rows

  // Column map: current index -> snapshot index (or -1), by k-th occurrence of the label.
  const occurrencesSeen = new Map<string, number>()
  const snapshotIndexByCurrentIndex = currentLabels.map((label) => {
    const occurrence = occurrencesSeen.get(label) ?? 0
    occurrencesSeen.set(label, occurrence + 1)
    if (!snapshotLabels.length) return -1
    let matchesSeen = 0
    for (
      let snapshotIndex = 0;
      snapshotIndex < snapshotLabels.length;
      snapshotIndex++
    ) {
      if (
        snapshotLabels[snapshotIndex] === label &&
        matchesSeen++ === occurrence
      )
        return snapshotIndex
    }
    return -1
  })
  const realigned: CellValue[][] = []
  for (let rowOffset = 0; rowOffset + rowShift < rows.length; rowOffset++) {
    const snapshotRow = rows[rowOffset + rowShift] ?? []
    realigned.push(
      snapshotIndexByCurrentIndex.map((snapshotIndex) =>
        snapshotIndex >= 0 ? (snapshotRow[snapshotIndex] ?? '') : '',
      ),
    )
  }
  return realigned
}

// ---------------------------------------------------------------------------
// Painting (one batchUpdate) and snapshot writing (one values.batchUpdate)
// ---------------------------------------------------------------------------

/**
 * Requests that clear last time's highlighted rows and paint this time's.
 * With no metadata (first baseline) the whole tracked block is cleared once.
 */
export function paintRequests(
  tracker: LoadedTracker,
  rowColors: Map<number, (string | null)[]>,
): { requests: Request[]; painted: Run[] } {
  const { layout, displaySheetId } = tracker
  const startColumnIndex = layout.minDisplayCol - 1
  const endColumnIndex = layout.maxDisplayCol
  const requests: Request[] = []
  const runRange = (run: Run): Record<string, number> => ({
    sheetId: displaySheetId,
    startRowIndex: layout.spec.displayFirstRow - 1 + run.start,
    endRowIndex: layout.spec.displayFirstRow - 1 + run.start + run.count,
    startColumnIndex,
    endColumnIndex,
  })
  const previouslyPaintedRuns: Run[] = tracker.snapshotMeta
    ? tracker.snapshotMeta.painted
    : [
        {
          start: 0,
          count: Math.max(
            tracker.currentValues.length,
            tracker.snapshotValues?.length ?? 0,
            tracker.displayKeys.length,
          ),
        },
      ]
  for (const run of previouslyPaintedRuns) {
    if (run.count <= 0) continue
    requests.push({
      repeatCell: {
        range: runRange(run),
        cell: { userEnteredFormat: {} },
        fields: 'userEnteredFormat.backgroundColor',
      },
    })
  }

  const changedRowOffsets = [...rowColors.keys()].sort(
    (left, right) => left - right,
  )
  const painted = toRuns(changedRowOffsets)
  for (const run of painted) {
    requests.push({
      updateCells: {
        range: runRange(run),
        rows: Array.from({ length: run.count }, (_, rowInRun) => ({
          values: rowColors
            .get(run.start + rowInRun)!
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

/** The values.batchUpdate entries that store `rows` (+ meta) as the snapshot of a tracker. */
export function snapshotWrites(
  tracker: LoadedTracker,
  rows: CellValue[][],
  paintedRuns: Run[],
): { range: string; values: unknown[][] }[] {
  const chunks = encodeSnapshotChunks(rows)
  const meta: SnapshotMeta = {
    v: 3,
    firstRow: tracker.layout.spec.dataFirstRow,
    minCol: tracker.layout.minDataCol,
    maxCol: tracker.layout.maxDataCol,
    rows: rows.length,
    cells: chunks.length,
    labels: tracker.layout.dataCols.map(
      (column) => tracker.layout.labels[column] ?? '',
    ),
    painted: paintedRuns,
  }
  const snapshotColumn: unknown[][] = [
    [JSON.stringify(meta)],
    ...chunks.map((chunk) => [chunk]),
  ]
  const leftoverCells = Math.max(
    0,
    (tracker.snapshotMeta?.cells ?? 0) - chunks.length,
  )
  for (let index = 0; index < leftoverCells; index++) snapshotColumn.push([''])
  return [
    {
      range: sheetRange(
        snapshotSheetName(tracker.layout.spec.key),
        `A1:A${snapshotColumn.length}`,
      ),
      values: snapshotColumn,
    },
  ]
}

/** Just the metadata cell (used when highlights change but the baseline must stay). */
function metaWrite(
  tracker: LoadedTracker,
  paintedRuns: Run[],
): { range: string; values: unknown[][] } {
  const meta: SnapshotMeta = {
    ...(tracker.snapshotMeta as SnapshotMeta),
    painted: paintedRuns,
  }
  return {
    range: sheetRange(snapshotSheetName(tracker.layout.spec.key), 'A1'),
    values: [[JSON.stringify(meta)]],
  }
}

/** Make sure each of these trackers' snapshot sheets exists (hidden); a stale one is emptied first. */
function prepareSnapshotSheets(
  spreadsheet: Spreadsheet,
  trackers: LoadedTracker[],
): void {
  for (const tracker of trackers) {
    const snapshotName = snapshotSheetName(tracker.layout.spec.key)
    const snapshotSheet = spreadsheet.getSheetByName(snapshotName)
    if (!snapshotSheet) {
      spreadsheet.insertSheet(snapshotName).hideSheet()
    } else if (tracker.snapshotSheetStale) {
      snapshotSheet.clear()
    }
  }
}

/**
 * Re-sort the display's data rows by the key column, but only when they are
 * actually out of order (a slicer or manual sort moved them). Painting is by
 * row offset, so the display must be in the data sheet's canonical order.
 */
export function ensureDisplayOrder(
  spreadsheet: Spreadsheet,
  tracker: LoadedTracker,
): boolean {
  if (tracker.displayKeys.length <= 1 || !outOfOrder(tracker.displayKeys))
    return false
  const spec = tracker.layout.spec
  const displaySheet = spreadsheet.getSheetByName(spec.displaySheet)!
  const lastColumn = displaySheet.getLastColumn()
  displaySheet
    .getRange(spec.displayFirstRow, 1, tracker.displayKeys.length, lastColumn)
    .sort({ column: spec.sortDisplayColumn, ascending: true })
  Logger.log(
    `${spec.key}: display was out of order; re-sorted by column ${spec.sortDisplayColumn}`,
  )
  return true
}

// ---------------------------------------------------------------------------
// Public flow
// ---------------------------------------------------------------------------

/**
 * Full save-upload flow: read everything, diff, paint the changed rows (and
 * clear last time's), write the new snapshots.
 * Assumes the caller (uploadFileTracked) already reset toast state. On
 * failure the user gets an error toast and the error is rethrown.
 */
export function processChanges(
  options?: { skipSnapshot?: boolean },
  client: SheetsClient = liveSheets,
): void {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet()
  const skipSnapshot = !!(options && options.skipSnapshot)
  try {
    startStep(spreadsheet, 'Reading sheets')
    const workbook = loadWorkbook(spreadsheet, client)

    startStep(spreadsheet, 'Highlighting changes')
    const paintBatch: Request[] = []
    const paintedRunsPerTracker: Run[][] = []
    for (const tracker of workbook.trackers) {
      const key = tracker.layout.spec.key
      if (!tracker.snapshotValues) {
        Logger.log(`${key}: no snapshot yet, nothing to highlight`)
        // Unknown highlight state (no metadata): clear the block once so
        // nothing stale survives into the new baseline.
        if (!tracker.snapshotMeta)
          paintBatch.push(...paintRequests(tracker, new Map()).requests)
        paintedRunsPerTracker.push([])
        continue
      }
      ensureDisplayOrder(spreadsheet, tracker)
      const { rowColors, changedCells } = diffBlocks(
        tracker.layout,
        tracker.snapshotValues,
        tracker.currentValues,
      )
      const paint = paintRequests(tracker, rowColors)
      paintBatch.push(...paint.requests)
      paintedRunsPerTracker.push(paint.painted)
      Logger.log(
        `${key}: highlighted ${changedCells} changed cells in ${rowColors.size} rows over ${tracker.currentValues.length} rows`,
      )
    }
    if (paintBatch.length) client.batchUpdate(spreadsheet.getId(), paintBatch)

    startStep(
      spreadsheet,
      skipSnapshot ? 'Saving highlight state' : 'Snapshotting',
    )
    const valueWrites: { range: string; values: unknown[][] }[] = []
    const trackersToWrite: LoadedTracker[] = []
    workbook.trackers.forEach((tracker, index) => {
      const paintedRuns = paintedRunsPerTracker[index]!
      if (!skipSnapshot) {
        valueWrites.push(
          ...snapshotWrites(tracker, tracker.currentValues, paintedRuns),
        )
      } else if (!tracker.snapshotValues) {
        return // no baseline yet and we were asked not to create one
      } else {
        valueWrites.push(metaWrite(tracker, paintedRuns))
      }
      trackersToWrite.push(tracker)
    })
    prepareSnapshotSheets(spreadsheet, trackersToWrite)
    if (valueWrites.length)
      client.valuesBatchUpdate(spreadsheet.getId(), valueWrites)
    finishStep()
  } catch (error) {
    failFlow(spreadsheet, error)
    throw error
  }
  finishFlow(
    spreadsheet,
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
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet()
  runStandaloneIfNeeded(spreadsheet, 'Snapshot', () => {
    startStep(spreadsheet, 'Reading sheets')
    const workbook = loadWorkbook(spreadsheet, client)
    startStep(spreadsheet, 'Snapshotting')
    prepareSnapshotSheets(spreadsheet, workbook.trackers)
    client.valuesBatchUpdate(
      spreadsheet.getId(),
      workbook.trackers.flatMap((tracker) =>
        snapshotWrites(
          tracker,
          tracker.currentValues,
          tracker.snapshotMeta?.painted ?? [],
        ),
      ),
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
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet()
  runStandaloneIfNeeded(spreadsheet, 'Clear highlights', () => {
    startStep(spreadsheet, 'Reading sheets')
    const workbook = loadWorkbook(spreadsheet, client)
    startStep(spreadsheet, 'Clearing highlights')
    // Manual clear: wipe the WHOLE tracked block of every display (not just
    // the rows we remember painting), so anything stray goes too.
    const requests: Request[] = []
    for (const tracker of workbook.trackers) {
      requests.push(
        ...paintRequests({ ...tracker, snapshotMeta: null }, new Map())
          .requests,
      )
    }
    if (requests.length) client.batchUpdate(spreadsheet.getId(), requests)
    const metaWrites = workbook.trackers
      .filter((tracker) => tracker.snapshotMeta)
      .map((tracker) => metaWrite(tracker, []))
    if (metaWrites.length)
      client.valuesBatchUpdate(spreadsheet.getId(), metaWrites)
    finishStep()
  })
}

/** Dry run: what the layout probe finds in this workbook, one line per tracker (or the error). */
export function describeLayout(client: SheetsClient = liveSheets): string {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet()
  try {
    return loadWorkbook(spreadsheet, client)
      .trackers.map((tracker) => describeResolved(tracker.layout))
      .join('\n')
  } catch (error) {
    return 'ERROR ' + (error instanceof Error ? error.message : String(error))
  }
}
