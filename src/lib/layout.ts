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

export function normalizeLabel(s: unknown): string {
  return String(s ?? '')
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
  const want = normalizeLabel(text)
  for (let r = 0; r < band.length; r++) {
    const row = band[r] ?? []
    for (let c = 0; c < row.length; c++) {
      if (normalizeLabel(row[c]) === want) return { row: r + 1, col: c + 1 }
    }
  }
  return null
}

function mustFind(
  band: unknown[][],
  text: string,
  where: string,
): { row: number; col: number } {
  const hit = findLabel(band, text)
  if (!hit) {
    throw new Error(
      `Layout: could not find the header "${text}" in the first ${band.length} rows of ${where}. ` +
        'The creator may have renamed or moved it — update the tracker spec (src/lib/layout.ts).',
    )
  }
  return hit
}

/** First non-blank cell of `row` (1-based, from the band) right of `fixedColumns`; 1-based column. */
export function firstNonBlankRightOf(
  band: unknown[][],
  row: number,
  fixedColumns: number,
  where: string,
): number {
  const line = band[row - 1] ?? []
  for (let c = fixedColumns; c < line.length; c++) {
    if (String(line[c] ?? '').trim() !== '') return c + 1
  }
  throw new Error(
    `Layout: row ${row} of ${where} is blank right of column ${fixedColumns}; cannot locate the data block.`,
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
  const dataWhere = `"${spec.dataSheet}"`
  const displayWhere = `"${spec.displaySheet}"`

  const dataBlockStart = mustFind(dataBand, spec.dataBlockAnchor, dataWhere)
  const displayBlockStart =
    spec.displayAnchor.kind === 'label'
      ? mustFind(displayBand, spec.displayAnchor.text, displayWhere).col
      : firstNonBlankRightOf(
          displayBand,
          spec.displayAnchor.locatorRow,
          spec.displayAnchor.fixedColumns,
          displayWhere,
        )
  const shift = displayBlockStart - dataBlockStart.col

  // Tracked range, by label, on the same header row as the block anchor.
  const from = mustFind(dataBand, spec.trackFrom, dataWhere)
  const headerRow = dataBand[from.row - 1] ?? []
  let to: number
  if (spec.trackTo) {
    to = mustFind(dataBand, spec.trackTo, dataWhere).col
  } else {
    to = headerRow.length
    while (to > from.col && String(headerRow[to - 1] ?? '').trim() === '') to--
  }
  if (to < from.col)
    throw new Error(
      `Layout: "${spec.trackTo}" is left of "${spec.trackFrom}" in ${dataWhere}`,
    )

  if (spec.crossCheck) {
    const d = mustFind(dataBand, spec.crossCheck, dataWhere)
    const expectCol = d.col + shift
    const got = displayBand.map((r) => normalizeLabel(r[expectCol - 1]))
    if (!got.includes(normalizeLabel(spec.crossCheck))) {
      throw new Error(
        `Layout: "${spec.crossCheck}" is at column ${d.col} in ${dataWhere} so it should be at column ${expectCol} in ${displayWhere} (shift ${shift}), but that column's header is "${displayBand[d.row - 1]?.[expectCol - 1] ?? ''}". Layout changed; nothing highlighted.`,
      )
    }
  }

  // exclude/increment name the FIRST column carrying that label in the
  // tracked header row (labels can repeat further right — e.g. "Friendship"
  // is both an ability attribute and, 90 columns later, a challenge flag).
  const firstColOf = (name: string): number => {
    const want = normalizeLabel(name)
    for (let c = from.col; c <= to; c++) {
      if (normalizeLabel(headerRow[c - 1]) === want) return c
    }
    throw new Error(
      `Layout: tracked column "${name}" not found in the header of ${dataWhere}; update the tracker spec.`,
    )
  }
  const excluded = new Set(spec.exclude.map(firstColOf))
  const increment = new Set(spec.increment.map(firstColOf))

  const labels: Record<number, string> = {}
  const cells: ResolvedTracker['cells'] = []
  const dataCols: number[] = []
  for (let c = from.col; c <= to; c++) {
    labels[c] = String(headerRow[c - 1] ?? '')
    dataCols.push(c)
    cells.push({
      dataCol: c,
      displayCol: c + shift,
      color: excluded.has(c)
        ? null
        : increment.has(c)
          ? spec.incrementColor
          : spec.color,
    })
  }

  return {
    spec,
    shift,
    dataCols,
    minDataCol: from.col,
    maxDataCol: to,
    minDisplayCol: from.col + shift,
    maxDisplayCol: to + shift,
    cells,
    labels,
    dataBand,
  }
}

/** Human-readable summary of a resolved tracker, for logs and the dry run. */
export function describeResolved(r: ResolvedTracker): string {
  const a1 = (c: number): string => columnLetter(c)
  const first = r.cells[0]!
  const last = r.cells[r.cells.length - 1]!
  const excluded = r.cells
    .filter((c) => c.color === null)
    .map((c) => `${r.labels[c.dataCol]}→${a1(c.displayCol)}`)
  const inc = r.cells
    .filter((c) => c.color === r.spec.incrementColor)
    .map((c) => `${r.labels[c.dataCol]}→${a1(c.displayCol)}`)
  return (
    `${r.spec.key}: data ${a1(first.dataCol)}–${a1(last.dataCol)} (${r.labels[first.dataCol]} … ${r.labels[last.dataCol]}) → display ${a1(first.displayCol)}–${a1(last.displayCol)} (shift ${r.shift >= 0 ? '+' : ''}${r.shift})` +
    (inc.length ? `; increment: ${inc.join(', ')}` : '') +
    (excluded.length ? `; never highlighted: ${excluded.join(', ')}` : '')
  )
}

export function columnLetter(col: number): string {
  let s = ''
  while (col > 0) {
    const m = (col - 1) % 26
    s = String.fromCharCode(65 + m) + s
    col = Math.floor((col - 1) / 26)
  }
  return s
}
