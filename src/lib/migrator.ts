/**
 * MIGRATOR
 *
 * Ports your customizations from an old OfflineDex spreadsheet to a new one,
 * as a plan, preview, apply pipeline on the Sheets API:
 *   1. read the source (sheet list and merges; formats and values of the
 *      customized ranges) and the destination (sheet list, banding, CF and
 *      merges; the locator cells);
 *   2. build a list of migration ops (human label plus batchUpdate requests).
 *      This step is pure and tested. Planning throws if a landmark doesn't
 *      fit, so nothing is touched when the creator's layout changed;
 *   3. apply everything in one atomic batchUpdate: all steps land or none.
 *
 * `finishSetup` (setup.ts) drives it: planForVersions, then describePlan in
 * the confirm dialog, then applyPlanWithProgress.
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

// Daily Mode carries two structural customizations of ours that a fresh copy
// lacks, and both shift everything after them:
//
//   * custom column L: the map-size inputs (L12:M15) the IMAGE formula reads.
//     Detected by the creator's "Missing Gym Leader Voucher…" landmark, at N2
//     when L exists and M2 when it doesn't.
//   * custom row 15: a blank row above the creator's wiki-link row so the
//     "Rows" input has a line of its own. Detected by where the map-image
//     merge starts, B17 when the row exists and B16 when it doesn't.
//
// The source has both, so source coordinates are also the destination's final
// coordinates. Every write below uses them, and the two inserts run first in
// the same batch.
export const DAILY_MODE_SHEET = 'Daily Mode'
export const DAILY_MODE_CUSTOM_COLUMN = 12 // L
export const DAILY_MODE_CUSTOM_ROW = 15
export const DAILY_MODE_LANDMARK_ROW = 2
export const DAILY_MODE_LANDMARK_COL_WITH_L = 14 // N
export const DAILY_MODE_LANDMARK_COL_WITHOUT_L = 13 // M
export const DAILY_MODE_IMAGE_COLUMN = 2 // B
export const DAILY_MODE_IMAGE_ROW_WITH_CUSTOM_ROW = 17
export const DAILY_MODE_IMAGE_ROW_WITHOUT_CUSTOM_ROW = 16

/** A rectangular block in 1-based, inclusive sheet coordinates. */
type Block = {
  firstRow: number
  firstColumn: number
  lastRow: number
  lastColumn: number
}
/** L12:M15, the map-size inputs the IMAGE formula reads (Map Width/Height/Scale/Rows). */
export const DAILY_MODE_INPUTS_BLOCK: Block = {
  firstRow: 12,
  firstColumn: 12,
  lastRow: 15,
  lastColumn: 13,
}
/**
 * B12:M<image bottom>, the region whose merges are made to match the source's
 * (the input rows, the creator's wiki-link row, and the map-image block).
 * Every source merge inside it is ported; any destination merge overlapping
 * one of them is unmerged first.
 */
export const DAILY_MODE_MERGE_FIRST_ROW = 12
export const DAILY_MODE_MERGE_FIRST_COLUMN = 2 // B
export const DAILY_MODE_MERGE_LAST_COLUMN = 13 // M

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
    fields: 'sheets(properties(sheetId,title,hidden,gridProperties),merges)',
  })
  // The map-image block is however big the source's merge is, so the metadata
  // read has to come first: its size decides which range we ask for here.
  const grid = client.get(sourceSpreadsheetId, {
    ranges: [
      `'${QUICK_CHECKLIST_SHEET}'!1:${QUICK_CHECKLIST_HEADER_ROWS}`,
      blockRange(DAILY_MODE_SHEET, dailyModeImageBlock(meta)),
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

/** The merged cell of a Daily Mode sheet whose top-left is `row`/`column` (1-based), or null. */
function dailyModeMergeAt(
  info: SpreadsheetInfo,
  spreadsheetRole: string,
  row: number,
  column: number,
): GridRange | null {
  const sheet = requireFound(
    sheetByTitle(info, DAILY_MODE_SHEET),
    `Daily Mode not found in the ${spreadsheetRole}`,
  )
  return (
    (sheet.merges ?? []).find(
      (merge) =>
        (merge.startRowIndex ?? 0) === row - 1 &&
        (merge.startColumnIndex ?? 0) === column - 1,
    ) ?? null
  )
}

/**
 * The source's map-image block, taken from the merge it is (its bottom row
 * follows the map's aspect ratio, so it is not a constant). Throws when the
 * source has no merge at B17, so nothing is ported on an unknown layout.
 */
export function dailyModeImageBlock(sourceMeta: SpreadsheetInfo): Block {
  const anchor = a1(
    DAILY_MODE_IMAGE_ROW_WITH_CUSTOM_ROW,
    DAILY_MODE_IMAGE_COLUMN,
  )
  const merge = dailyModeMergeAt(
    sourceMeta,
    'source',
    DAILY_MODE_IMAGE_ROW_WITH_CUSTOM_ROW,
    DAILY_MODE_IMAGE_COLUMN,
  )
  if (!merge) {
    throw new Error(
      `Daily Mode: no merged cell starts at ${anchor} in the source, so the map image block cannot be located; layout changed, nothing ported`,
    )
  }
  return {
    firstRow: DAILY_MODE_IMAGE_ROW_WITH_CUSTOM_ROW,
    firstColumn: DAILY_MODE_IMAGE_COLUMN,
    lastRow: merge.endRowIndex ?? DAILY_MODE_IMAGE_ROW_WITH_CUSTOM_ROW,
    lastColumn: merge.endColumnIndex ?? DAILY_MODE_IMAGE_COLUMN,
  }
}

/**
 * Structural check on the destination: true = our custom row 15 is already
 * there (the map-image merge starts at B17), false = insert it (it starts at
 * B16, a fresh copy). Throws when it starts at neither.
 */
export function dailyModeHasCustomRow(dest: DestInfo): boolean {
  const startsAt = (row: number): boolean =>
    dailyModeMergeAt(dest.meta, 'destination', row, DAILY_MODE_IMAGE_COLUMN) !==
    null
  if (startsAt(DAILY_MODE_IMAGE_ROW_WITH_CUSTOM_ROW)) return true
  if (startsAt(DAILY_MODE_IMAGE_ROW_WITHOUT_CUSTOM_ROW)) return false
  throw new Error(
    `Daily Mode: the map image merge starts at neither ${a1(DAILY_MODE_IMAGE_ROW_WITH_CUSTOM_ROW, DAILY_MODE_IMAGE_COLUMN)} nor ${a1(DAILY_MODE_IMAGE_ROW_WITHOUT_CUSTOM_ROW, DAILY_MODE_IMAGE_COLUMN)} in the destination; layout changed, Daily Mode not touched`,
  )
}

/** A block as A1 ('B16:M131'), for op labels. */
function blockLabel(block: Block): string {
  return `${a1(block.firstRow, block.firstColumn)}:${a1(block.lastRow, block.lastColumn)}`
}

/**
 * Daily Mode: insert custom column L and custom row 15 when missing; formats
 * for the map-image block and the L12:M15 inputs; height of row 15 and widths
 * of L and M; make the merges of B12:M<image bottom> match the source's;
 * the image formula/value top-aligned; L12:M15 formulas/values.
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
  const imageBlock = dailyModeImageBlock(source.meta)
  const hasCustomColumn = dailyModeHasCustomColumn(source, dest)
  const hasCustomRow = dailyModeHasCustomRow(dest)
  const ops: MigrationOp[] = []
  const customColumnIndex = DAILY_MODE_CUSTOM_COLUMN - 1 // 0-based
  const customRowIndex = DAILY_MODE_CUSTOM_ROW - 1 // 0-based

  // Both inserts go first: everything after them is in post-insert (= source)
  // coordinates, and the batch applies its requests in order.
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
  if (!hasCustomRow) {
    ops.push({
      label: `Daily Mode: insert custom row ${DAILY_MODE_CUSTOM_ROW}`,
      note: `map image merge found at ${a1(DAILY_MODE_IMAGE_ROW_WITHOUT_CUSTOM_ROW, DAILY_MODE_IMAGE_COLUMN)} (fresh copy)`,
      requests: [
        {
          insertDimension: {
            range: {
              sheetId,
              dimension: 'ROWS',
              startIndex: customRowIndex,
              endIndex: customRowIndex + 1,
            },
            inheritFromBefore: false,
          },
        },
      ],
    })
  } else {
    notes.push(
      `Daily Mode: custom row ${DAILY_MODE_CUSTOM_ROW} already present (map image merge at ${a1(DAILY_MODE_IMAGE_ROW_WITH_CUSTOM_ROW, DAILY_MODE_IMAGE_COLUMN)})`,
    )
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
    formatBlockOp(
      imageBlock,
      `Daily Mode: formats of ${blockLabel(imageBlock)}`,
    ),
  )
  ops.push(
    formatBlockOp(
      DAILY_MODE_INPUTS_BLOCK,
      `Daily Mode: formats of ${blockLabel(DAILY_MODE_INPUTS_BLOCK)}`,
    ),
  )

  // Column widths L, M from the source (its image block carries columnMetadata for B..M).
  const sourceImageBlockGrid = gridAt(
    sourceSheet,
    imageBlock.firstRow - 1,
    imageBlock.firstColumn - 1,
  )
  const dimensionRequests: Request[] = []
  for (const column of [
    DAILY_MODE_CUSTOM_COLUMN,
    DAILY_MODE_CUSTOM_COLUMN + 1,
  ]) {
    const columnMeta =
      sourceImageBlockGrid?.columnMetadata?.[column - imageBlock.firstColumn]
    if (!columnMeta?.pixelSize) continue
    dimensionRequests.push({
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
  // Height of the row we insert: a fresh insert would otherwise inherit a
  // neighbour's. The inputs block spans it, so its rowMetadata carries it.
  const sourceInputsGrid = gridAt(
    sourceSheet,
    DAILY_MODE_INPUTS_BLOCK.firstRow - 1,
    DAILY_MODE_INPUTS_BLOCK.firstColumn - 1,
  )
  const customRowMeta =
    sourceInputsGrid?.rowMetadata?.[
      DAILY_MODE_CUSTOM_ROW - DAILY_MODE_INPUTS_BLOCK.firstRow
    ]
  if (customRowMeta?.pixelSize) {
    dimensionRequests.push({
      updateDimensionProperties: {
        range: {
          sheetId,
          dimension: 'ROWS',
          startIndex: customRowIndex,
          endIndex: customRowIndex + 1,
        },
        properties: { pixelSize: customRowMeta.pixelSize },
        fields: 'pixelSize',
      },
    })
  }
  if (dimensionRequests.length)
    ops.push({
      label: `Daily Mode: widths of columns L and M, height of row ${DAILY_MODE_CUSTOM_ROW}`,
      requests: dimensionRequests,
    })

  // Make the merges of B12:M<image bottom> match the source's: unmerge any
  // destination merge overlapping a source merge (post-insert coordinates),
  // then merge the source's. Re-running plans the same pair, so it is
  // idempotent. The region widens to the image block if that reaches past M.
  const mergedRegion: Block = {
    firstRow: DAILY_MODE_MERGE_FIRST_ROW,
    firstColumn: DAILY_MODE_MERGE_FIRST_COLUMN,
    lastRow: imageBlock.lastRow,
    lastColumn: Math.max(DAILY_MODE_MERGE_LAST_COLUMN, imageBlock.lastColumn),
  }
  const sourceSheetMeta = requireFound(
    sheetByTitle(source.meta, DAILY_MODE_SHEET),
    'Daily Mode not found in the source',
  )
  const targetMerges = (sourceSheetMeta.merges ?? [])
    .filter((merge) =>
      rangeContains(
        {
          sheetId,
          startRowIndex: mergedRegion.firstRow - 1,
          endRowIndex: mergedRegion.lastRow,
          startColumnIndex: mergedRegion.firstColumn - 1,
          endColumnIndex: mergedRegion.lastColumn,
        },
        merge,
      ),
    )
    .map((merge) => ({ ...merge, sheetId }))
    .sort(
      (mergeA, mergeB) =>
        (mergeA.startRowIndex ?? 0) - (mergeB.startRowIndex ?? 0) ||
        (mergeA.startColumnIndex ?? 0) - (mergeB.startColumnIndex ?? 0),
    )
  const existingMerges = (destSheetMeta.merges ?? [])
    .map((merge) =>
      hasCustomColumn
        ? merge
        : shiftMergeForColumnInsert(merge, customColumnIndex),
    )
    .map((merge) =>
      hasCustomRow ? merge : shiftMergeForRowInsert(merge, customRowIndex),
    )
  const overlappingMerges = existingMerges.filter((merge) =>
    targetMerges.some((target) => rangesOverlap(merge, target)),
  )
  const mergeRequests: Request[] = overlappingMerges.map((merge) => ({
    unmergeCells: { range: { ...merge, sheetId } },
  }))
  for (const merge of targetMerges)
    mergeRequests.push({ mergeCells: { range: merge, mergeType: 'MERGE_ALL' } })
  ops.push({
    label: `Daily Mode: ${targetMerges.length} merge(s) in ${blockLabel(mergedRegion)}`,
    note:
      `map image ${blockLabel(imageBlock)}` +
      (overlappingMerges.length
        ? `; unmerging ${overlappingMerges.length} existing merge(s) first`
        : ''),
    requests: mergeRequests,
  })

  // The image cell's value/formula, top-aligned.
  const sourceImageCell = cellAt(sourceImageBlockGrid, 0, 0)
  const imageAnchor = a1(imageBlock.firstRow, imageBlock.firstColumn)
  ops.push({
    label: `Daily Mode: ${imageAnchor} formula`,
    note: sourceImageCell.userEnteredValue?.formulaValue
      ? 'formula copied from the source'
      : 'value copied from the source',
    requests: [
      {
        updateCells: {
          range: {
            sheetId,
            startRowIndex: imageBlock.firstRow - 1,
            endRowIndex: imageBlock.firstRow,
            startColumnIndex: imageBlock.firstColumn - 1,
            endColumnIndex: imageBlock.firstColumn,
          },
          rows: [
            {
              values: [
                {
                  userEnteredValue: sourceImageCell.userEnteredValue ?? {},
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

  // L12:M15 formulas/values.
  const inputRowCount =
    DAILY_MODE_INPUTS_BLOCK.lastRow - DAILY_MODE_INPUTS_BLOCK.firstRow + 1
  const inputColumnCount =
    DAILY_MODE_INPUTS_BLOCK.lastColumn - DAILY_MODE_INPUTS_BLOCK.firstColumn + 1
  ops.push({
    label: `Daily Mode: ${blockLabel(DAILY_MODE_INPUTS_BLOCK)} inputs`,
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
export function shiftMergeForColumnInsert(
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

/** How a merge (pre-insert coordinates) looks after a row is inserted at 0-based `insertedRowIndex`. */
export function shiftMergeForRowInsert(
  merge: GridRange,
  insertedRowIndex: number,
): GridRange {
  const startRowIndex = merge.startRowIndex ?? 0
  const endRowIndex = merge.endRowIndex ?? 0
  if (startRowIndex >= insertedRowIndex)
    return {
      ...merge,
      startRowIndex: startRowIndex + 1,
      endRowIndex: endRowIndex + 1,
    }
  if (endRowIndex > insertedRowIndex)
    return { ...merge, endRowIndex: endRowIndex + 1 } // insertion inside the merge grows it
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

/** True when `inner` lies entirely within `outer`. */
export function rangeContains(outer: GridRange, inner: GridRange): boolean {
  return (
    (inner.startRowIndex ?? 0) >= (outer.startRowIndex ?? 0) &&
    (inner.endRowIndex ?? Infinity) <= (outer.endRowIndex ?? Infinity) &&
    (inner.startColumnIndex ?? 0) >= (outer.startColumnIndex ?? 0) &&
    (inner.endColumnIndex ?? Infinity) <= (outer.endColumnIndex ?? Infinity)
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
