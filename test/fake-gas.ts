/**
 * A small in-memory stand-in for the Apps Script services the library uses,
 * good enough to run the SaveTracker / Setup logic offline under node:test.
 *
 * Importing this module installs the fakes on globalThis (SpreadsheetApp,
 * Logger, PropertiesService, Utilities, LockService). Import it BEFORE any
 * src/lib module in a test file. Every Sheets "API call" is appended to
 * `calls` so tests can assert on the number of round-trips a flow makes.
 */

export type CellValue = string | number | boolean | null

export const calls: string[] = []
/**
 * SpreadsheetApp mutations are applied lazily in real Apps Script; the fake
 * counts them and the fake Sheets API refuses to run while any are pending
 * (i.e. until SpreadsheetApp.flush() was called) — the bug class that painted
 * the wrong rows on 2026-08-18.
 */
export let pendingMutations = 0
export function noteMutation(): void {
  pendingMutations++
}
export const logs: string[] = []
export const toasts: { title: string; body: string; timeout: number }[] = []

export function resetFakes(): void {
  pendingMutations = 0
  calls.length = 0
  logs.length = 0
  toasts.length = 0
  apiCalls.length = 0
  batchUpdates.length = 0
  activeSpreadsheet = null
  docProps.clear()
}

function colToLetters(col: number): string {
  let letters = ''
  let remaining = col
  while (remaining > 0) {
    const remainder = (remaining - 1) % 26
    letters = String.fromCharCode(65 + remainder) + letters
    remaining = Math.floor((remaining - 1) / 26)
  }
  return letters
}

function lettersToCol(letters: string): number {
  let col = 0
  for (const letter of letters.toUpperCase())
    col = col * 26 + (letter.charCodeAt(0) - 64)
  return col
}

/** Parse "B16", "B16:M131", "A:A" (unbounded rows become the sheet's max). */
function parseA1(
  a1: string,
  sheet: FakeSheet,
): { row: number; col: number; numRows: number; numCols: number } {
  const [startRef, endRef] = a1.split(':') as [string, string | undefined]
  const startMatch = startRef.match(/^([A-Za-z]+)(\d*)$/)
  if (!startMatch) throw new Error('bad A1: ' + a1)
  const col = lettersToCol(startMatch[1]!)
  const row = startMatch[2] ? parseInt(startMatch[2], 10) : 1
  if (!endRef) return { row, col, numRows: 1, numCols: 1 }
  const endMatch = endRef.match(/^([A-Za-z]+)(\d*)$/)
  if (!endMatch) throw new Error('bad A1: ' + a1)
  const endCol = lettersToCol(endMatch[1]!)
  const endRow = endMatch[2] ? parseInt(endMatch[2], 10) : sheet.getMaxRows()
  return { row, col, numRows: endRow - row + 1, numCols: endCol - col + 1 }
}

export class FakeRange {
  readonly sheet: FakeSheet
  readonly row: number
  readonly col: number
  readonly numRows: number
  readonly numCols: number
  constructor(
    sheet: FakeSheet,
    row: number,
    col: number,
    numRows: number,
    numCols: number,
  ) {
    this.sheet = sheet
    this.row = row
    this.col = col
    this.numRows = numRows
    this.numCols = numCols
  }
  private recordCall(methodName: string): void {
    calls.push(
      `${this.sheet.name}.${methodName}(${this.row},${this.col},${this.numRows},${this.numCols})`,
    )
  }
  getLastRow(): number {
    return this.row + this.numRows - 1
  }
  getLastColumn(): number {
    return this.col + this.numCols - 1
  }
  getValues(): CellValue[][] {
    this.recordCall('getValues')
    return this.sheet.readValues(this.row, this.col, this.numRows, this.numCols)
  }
  getDisplayValues(): string[][] {
    this.recordCall('getDisplayValues')
    return this.sheet
      .readValues(this.row, this.col, this.numRows, this.numCols)
      .map((row) => row.map((value) => (value === null ? '' : String(value))))
  }
  setValues(values: CellValue[][]): FakeRange {
    noteMutation()
    this.recordCall('setValues')
    if (
      values.length !== this.numRows ||
      values.some((row) => row.length !== this.numCols)
    ) {
      throw new Error(
        `setValues size mismatch on ${this.sheet.name}!(${this.row},${this.col},${this.numRows},${this.numCols}): got ${values.length}x${values[0]?.length}`,
      )
    }
    this.sheet.writeValues(this.row, this.col, values)
    return this
  }
  setBackgrounds(backgrounds: (string | null)[][]): FakeRange {
    noteMutation()
    this.recordCall('setBackgrounds')
    if (
      backgrounds.length !== this.numRows ||
      backgrounds.some((row) => row.length !== this.numCols)
    ) {
      throw new Error(
        `setBackgrounds size mismatch on ${this.sheet.name}!(${this.row},${this.col},${this.numRows},${this.numCols})`,
      )
    }
    this.sheet.writeBackgrounds(this.row, this.col, backgrounds)
    return this
  }
  setBackground(color: string | null): FakeRange {
    noteMutation()
    this.recordCall('setBackground')
    const backgrounds = Array.from({ length: this.numRows }, () =>
      new Array<string | null>(this.numCols).fill(color),
    )
    this.sheet.writeBackgrounds(this.row, this.col, backgrounds)
    return this
  }
  clearContent(): FakeRange {
    noteMutation()
    this.recordCall('clearContent')
    const blanks = Array.from({ length: this.numRows }, () =>
      new Array<CellValue>(this.numCols).fill(''),
    )
    this.sheet.writeValues(this.row, this.col, blanks)
    return this
  }
  sort(spec: { column: number; ascending: boolean }): FakeRange {
    noteMutation()
    this.recordCall('sort')
    this.sheet.sortRows(
      this.row,
      this.col,
      this.numRows,
      this.numCols,
      spec.column,
      spec.ascending,
    )
    return this
  }
}

type Cell = { value: CellValue; background: string | null }

export class FakeSheet {
  private cells = new Map<string, Cell>()
  hidden = false
  private maxRows = 1000
  private maxCols = 26

  readonly spreadsheet: FakeSpreadsheet
  name: string
  constructor(spreadsheet: FakeSpreadsheet, name: string) {
    this.spreadsheet = spreadsheet
    this.name = name
  }

  private cellKey(row: number, col: number): string {
    return row + ':' + col
  }
  private cell(row: number, col: number): Cell {
    let cell = this.cells.get(this.cellKey(row, col))
    if (!cell) {
      cell = { value: '', background: null }
      this.cells.set(this.cellKey(row, col), cell)
    }
    if (row > this.maxRows) this.maxRows = row
    if (col > this.maxCols) this.maxCols = col
    return cell
  }

  /** Test helper: load a 2-D array at (row, col). */
  load(row: number, col: number, values: CellValue[][]): this {
    this.writeValues(row, col, values)
    return this
  }
  /** Test helper: read the whole used grid of values. */
  grid(): CellValue[][] {
    return this.readValues(1, 1, this.getLastRow(), this.getLastColumn())
  }
  backgroundAt(row: number, col: number): string | null {
    return this.cells.get(this.cellKey(row, col))?.background ?? null
  }
  valueAt(row: number, col: number): CellValue {
    return this.cells.get(this.cellKey(row, col))?.value ?? ''
  }

  readValues(
    row: number,
    col: number,
    numRows: number,
    numCols: number,
  ): CellValue[][] {
    const values: CellValue[][] = []
    for (let rowOffset = 0; rowOffset < numRows; rowOffset++) {
      const line: CellValue[] = []
      for (let colOffset = 0; colOffset < numCols; colOffset++)
        line.push(
          this.cells.get(this.cellKey(row + rowOffset, col + colOffset))
            ?.value ?? '',
        )
      values.push(line)
    }
    return values
  }
  readBackgrounds(
    row: number,
    col: number,
    numRows: number,
    numCols: number,
  ): (string | null)[][] {
    const backgrounds: (string | null)[][] = []
    for (let rowOffset = 0; rowOffset < numRows; rowOffset++) {
      const line: (string | null)[] = []
      for (let colOffset = 0; colOffset < numCols; colOffset++)
        line.push(
          this.cells.get(this.cellKey(row + rowOffset, col + colOffset))
            ?.background ?? null,
        )
      backgrounds.push(line)
    }
    return backgrounds
  }
  writeValues(row: number, col: number, values: CellValue[][]): void {
    values.forEach((line, rowOffset) =>
      line.forEach((value, colOffset) => {
        this.cell(row + rowOffset, col + colOffset).value = value
      }),
    )
  }
  writeBackgrounds(
    row: number,
    col: number,
    backgrounds: (string | null)[][],
  ): void {
    backgrounds.forEach((line, rowOffset) =>
      line.forEach(
        (color, colOffset) =>
          (this.cell(row + rowOffset, col + colOffset).background = color),
      ),
    )
  }
  sortRows(
    row: number,
    col: number,
    numRows: number,
    numCols: number,
    sortColumn: number,
    ascending: boolean,
  ): void {
    const rows: Cell[][] = []
    for (let rowOffset = 0; rowOffset < numRows; rowOffset++) {
      const line: Cell[] = []
      for (let colOffset = 0; colOffset < numCols; colOffset++)
        line.push({ ...this.cell(row + rowOffset, col + colOffset) })
      rows.push(line)
    }
    const sortIndex = sortColumn - col
    rows.sort((left, right) => {
      const leftValue = left[sortIndex]!.value
      const rightValue = right[sortIndex]!.value
      const comparison =
        typeof leftValue === 'number' && typeof rightValue === 'number'
          ? leftValue - rightValue
          : String(leftValue).localeCompare(String(rightValue))
      return ascending ? comparison : -comparison
    })
    rows.forEach((line, rowOffset) =>
      line.forEach((cell, colOffset) =>
        Object.assign(this.cell(row + rowOffset, col + colOffset), cell),
      ),
    )
  }

  // --- Sheet API ---
  getName(): string {
    calls.push(`${this.name}.getName`)
    return this.name
  }
  getRange(
    rowOrA1: number | string,
    col?: number,
    numRows?: number,
    numCols?: number,
  ): FakeRange {
    if (typeof rowOrA1 === 'string') {
      const parsed = parseA1(rowOrA1, this)
      return new FakeRange(
        this,
        parsed.row,
        parsed.col,
        parsed.numRows,
        parsed.numCols,
      )
    }
    return new FakeRange(this, rowOrA1, col ?? 1, numRows ?? 1, numCols ?? 1)
  }
  getLastRow(): number {
    calls.push(`${this.name}.getLastRow`)
    let lastRow = 0
    for (const [key, cell] of this.cells) {
      if (cell.value !== '' && cell.value !== null)
        lastRow = Math.max(lastRow, parseInt(key.split(':')[0]!, 10))
    }
    return lastRow
  }
  getLastColumn(): number {
    calls.push(`${this.name}.getLastColumn`)
    let lastCol = 0
    for (const [key, cell] of this.cells) {
      if (cell.value !== '' && cell.value !== null)
        lastCol = Math.max(lastCol, parseInt(key.split(':')[1]!, 10))
    }
    return lastCol
  }
  getMaxRows(): number {
    return this.maxRows
  }
  getMaxColumns(): number {
    return this.maxCols
  }
  hideSheet(): void {
    noteMutation()
    calls.push(`${this.name}.hideSheet`)
    this.hidden = true
  }
  clear(): void {
    noteMutation()
    calls.push(`${this.name}.clear`)
    this.cells.clear()
  }
  insertRowsBefore(row: number, count: number): void {
    noteMutation()
    calls.push(`${this.name}.insertRowsBefore(${row},${count})`)
    const shifted = new Map<string, Cell>()
    for (const [key, cell] of this.cells) {
      const [cellRow, cellCol] = key.split(':').map(Number) as [number, number]
      shifted.set(
        this.cellKey(cellRow >= row ? cellRow + count : cellRow, cellCol),
        cell,
      )
    }
    this.cells = shifted
    this.maxRows += count
  }
  setColumnWidth(col: number, width: number): void {
    calls.push(`${this.name}.setColumnWidth(${col},${width})`)
  }
  deleteRows(row: number, count: number): void {
    noteMutation()
    calls.push(`${this.name}.deleteRows(${row},${count})`)
    const remaining = new Map<string, Cell>()
    for (const [key, cell] of this.cells) {
      const [cellRow, cellCol] = key.split(':').map(Number) as [number, number]
      if (cellRow >= row && cellRow < row + count) continue
      remaining.set(
        this.cellKey(
          cellRow >= row + count ? cellRow - count : cellRow,
          cellCol,
        ),
        cell,
      )
    }
    this.cells = remaining
  }
}

export class FakeSpreadsheet {
  private sheets: FakeSheet[] = []
  name: string
  id: string
  constructor(name = 'Offline RogueDex 6.03', id = 'fake-spreadsheet-id') {
    this.name = name
    this.id = id
  }
  addSheet(name: string): FakeSheet {
    const sheet = new FakeSheet(this, name)
    this.sheets.push(sheet)
    return sheet
  }
  // --- Spreadsheet API ---
  getName(): string {
    return this.name
  }
  getId(): string {
    return this.id
  }
  getSheetByName(name: string): FakeSheet | null {
    calls.push(`getSheetByName(${name})`)
    return this.sheets.find((sheet) => sheet.name === name) ?? null
  }
  getSheets(): FakeSheet[] {
    return [...this.sheets]
  }
  insertSheet(name: string): FakeSheet {
    noteMutation()
    calls.push(`insertSheet(${name})`)
    return this.addSheet(name)
  }
  deleteSheet(sheet: FakeSheet): void {
    noteMutation()
    calls.push(`deleteSheet(${sheet.name})`)
    this.sheets = this.sheets.filter((other) => other !== sheet)
  }
  toast(body: string, title: string, timeout: number): void {
    calls.push('toast')
    toasts.push({ title, body, timeout })
  }
}

let activeSpreadsheet: FakeSpreadsheet | null = null
export function setActiveSpreadsheet(spreadsheet: FakeSpreadsheet): void {
  activeSpreadsheet = spreadsheet
}

const docProps = new Map<string, string>()

const fakeGlobals = globalThis as Record<string, unknown>
fakeGlobals['SpreadsheetApp'] = {
  getActiveSpreadsheet(): FakeSpreadsheet {
    if (!activeSpreadsheet) throw new Error('no active spreadsheet set in test')
    return activeSpreadsheet
  },
  flush(): void {
    calls.push('flush')
    pendingMutations = 0
  },
}
fakeGlobals['Logger'] = {
  log(message: unknown): void {
    logs.push(String(message))
  },
}
fakeGlobals['PropertiesService'] = {
  getDocumentProperties() {
    return {
      getProperty: (key: string) => docProps.get(key) ?? null,
      setProperty: (key: string, value: string) => docProps.set(key, value),
      deleteProperty: (key: string) => docProps.delete(key),
    }
  },
}

// ---------------------------------------------------------------------------
// Fake Sheets advanced service (the subset the library uses), operating on the
// active FakeSpreadsheet. Ranges are A1 with a sheet name:
//   'Quick Checklist'!1:10  |  STARTER_DEX.data!3:2000  |  'Sheet'!A12:A  |  'Sheet'!D12:K900
// ---------------------------------------------------------------------------

export const apiCalls: { method: string; detail: unknown }[] = []
export const batchUpdates: {
  id: string
  requests: Record<string, unknown>[]
}[] = []

function sheetIdOf(sheet: FakeSheet): number {
  return sheet.spreadsheet.getSheets().indexOf(sheet) + 100
}
function sheetById(spreadsheet: FakeSpreadsheet, sheetId: number): FakeSheet {
  const sheet = spreadsheet.getSheets()[sheetId - 100]
  if (!sheet) throw new Error('fake Sheets: no sheet with id ' + sheetId)
  return sheet
}

function parseSheetRange(
  spreadsheet: FakeSpreadsheet,
  ref: string,
): {
  sheet: FakeSheet
  row: number
  col: number
  numRows: number
  numCols: number
} {
  const refMatch = ref.match(/^(?:'((?:[^']|'')*)'|([^'!]+))!(.+)$/)
  if (!refMatch) throw new Error('fake Sheets: bad range ' + ref)
  const sheetName = (refMatch[1] ?? refMatch[2] ?? '').replace(/''/g, "'")
  const sheet = spreadsheet.getSheetByName(sheetName)
  if (!sheet) throw new Error(`fake Sheets: Unable to parse range: ${ref}`)
  const a1 = refMatch[3]!
  const lastRow = Math.max(sheet.getLastRow(), 1)
  const lastCol = Math.max(sheet.getLastColumn(), 1)
  let row: number, col: number, endRow: number, endCol: number
  const rowRangeMatch = a1.match(/^(\d+):(\d+)$/)
  const colRangeMatch = a1.match(/^([A-Z]+):([A-Z]+)$/)
  if (rowRangeMatch) {
    row = parseInt(rowRangeMatch[1]!, 10)
    endRow = Math.min(parseInt(rowRangeMatch[2]!, 10), sheet.getMaxRows())
    col = 1
    endCol = lastCol
  } else if (colRangeMatch) {
    col = lettersToCol(colRangeMatch[1]!)
    endCol = lettersToCol(colRangeMatch[2]!)
    row = 1
    endRow = lastRow
  } else {
    const [startRef, endRef] = a1.split(':') as [string, string | undefined]
    const startMatch = startRef.match(/^([A-Z]+)(\d+)$/)
    if (!startMatch) throw new Error('fake Sheets: bad A1 ' + a1)
    col = lettersToCol(startMatch[1]!)
    row = parseInt(startMatch[2]!, 10)
    if (!endRef) {
      endCol = col
      endRow = row
    } else {
      const endMatch = endRef.match(/^([A-Z]+)(\d*)$/)
      if (!endMatch) throw new Error('fake Sheets: bad A1 ' + a1)
      endCol = lettersToCol(endMatch[1]!)
      endRow = endMatch[2] ? parseInt(endMatch[2], 10) : Math.max(lastRow, row)
    }
  }
  return {
    sheet,
    row,
    col,
    numRows: Math.max(0, endRow - row + 1),
    numCols: Math.max(0, endCol - col + 1),
  }
}

/** Trim like the API: drop trailing '' cells per row and trailing empty rows. */
function ragged(values: CellValue[][]): CellValue[][] {
  const trimmedRows = values.map((row) => {
    let end = row.length
    while (end > 0 && (row[end - 1] === '' || row[end - 1] === null)) end--
    return row.slice(0, end)
  })
  let rowCount = trimmedRows.length
  while (rowCount > 0 && trimmedRows[rowCount - 1]!.length === 0) rowCount--
  return trimmedRows.slice(0, rowCount)
}

function hexOf(
  color: { red?: number; green?: number; blue?: number } | undefined,
): string | null {
  if (!color) return null
  const channelHex = (channel: number | undefined): string =>
    Math.round((channel ?? 0) * 255)
      .toString(16)
      .padStart(2, '0')
  return (
    '#' +
    channelHex(color.red) +
    channelHex(color.green) +
    channelHex(color.blue)
  )
}

function applyRequest(
  spreadsheet: FakeSpreadsheet,
  request: Record<string, unknown>,
): void {
  if ('updateCells' in request) {
    const update = request['updateCells'] as {
      range: Record<string, number>
      rows: {
        values: {
          userEnteredFormat?: {
            backgroundColor?: { red?: number; green?: number; blue?: number }
          }
        }[]
      }[]
      fields: string
    }
    if (!update.fields.includes('backgroundColor')) return
    const sheet = sheetById(spreadsheet, update.range['sheetId']!)
    update.rows.forEach((row, rowOffset) => {
      const backgrounds = row.values.map((cell) =>
        hexOf(cell.userEnteredFormat?.backgroundColor),
      )
      sheet.writeBackgrounds(
        update.range['startRowIndex']! + 1 + rowOffset,
        update.range['startColumnIndex']! + 1,
        [backgrounds],
      )
    })
    return
  }
  if ('repeatCell' in request) {
    const repeat = request['repeatCell'] as {
      range: Record<string, number>
      cell: {
        userEnteredFormat?: {
          backgroundColor?: { red?: number; green?: number; blue?: number }
        }
      }
      fields: string
    }
    if (!repeat.fields.includes('backgroundColor')) return
    const sheet = sheetById(spreadsheet, repeat.range['sheetId']!)
    const color = hexOf(repeat.cell.userEnteredFormat?.backgroundColor)
    const numRows =
      repeat.range['endRowIndex']! - repeat.range['startRowIndex']!
    const numCols =
      repeat.range['endColumnIndex']! - repeat.range['startColumnIndex']!
    const backgrounds = Array.from({ length: numRows }, () =>
      new Array<string | null>(numCols).fill(color),
    )
    sheet.writeBackgrounds(
      repeat.range['startRowIndex']! + 1,
      repeat.range['startColumnIndex']! + 1,
      backgrounds,
    )
    return
  }
  // Other request kinds are recorded only.
}

function requireFlushed(method: string): void {
  if (pendingMutations > 0) {
    throw new Error(
      `fake Sheets: ${method} called with ${pendingMutations} unflushed SpreadsheetApp mutation(s) — call SpreadsheetApp.flush() first (real Apps Script applies them lazily, after the API call)`,
    )
  }
}

function activeFakeSpreadsheet(): FakeSpreadsheet {
  return (
    fakeGlobals['SpreadsheetApp'] as { getActiveSpreadsheet(): FakeSpreadsheet }
  ).getActiveSpreadsheet()
}

fakeGlobals['Sheets'] = {
  Spreadsheets: {
    get(_id: string, params: { fields?: string; ranges?: string[] }) {
      requireFlushed('spreadsheets.get')
      apiCalls.push({ method: 'spreadsheets.get', detail: params })
      const spreadsheet = activeFakeSpreadsheet()
      return {
        spreadsheetId: spreadsheet.getId(),
        sheets: spreadsheet.getSheets().map((sheet) => ({
          properties: {
            sheetId: sheetIdOf(sheet),
            title: sheet.name,
            hidden: sheet.hidden,
            gridProperties: {
              rowCount: sheet.getMaxRows(),
              columnCount: sheet.getMaxColumns(),
            },
          },
        })),
      }
    },
    batchUpdate(body: { requests: Record<string, unknown>[] }, id: string) {
      requireFlushed('spreadsheets.batchUpdate')
      apiCalls.push({
        method: 'spreadsheets.batchUpdate',
        detail: body.requests.length,
      })
      batchUpdates.push({ id, requests: body.requests })
      const spreadsheet = activeFakeSpreadsheet()
      for (const request of body.requests) applyRequest(spreadsheet, request)
      return {}
    },
    Values: {
      batchGet(_id: string, params: { ranges: string[] }) {
        requireFlushed('values.batchGet')
        apiCalls.push({ method: 'values.batchGet', detail: params.ranges })
        const spreadsheet = activeFakeSpreadsheet()
        return {
          valueRanges: params.ranges.map((ref) => {
            const target = parseSheetRange(spreadsheet, ref)
            const values = ragged(
              target.sheet.readValues(
                target.row,
                target.col,
                target.numRows,
                target.numCols,
              ),
            )
            return values.length ? { range: ref, values } : { range: ref }
          }),
        }
      },
      batchUpdate(
        body: { data: { range: string; values: CellValue[][] }[] },
        _id: string,
      ) {
        requireFlushed('values.batchUpdate')
        apiCalls.push({
          method: 'values.batchUpdate',
          detail: body.data.map((entry) => entry.range),
        })
        const spreadsheet = activeFakeSpreadsheet()
        for (const entry of body.data) {
          const target = parseSheetRange(spreadsheet, entry.range)
          target.sheet.writeValues(target.row, target.col, entry.values)
        }
        return {}
      },
    },
  },
}
