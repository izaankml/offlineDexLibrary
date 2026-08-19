/**
 * MIGRATOR
 *
 * Ports your customizations from an old OfflineDex spreadsheet to a new one.
 *
 * Since 2026-08 this is a plan → preview → apply pipeline on the Sheets API:
 *   1. read the source (2 GETs: sheet list; formats/values of the customized
 *      ranges) and the destination (2 GETs: sheet list + banding/CF/merges;
 *      the locator cells) — no `openById`, no temp sheets;
 *   2. build a list of Ops (human label + batchUpdate requests) — pure,
 *      tested; planning THROWS if a landmark doesn't fit, so nothing is
 *      touched when the creator's layout changed;
 *   3. apply everything in ONE batchUpdate — atomic: all steps land or none.
 *
 * `finishSetup` shows the plan (describePlan) before applying it.
 */

import { copyName } from '../shared/naming.ts'
import { shiftFormulaColumns } from './formulaShift.ts'
import {
  finishFlow,
  finishStep,
  resetToastProgress,
  startStep,
} from './progress.ts'
import {
  type BandedRange,
  type CellData,
  type ConditionalFormatRule,
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

// Daily Mode: custom column L (map-size inputs L12:M14 feed the IMAGE formula
// in B16). Presence is detected by the creator's "Missing Gym Leader
// Voucher…" landmark: N2 when L exists (source), M2 when it doesn't (fresh copy).
export const DAILY_MODE_SHEET = 'Daily Mode'
export const DAILY_MODE_CUSTOM_COLUMN = 12 // L
export const DAILY_MODE_LANDMARK_ROW = 2
export const DAILY_MODE_LANDMARK_COL_WITH_L = 14 // N
export const DAILY_MODE_LANDMARK_COL_WITHOUT_L = 13 // M
export const B16_MERGE = { row1: 16, col1: 2, row2: 131, col2: 13 } // B16:M131
export const DAILY_INPUTS = { row1: 12, col1: 12, row2: 14, col2: 13 } // L12:M14

// IV conditional formatting on the dex checklists.
export const DEX_IV_HIGHLIGHT_SHEETS = [
  'Starter DEX Checklist',
  'Full DEX Checklist',
]
export const DEX_IV_PERFECT_VALUE = '31'
export const DEX_IV_IMPERFECT_COLOR = '#ea9999' // red

export type Op = { label: string; requests: Request[]; note?: string }
export type MigrationPlan = {
  srcId: string
  dstId: string
  sourceVersion: string
  destVersion: string
  ops: Op[]
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
  const ss = SpreadsheetApp.getActiveSpreadsheet()
  const srcId = findFileIdByVersion(sourceVersion)
  const dstId = ss.getId()
  Logger.log(
    `Source: ${sourceVersion} -> ${srcId}; dest: ${destVersion} -> ${dstId} (active)`,
  )
  const src = readSource(client, srcId)
  const dst = readDestination(client, dstId)
  const { ops, notes } = buildPlan(src, dst, destVersion)
  return { srcId, dstId, sourceVersion, destVersion, ops, notes }
}

/** Apply a plan in one atomic batchUpdate. */
export function applyPlan(
  plan: MigrationPlan,
  client: SheetsClient = liveSheets,
): void {
  const requests = plan.ops.flatMap((op) => op.requests)
  if (requests.length === 0) return
  client.batchUpdate(plan.dstId, requests)
}

/**
 * Plan + apply with toast progress and timings; returns per-step results for
 * the caller to surface. Kept for callers that don't preview first.
 */
export function portAll(
  sourceVersion: string,
  destVersion: string,
  client: SheetsClient = liveSheets,
): StepResult[] {
  const ss = SpreadsheetApp.getActiveSpreadsheet()
  resetToastProgress('migration')
  let plan: MigrationPlan
  startStep(ss, 'Planning migration')
  try {
    plan = planForVersions(sourceVersion, destVersion, client)
  } catch (e) {
    finishFlow(ss, 'Migration not started', 10)
    return [
      {
        label: 'Planning migration',
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      },
    ]
  }
  finishStep()
  const results = applyPlanWithProgress(plan, client)
  Logger.log(formatResults(results))
  return results
}

/** Apply with a toast step; one result per op (all OK, or all ERR with the same message — the batch is atomic). */
export function applyPlanWithProgress(
  plan: MigrationPlan,
  client: SheetsClient = liveSheets,
): StepResult[] {
  const ss = SpreadsheetApp.getActiveSpreadsheet()
  const requests = plan.ops.reduce((n, op) => n + op.requests.length, 0)
  startStep(ss, `Applying ${plan.ops.length} steps (${requests} changes)`)
  try {
    applyPlan(plan, client)
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    finishFlow(ss, 'Migration failed', 10)
    return plan.ops.map((op) => ({ label: op.label, ok: false, error }))
  }
  finishFlow(ss, 'Migration complete', 10)
  return plan.ops.map((op) => ({ label: op.label, ok: true }))
}

/** "OK  label" / "ERR label: message" lines. */
export function formatResults(results: StepResult[]): string {
  return results
    .map((r) => (r.ok ? 'OK  ' + r.label : 'ERR ' + r.label + ': ' + r.error))
    .join('\n')
}

/** Human-readable plan, for the confirm dialog and the log. */
export function describePlan(plan: MigrationPlan): string {
  const lines = plan.ops.map(
    (op) => `• ${op.label}${op.note ? ` — ${op.note}` : ''}`,
  )
  const notes = plan.notes.map((n) => `· ${n}`)
  return [...lines, ...notes].join('\n')
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type SourceInfo = { meta: SpreadsheetInfo; grid: SpreadsheetInfo }
export type DestInfo = { meta: SpreadsheetInfo; grid: SpreadsheetInfo }

const GRID_FIELDS =
  'sheets(properties(sheetId,title,gridProperties),data(startRow,startColumn,rowData(values(userEnteredValue,userEnteredFormat,formattedValue)),rowMetadata,columnMetadata))'

export function readSource(client: SheetsClient, srcId: string): SourceInfo {
  const meta = client.get(srcId, {
    fields: 'sheets(properties(sheetId,title,hidden,gridProperties))',
  })
  const grid = client.get(srcId, {
    ranges: [
      `'${QUICK_CHECKLIST_SHEET}'!1:${QUICK_CHECKLIST_HEADER_ROWS}`,
      `'${DAILY_MODE_SHEET}'!${a1(B16_MERGE.row1, B16_MERGE.col1)}:${a1(B16_MERGE.row2, B16_MERGE.col2)}`,
      `'${DAILY_MODE_SHEET}'!${a1(DAILY_INPUTS.row1, DAILY_INPUTS.col1)}:${a1(DAILY_INPUTS.row2, DAILY_INPUTS.col2)}`,
      `'${DAILY_MODE_SHEET}'!${a1(DAILY_MODE_LANDMARK_ROW, DAILY_MODE_LANDMARK_COL_WITH_L)}`,
    ],
    includeGridData: true,
    fields: GRID_FIELDS,
  })
  return { meta, grid }
}

export function readDestination(client: SheetsClient, dstId: string): DestInfo {
  const meta = client.get(dstId, {
    fields:
      'sheets(properties(sheetId,title,hidden,gridProperties),merges,bandedRanges,conditionalFormats)',
  })
  const grid = client.get(dstId, {
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
  src: SourceInfo,
  dst: DestInfo,
  destVersion: string,
): { ops: Op[]; notes: string[] } {
  const ops: Op[] = []
  const notes: string[] = []
  ops.push(...planQuickChecklist(src, dst, destVersion))
  ops.push(...planQuickChecklistBanding(dst, notes))
  ops.push(...planDailyMode(src, dst, notes))
  ops.push(...planHiddenSheets(src, dst, notes))
  ops.push(...planDexIvHighlight(dst, notes))
  return { ops, notes }
}

function need<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) throw new Error(what)
  return v
}

/** First non-blank cell of the locator row right of the fixed columns (1-based col). */
export function quickChecklistFirstDataColumn(
  grid: GridData | null,
  which: string,
): number {
  const rowIdx = QUICK_CHECKLIST_LOCATOR_ROW - 1 - (grid?.startRow ?? 0)
  const cells = grid?.rowData?.[rowIdx]?.values ?? []
  for (let c = QUICK_CHECKLIST_FIXED_COLUMNS; c < cells.length; c++) {
    if (displayText(cells[c]!).trim() !== '') return c + 1
  }
  throw new Error(
    `Quick Checklist (${which}): row ${QUICK_CHECKLIST_LOCATOR_ROW} is blank right of column ${QUICK_CHECKLIST_FIXED_COLUMNS}; cannot locate the data block`,
  )
}

/**
 * Rows 1-10 of the Quick Checklist: formats for every source column, row
 * heights + hidden rows, column widths, row 1 formulas/values over the data
 * block and all of row 10 (same-sheet references shifted if the destination
 * block starts further right), hide Ribbons, stamp the title.
 */
export function planQuickChecklist(
  src: SourceInfo,
  dst: DestInfo,
  destVersion: string,
): Op[] {
  const sSheet = need(
    sheetByTitle(src.grid, QUICK_CHECKLIST_SHEET),
    'Quick Checklist not found in the source',
  )
  const dSheet = need(
    sheetByTitle(dst.grid, QUICK_CHECKLIST_SHEET),
    'Quick Checklist not found in the destination',
  )
  const dMeta = need(
    sheetByTitle(dst.meta, QUICK_CHECKLIST_SHEET),
    'Quick Checklist not found in the destination',
  )
  const sheetId = dSheet.properties.sheetId
  const sGrid = gridAt(sSheet)
  const dGrid = gridAt(dSheet)

  const srcFirst = quickChecklistFirstDataColumn(sGrid, 'source')
  const dstFirst = quickChecklistFirstDataColumn(dGrid, 'destination')
  const offset = dstFirst - srcFirst
  if (offset < 0) {
    throw new Error(
      `Quick Checklist: destination data block starts at column ${dstFirst}, left of the source's ${srcFirst}; layout unknown, nothing ported`,
    )
  }
  // Port up to the end of the data block (Ribbons); nothing of ours lives to
  // the right of it, and the source's grid may be wider for stale reasons
  // (e.g. the old SaveTracker marker column) that must not be carried over.
  const srcCols = srcFirst + QUICK_CHECKLIST_DATA_COLUMNS - 1
  const neededCols = srcCols + offset
  const dstCols = dMeta.properties.gridProperties?.columnCount ?? 0
  const lastData = dstFirst + QUICK_CHECKLIST_DATA_COLUMNS - 1
  const mapCol = (c1: number): number => (c1 >= srcFirst ? c1 + offset : c1) // 1-based

  const ops: Op[] = []
  const requests: Request[] = []

  if (dstCols < neededCols) {
    requests.push({
      appendDimension: {
        sheetId,
        dimension: 'COLUMNS',
        length: neededCols - dstCols,
      },
    })
  }

  // Formats, rows 1-10, in up to two column segments (left of the block, and the shifted block+rest).
  const formatRows = (c1From: number, c1To: number): Request => ({
    updateCells: {
      range: {
        sheetId,
        startRowIndex: 0,
        endRowIndex: QUICK_CHECKLIST_HEADER_ROWS,
        startColumnIndex: mapCol(c1From) - 1,
        endColumnIndex: mapCol(c1To),
      },
      rows: Array.from({ length: QUICK_CHECKLIST_HEADER_ROWS }, (_, r) => ({
        values: Array.from({ length: c1To - c1From + 1 }, (_, i) => ({
          userEnteredFormat:
            cellAt(sGrid, r, c1From - 1 + i).userEnteredFormat ?? {},
        })),
      })),
      fields: 'userEnteredFormat',
    },
  })
  if (srcFirst > 1) requests.push(formatRows(1, srcFirst - 1))
  requests.push(formatRows(srcFirst, srcCols))

  // Row heights + hidden rows.
  for (let r = 0; r < QUICK_CHECKLIST_HEADER_ROWS; r++) {
    const m = sGrid?.rowMetadata?.[r] ?? {}
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'ROWS', startIndex: r, endIndex: r + 1 },
        properties: {
          pixelSize: m.pixelSize ?? 21,
          hiddenByUser: !!m.hiddenByUser,
        },
        fields: 'pixelSize,hiddenByUser',
      },
    })
  }
  // Column widths (hidden states stay the creator's).
  for (let c1 = 1; c1 <= srcCols; c1++) {
    const m = sGrid?.columnMetadata?.[c1 - 1]
    if (!m?.pixelSize) continue
    requests.push({
      updateDimensionProperties: {
        range: {
          sheetId,
          dimension: 'COLUMNS',
          startIndex: mapCol(c1) - 1,
          endIndex: mapCol(c1),
        },
        properties: { pixelSize: m.pixelSize },
        fields: 'pixelSize',
      },
    })
  }

  // Row 1 over the data block; row 10 in full — formulas (shifted) or values.
  const valueCells = (row1: number, c1From: number, c1To: number): Request => ({
    updateCells: {
      range: {
        sheetId,
        startRowIndex: row1 - 1,
        endRowIndex: row1,
        startColumnIndex: mapCol(c1From) - 1,
        endColumnIndex: mapCol(c1To),
      },
      rows: [
        {
          values: Array.from({ length: c1To - c1From + 1 }, (_, i) => {
            const v = cellAt(sGrid, row1 - 1, c1From - 1 + i).userEnteredValue
            if (!v) return {}
            if (v.formulaValue !== undefined) {
              return {
                userEnteredValue: {
                  formulaValue: shiftFormulaColumns(
                    v.formulaValue,
                    srcFirst,
                    offset,
                  ),
                },
              }
            }
            return { userEnteredValue: v }
          }),
        },
      ],
      fields: 'userEnteredValue',
    },
  })
  requests.push(
    valueCells(1, srcFirst, srcFirst + QUICK_CHECKLIST_DATA_COLUMNS - 1),
  )
  if (srcFirst > 1)
    requests.push(valueCells(QUICK_CHECKLIST_LOCATOR_ROW, 1, srcFirst - 1))
  requests.push(valueCells(QUICK_CHECKLIST_LOCATOR_ROW, srcFirst, srcCols))

  // Hide Ribbons (last column of the block).
  requests.push({
    updateDimensionProperties: {
      range: {
        sheetId,
        dimension: 'COLUMNS',
        startIndex: lastData - 1,
        endIndex: lastData,
      },
      properties: { hiddenByUser: true },
      fields: 'hiddenByUser',
    },
  })

  const heights = Array.from(
    { length: QUICK_CHECKLIST_HEADER_ROWS },
    (_, r) => {
      const m = sGrid?.rowMetadata?.[r] ?? {}
      return `${m.pixelSize ?? '?'}${m.hiddenByUser ? 'h' : ''}`
    },
  ).join('/')
  ops.push({
    label: 'Quick Checklist header (rows 1–10)',
    note:
      (offset > 0
        ? `source block at column ${srcFirst}, destination at ${dstFirst}: formulas shifted right by ${offset}; Ribbons (col ${lastData}) hidden`
        : `block at column ${dstFirst} in both; Ribbons (col ${lastData}) hidden`) +
      `; row heights ${heights}px (h = hidden)`,
    requests,
  })

  // Title stamp unless A1 is a formula.
  const a1cell = cellAt(dGrid, 0, 0)
  if (a1cell.userEnteredValue?.formulaValue !== undefined) {
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
  dst: DestInfo,
  notes: string[],
): Op[] {
  const dMeta = need(
    sheetByTitle(dst.meta, QUICK_CHECKLIST_SHEET),
    'Quick Checklist not found in the destination',
  )
  const sheetId = dMeta.properties.sheetId
  const IMG0 = QUICK_CHECKLIST_IMAGE_COLUMN - 1 // 0-based
  const bandings = dMeta.bandedRanges ?? []
  const clearFills = (r: GridRange): Request => ({
    repeatCell: {
      range: {
        sheetId,
        startRowIndex: r.startRowIndex,
        endRowIndex: r.endRowIndex,
        startColumnIndex: IMG0,
        endColumnIndex: IMG0 + 1,
      },
      cell: { userEnteredFormat: {} },
      fields:
        'userEnteredFormat.backgroundColor,userEnteredFormat.backgroundColorStyle',
    },
  })

  const right = bandings.find(
    (b) => (b.range.startColumnIndex ?? 0) === IMG0 + 1,
  )
  if (right) {
    const left = bandings.find(
      (b) => b !== right && (b.range.endColumnIndex ?? 0) === IMG0,
    )
    const startColumnIndex = left ? (left.range.startColumnIndex ?? 0) : IMG0
    const requests: Request[] = []
    if (left)
      requests.push({ deleteBanding: { bandedRangeId: left.bandedRangeId } })
    requests.push({
      updateBanding: {
        bandedRange: {
          bandedRangeId: right.bandedRangeId,
          range: { ...right.range, startColumnIndex },
        },
        fields: 'range',
      },
    })
    requests.push(clearFills(right.range))
    return [
      {
        label: 'Quick Checklist banding over the image column',
        note: left ? 'merged with the A-only banding' : 'extended left to B',
        requests,
      },
    ]
  }
  const spanning = bandings.find(
    (b) =>
      (b.range.startColumnIndex ?? 0) <= IMG0 &&
      (b.range.endColumnIndex ?? 0) > IMG0,
  )
  if (spanning) {
    return [
      {
        label: 'Quick Checklist banding over the image column',
        note: 'already covers B; clearing B fills',
        requests: [clearFills(spanning.range)],
      },
    ]
  }
  const parity = /ISEVEN\s*\(\s*ROW|ISODD\s*\(\s*ROW|MOD\s*\(\s*ROW/i
  const requests: Request[] = []
  ;(dMeta.conditionalFormats ?? []).forEach((rule, index) => {
    const formula =
      rule.booleanRule?.condition.values?.[0]?.userEnteredValue ?? ''
    if (
      rule.booleanRule?.condition.type !== 'CUSTOM_FORMULA' ||
      !parity.test(formula)
    )
      return
    let touched = false
    const ranges = rule.ranges.map((rg) => {
      const c1 = rg.startColumnIndex ?? 0
      const c2 = (rg.endColumnIndex ?? 0) - 1
      if (c1 <= IMG0 && c2 >= IMG0) return rg
      if (c2 === IMG0 - 1 || c1 === IMG0 + 1) {
        touched = true
        return {
          ...rg,
          startColumnIndex: Math.min(c1, IMG0),
          endColumnIndex: Math.max(c2, IMG0) + 1,
        }
      }
      return rg
    })
    if (touched)
      requests.push({
        updateConditionalFormatRule: {
          sheetId,
          index,
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
  src: SourceInfo,
  dst: DestInfo,
): boolean {
  const sSheet = need(
    sheetByTitle(src.grid, DAILY_MODE_SHEET),
    'Daily Mode not found in the source',
  )
  const dSheet = need(
    sheetByTitle(dst.grid, DAILY_MODE_SHEET),
    'Daily Mode not found in the destination',
  )
  const sLandmark = gridAt(
    sSheet,
    DAILY_MODE_LANDMARK_ROW - 1,
    DAILY_MODE_LANDMARK_COL_WITH_L - 1,
  )
  const label = displayText(cellAt(sLandmark, 0, 0)).trim()
  if (!label) {
    throw new Error(
      `Daily Mode: landmark cell ${a1(DAILY_MODE_LANDMARK_ROW, DAILY_MODE_LANDMARK_COL_WITH_L)} is blank in the source; cannot tell whether column L is present`,
    )
  }
  const dLandmarks = gridAt(
    dSheet,
    DAILY_MODE_LANDMARK_ROW - 1,
    DAILY_MODE_LANDMARK_COL_WITHOUT_L - 1,
  )
  const withoutL = displayText(cellAt(dLandmarks, 0, 0)).trim()
  const withL = displayText(cellAt(dLandmarks, 0, 1)).trim()
  if (withL === label) return true
  if (withoutL === label) return false
  throw new Error(
    `Daily Mode: landmark "${label}" is at neither ${a1(DAILY_MODE_LANDMARK_ROW, DAILY_MODE_LANDMARK_COL_WITH_L)} nor ${a1(DAILY_MODE_LANDMARK_ROW, DAILY_MODE_LANDMARK_COL_WITHOUT_L)} in the destination; layout changed, Daily Mode not touched`,
  )
}

/**
 * Daily Mode: insert custom column L when missing; formats for B16:M131 and
 * L12:M14; widths of L and M; merge B16:M131 (unmerging whatever overlaps);
 * B16 formula/value top-aligned; L12:M14 formulas/values.
 */
export function planDailyMode(
  src: SourceInfo,
  dst: DestInfo,
  notes: string[],
): Op[] {
  const sSheet = need(
    sheetByTitle(src.grid, DAILY_MODE_SHEET),
    'Daily Mode not found in the source',
  )
  const dMeta = need(
    sheetByTitle(dst.meta, DAILY_MODE_SHEET),
    'Daily Mode not found in the destination',
  )
  const sheetId = dMeta.properties.sheetId
  const hasL = dailyModeHasCustomColumn(src, dst)
  const ops: Op[] = []
  const L0 = DAILY_MODE_CUSTOM_COLUMN - 1

  if (!hasL) {
    ops.push({
      label: 'Daily Mode: insert custom column L',
      note: 'landmark found at M2 (fresh copy)',
      requests: [
        {
          insertDimension: {
            range: {
              sheetId,
              dimension: 'COLUMNS',
              startIndex: L0,
              endIndex: L0 + 1,
            },
            inheritFromBefore: false,
          },
        },
      ],
    })
  } else {
    notes.push('Daily Mode: custom column L already present (landmark at N2)')
  }

  const formatBlock = (
    row1: number,
    col1: number,
    row2: number,
    col2: number,
    label: string,
  ): Op => {
    const grid = gridAt(sSheet, row1 - 1, col1 - 1)
    const nRows = row2 - row1 + 1
    const nCols = col2 - col1 + 1
    return {
      label,
      requests: [
        {
          updateCells: {
            range: {
              sheetId,
              startRowIndex: row1 - 1,
              endRowIndex: row2,
              startColumnIndex: col1 - 1,
              endColumnIndex: col2,
            },
            rows: Array.from({ length: nRows }, (_, r) => ({
              values: Array.from({ length: nCols }, (_, c) => ({
                userEnteredFormat: cellAt(grid, r, c).userEnteredFormat ?? {},
              })),
            })),
            fields: 'userEnteredFormat',
          },
        },
      ],
    }
  }
  ops.push(
    formatBlock(
      B16_MERGE.row1,
      B16_MERGE.col1,
      B16_MERGE.row2,
      B16_MERGE.col2,
      'Daily Mode: formats of B16:M131',
    ),
  )
  ops.push(
    formatBlock(
      DAILY_INPUTS.row1,
      DAILY_INPUTS.col1,
      DAILY_INPUTS.row2,
      DAILY_INPUTS.col2,
      'Daily Mode: formats of L12:M14',
    ),
  )

  // Column widths L, M from the source (its B16:M131 block carries columnMetadata for B..M).
  const bGrid = gridAt(sSheet, B16_MERGE.row1 - 1, B16_MERGE.col1 - 1)
  const widthReqs: Request[] = []
  for (const col1 of [DAILY_MODE_CUSTOM_COLUMN, DAILY_MODE_CUSTOM_COLUMN + 1]) {
    const m = bGrid?.columnMetadata?.[col1 - B16_MERGE.col1]
    if (!m?.pixelSize) continue
    widthReqs.push({
      updateDimensionProperties: {
        range: {
          sheetId,
          dimension: 'COLUMNS',
          startIndex: col1 - 1,
          endIndex: col1,
        },
        properties: { pixelSize: m.pixelSize },
        fields: 'pixelSize',
      },
    })
  }
  if (widthReqs.length)
    ops.push({
      label: 'Daily Mode: widths of columns L and M',
      requests: widthReqs,
    })

  // Merge B16:M131 — first unmerge anything overlapping it (in post-insert coordinates).
  const target: GridRange = {
    sheetId,
    startRowIndex: B16_MERGE.row1 - 1,
    endRowIndex: B16_MERGE.row2,
    startColumnIndex: B16_MERGE.col1 - 1,
    endColumnIndex: B16_MERGE.col2,
  }
  const merges = (dMeta.merges ?? []).map((m) =>
    hasL ? m : shiftMergeForInsert(m, L0),
  )
  const overlapping = merges.filter((m) => rangesOverlap(m, target))
  const mergeReqs: Request[] = overlapping.map((m) => ({
    unmergeCells: { range: { ...m, sheetId } },
  }))
  mergeReqs.push({ mergeCells: { range: target, mergeType: 'MERGE_ALL' } })
  ops.push({
    label: 'Daily Mode: merge B16:M131',
    ...(overlapping.length
      ? { note: `unmerging ${overlapping.length} existing merge(s) first` }
      : {}),
    requests: mergeReqs,
  })

  // B16 value/formula, top-aligned.
  const b16 = cellAt(bGrid, 0, 0)
  ops.push({
    label: 'Daily Mode: B16 formula',
    note: b16.userEnteredValue?.formulaValue
      ? 'formula copied from the source'
      : 'value copied from the source',
    requests: [
      {
        updateCells: {
          range: {
            sheetId,
            startRowIndex: B16_MERGE.row1 - 1,
            endRowIndex: B16_MERGE.row1,
            startColumnIndex: B16_MERGE.col1 - 1,
            endColumnIndex: B16_MERGE.col1,
          },
          rows: [
            {
              values: [
                {
                  userEnteredValue: b16.userEnteredValue ?? {},
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
  const inputs = gridAt(sSheet, DAILY_INPUTS.row1 - 1, DAILY_INPUTS.col1 - 1)
  const nRows = DAILY_INPUTS.row2 - DAILY_INPUTS.row1 + 1
  const nCols = DAILY_INPUTS.col2 - DAILY_INPUTS.col1 + 1
  ops.push({
    label: 'Daily Mode: L12:M14 inputs',
    requests: [
      {
        updateCells: {
          range: {
            sheetId,
            startRowIndex: DAILY_INPUTS.row1 - 1,
            endRowIndex: DAILY_INPUTS.row2,
            startColumnIndex: DAILY_INPUTS.col1 - 1,
            endColumnIndex: DAILY_INPUTS.col2,
          },
          rows: Array.from({ length: nRows }, (_, r) => ({
            values: Array.from({ length: nCols }, (_, c) => {
              const v = cellAt(inputs, r, c).userEnteredValue
              return v ? { userEnteredValue: v } : {}
            }),
          })),
          fields: 'userEnteredValue',
        },
      },
    ],
  })
  return ops
}

/** How a merge (pre-insert coordinates) looks after a column is inserted at `col0`. */
export function shiftMergeForInsert(m: GridRange, col0: number): GridRange {
  const s = m.startColumnIndex ?? 0
  const e = m.endColumnIndex ?? 0
  if (s >= col0) return { ...m, startColumnIndex: s + 1, endColumnIndex: e + 1 }
  if (e > col0) return { ...m, endColumnIndex: e + 1 } // insertion inside the merge widens it
  return m
}

export function rangesOverlap(a: GridRange, b: GridRange): boolean {
  return (
    (a.startRowIndex ?? 0) < (b.endRowIndex ?? Infinity) &&
    (b.startRowIndex ?? 0) < (a.endRowIndex ?? Infinity) &&
    (a.startColumnIndex ?? 0) < (b.endColumnIndex ?? Infinity) &&
    (b.startColumnIndex ?? 0) < (a.endColumnIndex ?? Infinity)
  )
}

/** Hide every destination sheet whose same-named source sheet is hidden. */
export function planHiddenSheets(
  src: SourceInfo,
  dst: DestInfo,
  notes: string[],
): Op[] {
  const dstByTitle = new Map(
    (dst.meta.sheets ?? []).map((s) => [s.properties.title, s]),
  )
  const requests: Request[] = []
  const names: string[] = []
  for (const s of src.meta.sheets ?? []) {
    if (!s.properties.hidden) continue
    const d = dstByTitle.get(s.properties.title)
    if (!d || d.properties.hidden) continue
    requests.push({
      updateSheetProperties: {
        properties: { sheetId: d.properties.sheetId, hidden: true },
        fields: 'hidden',
      },
    })
    names.push(s.properties.title)
  }
  if (!requests.length) {
    notes.push('Hidden sheets: nothing to hide (already matching)')
    return []
  }
  return [
    {
      label: `Hide ${names.length} sheet(s)`,
      note: names.join(', '),
      requests,
    },
  ]
}

/** Replace the "perfect IV" (= 31 → yellow) rules on the dex checklists with "≠ 31 → red" over the same ranges. */
export function planDexIvHighlight(dst: DestInfo, notes: string[]): Op[] {
  const ops: Op[] = []
  for (const name of DEX_IV_HIGHLIGHT_SHEETS) {
    const sheet = sheetByTitle(dst.meta, name)
    if (!sheet) {
      notes.push(`IV highlight: "${name}" not found, skipping`)
      continue
    }
    const sheetId = sheet.properties.sheetId
    const rules = sheet.conditionalFormats ?? []
    const matches = rules
      .map((rule, index) => ({ rule, index }))
      .filter(({ rule }) => isPerfectIvRule(rule))
    if (!matches.length) {
      notes.push(
        `IV highlight: no "= ${DEX_IV_PERFECT_VALUE}" rule on "${name}" (already replaced?)`,
      )
      continue
    }
    const requests: Request[] = []
    // Highest index first so earlier indices stay valid while we replace.
    for (const { rule, index } of [...matches].sort(
      (x, y) => y.index - x.index,
    )) {
      requests.push({ deleteConditionalFormatRule: { sheetId, index } })
      rule.ranges.forEach((range, k) => {
        const topLeft = a1(
          (range.startRowIndex ?? 0) + 1,
          (range.startColumnIndex ?? 0) + 1,
        )
        requests.push({
          addConditionalFormatRule: {
            index: index + k,
            rule: {
              ranges: [{ ...range, sheetId }],
              booleanRule: {
                condition: {
                  type: 'CUSTOM_FORMULA',
                  values: [
                    {
                      userEnteredValue: `=TO_TEXT(${topLeft})<>"${DEX_IV_PERFECT_VALUE}"`,
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
      label: `${name}: IV highlight → red when not 31`,
      note: `${matches.length} rule(s) replaced`,
      requests,
    })
  }
  return ops
}

export function isPerfectIvRule(rule: ConditionalFormatRule): boolean {
  const cond = rule.booleanRule?.condition
  if (!cond) return false
  const value = String(cond.values?.[0]?.userEnteredValue ?? '')
  return (
    (cond.type === 'TEXT_EQ' || cond.type === 'NUMBER_EQ') &&
    value === DEX_IV_PERFECT_VALUE
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
  const it = DriveApp.searchFiles(query)
  const out: GoogleAppsScript.Drive.File[] = []
  while (it.hasNext()) out.push(it.next())
  return out
}

/** Drive file ID of an Offline RogueDex spreadsheet by version (newest if several). */
export function findFileIdByVersion(version: string): string {
  const targetName = copyName(version)
  const matches = findSpreadsheetsNamed(targetName)
  if (matches.length === 0) {
    throw new Error(
      `No file found named "${targetName}". Check the version number, or rename your copy to match.`,
    )
  }
  if (matches.length > 1) {
    matches.sort(
      (a, b) => b.getLastUpdated().getTime() - a.getLastUpdated().getTime(),
    )
    Logger.log(
      `Multiple files named "${targetName}" found. Using newest: ${matches[0]!.getId()}. Others ignored: ${matches
        .slice(1)
        .map((f) => f.getId())
        .join(', ')}`,
    )
  }
  return matches[0]!.getId()
}

// Re-exported for tests / callers that only need the pure pieces.
export type { BandedRange, CellData, SheetInfo }
