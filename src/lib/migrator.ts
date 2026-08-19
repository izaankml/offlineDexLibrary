/**
 * MIGRATOR
 *
 * Ports your customizations from an old OfflineDex spreadsheet to a new one.
 *
 * Since 2026-08 this is a plan → preview → apply pipeline on the Sheets API:
 *   1. read the source (2 GETs: sheet list; formats/values of the customized
 *      ranges) and the destination (2 GETs: sheet list + banding/CF/merges;
 *      the locator cells) — no `openById`, no temp sheets;
 *   2. build a list of migration ops (human label + batchUpdate requests) —
 *      pure, tested; planning THROWS if a landmark doesn't fit, so nothing is
 *      touched when the creator's layout changed;
 *   3. apply everything in ONE batchUpdate — atomic: all steps land or none.
 *
 * `finishSetup` (setup.ts) drives it: planForVersions → describePlan in the
 * confirm dialog → applyPlanWithProgress.
 */

import { copyName } from '../shared/naming.ts'
import { shiftFormulaColumns } from './formulaShift.ts'
import { finishFlow, startStep } from './progress.ts'
import {
  type ConditionalFormatRule,
  type GridData,
  type GridRange,
  type Request,
  type SheetsClient,
  type SpreadsheetInfo,
  a1,
  cellAt,
  displayText,
  gridAt,
  hexToColor,
  liveSheets,
  sheetByTitle,
} from './sheetsApi.ts'

// Quick Checklist: columns A-D (#, image, Dex#, name) are fixed; the data
// block ("Caught?" … "Ribbons", QUICK_CHECKLIST_DATA_COLUMNS wide) starts at E
// in creator 6.01 and F from 6.03 (hidden junk column E). Each sheet's block
// is located by the first non-blank cell in row 10 right of D — the creator's
// stats row on a fresh copy, your "Stats:" row on a migrated one.
export const QUICK_CHECKLIST_SHEET = 'Quick Checklist'
export const QUICK_CHECKLIST_FIXED_COLUMNS = 4
export const QUICK_CHECKLIST_DATA_COLUMNS = 11
export const QUICK_CHECKLIST_LOCATOR_ROW = 10
export const QUICK_CHECKLIST_HEADER_ROWS = 10
export const QUICK_CHECKLIST_TITLE_PREFIX = 'POKEROGUE DEX '
export const QUICK_CHECKLIST_IMAGE_COLUMN = 2
/** Sheets' default row height; a non-hidden row at this height is treated as "Fit to data". */
const DEFAULT_ROW_HEIGHT = 21

// Daily Mode: custom column L (map-size inputs L12:M14 feed the IMAGE formula
// in B16). Presence is detected by the creator's "Missing Gym Leader
// Voucher…" landmark: N2 when L exists (source), M2 when it doesn't (fresh copy).
export const DAILY_MODE_SHEET = 'Daily Mode'
export const DAILY_MODE_CUSTOM_COLUMN = 12 // L
export const DAILY_MODE_LANDMARK_ROW = 2
export const DAILY_MODE_LANDMARK_COL_WITH_L = 14 // N
export const DAILY_MODE_LANDMARK_COL_WITHOUT_L = 13 // M

/** A rectangular block in 1-based, inclusive sheet coordinates. */
type Block = {
  firstRow: number
  firstColumn: number
  lastRow: number
  lastColumn: number
}
/** B16:M131 — the merged cell holding the daily map IMAGE formula. */
export const DAILY_MODE_IMAGE_BLOCK: Block = {
  firstRow: 16,
  firstColumn: 2,
  lastRow: 131,
  lastColumn: 13,
}
/** L12:M14 — the map-size inputs the IMAGE formula reads. */
export const DAILY_MODE_INPUTS_BLOCK: Block = {
  firstRow: 12,
  firstColumn: 12,
  lastRow: 14,
  lastColumn: 13,
}

// IV conditional formatting on the dex checklists.
export const DEX_IV_HIGHLIGHT_SHEETS = [
  'Starter DEX Checklist',
  'Full DEX Checklist',
]
export const DEX_IV_PERFECT_VALUE = '31'
export const DEX_IV_IMPERFECT_COLOR = '#ea9999' // red

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

/** Apply with a toast step; one result per op (all OK, or all ERR with the same message — the batch is atomic). */
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
    (op) => `• ${op.label}${op.note ? ` — ${op.note}` : ''}`,
  )
  const noteLines = plan.notes.map((note) => `· ${note}`)
  return [...opLines, ...noteLines].join('\n')
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** `meta`: sheet list (+ banding/CF/merges for the destination); `grid`: cell data of the customized ranges. */
export type SourceInfo = { meta: SpreadsheetInfo; grid: SpreadsheetInfo }
export type DestInfo = { meta: SpreadsheetInfo; grid: SpreadsheetInfo }

const GRID_FIELDS =
  'sheets(properties(sheetId,title,gridProperties),data(startRow,startColumn,rowData(values(userEnteredValue,userEnteredFormat,formattedValue)),rowMetadata,columnMetadata))'

/** A1 range of a Block on a sheet: 'Daily Mode'!B16:M131. */
function blockRange(sheetTitle: string, block: Block): string {
  return `'${sheetTitle}'!${a1(block.firstRow, block.firstColumn)}:${a1(block.lastRow, block.lastColumn)}`
}

export function readSource(
  client: SheetsClient,
  sourceSpreadsheetId: string,
): SourceInfo {
  const meta = client.get(sourceSpreadsheetId, {
    fields: 'sheets(properties(sheetId,title,hidden,gridProperties))',
  })
  const grid = client.get(sourceSpreadsheetId, {
    ranges: [
      `'${QUICK_CHECKLIST_SHEET}'!1:${QUICK_CHECKLIST_HEADER_ROWS}`,
      blockRange(DAILY_MODE_SHEET, DAILY_MODE_IMAGE_BLOCK),
      blockRange(DAILY_MODE_SHEET, DAILY_MODE_INPUTS_BLOCK),
      `'${DAILY_MODE_SHEET}'!${a1(DAILY_MODE_LANDMARK_ROW, DAILY_MODE_LANDMARK_COL_WITH_L)}`,
    ],
    includeGridData: true,
    fields: GRID_FIELDS,
  })
  return { meta, grid }
}

export function readDestination(
  client: SheetsClient,
  destSpreadsheetId: string,
): DestInfo {
  const meta = client.get(destSpreadsheetId, {
    fields:
      'sheets(properties(sheetId,title,hidden,gridProperties),merges,bandedRanges,conditionalFormats)',
  })
  const grid = client.get(destSpreadsheetId, {
    ranges: [
      `'${QUICK_CHECKLIST_SHEET}'!1:${QUICK_CHECKLIST_HEADER_ROWS}`,
      `'${DAILY_MODE_SHEET}'!${a1(DAILY_MODE_LANDMARK_ROW, DAILY_MODE_LANDMARK_COL_WITHOUT_L)}:${a1(DAILY_MODE_LANDMARK_ROW, DAILY_MODE_LANDMARK_COL_WITH_L)}`,
    ],
    includeGridData: true,
    fields: GRID_FIELDS,
  })
  return { meta, grid }
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
  ops.push(...planDailyMode(source, dest, notes))
  ops.push(...planHiddenSheets(source, dest, notes))
  ops.push(...planDexIvHighlight(dest, notes))
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
  // Port up to the end of the data block (Ribbons); nothing of ours lives to
  // the right of it, and the source's grid may be wider for stale reasons
  // (e.g. the old SaveTracker marker column) that must not be carried over.
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

  // Row heights + hidden rows. A source row at the default height that isn't
  // hidden is (almost always) "Fit to data" — the API only reports the stored
  // 21 px, not the rendered height — so those rows are auto-resized in the
  // destination after the cell contents are written (see below).
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

  // Row 1 over the data block; row 10 in full — formulas (shifted) or values.
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

  // Title stamp unless A1 is a formula.
  const destTitleCell = cellAt(destGrid, 0, 0)
  if (destTitleCell.userEnteredValue?.formulaValue !== undefined) {
    ops.push({
      label: 'Quick Checklist title',
      note: 'A1 is a formula; left alone',
      requests: [],
    })
  } else {
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
  }
  return ops
}

/**
 * Extend the alternating-colour banding to cover the Pokémon image column B:
 * a banding starting at C is stretched left (merging with an A-only banding
 * if present) and B's cell fills are cleared over the banded rows. If a
 * banding already spans B, only the fills are cleared. Otherwise row-parity
 * CF rules adjacent to B are widened.
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
  const rowParityFormula = /ISEVEN\s*\(\s*ROW|ISODD\s*\(\s*ROW|MOD\s*\(\s*ROW/i
  const requests: Request[] = []
  ;(destSheetMeta.conditionalFormats ?? []).forEach((rule, ruleIndex) => {
    const formula =
      rule.booleanRule?.condition.values?.[0]?.userEnteredValue ?? ''
    if (
      rule.booleanRule?.condition.type !== 'CUSTOM_FORMULA' ||
      !rowParityFormula.test(formula)
    )
      return
    let widened = false
    const ranges = rule.ranges.map((range) => {
      const firstColumnIndex = range.startColumnIndex ?? 0
      const lastColumnIndex = (range.endColumnIndex ?? 0) - 1
      if (
        firstColumnIndex <= imageColumnIndex &&
        lastColumnIndex >= imageColumnIndex
      )
        return range
      if (
        lastColumnIndex === imageColumnIndex - 1 ||
        firstColumnIndex === imageColumnIndex + 1
      ) {
        widened = true
        return {
          ...range,
          startColumnIndex: Math.min(firstColumnIndex, imageColumnIndex),
          endColumnIndex: Math.max(lastColumnIndex, imageColumnIndex) + 1,
        }
      }
      return range
    })
    if (widened)
      requests.push({
        updateConditionalFormatRule: {
          sheetId,
          index: ruleIndex,
          rule: { ...rule, ranges },
        },
      })
  })
  if (requests.length) {
    return [
      {
        label: 'Quick Checklist banding over the image column',
        note: `widened ${requests.length} row-parity CF rule(s)`,
        requests,
      },
    ]
  }
  notes.push(
    'Quick Checklist: no banding or row-parity CF adjacent to column B; nothing to extend',
  )
  return []
}

/** Landmark check: true = column L present; false = insert it; throws when neither cell holds the label. */
export function dailyModeHasCustomColumn(
  source: SourceInfo,
  dest: DestInfo,
): boolean {
  const sourceSheet = requireFound(
    sheetByTitle(source.grid, DAILY_MODE_SHEET),
    'Daily Mode not found in the source',
  )
  const destSheet = requireFound(
    sheetByTitle(dest.grid, DAILY_MODE_SHEET),
    'Daily Mode not found in the destination',
  )
  const sourceLandmarkGrid = gridAt(
    sourceSheet,
    DAILY_MODE_LANDMARK_ROW - 1,
    DAILY_MODE_LANDMARK_COL_WITH_L - 1,
  )
  const landmarkText = displayText(cellAt(sourceLandmarkGrid, 0, 0)).trim()
  if (!landmarkText) {
    throw new Error(
      `Daily Mode: landmark cell ${a1(DAILY_MODE_LANDMARK_ROW, DAILY_MODE_LANDMARK_COL_WITH_L)} is blank in the source; cannot tell whether column L is present`,
    )
  }
  const destLandmarkGrid = gridAt(
    destSheet,
    DAILY_MODE_LANDMARK_ROW - 1,
    DAILY_MODE_LANDMARK_COL_WITHOUT_L - 1,
  )
  const destTextWithoutL = displayText(cellAt(destLandmarkGrid, 0, 0)).trim()
  const destTextWithL = displayText(cellAt(destLandmarkGrid, 0, 1)).trim()
  if (destTextWithL === landmarkText) return true
  if (destTextWithoutL === landmarkText) return false
  throw new Error(
    `Daily Mode: landmark "${landmarkText}" is at neither ${a1(DAILY_MODE_LANDMARK_ROW, DAILY_MODE_LANDMARK_COL_WITH_L)} nor ${a1(DAILY_MODE_LANDMARK_ROW, DAILY_MODE_LANDMARK_COL_WITHOUT_L)} in the destination; layout changed, Daily Mode not touched`,
  )
}

/**
 * Daily Mode: insert custom column L when missing; formats for B16:M131 and
 * L12:M14; widths of L and M; merge B16:M131 (unmerging whatever overlaps);
 * B16 formula/value top-aligned; L12:M14 formulas/values.
 */
export function planDailyMode(
  source: SourceInfo,
  dest: DestInfo,
  notes: string[],
): MigrationOp[] {
  const sourceSheet = requireFound(
    sheetByTitle(source.grid, DAILY_MODE_SHEET),
    'Daily Mode not found in the source',
  )
  const destSheetMeta = requireFound(
    sheetByTitle(dest.meta, DAILY_MODE_SHEET),
    'Daily Mode not found in the destination',
  )
  const sheetId = destSheetMeta.properties.sheetId
  const hasCustomColumn = dailyModeHasCustomColumn(source, dest)
  const ops: MigrationOp[] = []
  const customColumnIndex = DAILY_MODE_CUSTOM_COLUMN - 1 // 0-based

  if (!hasCustomColumn) {
    ops.push({
      label: 'Daily Mode: insert custom column L',
      note: 'landmark found at M2 (fresh copy)',
      requests: [
        {
          insertDimension: {
            range: {
              sheetId,
              dimension: 'COLUMNS',
              startIndex: customColumnIndex,
              endIndex: customColumnIndex + 1,
            },
            inheritFromBefore: false,
          },
        },
      ],
    })
  } else {
    notes.push('Daily Mode: custom column L already present (landmark at N2)')
  }

  const formatBlockOp = (block: Block, label: string): MigrationOp => {
    const sourceBlockGrid = gridAt(
      sourceSheet,
      block.firstRow - 1,
      block.firstColumn - 1,
    )
    const rowCount = block.lastRow - block.firstRow + 1
    const columnCount = block.lastColumn - block.firstColumn + 1
    return {
      label,
      requests: [
        {
          updateCells: {
            range: {
              sheetId,
              startRowIndex: block.firstRow - 1,
              endRowIndex: block.lastRow,
              startColumnIndex: block.firstColumn - 1,
              endColumnIndex: block.lastColumn,
            },
            rows: Array.from({ length: rowCount }, (_, rowOffset) => ({
              values: Array.from(
                { length: columnCount },
                (_, columnOffset) => ({
                  userEnteredFormat:
                    cellAt(sourceBlockGrid, rowOffset, columnOffset)
                      .userEnteredFormat ?? {},
                }),
              ),
            })),
            fields: 'userEnteredFormat',
          },
        },
      ],
    }
  }
  ops.push(
    formatBlockOp(DAILY_MODE_IMAGE_BLOCK, 'Daily Mode: formats of B16:M131'),
  )
  ops.push(
    formatBlockOp(DAILY_MODE_INPUTS_BLOCK, 'Daily Mode: formats of L12:M14'),
  )

  // Column widths L, M from the source (its B16:M131 block carries columnMetadata for B..M).
  const sourceImageBlockGrid = gridAt(
    sourceSheet,
    DAILY_MODE_IMAGE_BLOCK.firstRow - 1,
    DAILY_MODE_IMAGE_BLOCK.firstColumn - 1,
  )
  const widthRequests: Request[] = []
  for (const column of [
    DAILY_MODE_CUSTOM_COLUMN,
    DAILY_MODE_CUSTOM_COLUMN + 1,
  ]) {
    const columnMeta =
      sourceImageBlockGrid?.columnMetadata?.[
        column - DAILY_MODE_IMAGE_BLOCK.firstColumn
      ]
    if (!columnMeta?.pixelSize) continue
    widthRequests.push({
      updateDimensionProperties: {
        range: {
          sheetId,
          dimension: 'COLUMNS',
          startIndex: column - 1,
          endIndex: column,
        },
        properties: { pixelSize: columnMeta.pixelSize },
        fields: 'pixelSize',
      },
    })
  }
  if (widthRequests.length)
    ops.push({
      label: 'Daily Mode: widths of columns L and M',
      requests: widthRequests,
    })

  // Merge B16:M131 — first unmerge anything overlapping it (in post-insert coordinates).
  const targetMerge: GridRange = {
    sheetId,
    startRowIndex: DAILY_MODE_IMAGE_BLOCK.firstRow - 1,
    endRowIndex: DAILY_MODE_IMAGE_BLOCK.lastRow,
    startColumnIndex: DAILY_MODE_IMAGE_BLOCK.firstColumn - 1,
    endColumnIndex: DAILY_MODE_IMAGE_BLOCK.lastColumn,
  }
  const existingMerges = (destSheetMeta.merges ?? []).map((merge) =>
    hasCustomColumn ? merge : shiftMergeForInsert(merge, customColumnIndex),
  )
  const overlappingMerges = existingMerges.filter((merge) =>
    rangesOverlap(merge, targetMerge),
  )
  const mergeRequests: Request[] = overlappingMerges.map((merge) => ({
    unmergeCells: { range: { ...merge, sheetId } },
  }))
  mergeRequests.push({
    mergeCells: { range: targetMerge, mergeType: 'MERGE_ALL' },
  })
  ops.push({
    label: 'Daily Mode: merge B16:M131',
    ...(overlappingMerges.length
      ? {
          note: `unmerging ${overlappingMerges.length} existing merge(s) first`,
        }
      : {}),
    requests: mergeRequests,
  })

  // B16 value/formula, top-aligned.
  const sourceB16Cell = cellAt(sourceImageBlockGrid, 0, 0)
  ops.push({
    label: 'Daily Mode: B16 formula',
    note: sourceB16Cell.userEnteredValue?.formulaValue
      ? 'formula copied from the source'
      : 'value copied from the source',
    requests: [
      {
        updateCells: {
          range: {
            sheetId,
            startRowIndex: DAILY_MODE_IMAGE_BLOCK.firstRow - 1,
            endRowIndex: DAILY_MODE_IMAGE_BLOCK.firstRow,
            startColumnIndex: DAILY_MODE_IMAGE_BLOCK.firstColumn - 1,
            endColumnIndex: DAILY_MODE_IMAGE_BLOCK.firstColumn,
          },
          rows: [
            {
              values: [
                {
                  userEnteredValue: sourceB16Cell.userEnteredValue ?? {},
                  userEnteredFormat: { verticalAlignment: 'TOP' },
                },
              ],
            },
          ],
          fields: 'userEnteredValue,userEnteredFormat.verticalAlignment',
        },
      },
    ],
  })

  // L12:M14 formulas/values.
  const sourceInputsGrid = gridAt(
    sourceSheet,
    DAILY_MODE_INPUTS_BLOCK.firstRow - 1,
    DAILY_MODE_INPUTS_BLOCK.firstColumn - 1,
  )
  const inputRowCount =
    DAILY_MODE_INPUTS_BLOCK.lastRow - DAILY_MODE_INPUTS_BLOCK.firstRow + 1
  const inputColumnCount =
    DAILY_MODE_INPUTS_BLOCK.lastColumn - DAILY_MODE_INPUTS_BLOCK.firstColumn + 1
  ops.push({
    label: 'Daily Mode: L12:M14 inputs',
    requests: [
      {
        updateCells: {
          range: {
            sheetId,
            startRowIndex: DAILY_MODE_INPUTS_BLOCK.firstRow - 1,
            endRowIndex: DAILY_MODE_INPUTS_BLOCK.lastRow,
            startColumnIndex: DAILY_MODE_INPUTS_BLOCK.firstColumn - 1,
            endColumnIndex: DAILY_MODE_INPUTS_BLOCK.lastColumn,
          },
          rows: Array.from({ length: inputRowCount }, (_, rowOffset) => ({
            values: Array.from(
              { length: inputColumnCount },
              (_, columnOffset) => {
                const sourceValue = cellAt(
                  sourceInputsGrid,
                  rowOffset,
                  columnOffset,
                ).userEnteredValue
                return sourceValue ? { userEnteredValue: sourceValue } : {}
              },
            ),
          })),
          fields: 'userEnteredValue',
        },
      },
    ],
  })
  return ops
}

/** How a merge (pre-insert coordinates) looks after a column is inserted at 0-based `insertedColumnIndex`. */
export function shiftMergeForInsert(
  merge: GridRange,
  insertedColumnIndex: number,
): GridRange {
  const startColumnIndex = merge.startColumnIndex ?? 0
  const endColumnIndex = merge.endColumnIndex ?? 0
  if (startColumnIndex >= insertedColumnIndex)
    return {
      ...merge,
      startColumnIndex: startColumnIndex + 1,
      endColumnIndex: endColumnIndex + 1,
    }
  if (endColumnIndex > insertedColumnIndex)
    return { ...merge, endColumnIndex: endColumnIndex + 1 } // insertion inside the merge widens it
  return merge
}

export function rangesOverlap(rangeA: GridRange, rangeB: GridRange): boolean {
  return (
    (rangeA.startRowIndex ?? 0) < (rangeB.endRowIndex ?? Infinity) &&
    (rangeB.startRowIndex ?? 0) < (rangeA.endRowIndex ?? Infinity) &&
    (rangeA.startColumnIndex ?? 0) < (rangeB.endColumnIndex ?? Infinity) &&
    (rangeB.startColumnIndex ?? 0) < (rangeA.endColumnIndex ?? Infinity)
  )
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

// ---------------------------------------------------------------------------
// Drive lookup
// ---------------------------------------------------------------------------

/** Every non-trashed spreadsheet in Drive with exactly this name. */
export function findSpreadsheetsNamed(
  name: string,
): GoogleAppsScript.Drive.File[] {
  const query =
    "title = '" +
    name.replace(/'/g, "\\'") +
    "' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false"
  const fileIterator = DriveApp.searchFiles(query)
  const files: GoogleAppsScript.Drive.File[] = []
  while (fileIterator.hasNext()) files.push(fileIterator.next())
  return files
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
        fileB.getLastUpdated().getTime() - fileA.getLastUpdated().getTime(),
    )
    Logger.log(
      `Multiple files named "${targetName}" found. Using newest: ${matchingFiles[0]!.getId()}. Others ignored: ${matchingFiles
        .slice(1)
        .map((file) => file.getId())
        .join(', ')}`,
    )
  }
  return matchingFiles[0]!.getId()
}
