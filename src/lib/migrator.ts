/**
 * MIGRATOR
 *
 * Ports your customizations from an old OfflineDex spreadsheet to a new one,
 * as a plan, preview, apply pipeline on the Sheets API:
 *   1. read the source (sheet list; formats and values of the customized
 *      ranges) and the destination (sheet list, banding and CF; the locator
 *      cells);
 *   2. build a list of migration ops (human label plus batchUpdate requests).
 *      This step is pure and tested. Planning throws if a landmark doesn't
 *      fit, so nothing is touched when the creator's layout changed;
 *   3. apply everything in one atomic batchUpdate: all steps land or none.
 *
 * `finishSetup` (setup.ts) drives it: planForVersions, then describePlan in
 * the confirm dialog, then applyPlanWithProgress.
 */

import { copyName } from '../shared/naming.ts'
import {
  type DriveSpreadsheet,
  driveQueryString,
  listSpreadsheets,
} from './driveApi.ts'
import { shiftFormulaColumns } from './formulaShift.ts'
import { finishFlow, startStep } from './progress.ts'
import {
  type CellData,
  type ConditionalFormatRule,
  type ExtendedValue,
  type GridData,
  type GridRange,
  type Request,
  type SheetInfo,
  type SheetsClient,
  type SpreadsheetInfo,
  a1,
  cellAt,
  displayText,
  gridAt,
  hexToColor,
  liveSheets,
  sheetByTitle,
  sheetRange,
} from './sheetsApi.ts'
import {
  DAILY_UNLOCKS_AG3_FORMULA,
  UNLOCK_MAP_FORMULA_COLUMNS,
  UNLOCK_MAP_FORMULA_ROW,
  normalizeFormula,
  sameFormula,
  unlockMapBiomeRange,
  unlockMapColumnFormula,
} from './trackedFormulas.ts'

// Quick Checklist: columns A-D (#, image, Dex#, name) are fixed; where the
// data block ("Caught?" … "Ribbons", QUICK_CHECKLIST_DATA_COLUMNS wide) starts
// varies by creator version. Each sheet's block is located by the first
// non-blank cell in row 10 right of D: the creator's stats row on a fresh
// copy, your "Stats:" row on a migrated one.
export const QUICK_CHECKLIST_SHEET = 'Quick Checklist'
export const QUICK_CHECKLIST_FIXED_COLUMNS = 4
export const QUICK_CHECKLIST_DATA_COLUMNS = 11
export const QUICK_CHECKLIST_LOCATOR_ROW = 10
export const QUICK_CHECKLIST_HEADER_ROWS = 10
export const QUICK_CHECKLIST_TITLE_PREFIX = 'POKEROGUE DEX '
export const QUICK_CHECKLIST_IMAGE_COLUMN = 2
/** Sheets' default row height; a non-hidden row at this height is treated as "Fit to data". */
const DEFAULT_ROW_HEIGHT = 21

// IV conditional formatting on the dex checklists.
export const DEX_IV_HIGHLIGHT_SHEETS = [
  'Starter DEX Checklist',
  'Full DEX Checklist',
]
export const DEX_IV_PERFECT_VALUE = '31'
export const DEX_IV_IMPERFECT_COLOR = '#ea9999' // red

// Daily Unlock Map: the per-unlock strings carry a parenthesized category
// marker ("(Shiny)", "(Caught)", …) for everything but nature unlocks, and the
// charm waves from the Daily Mode overrides carry a bracketed one
// ("[Shiny Charm]"); cells holding either are tinted so they stand out on the
// map. A default shiny of a species with rare and epic variants reads
// "Default Shiny", with no marker. Each pattern needs a capital letter after
// its bracket so charm counts such as "(3)" do not match. The biome grid
// starts at E2.
export const UNLOCK_MAP_SHEET = 'Daily Unlock Map'
export const UNLOCK_MAP_GRID_FIRST_ROW = 2
export const UNLOCK_MAP_GRID_FIRST_COLUMN = 5 // E
/** Tried in order: the first match colours the cell, so unlocks beat charms. */
export const UNLOCK_MAP_RULES: {
  label: string
  pattern: string
  color: string
}[] = [
  { label: 'unlocks light green', pattern: '\\([A-Z]', color: '#b7e1cd' },
  { label: 'charms light orange', pattern: '\\[[A-Z]', color: '#f9cb9c' },
]

// Daily Mode Unlocks: AG3 holds the ArrayFormula that builds each unlock's map
// string (wave, Pokémon, lures, the category marker). The repo's copy
// (trackedFormulas.ts) is written. The headers it reads are checked first, so
// a reshaped creator layout stops the plan.
export const DAILY_UNLOCKS_SHEET = 'Daily Mode Unlocks'
export const DAILY_UNLOCKS_FORMULA_ROW = 3
export const DAILY_UNLOCKS_FORMULA_COLUMN = 33 // AG
export const DAILY_UNLOCKS_LANDMARKS: {
  row: number
  column: number
  label: string
}[] = [
  { row: 1, column: 4, label: 'New Caught' }, // D1
  { row: 1, column: 5, label: 'New Fought' }, // E1
  { row: 1, column: 6, label: 'New Shiny' }, // F1
  { row: 1, column: 7, label: 'New Ability' }, // G1
  { row: 1, column: 8, label: 'New Hidden Ability' }, // H1
  { row: 1, column: 10, label: 'New Form' }, // J1
  { row: 1, column: 11, label: 'New Gender' }, // K1
  { row: 1, column: 12, label: 'New IVs' }, // L1
  { row: 2, column: 1, label: 'Dex#' }, // A2, the species and owned-IV lookups' key
  { row: 2, column: 13, label: 'Wave' }, // M2
  { row: 2, column: 14, label: 'Biome' }, // N2, the map formulas' biome filter
  { row: 2, column: 16, label: 'Pokemon' }, // P2
  { row: 2, column: 18, label: 'Lures' }, // R2
  { row: 2, column: 19, label: 'Charms' }, // S2
  { row: 2, column: 20, label: 'Shiny' }, // T2
  { row: 2, column: 21, label: 'IVs' }, // U2, merged over the six stats
]

// The AG3 formula also reads two sheets outside Daily Mode Unlocks: the species
// table, for whether a species has rare and epic shiny variants, and the daily
// calculation tab, for the starter's owned IVs. Their headers are checked the
// same way, so a creator move stops the plan instead of porting a formula that
// would read the wrong columns.
export const AG3_LOOKUP_SHEETS: {
  title: string
  headerRow: number
  lastColumn: number
  landmarks: { column: number; label: string }[]
}[] = [
  {
    title: 'STATIC:data.SPECIES',
    headerRow: 1,
    lastColumn: 37, // AK
    landmarks: [
      { column: 1, label: 'Dex #' }, // A1, the lookup key
      { column: 37, label: 'hasVariants' }, // AK1
    ],
  },
  {
    title: 'DAILY_MODE.data',
    headerRow: 1,
    lastColumn: 77, // BY
    landmarks: [
      { column: 27, label: 'HP' }, // AA1, first owned IV
      { column: 32, label: 'SPE' }, // AF1, last owned IV
      { column: 77, label: 'Species ID' }, // BY1, the owned-IV lookup's key
    ],
  },
]

// Daily Mode Unlocks: the checkboxes in D2:L2, under the "New …" headers in
// D1:L1, choose which unlock categories the sheet lists. All are turned on.
export const DAILY_UNLOCKS_FILTER_ROW = 2
export const DAILY_UNLOCKS_FILTER_FIRST_COLUMN = 4 // D
export const DAILY_UNLOCKS_FILTER_LABELS = [
  'New Caught',
  'New Fought',
  'New Shiny',
  'New Ability',
  'New Hidden Ability',
  'New Nature',
  'New Form',
  'New Gender',
  'New IVs',
]

// Daily Mode: the charm wave overrides under the "Override wave numbers"
// headers in H2 and L2. A migrated copy starts with them empty.
export const DAILY_MODE_SHEET = 'Daily Mode'
export const DAILY_MODE_OVERRIDE_HEADER = 'Override wave numbers'
export const DAILY_MODE_OVERRIDE_HEADER_ROW = 2
export const DAILY_MODE_OVERRIDE_LAST_ROW = 6
export const DAILY_MODE_OVERRIDE_COLUMNS = [8, 12] // H, L

// Party Checklist: column A holds the Pokémon typed in by hand under the
// "Pokemon" header in A2, each name in a two-row merge (A3:A4, A5:A6, …);
// the rest of each row is looked up from it.
export const PARTY_CHECKLIST_SHEET = 'Party Checklist'
export const PARTY_CHECKLIST_NAME_HEADER = 'Pokemon'
export const PARTY_CHECKLIST_HEADER_ROW = 2
export const PARTY_CHECKLIST_ROWS_PER_NAME = 2

/** One human-visible migration step and the batchUpdate requests that implement it. */
export type MigrationOp = { label: string; requests: Request[]; note?: string }
export type MigrationPlan = {
  sourceSpreadsheetId: string
  destSpreadsheetId: string
  sourceVersion: string
  destVersion: string
  ops: MigrationOp[]
  /** Things that were checked and found already done / not applicable. */
  notes: string[]
}
export type StepResult = { label: string; ok: boolean; error?: string }

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Read both spreadsheets and build the plan for migrating `sourceVersion` →
 * the active spreadsheet (`destVersion`). Nothing is written. Throws when a
 * landmark doesn't fit (the message says which).
 */
export function planForVersions(
  sourceVersion: string,
  destVersion: string,
  client: SheetsClient = liveSheets,
): MigrationPlan {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet()
  const sourceSpreadsheetId = findFileIdByVersion(sourceVersion)
  const destSpreadsheetId = spreadsheet.getId()
  Logger.log(
    `Source: ${sourceVersion} -> ${sourceSpreadsheetId}; dest: ${destVersion} -> ${destSpreadsheetId} (active)`,
  )
  const source = readSource(client, sourceSpreadsheetId)
  const dest = readDestination(client, destSpreadsheetId)
  const { ops, notes } = buildPlan(source, dest, destVersion)
  return {
    sourceSpreadsheetId,
    destSpreadsheetId,
    sourceVersion,
    destVersion,
    ops,
    notes,
  }
}

/** Apply a plan in one atomic batchUpdate. */
export function applyPlan(
  plan: MigrationPlan,
  client: SheetsClient = liveSheets,
): void {
  const requests = plan.ops.flatMap((op) => op.requests)
  if (requests.length === 0) return
  client.batchUpdate(plan.destSpreadsheetId, requests)
}

/** Apply with a toast step; one result per op (all OK, or all ERR with the same message, since the batch is atomic). */
export function applyPlanWithProgress(
  plan: MigrationPlan,
  client: SheetsClient = liveSheets,
): StepResult[] {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet()
  const requestCount = plan.ops.reduce(
    (total, op) => total + op.requests.length,
    0,
  )
  startStep(
    spreadsheet,
    `Applying ${plan.ops.length} steps (${requestCount} changes)`,
  )
  try {
    applyPlan(plan, client)
  } catch (applyError) {
    const error =
      applyError instanceof Error ? applyError.message : String(applyError)
    finishFlow(spreadsheet, 'Migration failed', 10)
    return plan.ops.map((op) => ({ label: op.label, ok: false, error }))
  }
  finishFlow(spreadsheet, 'Migration complete', 10)
  return plan.ops.map((op) => ({ label: op.label, ok: true }))
}

/** "OK  label" / "ERR label: message" lines. */
export function formatResults(results: StepResult[]): string {
  return results
    .map((result) =>
      result.ok
        ? 'OK  ' + result.label
        : 'ERR ' + result.label + ': ' + result.error,
    )
    .join('\n')
}

/** Human-readable plan, for the confirm dialog and the log. */
export function describePlan(plan: MigrationPlan): string {
  const opLines = plan.ops.map(
    (op) => `• ${op.label}${op.note ? `\n    ${op.note}` : ''}`,
  )
  const noteLines = plan.notes.map((note) => `· ${note}`)
  return [...opLines, ...noteLines].join('\n')
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** `meta`: sheet list (+ banding/CF for the destination); `grid`: cell data of the customized ranges. */
export type SourceInfo = { meta: SpreadsheetInfo; grid: SpreadsheetInfo }
export type DestInfo = { meta: SpreadsheetInfo; grid: SpreadsheetInfo }

const GRID_FIELDS =
  'sheets(properties(sheetId,title,gridProperties),data(startRow,startColumn,rowData(values(userEnteredValue,userEnteredFormat,formattedValue)),rowMetadata,columnMetadata))'

export function readSource(
  client: SheetsClient,
  sourceSpreadsheetId: string,
): SourceInfo {
  const meta = client.get(sourceSpreadsheetId, {
    fields: 'sheets(properties(sheetId,title,index,hidden,gridProperties))',
  })
  // The metadata read comes first: it says which optional sheets exist.
  // The tracked formulas are read only to compare with the repo's copies.
  const grid = client.get(sourceSpreadsheetId, {
    ranges: [
      `'${QUICK_CHECKLIST_SHEET}'!1:${QUICK_CHECKLIST_HEADER_ROWS}`,
      ...trackedFormulaRanges(meta),
      ...partyChecklistNameRanges(meta),
    ],
    includeGridData: true,
    fields: GRID_FIELDS,
  })
  return { meta, grid }
}

/** The Party Checklist name column from its header down, if `meta` has the sheet. */
function partyChecklistNameRanges(meta: SpreadsheetInfo): string[] {
  return sheetByTitle(meta, PARTY_CHECKLIST_SHEET)
    ? [sheetRange(PARTY_CHECKLIST_SHEET, `A${PARTY_CHECKLIST_HEADER_ROW}:A`)]
    : []
}

/** Ranges holding the tracked formulas, on the sheets of `meta` that exist. */
function trackedFormulaRanges(meta: SpreadsheetInfo): string[] {
  const ranges: string[] = []
  if (sheetByTitle(meta, DAILY_UNLOCKS_SHEET))
    ranges.push(
      sheetRange(
        DAILY_UNLOCKS_SHEET,
        a1(DAILY_UNLOCKS_FORMULA_ROW, DAILY_UNLOCKS_FORMULA_COLUMN),
      ),
    )
  if (sheetByTitle(meta, UNLOCK_MAP_SHEET))
    ranges.push(sheetRange(UNLOCK_MAP_SHEET, unlockMapFormulaCells()))
  return ranges
}

/** E2:I2, the Daily Unlock Map cells holding one formula per column. */
function unlockMapFormulaCells(): string {
  const columns = UNLOCK_MAP_FORMULA_COLUMNS.map((entry) => entry.column)
  return `${a1(UNLOCK_MAP_FORMULA_ROW, Math.min(...columns))}:${a1(UNLOCK_MAP_FORMULA_ROW, Math.max(...columns))}`
}

export function readDestination(
  client: SheetsClient,
  destSpreadsheetId: string,
): DestInfo {
  const meta = client.get(destSpreadsheetId, {
    fields:
      'sheets(properties(sheetId,title,index,hidden,gridProperties),bandedRanges,conditionalFormats)',
  })
  const grid = client.get(destSpreadsheetId, {
    ranges: [
      `'${QUICK_CHECKLIST_SHEET}'!1:${QUICK_CHECKLIST_HEADER_ROWS}`,
      // The landmark headers and the formula cell, read as one block from A1.
      sheetRange(
        DAILY_UNLOCKS_SHEET,
        `A1:${a1(DAILY_UNLOCKS_FORMULA_ROW, DAILY_UNLOCKS_FORMULA_COLUMN)}`,
      ),
      // The header rows of the sheets AG3 looks up.
      ...AG3_LOOKUP_SHEETS.map((lookup) =>
        sheetRange(
          lookup.title,
          `A${lookup.headerRow}:${a1(lookup.headerRow, lookup.lastColumn)}`,
        ),
      ),
      ...(sheetByTitle(meta, UNLOCK_MAP_SHEET)
        ? [sheetRange(UNLOCK_MAP_SHEET, unlockMapFormulaCells())]
        : []),
      ...(sheetByTitle(meta, DAILY_MODE_SHEET)
        ? [sheetRange(DAILY_MODE_SHEET, dailyModeOverrideBlock())]
        : []),
      ...partyChecklistNameRanges(meta),
    ],
    includeGridData: true,
    fields: GRID_FIELDS,
  })
  return { meta, grid }
}

/** H2:L6 on Daily Mode: both override headers and the cells under them. */
function dailyModeOverrideBlock(): string {
  return `${a1(DAILY_MODE_OVERRIDE_HEADER_ROW, Math.min(...DAILY_MODE_OVERRIDE_COLUMNS))}:${a1(DAILY_MODE_OVERRIDE_LAST_ROW, Math.max(...DAILY_MODE_OVERRIDE_COLUMNS))}`
}

// ---------------------------------------------------------------------------
// Plan (pure)
// ---------------------------------------------------------------------------

export function buildPlan(
  source: SourceInfo,
  dest: DestInfo,
  destVersion: string,
): { ops: MigrationOp[]; notes: string[] } {
  const ops: MigrationOp[] = []
  const notes: string[] = []
  ops.push(...planQuickChecklist(source, dest, destVersion))
  ops.push(...planQuickChecklistBanding(dest, notes))
  ops.push(...planHiddenSheets(source, dest, notes))
  ops.push(...planSheetOrder(source, dest, notes))
  ops.push(...planDexIvHighlight(dest, notes))
  ops.push(...planUnlockMapHighlight(dest, notes))
  ops.push(...planDailyUnlocksFormula(source, dest, notes))
  ops.push(...planDailyUnlocksFilters(dest, notes))
  ops.push(...planDailyModeOverrides(dest, notes))
  ops.push(...planPartyChecklistNames(source, dest, notes))
  ops.push(...planUnlockMapFormulas(source, dest, notes))
  return { ops, notes }
}

/** Unwrap a lookup result, throwing `missingMessage` when it is null/undefined. */
function requireFound<T>(
  value: T | null | undefined,
  missingMessage: string,
): T {
  if (value === null || value === undefined) throw new Error(missingMessage)
  return value
}

/** First non-blank cell of the locator row right of the fixed columns (1-based col). */
export function quickChecklistFirstDataColumn(
  grid: GridData | null,
  spreadsheetRole: string,
): number {
  const locatorRowIndex =
    QUICK_CHECKLIST_LOCATOR_ROW - 1 - (grid?.startRow ?? 0)
  const locatorRowCells = grid?.rowData?.[locatorRowIndex]?.values ?? []
  for (
    let columnIndex = QUICK_CHECKLIST_FIXED_COLUMNS;
    columnIndex < locatorRowCells.length;
    columnIndex++
  ) {
    if (displayText(locatorRowCells[columnIndex]!).trim() !== '')
      return columnIndex + 1
  }
  throw new Error(
    `Quick Checklist (${spreadsheetRole}): row ${QUICK_CHECKLIST_LOCATOR_ROW} is blank right of column ${QUICK_CHECKLIST_FIXED_COLUMNS}; cannot locate the data block`,
  )
}

/**
 * Rows 1-10 of the Quick Checklist: formats for every source column, row
 * heights + hidden rows, column widths, row 1 formulas/values over the data
 * block and all of row 10 (same-sheet references shifted if the destination
 * block starts further right), hide Ribbons, stamp the title.
 */
export function planQuickChecklist(
  source: SourceInfo,
  dest: DestInfo,
  destVersion: string,
): MigrationOp[] {
  const sourceSheet = requireFound(
    sheetByTitle(source.grid, QUICK_CHECKLIST_SHEET),
    'Quick Checklist not found in the source',
  )
  const destSheet = requireFound(
    sheetByTitle(dest.grid, QUICK_CHECKLIST_SHEET),
    'Quick Checklist not found in the destination',
  )
  const destSheetMeta = requireFound(
    sheetByTitle(dest.meta, QUICK_CHECKLIST_SHEET),
    'Quick Checklist not found in the destination',
  )
  const sheetId = destSheet.properties.sheetId
  const sourceGrid = gridAt(sourceSheet)
  const destGrid = gridAt(destSheet)

  const sourceFirstDataColumn = quickChecklistFirstDataColumn(
    sourceGrid,
    'source',
  )
  const destFirstDataColumn = quickChecklistFirstDataColumn(
    destGrid,
    'destination',
  )
  const columnOffset = destFirstDataColumn - sourceFirstDataColumn
  if (columnOffset < 0) {
    throw new Error(
      `Quick Checklist: destination data block starts at column ${destFirstDataColumn}, left of the source's ${sourceFirstDataColumn}; layout unknown, nothing ported`,
    )
  }
  // Port only through the end of the data block (Ribbons); nothing of ours
  // lives right of it, and stray source columns must not be carried over.
  const sourceLastPortedColumn =
    sourceFirstDataColumn + QUICK_CHECKLIST_DATA_COLUMNS - 1
  const destColumnsNeeded = sourceLastPortedColumn + columnOffset
  const destColumnCount =
    destSheetMeta.properties.gridProperties?.columnCount ?? 0
  const destLastDataColumn =
    destFirstDataColumn + QUICK_CHECKLIST_DATA_COLUMNS - 1
  /** Where a 1-based source column lands in the destination (block columns shift; fixed columns don't). */
  const toDestColumn = (sourceColumn: number): number =>
    sourceColumn >= sourceFirstDataColumn
      ? sourceColumn + columnOffset
      : sourceColumn

  const ops: MigrationOp[] = []
  const requests: Request[] = []

  if (destColumnCount < destColumnsNeeded) {
    requests.push({
      appendDimension: {
        sheetId,
        dimension: 'COLUMNS',
        length: destColumnsNeeded - destColumnCount,
      },
    })
  }

  // Formats, rows 1-10, in up to two column segments (left of the block, and the shifted block+rest).
  const formatRowsRequest = (
    fromColumn: number,
    toColumn: number,
  ): Request => ({
    updateCells: {
      range: {
        sheetId,
        startRowIndex: 0,
        endRowIndex: QUICK_CHECKLIST_HEADER_ROWS,
        startColumnIndex: toDestColumn(fromColumn) - 1,
        endColumnIndex: toDestColumn(toColumn),
      },
      rows: Array.from(
        { length: QUICK_CHECKLIST_HEADER_ROWS },
        (_, rowIndex) => ({
          values: Array.from(
            { length: toColumn - fromColumn + 1 },
            (_, columnInSegment) => ({
              userEnteredFormat:
                cellAt(sourceGrid, rowIndex, fromColumn - 1 + columnInSegment)
                  .userEnteredFormat ?? {},
            }),
          ),
        }),
      ),
      fields: 'userEnteredFormat',
    },
  })
  if (sourceFirstDataColumn > 1)
    requests.push(formatRowsRequest(1, sourceFirstDataColumn - 1))
  requests.push(
    formatRowsRequest(sourceFirstDataColumn, sourceLastPortedColumn),
  )

  // Row heights and hidden rows. A visible source row at the default height
  // is treated as "Fit to data" (the API reports only the stored height), so
  // it is auto-resized after the cell contents are written below.
  const autoFitRowIndexes: number[] = []
  for (let rowIndex = 0; rowIndex < QUICK_CHECKLIST_HEADER_ROWS; rowIndex++) {
    const rowMeta = sourceGrid?.rowMetadata?.[rowIndex] ?? {}
    const isHidden = !!rowMeta.hiddenByUser
    const pixelSize = rowMeta.pixelSize ?? DEFAULT_ROW_HEIGHT
    if (!isHidden && pixelSize === DEFAULT_ROW_HEIGHT)
      autoFitRowIndexes.push(rowIndex)
    requests.push({
      updateDimensionProperties: {
        range: {
          sheetId,
          dimension: 'ROWS',
          startIndex: rowIndex,
          endIndex: rowIndex + 1,
        },
        properties: { pixelSize, hiddenByUser: isHidden },
        fields: 'pixelSize,hiddenByUser',
      },
    })
  }
  // Column widths (hidden states stay the creator's).
  for (
    let sourceColumn = 1;
    sourceColumn <= sourceLastPortedColumn;
    sourceColumn++
  ) {
    const columnMeta = sourceGrid?.columnMetadata?.[sourceColumn - 1]
    if (!columnMeta?.pixelSize) continue
    requests.push({
      updateDimensionProperties: {
        range: {
          sheetId,
          dimension: 'COLUMNS',
          startIndex: toDestColumn(sourceColumn) - 1,
          endIndex: toDestColumn(sourceColumn),
        },
        properties: { pixelSize: columnMeta.pixelSize },
        fields: 'pixelSize',
      },
    })
  }

  // Row 1 over the data block and row 10 in full: formulas (shifted) or values.
  const valuesRequest = (
    row: number,
    fromColumn: number,
    toColumn: number,
  ): Request => ({
    updateCells: {
      range: {
        sheetId,
        startRowIndex: row - 1,
        endRowIndex: row,
        startColumnIndex: toDestColumn(fromColumn) - 1,
        endColumnIndex: toDestColumn(toColumn),
      },
      rows: [
        {
          values: Array.from(
            { length: toColumn - fromColumn + 1 },
            (_, columnInSegment) => {
              const sourceValue = cellAt(
                sourceGrid,
                row - 1,
                fromColumn - 1 + columnInSegment,
              ).userEnteredValue
              if (!sourceValue) return {}
              if (sourceValue.formulaValue !== undefined) {
                return {
                  userEnteredValue: {
                    formulaValue: shiftFormulaColumns(
                      sourceValue.formulaValue,
                      sourceFirstDataColumn,
                      columnOffset,
                    ),
                  },
                }
              }
              return { userEnteredValue: sourceValue }
            },
          ),
        },
      ],
      fields: 'userEnteredValue',
    },
  })
  requests.push(
    valuesRequest(
      1,
      sourceFirstDataColumn,
      sourceFirstDataColumn + QUICK_CHECKLIST_DATA_COLUMNS - 1,
    ),
  )
  if (sourceFirstDataColumn > 1)
    requests.push(
      valuesRequest(QUICK_CHECKLIST_LOCATOR_ROW, 1, sourceFirstDataColumn - 1),
    )
  requests.push(
    valuesRequest(
      QUICK_CHECKLIST_LOCATOR_ROW,
      sourceFirstDataColumn,
      sourceLastPortedColumn,
    ),
  )

  // "Fit to data" for the auto-height rows, now that their contents are in place.
  for (const rowIndex of autoFitRowIndexes) {
    requests.push({
      autoResizeDimensions: {
        dimensions: {
          sheetId,
          dimension: 'ROWS',
          startIndex: rowIndex,
          endIndex: rowIndex + 1,
        },
      },
    })
  }

  // Hide Ribbons (last column of the block).
  requests.push({
    updateDimensionProperties: {
      range: {
        sheetId,
        dimension: 'COLUMNS',
        startIndex: destLastDataColumn - 1,
        endIndex: destLastDataColumn,
      },
      properties: { hiddenByUser: true },
      fields: 'hiddenByUser',
    },
  })

  ops.push({
    label: 'Quick Checklist header (rows 1–10)',
    note:
      columnOffset > 0
        ? `source block at column ${sourceFirstDataColumn}, destination at ${destFirstDataColumn}: formulas shifted right by ${columnOffset}; Ribbons (col ${destLastDataColumn}) hidden`
        : `block at column ${destFirstDataColumn} in both; Ribbons (col ${destLastDataColumn}) hidden`,
    requests,
  })

  // Title stamp: the creator's copy can lag a version.
  ops.push({
    label: 'Quick Checklist title',
    note: `A1 ← "${QUICK_CHECKLIST_TITLE_PREFIX}${destVersion}"`,
    requests: [
      {
        updateCells: {
          range: {
            sheetId,
            startRowIndex: 0,
            endRowIndex: 1,
            startColumnIndex: 0,
            endColumnIndex: 1,
          },
          rows: [
            {
              values: [
                {
                  userEnteredValue: {
                    stringValue: QUICK_CHECKLIST_TITLE_PREFIX + destVersion,
                  },
                },
              ],
            },
          ],
          fields: 'userEnteredValue',
        },
      },
    ],
  })
  return ops
}

/**
 * Extend the alternating-colour banding to cover the Pokémon image column B:
 * a banding starting at C is stretched left (merging with an A-only banding
 * if present) and B's cell fills are cleared over the banded rows. If a
 * banding already spans B, only the fills are cleared.
 */
export function planQuickChecklistBanding(
  dest: DestInfo,
  notes: string[],
): MigrationOp[] {
  const destSheetMeta = requireFound(
    sheetByTitle(dest.meta, QUICK_CHECKLIST_SHEET),
    'Quick Checklist not found in the destination',
  )
  const sheetId = destSheetMeta.properties.sheetId
  const imageColumnIndex = QUICK_CHECKLIST_IMAGE_COLUMN - 1 // 0-based
  const bandings = destSheetMeta.bandedRanges ?? []
  const clearImageFillsRequest = (bandedRange: GridRange): Request => ({
    repeatCell: {
      range: {
        sheetId,
        startRowIndex: bandedRange.startRowIndex,
        endRowIndex: bandedRange.endRowIndex,
        startColumnIndex: imageColumnIndex,
        endColumnIndex: imageColumnIndex + 1,
      },
      cell: { userEnteredFormat: {} },
      fields:
        'userEnteredFormat.backgroundColor,userEnteredFormat.backgroundColorStyle',
    },
  })

  const bandingRightOfImage = bandings.find(
    (banding) => (banding.range.startColumnIndex ?? 0) === imageColumnIndex + 1,
  )
  if (bandingRightOfImage) {
    const bandingLeftOfImage = bandings.find(
      (banding) =>
        banding !== bandingRightOfImage &&
        (banding.range.endColumnIndex ?? 0) === imageColumnIndex,
    )
    const startColumnIndex = bandingLeftOfImage
      ? (bandingLeftOfImage.range.startColumnIndex ?? 0)
      : imageColumnIndex
    const requests: Request[] = []
    if (bandingLeftOfImage)
      requests.push({
        deleteBanding: { bandedRangeId: bandingLeftOfImage.bandedRangeId },
      })
    requests.push({
      updateBanding: {
        bandedRange: {
          bandedRangeId: bandingRightOfImage.bandedRangeId,
          range: { ...bandingRightOfImage.range, startColumnIndex },
        },
        fields: 'range',
      },
    })
    requests.push(clearImageFillsRequest(bandingRightOfImage.range))
    return [
      {
        label: 'Quick Checklist banding over the image column',
        note: bandingLeftOfImage
          ? 'merged with the A-only banding'
          : 'extended left to B',
        requests,
      },
    ]
  }
  const bandingSpanningImage = bandings.find(
    (banding) =>
      (banding.range.startColumnIndex ?? 0) <= imageColumnIndex &&
      (banding.range.endColumnIndex ?? 0) > imageColumnIndex,
  )
  if (bandingSpanningImage) {
    return [
      {
        label: 'Quick Checklist banding over the image column',
        note: 'already covers B; clearing B fills',
        requests: [clearImageFillsRequest(bandingSpanningImage.range)],
      },
    ]
  }
  notes.push(
    'Quick Checklist: no banding starting at C or spanning B; nothing to extend',
  )
  return []
}

/** Hide every destination sheet whose same-named source sheet is hidden. */
export function planHiddenSheets(
  source: SourceInfo,
  dest: DestInfo,
  notes: string[],
): MigrationOp[] {
  const destSheetsByTitle = new Map(
    (dest.meta.sheets ?? []).map((sheet) => [sheet.properties.title, sheet]),
  )
  const requests: Request[] = []
  const hiddenTitles: string[] = []
  for (const sourceSheet of source.meta.sheets ?? []) {
    if (!sourceSheet.properties.hidden) continue
    const destSheet = destSheetsByTitle.get(sourceSheet.properties.title)
    if (!destSheet || destSheet.properties.hidden) continue
    requests.push({
      updateSheetProperties: {
        properties: { sheetId: destSheet.properties.sheetId, hidden: true },
        fields: 'hidden',
      },
    })
    hiddenTitles.push(sourceSheet.properties.title)
  }
  if (!requests.length) {
    notes.push('Hidden sheets: nothing to hide (already matching)')
    return []
  }
  return [
    {
      label: `Hide ${hiddenTitles.length} sheet(s)`,
      note: hiddenTitles.join(', '),
      requests,
    },
  ]
}

/** A spreadsheet's sheets in tab order. */
function sheetsInTabOrder(spreadsheet: SpreadsheetInfo): SheetInfo[] {
  return (spreadsheet.sheets ?? [])
    .map((sheet, position) => ({
      sheet,
      tabIndex: sheet.properties.index ?? position,
    }))
    .sort((left, right) => left.tabIndex - right.tabIndex)
    .map(({ sheet }) => sheet)
}

/**
 * Arrange the destination's tabs in the source's order. Sheets in both,
 * matched by title, take the source's relative order in the positions such
 * sheets hold in the destination; sheets only in the destination stay put.
 */
export function planSheetOrder(
  source: SourceInfo,
  dest: DestInfo,
  notes: string[],
): MigrationOp[] {
  const destSheets = sheetsInTabOrder(dest.meta)
  const destSheetsByTitle = new Map(
    destSheets.map((sheet) => [sheet.properties.title, sheet]),
  )
  const sharedInSourceOrder = sheetsInTabOrder(source.meta)
    .map((sheet) => destSheetsByTitle.get(sheet.properties.title))
    .filter((sheet) => sheet !== undefined)
  const shared = new Set(sharedInSourceOrder)
  let nextShared = 0
  const targetOrder = destSheets.map((sheet) =>
    shared.has(sheet) ? sharedInSourceOrder[nextShared++]! : sheet,
  )
  // Each sheet moves left into its final position, where the API's
  // before-the-move index equals the target index.
  const currentOrder = [...destSheets]
  const requests: Request[] = []
  const movedTitles: string[] = []
  targetOrder.forEach((sheet, targetIndex) => {
    const currentIndex = currentOrder.indexOf(sheet)
    if (currentIndex === targetIndex) return
    currentOrder.splice(currentIndex, 1)
    currentOrder.splice(targetIndex, 0, sheet)
    requests.push({
      updateSheetProperties: {
        properties: { sheetId: sheet.properties.sheetId, index: targetIndex },
        fields: 'index',
      },
    })
    movedTitles.push(sheet.properties.title)
  })
  if (!requests.length) {
    notes.push('Sheet order: already matching the previous version')
    return []
  }
  return [
    {
      label: 'Sheet order: match the previous version',
      note: `moved ${movedTitles.join(', ')}`,
      requests,
    },
  ]
}

/** Replace the "perfect IV" (= 31 → yellow) rules on the dex checklists with "≠ 31 → red" over the same ranges. */
export function planDexIvHighlight(
  dest: DestInfo,
  notes: string[],
): MigrationOp[] {
  const ops: MigrationOp[] = []
  for (const sheetTitle of DEX_IV_HIGHLIGHT_SHEETS) {
    const sheet = sheetByTitle(dest.meta, sheetTitle)
    if (!sheet) {
      notes.push(`IV highlight: "${sheetTitle}" not found, skipping`)
      continue
    }
    const sheetId = sheet.properties.sheetId
    const rules = sheet.conditionalFormats ?? []
    const perfectIvRules = rules
      .map((rule, index) => ({ rule, index }))
      .filter(({ rule }) => isPerfectIvRule(rule))
    if (!perfectIvRules.length) {
      notes.push(
        `IV highlight: no "= ${DEX_IV_PERFECT_VALUE}" rule on "${sheetTitle}" (already replaced?)`,
      )
      continue
    }
    const requests: Request[] = []
    // Highest index first so earlier indices stay valid while we replace.
    for (const { rule, index } of [...perfectIvRules].sort(
      (ruleA, ruleB) => ruleB.index - ruleA.index,
    )) {
      requests.push({ deleteConditionalFormatRule: { sheetId, index } })
      rule.ranges.forEach((range, rangeOffset) => {
        const topLeftCell = a1(
          (range.startRowIndex ?? 0) + 1,
          (range.startColumnIndex ?? 0) + 1,
        )
        requests.push({
          addConditionalFormatRule: {
            index: index + rangeOffset,
            rule: {
              ranges: [{ ...range, sheetId }],
              booleanRule: {
                condition: {
                  type: 'CUSTOM_FORMULA',
                  values: [
                    {
                      userEnteredValue: `=TO_TEXT(${topLeftCell})<>"${DEX_IV_PERFECT_VALUE}"`,
                    },
                  ],
                },
                format: { backgroundColor: hexToColor(DEX_IV_IMPERFECT_COLOR) },
              },
            },
          },
        })
      })
    }
    ops.push({
      label: `${sheetTitle}: IV highlight → red when not 31`,
      note: `${perfectIvRules.length} rule(s) replaced`,
      requests,
    })
  }
  return ops
}

export function isPerfectIvRule(rule: ConditionalFormatRule): boolean {
  const condition = rule.booleanRule?.condition
  if (!condition) return false
  const conditionValue = String(condition.values?.[0]?.userEnteredValue ?? '')
  return (
    (condition.type === 'TEXT_EQ' || condition.type === 'NUMBER_EQ') &&
    conditionValue === DEX_IV_PERFECT_VALUE
  )
}

/**
 * Tint every Daily Unlock Map cell whose text holds a marker: green for an
 * unlock, yellow for a cell that only announces a charm. Two REGEXMATCH
 * custom-formula rules over the biome grid, the unlock one first so a cell with
 * both reads as an unlock; each is skipped when the sheet already has it.
 */
export function planUnlockMapHighlight(
  dest: DestInfo,
  notes: string[],
): MigrationOp[] {
  const sheet = sheetByTitle(dest.meta, UNLOCK_MAP_SHEET)
  if (!sheet) {
    notes.push(
      `Unlock map highlight: "${UNLOCK_MAP_SHEET}" not found, skipping`,
    )
    return []
  }
  const existingRules = sheet.conditionalFormats ?? []
  const missingRules = UNLOCK_MAP_RULES.filter(
    (marker) =>
      !existingRules.some(
        (rule) => markerRuleFormula(rule) === markerFormula(marker.pattern),
      ),
  )
  if (!missingRules.length) {
    notes.push('Unlock map highlight: rules already present')
    return []
  }
  const sheetId = sheet.properties.sheetId
  const gridProperties = sheet.properties.gridProperties ?? {}
  const range: GridRange = {
    sheetId,
    startRowIndex: UNLOCK_MAP_GRID_FIRST_ROW - 1,
    startColumnIndex: UNLOCK_MAP_GRID_FIRST_COLUMN - 1,
    ...(gridProperties.rowCount
      ? { endRowIndex: gridProperties.rowCount }
      : {}),
    ...(gridProperties.columnCount
      ? { endColumnIndex: gridProperties.columnCount }
      : {}),
  }
  return [
    {
      label: `${UNLOCK_MAP_SHEET}: highlight cells with a marker`,
      note: `${missingRules.map((marker) => marker.label).join(' and ')} from ${a1(UNLOCK_MAP_GRID_FIRST_ROW, UNLOCK_MAP_GRID_FIRST_COLUMN)}`,
      requests: missingRules.map((marker, markerIndex) => ({
        addConditionalFormatRule: {
          index: markerIndex,
          rule: {
            ranges: [range],
            booleanRule: {
              condition: {
                type: 'CUSTOM_FORMULA',
                values: [{ userEnteredValue: markerFormula(marker.pattern) }],
              },
              format: { backgroundColor: hexToColor(marker.color) },
            },
          },
        },
      })),
    },
  ]
}

export function markerFormula(pattern: string): string {
  const topLeftCell = a1(
    UNLOCK_MAP_GRID_FIRST_ROW,
    UNLOCK_MAP_GRID_FIRST_COLUMN,
  )
  return `=REGEXMATCH(${topLeftCell}, "${pattern}")`
}

function markerRuleFormula(rule: ConditionalFormatRule): string | undefined {
  const condition = rule.booleanRule?.condition
  if (condition?.type !== 'CUSTOM_FORMULA') return undefined
  return condition.values?.[0]?.userEnteredValue
}

/** The formula a source sheet holds at `row`/`column` (1-based), as read by readSource. */
function sourceFormulaAt(
  source: SourceInfo,
  sheetTitle: string,
  row: number,
  column: number,
  firstColumn = column,
): string | undefined {
  const sourceSheet = sheetByTitle(source.grid, sheetTitle)
  if (!sourceSheet) return undefined
  return cellAt(
    gridAt(sourceSheet, row - 1, firstColumn - 1),
    0,
    column - firstColumn,
  ).userEnteredValue?.formulaValue
}

/** Note a source formula that differs from the repo's copy, which is what gets written. */
function noteSourceDrift(
  notes: string[],
  sheetTitle: string,
  cell: string,
  sourceFormula: string | undefined,
  repoFormula: string,
): void {
  if (sourceFormula !== undefined && !sameFormula(sourceFormula, repoFormula))
    notes.push(
      `${sheetTitle}: ${cell} in the source differs from the repo's copy in trackedFormulas.ts, which is what gets written; copy the source's into the repo first to keep its changes`,
    )
}

function formulaCellRequest(
  sheetId: number,
  row: number,
  column: number,
  formula: string,
): Request {
  return {
    updateCells: {
      range: {
        sheetId,
        startRowIndex: row - 1,
        endRowIndex: row,
        startColumnIndex: column - 1,
        endColumnIndex: column,
      },
      rows: [{ values: [{ userEnteredValue: { formulaValue: formula } }] }],
      fields: 'userEnteredValue',
    },
  }
}

/**
 * Write the repo's AG3 map-string formula into the destination's Daily Mode
 * Unlocks, unless it already holds it. Throws when the destination lacks the
 * formula, or a header the formula reads, on Daily Mode Unlocks or on a sheet
 * it looks up, is not where expected.
 */
export function planDailyUnlocksFormula(
  source: SourceInfo,
  dest: DestInfo,
  notes: string[],
): MigrationOp[] {
  const formulaCell = a1(
    DAILY_UNLOCKS_FORMULA_ROW,
    DAILY_UNLOCKS_FORMULA_COLUMN,
  )
  noteSourceDrift(
    notes,
    DAILY_UNLOCKS_SHEET,
    formulaCell,
    sourceFormulaAt(
      source,
      DAILY_UNLOCKS_SHEET,
      DAILY_UNLOCKS_FORMULA_ROW,
      DAILY_UNLOCKS_FORMULA_COLUMN,
    ),
    DAILY_UNLOCKS_AG3_FORMULA,
  )
  const destSheet = requireFound(
    sheetByTitle(dest.grid, DAILY_UNLOCKS_SHEET),
    `${DAILY_UNLOCKS_SHEET} not found in the destination`,
  )
  const destGrid = gridAt(destSheet, 0, 0)
  for (const landmark of DAILY_UNLOCKS_LANDMARKS) {
    const found = displayText(
      cellAt(destGrid, landmark.row - 1, landmark.column - 1),
    ).trim()
    if (found !== landmark.label)
      throw new Error(
        `${DAILY_UNLOCKS_SHEET}: expected "${landmark.label}" at ${a1(landmark.row, landmark.column)} in the destination, found "${found}"; layout changed, ${formulaCell} formula not ported`,
      )
  }
  for (const lookup of AG3_LOOKUP_SHEETS) {
    const lookupSheet = requireFound(
      sheetByTitle(dest.grid, lookup.title),
      `"${lookup.title}" not found in the destination; ${formulaCell} formula not ported`,
    )
    const lookupGrid = gridAt(lookupSheet, lookup.headerRow - 1, 0)
    for (const landmark of lookup.landmarks) {
      const found = displayText(
        cellAt(lookupGrid, 0, landmark.column - 1),
      ).trim()
      if (found !== landmark.label)
        throw new Error(
          `${lookup.title}: expected "${landmark.label}" at ${a1(lookup.headerRow, landmark.column)} in the destination, found "${found}"; the column AG3 looks up moved, ${formulaCell} formula not ported`,
        )
    }
  }
  const destFormula = cellAt(
    destGrid,
    DAILY_UNLOCKS_FORMULA_ROW - 1,
    DAILY_UNLOCKS_FORMULA_COLUMN - 1,
  ).userEnteredValue?.formulaValue
  if (destFormula === undefined)
    throw new Error(
      `${DAILY_UNLOCKS_SHEET}: ${formulaCell} holds no formula in the destination; the map-string column moved, formula not ported`,
    )
  if (sameFormula(destFormula, DAILY_UNLOCKS_AG3_FORMULA)) {
    notes.push(
      `${DAILY_UNLOCKS_SHEET}: ${formulaCell} formula already matching the repo's`,
    )
    return []
  }
  return [
    {
      label: `${DAILY_UNLOCKS_SHEET}: ${formulaCell} formula`,
      note: "the repo's copy",
      requests: [
        formulaCellRequest(
          destSheet.properties.sheetId,
          DAILY_UNLOCKS_FORMULA_ROW,
          DAILY_UNLOCKS_FORMULA_COLUMN,
          DAILY_UNLOCKS_AG3_FORMULA,
        ),
      ],
    },
  ]
}

/**
 * Check every Daily Mode Unlocks filter checkbox (D2:L2) in the destination.
 * Throws when a "New …" header above them is not where expected, or a cell
 * under one holds no checkbox value.
 */
export function planDailyUnlocksFilters(
  dest: DestInfo,
  notes: string[],
): MigrationOp[] {
  const headerRow = DAILY_UNLOCKS_FILTER_ROW - 1
  const lastColumn =
    DAILY_UNLOCKS_FILTER_FIRST_COLUMN + DAILY_UNLOCKS_FILTER_LABELS.length - 1
  const filterRange = `${a1(DAILY_UNLOCKS_FILTER_ROW, DAILY_UNLOCKS_FILTER_FIRST_COLUMN)}:${a1(DAILY_UNLOCKS_FILTER_ROW, lastColumn)}`
  const destSheet = requireFound(
    sheetByTitle(dest.grid, DAILY_UNLOCKS_SHEET),
    `${DAILY_UNLOCKS_SHEET} not found in the destination`,
  )
  const destGrid = gridAt(destSheet, 0, 0)
  const checkedStates = DAILY_UNLOCKS_FILTER_LABELS.map((label, offset) => {
    const column = DAILY_UNLOCKS_FILTER_FIRST_COLUMN + offset
    const header = displayText(
      cellAt(destGrid, headerRow - 1, column - 1),
    ).trim()
    if (header !== label)
      throw new Error(
        `${DAILY_UNLOCKS_SHEET}: expected "${label}" at ${a1(headerRow, column)} in the destination, found "${header}"; layout changed, ${filterRange} filters not checked`,
      )
    const checked = cellAt(destGrid, DAILY_UNLOCKS_FILTER_ROW - 1, column - 1)
      .userEnteredValue?.boolValue
    if (checked === undefined)
      throw new Error(
        `${DAILY_UNLOCKS_SHEET}: ${a1(DAILY_UNLOCKS_FILTER_ROW, column)} holds no checkbox in the destination; layout changed, ${filterRange} filters not checked`,
      )
    return checked
  })
  if (checkedStates.every((checked) => checked)) {
    notes.push(
      `${DAILY_UNLOCKS_SHEET}: ${filterRange} filters already all checked`,
    )
    return []
  }
  return [
    {
      label: `${DAILY_UNLOCKS_SHEET}: ${filterRange} filters`,
      note: 'all checked',
      requests: [
        {
          updateCells: {
            range: {
              sheetId: destSheet.properties.sheetId,
              startRowIndex: DAILY_UNLOCKS_FILTER_ROW - 1,
              endRowIndex: DAILY_UNLOCKS_FILTER_ROW,
              startColumnIndex: DAILY_UNLOCKS_FILTER_FIRST_COLUMN - 1,
              endColumnIndex: lastColumn,
            },
            rows: [
              {
                values: DAILY_UNLOCKS_FILTER_LABELS.map(() => ({
                  userEnteredValue: { boolValue: true },
                })),
              },
            ],
            fields: 'userEnteredValue',
          },
        },
      ],
    },
  ]
}

/**
 * Clear the Daily Mode charm wave overrides (H3:H6, L3:L6) in the destination,
 * keeping their formats. Throws when an "Override wave numbers" header is not
 * where expected; skipped with a note when the destination has no Daily Mode.
 */
export function planDailyModeOverrides(
  dest: DestInfo,
  notes: string[],
): MigrationOp[] {
  const destGridSheet = sheetByTitle(dest.grid, DAILY_MODE_SHEET)
  if (!destGridSheet) {
    notes.push(
      `Daily Mode overrides: "${DAILY_MODE_SHEET}" not found, skipping`,
    )
    return []
  }
  const firstColumn = Math.min(...DAILY_MODE_OVERRIDE_COLUMNS)
  const destGrid = gridAt(
    destGridSheet,
    DAILY_MODE_OVERRIDE_HEADER_ROW - 1,
    firstColumn - 1,
  )
  const overrideRanges = DAILY_MODE_OVERRIDE_COLUMNS.map(
    (column) =>
      `${a1(DAILY_MODE_OVERRIDE_HEADER_ROW + 1, column)}:${a1(DAILY_MODE_OVERRIDE_LAST_ROW, column)}`,
  )
  const requests: Request[] = []
  const clearedRanges: string[] = []
  DAILY_MODE_OVERRIDE_COLUMNS.forEach((column, columnOffset) => {
    const header = displayText(cellAt(destGrid, 0, column - firstColumn)).trim()
    if (header !== DAILY_MODE_OVERRIDE_HEADER)
      throw new Error(
        `${DAILY_MODE_SHEET}: expected "${DAILY_MODE_OVERRIDE_HEADER}" at ${a1(DAILY_MODE_OVERRIDE_HEADER_ROW, column)} in the destination, found "${header}"; layout changed, ${overrideRanges.join(' and ')} overrides not cleared`,
      )
    let holdsValue = false
    for (
      let row = DAILY_MODE_OVERRIDE_HEADER_ROW + 1;
      row <= DAILY_MODE_OVERRIDE_LAST_ROW;
      row++
    ) {
      const cell = cellAt(
        destGrid,
        row - DAILY_MODE_OVERRIDE_HEADER_ROW,
        column - firstColumn,
      )
      if (cell.userEnteredValue !== undefined) holdsValue = true
    }
    if (!holdsValue) return
    // updateCells without rows clears the named fields over the range.
    requests.push({
      updateCells: {
        range: {
          sheetId: destGridSheet.properties.sheetId,
          startRowIndex: DAILY_MODE_OVERRIDE_HEADER_ROW,
          endRowIndex: DAILY_MODE_OVERRIDE_LAST_ROW,
          startColumnIndex: column - 1,
          endColumnIndex: column,
        },
        fields: 'userEnteredValue',
      },
    })
    clearedRanges.push(overrideRanges[columnOffset]!)
  })
  if (!requests.length) {
    notes.push(
      `${DAILY_MODE_SHEET}: ${overrideRanges.join(' and ')} overrides already empty`,
    )
    return []
  }
  return [
    {
      label: `${DAILY_MODE_SHEET}: clear wave overrides`,
      note: clearedRanges.join(', '),
      requests,
    },
  ]
}

/** Party Checklist column A from the header row down, or null without the sheet. */
function partyChecklistNameColumn(
  spreadsheet: SpreadsheetInfo,
): CellData[] | null {
  const sheet = sheetByTitle(spreadsheet, PARTY_CHECKLIST_SHEET)
  if (!sheet) return null
  const grid = gridAt(sheet, PARTY_CHECKLIST_HEADER_ROW - 1, 0)
  return (grid?.rowData ?? []).map((row) => row.values?.[0] ?? {})
}

/** Offset of the last cell holding a value, or -1 when none does. */
function lastOffsetWithValue(cells: CellData[]): number {
  for (let offset = cells.length - 1; offset >= 0; offset--)
    if (cells[offset]!.userEnteredValue !== undefined) return offset
  return -1
}

/**
 * Copy the Party Checklist names (column A from row 3) from the source, so the
 * destination's column A holds exactly the source's values; formats are kept.
 * Throws when either "Pokemon" header is not in A2, a value sits in the lower
 * row of a name's merge on either side, the destination's column holds a
 * formula, or the source's names run past the destination's rows. Skipped
 * with a note when either side has no Party Checklist.
 */
export function planPartyChecklistNames(
  source: SourceInfo,
  dest: DestInfo,
  notes: string[],
): MigrationOp[] {
  const sourceColumn = partyChecklistNameColumn(source.grid)
  const destColumn = partyChecklistNameColumn(dest.grid)
  if (!sourceColumn || !destColumn) {
    notes.push(
      `Party Checklist names: "${PARTY_CHECKLIST_SHEET}" not found in the ${sourceColumn ? 'destination' : 'source'}, skipping`,
    )
    return []
  }
  const firstNameRow = PARTY_CHECKLIST_HEADER_ROW + 1
  const columns = [
    { cells: sourceColumn, spreadsheetRole: 'source' },
    { cells: destColumn, spreadsheetRole: 'destination' },
  ]
  for (const { cells, spreadsheetRole } of columns) {
    const header = displayText(cells[0] ?? {}).trim()
    if (header !== PARTY_CHECKLIST_NAME_HEADER)
      throw new Error(
        `${PARTY_CHECKLIST_SHEET}: expected "${PARTY_CHECKLIST_NAME_HEADER}" at A${PARTY_CHECKLIST_HEADER_ROW} in the ${spreadsheetRole}, found "${header}"; layout changed, names not copied`,
      )
  }
  const sourceNames = sourceColumn.slice(1)
  const destNames = destColumn.slice(1)
  const destFormulaOffset = destNames.findIndex(
    (cell) => cell.userEnteredValue?.formulaValue !== undefined,
  )
  if (destFormulaOffset >= 0)
    throw new Error(
      `${PARTY_CHECKLIST_SHEET}: A${firstNameRow + destFormulaOffset} holds a formula in the destination, so column A is no longer typed in by hand; names not copied`,
    )
  // A value off the first row of a merge means the names no longer pair up.
  for (const { cells, spreadsheetRole } of [
    { cells: sourceNames, spreadsheetRole: 'source' },
    { cells: destNames, spreadsheetRole: 'destination' },
  ]) {
    const offMergeOffset = cells.findIndex(
      (cell, offset) =>
        offset % PARTY_CHECKLIST_ROWS_PER_NAME !== 0 &&
        cell.userEnteredValue !== undefined,
    )
    if (offMergeOffset >= 0)
      throw new Error(
        `${PARTY_CHECKLIST_SHEET}: A${firstNameRow + offMergeOffset} holds a value in the ${spreadsheetRole}, but each name fills a ${PARTY_CHECKLIST_ROWS_PER_NAME}-row merge from A${firstNameRow}; layout changed, names not copied`,
      )
  }
  const lastNameOffset = Math.max(
    lastOffsetWithValue(sourceNames),
    lastOffsetWithValue(destNames),
  )
  // Through the last name's whole merge.
  const rowsToWrite =
    lastNameOffset < 0 ? 0 : lastNameOffset + PARTY_CHECKLIST_ROWS_PER_NAME
  if (rowsToWrite === 0) {
    notes.push(
      `${PARTY_CHECKLIST_SHEET}: column A holds no names in either version; nothing to copy`,
    )
    return []
  }
  const lastRow = firstNameRow + rowsToWrite - 1
  const destRowCount = sheetByTitle(dest.meta, PARTY_CHECKLIST_SHEET)
    ?.properties.gridProperties?.rowCount
  if (destRowCount !== undefined && lastRow > destRowCount)
    throw new Error(
      `${PARTY_CHECKLIST_SHEET}: the source's names reach row ${lastRow} but the destination has ${destRowCount} rows; names not copied`,
    )
  const values: (ExtendedValue | undefined)[] = Array.from(
    { length: rowsToWrite },
    (_, offset) => sourceNames[offset]?.userEnteredValue,
  )
  const nameRange = `A${firstNameRow}:A${lastRow}`
  const alreadyMatching = values.every(
    (value, offset) =>
      JSON.stringify(value ?? null) ===
      JSON.stringify(destNames[offset]?.userEnteredValue ?? null),
  )
  if (alreadyMatching) {
    notes.push(
      `${PARTY_CHECKLIST_SHEET}: ${nameRange} names already matching the previous version`,
    )
    return []
  }
  const nameCount = values.filter((value) => value !== undefined).length
  return [
    {
      label: `${PARTY_CHECKLIST_SHEET}: column A names`,
      note: `${nameRange} from the previous version (${nameCount} names)`,
      requests: [
        {
          updateCells: {
            range: {
              sheetId: sheetByTitle(dest.meta, PARTY_CHECKLIST_SHEET)!
                .properties.sheetId,
              startRowIndex: firstNameRow - 1,
              endRowIndex: lastRow,
              startColumnIndex: 0,
              endColumnIndex: 1,
            },
            rows: values.map((value) => ({
              values: [value === undefined ? {} : { userEnteredValue: value }],
            })),
            fields: 'userEnteredValue',
          },
        },
      ],
    },
  ]
}

/**
 * Write the repo's Daily Unlock Map column formulas (E2:I2) into the
 * destination, each cell only when it differs. A cell must already hold a
 * formula listing the same DAILY_MODE_MAP.data biome column, the creator's or
 * ours; otherwise the map was reshaped and planning throws. Skipped with a
 * note when the destination has no map sheet.
 */
export function planUnlockMapFormulas(
  source: SourceInfo,
  dest: DestInfo,
  notes: string[],
): MigrationOp[] {
  const destSheet = sheetByTitle(dest.meta, UNLOCK_MAP_SHEET)
  if (!destSheet) {
    notes.push(`Unlock map formulas: "${UNLOCK_MAP_SHEET}" not found, skipping`)
    return []
  }
  const firstColumn = Math.min(
    ...UNLOCK_MAP_FORMULA_COLUMNS.map((entry) => entry.column),
  )
  const destGridSheet = sheetByTitle(dest.grid, UNLOCK_MAP_SHEET)
  const destGrid = destGridSheet
    ? gridAt(destGridSheet, UNLOCK_MAP_FORMULA_ROW - 1, firstColumn - 1)
    : null
  const requests: Request[] = []
  const writtenCells: string[] = []
  for (const { column, biomeColumn } of UNLOCK_MAP_FORMULA_COLUMNS) {
    const cell = a1(UNLOCK_MAP_FORMULA_ROW, column)
    const repoFormula = unlockMapColumnFormula(column, biomeColumn)
    noteSourceDrift(
      notes,
      UNLOCK_MAP_SHEET,
      cell,
      sourceFormulaAt(
        source,
        UNLOCK_MAP_SHEET,
        UNLOCK_MAP_FORMULA_ROW,
        column,
        firstColumn,
      ),
      repoFormula,
    )
    const destFormula = cellAt(destGrid, 0, column - firstColumn)
      .userEnteredValue?.formulaValue
    if (destFormula === undefined)
      throw new Error(
        `${UNLOCK_MAP_SHEET}: ${cell} holds no formula in the destination; layout changed, map formulas not written`,
      )
    if (sameFormula(destFormula, repoFormula)) continue
    const biomeRange = unlockMapBiomeRange(biomeColumn)
    if (!normalizeFormula(destFormula).includes(normalizeFormula(biomeRange)))
      throw new Error(
        `${UNLOCK_MAP_SHEET}: ${cell} does not list ${biomeRange} in the destination; layout changed, map formulas not written`,
      )
    requests.push(
      formulaCellRequest(
        destSheet.properties.sheetId,
        UNLOCK_MAP_FORMULA_ROW,
        column,
        repoFormula,
      ),
    )
    writtenCells.push(cell)
  }
  if (!requests.length) {
    notes.push(
      `${UNLOCK_MAP_SHEET}: ${unlockMapFormulaCells()} formulas already matching the repo's`,
    )
    return []
  }
  return [
    {
      label: `${UNLOCK_MAP_SHEET}: column formulas`,
      note: `${writtenCells.join(', ')} from the repo's copy`,
      requests,
    },
  ]
}

// ---------------------------------------------------------------------------
// Drive lookup
// ---------------------------------------------------------------------------

/** Every non-trashed spreadsheet in Drive with exactly this name. */
export function findSpreadsheetsNamed(name: string): DriveSpreadsheet[] {
  return listSpreadsheets(`name = ${driveQueryString(name)}`)
}

/** Drive file ID of an Offline RogueDex spreadsheet by version (newest if several). */
export function findFileIdByVersion(version: string): string {
  const targetName = copyName(version)
  const matchingFiles = findSpreadsheetsNamed(targetName)
  if (matchingFiles.length === 0) {
    throw new Error(
      `No file found named "${targetName}". Check the version number, or rename your copy to match.`,
    )
  }
  if (matchingFiles.length > 1) {
    matchingFiles.sort(
      (fileA, fileB) =>
        Date.parse(fileB.modifiedTime) - Date.parse(fileA.modifiedTime),
    )
    Logger.log(
      `Multiple files named "${targetName}" found. Using newest: ${matchingFiles[0]!.id}. Others ignored: ${matchingFiles
        .slice(1)
        .map((file) => file.id)
        .join(', ')}`,
    )
  }
  return matchingFiles[0]!.id
}
