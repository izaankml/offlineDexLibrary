/**
 * Thin, typed façade over the Sheets advanced service (Sheets API v4) — just
 * the shapes the Migrator reads and writes. Kept minimal on purpose so tests
 * can hand-build responses and record requests without a network.
 */

export type Color = {
  red?: number
  green?: number
  blue?: number
  alpha?: number
}
export type CellFormat = Record<string, unknown>
export type ExtendedValue = {
  stringValue?: string
  numberValue?: number
  boolValue?: boolean
  formulaValue?: string
  errorValue?: unknown
}
export type CellData = {
  userEnteredValue?: ExtendedValue
  userEnteredFormat?: CellFormat
  formattedValue?: string
}
export type RowData = { values?: CellData[] }
export type DimensionProperties = { pixelSize?: number; hiddenByUser?: boolean }
export type GridData = {
  startRow?: number
  startColumn?: number
  rowData?: RowData[]
  rowMetadata?: DimensionProperties[]
  columnMetadata?: DimensionProperties[]
}
export type GridRange = {
  sheetId: number
  startRowIndex?: number
  endRowIndex?: number
  startColumnIndex?: number
  endColumnIndex?: number
}
export type BandedRange = { bandedRangeId: number; range: GridRange }
export type BooleanCondition = {
  type: string
  values?: { userEnteredValue?: string }[]
}
export type ConditionalFormatRule = {
  ranges: GridRange[]
  booleanRule?: { condition: BooleanCondition; format: CellFormat }
  gradientRule?: unknown
}
export type SheetProperties = {
  sheetId: number
  title: string
  index?: number
  hidden?: boolean
  gridProperties?: { rowCount?: number; columnCount?: number }
}
export type SheetInfo = {
  properties: SheetProperties
  data?: GridData[]
  merges?: GridRange[]
  bandedRanges?: BandedRange[]
  conditionalFormats?: ConditionalFormatRule[]
}
export type SpreadsheetInfo = { spreadsheetId?: string; sheets?: SheetInfo[] }

/** A batchUpdate request; the API's own union type is huge, so keep it open. */
export type Request = Record<string, unknown>

export type GetParams = {
  ranges?: string[]
  includeGridData?: boolean
  fields?: string
}

/** One range's values as returned by values.batchGet: ragged rows, trailing blanks omitted. */
export type ValueRange = { range?: string; values?: unknown[][] }
export type ValueRenderOption =
  'FORMATTED_VALUE' | 'UNFORMATTED_VALUE' | 'FORMULA'

export interface SheetsClient {
  get(spreadsheetId: string, params: GetParams): SpreadsheetInfo
  batchUpdate(spreadsheetId: string, requests: Request[]): void
  /** values.batchGet — one HTTP call for many ranges; result order matches `ranges`. */
  valuesBatchGet(
    spreadsheetId: string,
    ranges: string[],
    render: ValueRenderOption,
  ): ValueRange[]
  /** values.batchUpdate with RAW input — one HTTP call for many ranges. */
  valuesBatchUpdate(
    spreadsheetId: string,
    data: { range: string; values: unknown[][] }[],
  ): void
}

/**
 * The real service (requires "Sheets" in appsscript.json enabledAdvancedServices).
 * Every call flushes SpreadsheetApp first: its mutations (sort, clear, insertSheet…)
 * are applied lazily at the end of the execution, while API calls run immediately —
 * without the flush a queued sort would move rows AFTER the API painted them, and
 * a queued clear() would wipe a snapshot the API had just written.
 */
export const liveSheets: SheetsClient = {
  get(spreadsheetId, params) {
    SpreadsheetApp.flush()
    return spreadsheetsService().get(
      spreadsheetId,
      params as never,
    ) as unknown as SpreadsheetInfo
  },
  batchUpdate(spreadsheetId, requests) {
    SpreadsheetApp.flush()
    spreadsheetsService().batchUpdate(
      { requests: requests as never },
      spreadsheetId,
    )
  },
  valuesBatchGet(spreadsheetId, ranges, render) {
    SpreadsheetApp.flush()
    const response = spreadsheetsService().Values!.batchGet(spreadsheetId, {
      ranges,
      valueRenderOption: render,
      dateTimeRenderOption: 'FORMATTED_STRING',
    } as never) as unknown as { valueRanges?: ValueRange[] }
    return response.valueRanges ?? []
  },
  valuesBatchUpdate(spreadsheetId, data) {
    SpreadsheetApp.flush()
    spreadsheetsService().Values!.batchUpdate(
      { valueInputOption: 'RAW', data } as never,
      spreadsheetId,
    )
  },
}

function spreadsheetsService(): GoogleAppsScript.Sheets.Collection.SpreadsheetsCollection {
  const sheetsService = (globalThis as { Sheets?: GoogleAppsScript.Sheets })
    .Sheets
  if (!sheetsService?.Spreadsheets) {
    throw new Error(
      'The Sheets advanced service is not enabled for the OfflineDex Library (appsscript.json → enabledAdvancedServices).',
    )
  }
  return sheetsService.Spreadsheets
}

// ---------------------------------------------------------------------------
// Small helpers for reading grid data
// ---------------------------------------------------------------------------

/** Exact title first, then case/whitespace-insensitive (tab titles differ in case from what you'd type). */
export function sheetByTitle(
  info: SpreadsheetInfo,
  title: string,
): SheetInfo | null {
  const sheets = info.sheets ?? []
  const exactMatch = sheets.find((sheet) => sheet.properties.title === title)
  if (exactMatch) return exactMatch
  const normalizeTitle = (text: string): string =>
    text.replace(/\s+/g, ' ').trim().toLowerCase()
  const wantedTitle = normalizeTitle(title)
  return (
    sheets.find(
      (sheet) => normalizeTitle(sheet.properties.title) === wantedTitle,
    ) ?? null
  )
}

/** The GridData block of a sheet whose top-left is (startRow, startColumn), 0-based; the first block if unspecified. */
export function gridAt(
  sheet: SheetInfo,
  startRow?: number,
  startColumn?: number,
): GridData | null {
  const blocks = sheet.data ?? []
  if (startRow === undefined) return blocks[0] ?? null
  return (
    blocks.find(
      (block) =>
        (block.startRow ?? 0) === startRow &&
        (block.startColumn ?? 0) === (startColumn ?? 0),
    ) ?? null
  )
}

/** Cell at 0-based (rowIndex, columnIndex) inside a grid block, or an empty cell. */
export function cellAt(
  grid: GridData | null,
  rowIndex: number,
  columnIndex: number,
): CellData {
  return grid?.rowData?.[rowIndex]?.values?.[columnIndex] ?? {}
}

export function displayText(cell: CellData): string {
  if (cell.formattedValue !== undefined) return String(cell.formattedValue)
  const value = cell.userEnteredValue
  if (!value) return ''
  if (value.stringValue !== undefined) return value.stringValue
  if (value.numberValue !== undefined) return String(value.numberValue)
  if (value.boolValue !== undefined)
    return String(value.boolValue).toUpperCase()
  return ''
}

/** Hex '#rrggbb' → API Color. */
export function hexToColor(hex: string): Color {
  const rgbHex = hex.replace('#', '')
  return {
    red: parseInt(rgbHex.slice(0, 2), 16) / 255,
    green: parseInt(rgbHex.slice(2, 4), 16) / 255,
    blue: parseInt(rgbHex.slice(4, 6), 16) / 255,
  }
}

/** Quote a sheet name for an A1 range: 'Quick Checklist'!A1:B2 */
export function sheetRange(sheetName: string, a1Range: string): string {
  return `'${sheetName.replace(/'/g, "''")}'!${a1Range}`
}

/**
 * Normalize a values.batchGet block to exactly `rowCount` × `columnCount`, blanks as ''.
 * (The API omits trailing empty cells and rows.)
 */
export function padValues(
  values: unknown[][] | undefined,
  rowCount: number,
  columnCount: number,
): unknown[][] {
  const padded: unknown[][] = []
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
    const sourceRow = values?.[rowIndex] ?? []
    const row: unknown[] = new Array(columnCount)
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex++) {
      const value = sourceRow[columnIndex]
      row[columnIndex] = value === undefined || value === null ? '' : value
    }
    padded.push(row)
  }
  return padded
}

/** A1 notation for a 1-based (row, column): a1(16, 2) = 'B16'. */
export function a1(row: number, column: number): string {
  let letters = ''
  let remaining = column
  while (remaining > 0) {
    const remainder = (remaining - 1) % 26
    letters = String.fromCharCode(65 + remainder) + letters
    remaining = Math.floor((remaining - 1) / 26)
  }
  return letters + row
}
