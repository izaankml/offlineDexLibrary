/**
 * LAYOUT PROBE
 *
 * Every column fact the SaveTracker needs is located here at runtime by the
 * creator's own header text instead of being a hard-coded index. The data
 * sheets and the display sheets share header labels (verified on 6.03: the
 * dex sheets' row-2 sub-headers are identical; STARTER_CHECKLIST.data row 1
 * carries "Caught flag … Ribbons"), so a creator reshuffle either resolves
 * correctly or fails loudly with the header that was actually found.
 *
 * Pure: takes header grids (string[][]) — the SaveTracker reads them through
 * the Sheets API — so it can be tested with the captured 6.03 fixtures.
 */

/** How many top rows to scan for header anchors. */
export const HEADER_BAND_ROWS = 10

/**
 * Where a display sheet's data block starts. Either a header label to find in
 * the band, or the Quick Checklist rule shared with the Migrator: the first
 * non-blank cell of `locatorRow` right of `fixedColumns` (the creator's stats
 * row on a fresh copy, your "Stats:" row on a migrated one — the header
 * labels themselves are replaced by your stat formulas after migration).
 */
export type DisplayAnchor =
  | { kind: 'label'; text: string }
  | { kind: 'firstNonBlank'; locatorRow: number; fixedColumns: number }

export type TrackerSpec = {
  key: string
  dataSheet: string
  displaySheet: string
  /** First Pokémon row in the data sheet / display sheet. */
  dataFirstRow: number
  displayFirstRow: number
  /** Header label (in the data sheet's band) of the FIRST column of the block that lines up with the display's block. */
  dataBlockAnchor: string
  displayAnchor: DisplayAnchor
  /** Header labels (data sheet) of the first and last TRACKED columns; `trackTo: null` = through the last labelled column. */
  trackFrom: string
  trackTo: string | null
  /** Header labels of tracked columns that must never be highlighted (auto-calculated). */
  exclude: string[]
  /** Header labels of counter columns that get the increment colour. */
  increment: string[]
  color: string
  incrementColor: string
  /** Optional second label used to double-check the display shift (label must sit at data col + shift). */
  crossCheck: string | null
  /** 1-based display column whose ascending order is the canonical row order (usually A). */
  sortDisplayColumn: number
}

/** A fully resolved tracker: concrete columns for this workbook. */
export type ResolvedTracker = {
  spec: TrackerSpec
  /** displayCol - dataCol for every tracked column. */
  shift: number
  /** Tracked data columns, ascending. */
  dataCols: number[]
  minDataCol: number
  maxDataCol: number
  minDisplayCol: number
  maxDisplayCol: number
  /** Per tracked data column: {dataCol, displayCol, color|null(excluded)} */
  cells: { dataCol: number; displayCol: number; color: string | null }[]
  /** Header labels by data column (for logs / dry runs). */
  labels: Record<number, string>
  /** The data sheet's header band as read (display strings), reused by the snapshot writer. */
  dataBand: unknown[][]
}

export function normalizeLabel(text: unknown): string {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * Find a label in a header band. Returns the 1-based column of its first
 * occurrence (scanning row by row, left to right), or null.
 */
export function findLabel(
  band: unknown[][],
  text: string,
): { row: number; col: number } | null {
  const wantedLabel = normalizeLabel(text)
  for (let rowIndex = 0; rowIndex < band.length; rowIndex++) {
    const row = band[rowIndex] ?? []
    for (let columnIndex = 0; columnIndex < row.length; columnIndex++) {
      if (normalizeLabel(row[columnIndex]) === wantedLabel)
        return { row: rowIndex + 1, col: columnIndex + 1 }
    }
  }
  return null
}

function mustFind(
  band: unknown[][],
  text: string,
  sheetDescription: string,
): { row: number; col: number } {
  const found = findLabel(band, text)
  if (!found) {
    throw new Error(
      `Layout: could not find the header "${text}" in the first ${band.length} rows of ${sheetDescription}. ` +
        'The creator may have renamed or moved it — update the tracker spec (src/lib/layout.ts).',
    )
  }
  return found
}

/** First non-blank cell of `row` (1-based, from the band) right of `fixedColumns`; 1-based column. */
export function firstNonBlankRightOf(
  band: unknown[][],
  row: number,
  fixedColumns: number,
  sheetDescription: string,
): number {
  const rowValues = band[row - 1] ?? []
  for (
    let columnIndex = fixedColumns;
    columnIndex < rowValues.length;
    columnIndex++
  ) {
    if (String(rowValues[columnIndex] ?? '').trim() !== '')
      return columnIndex + 1
  }
  throw new Error(
    `Layout: row ${row} of ${sheetDescription} is blank right of column ${fixedColumns}; cannot locate the data block.`,
  )
}

/**
 * Resolve a tracker spec against the two header bands (pure).
 * @param dataBand   header rows of the data sheet (band rows × full width)
 * @param displayBand header rows of the display sheet
 */
export function resolveFromBands(
  spec: TrackerSpec,
  dataBand: unknown[][],
  displayBand: unknown[][],
): ResolvedTracker {
  const dataSheetName = `"${spec.dataSheet}"`
  const displaySheetName = `"${spec.displaySheet}"`

  const dataBlockStart = mustFind(dataBand, spec.dataBlockAnchor, dataSheetName)
  const displayBlockStartColumn =
    spec.displayAnchor.kind === 'label'
      ? mustFind(displayBand, spec.displayAnchor.text, displaySheetName).col
      : firstNonBlankRightOf(
          displayBand,
          spec.displayAnchor.locatorRow,
          spec.displayAnchor.fixedColumns,
          displaySheetName,
        )
  const shift = displayBlockStartColumn - dataBlockStart.col

  // Tracked range, by label, on the same header row as the block anchor.
  const trackFrom = mustFind(dataBand, spec.trackFrom, dataSheetName)
  const headerRow = dataBand[trackFrom.row - 1] ?? []
  let trackToColumn: number
  if (spec.trackTo) {
    trackToColumn = mustFind(dataBand, spec.trackTo, dataSheetName).col
  } else {
    trackToColumn = headerRow.length
    while (
      trackToColumn > trackFrom.col &&
      String(headerRow[trackToColumn - 1] ?? '').trim() === ''
    )
      trackToColumn--
  }
  if (trackToColumn < trackFrom.col)
    throw new Error(
      `Layout: "${spec.trackTo}" is left of "${spec.trackFrom}" in ${dataSheetName}`,
    )

  if (spec.crossCheck) {
    const crossCheckInData = mustFind(dataBand, spec.crossCheck, dataSheetName)
    const expectedDisplayColumn = crossCheckInData.col + shift
    const displayLabelsAtColumn = displayBand.map((row) =>
      normalizeLabel(row[expectedDisplayColumn - 1]),
    )
    if (!displayLabelsAtColumn.includes(normalizeLabel(spec.crossCheck))) {
      throw new Error(
        `Layout: "${spec.crossCheck}" is at column ${crossCheckInData.col} in ${dataSheetName} so it should be at column ${expectedDisplayColumn} in ${displaySheetName} (shift ${shift}), but that column's header is "${displayBand[crossCheckInData.row - 1]?.[expectedDisplayColumn - 1] ?? ''}". Layout changed; nothing highlighted.`,
      )
    }
  }

  // exclude/increment name the FIRST column carrying that label in the
  // tracked header row (labels can repeat further right — e.g. "Friendship"
  // is both an ability attribute and, 90 columns later, a challenge flag).
  const firstTrackedColumnLabelled = (label: string): number => {
    const wantedLabel = normalizeLabel(label)
    for (let column = trackFrom.col; column <= trackToColumn; column++) {
      if (normalizeLabel(headerRow[column - 1]) === wantedLabel) return column
    }
    throw new Error(
      `Layout: tracked column "${label}" not found in the header of ${dataSheetName}; update the tracker spec.`,
    )
  }
  const excludedColumns = new Set(spec.exclude.map(firstTrackedColumnLabelled))
  const incrementColumns = new Set(
    spec.increment.map(firstTrackedColumnLabelled),
  )

  const labels: Record<number, string> = {}
  const cells: ResolvedTracker['cells'] = []
  const dataCols: number[] = []
  for (let column = trackFrom.col; column <= trackToColumn; column++) {
    labels[column] = String(headerRow[column - 1] ?? '')
    dataCols.push(column)
    cells.push({
      dataCol: column,
      displayCol: column + shift,
      color: excludedColumns.has(column)
        ? null
        : incrementColumns.has(column)
          ? spec.incrementColor
          : spec.color,
    })
  }

  return {
    spec,
    shift,
    dataCols,
    minDataCol: trackFrom.col,
    maxDataCol: trackToColumn,
    minDisplayCol: trackFrom.col + shift,
    maxDisplayCol: trackToColumn + shift,
    cells,
    labels,
    dataBand,
  }
}

/** Human-readable summary of a resolved tracker, for logs and the dry run. */
export function describeResolved(tracker: ResolvedTracker): string {
  const firstCell = tracker.cells[0]!
  const lastCell = tracker.cells[tracker.cells.length - 1]!
  const neverHighlighted = tracker.cells
    .filter((cell) => cell.color === null)
    .map(
      (cell) =>
        `${tracker.labels[cell.dataCol]}→${columnLetter(cell.displayCol)}`,
    )
  const incremented = tracker.cells
    .filter((cell) => cell.color === tracker.spec.incrementColor)
    .map(
      (cell) =>
        `${tracker.labels[cell.dataCol]}→${columnLetter(cell.displayCol)}`,
    )
  return (
    `${tracker.spec.key}: data ${columnLetter(firstCell.dataCol)}–${columnLetter(lastCell.dataCol)} (${tracker.labels[firstCell.dataCol]} … ${tracker.labels[lastCell.dataCol]}) → display ${columnLetter(firstCell.displayCol)}–${columnLetter(lastCell.displayCol)} (shift ${tracker.shift >= 0 ? '+' : ''}${tracker.shift})` +
    (incremented.length ? `; increment: ${incremented.join(', ')}` : '') +
    (neverHighlighted.length
      ? `; never highlighted: ${neverHighlighted.join(', ')}`
      : '')
  )
}

export function columnLetter(column: number): string {
  let letters = ''
  let remaining = column
  while (remaining > 0) {
    const remainder = (remaining - 1) % 26
    letters = String.fromCharCode(65 + remainder) + letters
    remaining = Math.floor((remaining - 1) / 26)
  }
  return letters
}
