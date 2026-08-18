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

/** The real service (requires "Sheets" in appsscript.json enabledAdvancedServices). */
export const liveSheets: SheetsClient = {
  get(spreadsheetId, params) {
    return service().get(
      spreadsheetId,
      params as never,
    ) as unknown as SpreadsheetInfo
  },
  batchUpdate(spreadsheetId, requests) {
    service().batchUpdate({ requests: requests as never }, spreadsheetId)
  },
  valuesBatchGet(spreadsheetId, ranges, render) {
    const res = service().Values!.batchGet(spreadsheetId, {
      ranges,
      valueRenderOption: render,
      dateTimeRenderOption: 'FORMATTED_STRING',
    } as never) as unknown as { valueRanges?: ValueRange[] }
    return res.valueRanges ?? []
  },
  valuesBatchUpdate(spreadsheetId, data) {
    service().Values!.batchUpdate(
      { valueInputOption: 'RAW', data } as never,
      spreadsheetId,
    )
  },
}

function service(): GoogleAppsScript.Sheets.Collection.SpreadsheetsCollection {
  const api = (globalThis as { Sheets?: GoogleAppsScript.Sheets }).Sheets
  if (!api?.Spreadsheets) {
    throw new Error(
      'The Sheets advanced service is not enabled for the OfflineDex Library (appsscript.json → enabledAdvancedServices).',
    )
  }
  return api.Spreadsheets
}

// ---------------------------------------------------------------------------
// Small helpers for reading grid data
// ---------------------------------------------------------------------------

export function sheetByTitle(
  info: SpreadsheetInfo,
  title: string,
): SheetInfo | null {
  return info.sheets?.find((s) => s.properties.title === title) ?? null
}

/** The GridData block of a sheet whose top-left is (row0, col0), 0-based; the first block if unspecified. */
export function gridAt(
  sheet: SheetInfo,
  row0?: number,
  col0?: number,
): GridData | null {
  const blocks = sheet.data ?? []
  if (row0 === undefined) return blocks[0] ?? null
  return (
    blocks.find(
      (g) => (g.startRow ?? 0) === row0 && (g.startColumn ?? 0) === (col0 ?? 0),
    ) ?? null
  )
}

/** Cell at 0-based (r, c) inside a grid block, or an empty cell. */
export function cellAt(grid: GridData | null, r: number, c: number): CellData {
  return grid?.rowData?.[r]?.values?.[c] ?? {}
}

export function displayText(cell: CellData): string {
  if (cell.formattedValue !== undefined) return String(cell.formattedValue)
  const v = cell.userEnteredValue
  if (!v) return ''
  if (v.stringValue !== undefined) return v.stringValue
  if (v.numberValue !== undefined) return String(v.numberValue)
  if (v.boolValue !== undefined) return String(v.boolValue).toUpperCase()
  return ''
}

/** Hex '#rrggbb' → API Color. */
export function hexToColor(hex: string): Color {
  const m = hex.replace('#', '')
  return {
    red: parseInt(m.slice(0, 2), 16) / 255,
    green: parseInt(m.slice(2, 4), 16) / 255,
    blue: parseInt(m.slice(4, 6), 16) / 255,
  }
}

/** Quote a sheet name for an A1 range: 'Quick Checklist'!A1:B2 */
export function sheetRange(sheetName: string, a1Range: string): string {
  return `'${sheetName.replace(/'/g, "''")}'!${a1Range}`
}

/**
 * Normalize a values.batchGet block to exactly `rows` × `cols`, blanks as ''.
 * (The API omits trailing empty cells and rows.)
 */
export function padValues(
  values: unknown[][] | undefined,
  rows: number,
  cols: number,
): unknown[][] {
  const out: unknown[][] = []
  for (let r = 0; r < rows; r++) {
    const src = values?.[r] ?? []
    const row: unknown[] = new Array(cols)
    for (let c = 0; c < cols; c++) {
      const v = src[c]
      row[c] = v === undefined || v === null ? '' : v
    }
    out.push(row)
  }
  return out
}

/** API Color → '#rrggbb' (used by tests / logs). */
export function colorToHex(c: Color | undefined): string | null {
  if (!c) return null
  const h = (x: number | undefined): string =>
    Math.round((x ?? 0) * 255)
      .toString(16)
      .padStart(2, '0')
  return '#' + h(c.red) + h(c.green) + h(c.blue)
}

export function a1(row1: number, col1: number): string {
  let s = ''
  let c = col1
  while (c > 0) {
    const m = (c - 1) % 26
    s = String.fromCharCode(65 + m) + s
    c = Math.floor((c - 1) / 26)
  }
  return s + row1
}
