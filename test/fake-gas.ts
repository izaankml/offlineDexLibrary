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
export const logs: string[] = []
export const toasts: { title: string; body: string; timeout: number }[] = []

export function resetFakes(): void {
  calls.length = 0
  logs.length = 0
  toasts.length = 0
  apiCalls.length = 0
  batchUpdates.length = 0
  activeSpreadsheet = null
  docProps.clear()
}

function colToLetters(col: number): string {
  let s = ''
  while (col > 0) {
    const m = (col - 1) % 26
    s = String.fromCharCode(65 + m) + s
    col = Math.floor((col - 1) / 26)
  }
  return s
}

function lettersToCol(letters: string): number {
  let n = 0
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n
}

/** Parse "B16", "B16:M131", "A:A" (unbounded rows become the sheet's max). */
function parseA1(
  a1: string,
  sheet: FakeSheet,
): { row: number; col: number; numRows: number; numCols: number } {
  const [start, end] = a1.split(':') as [string, string | undefined]
  const m1 = start.match(/^([A-Za-z]+)(\d*)$/)
  if (!m1) throw new Error('bad A1: ' + a1)
  const col = lettersToCol(m1[1]!)
  const row = m1[2] ? parseInt(m1[2], 10) : 1
  if (!end) return { row, col, numRows: 1, numCols: 1 }
  const m2 = end.match(/^([A-Za-z]+)(\d*)$/)
  if (!m2) throw new Error('bad A1: ' + a1)
  const col2 = lettersToCol(m2[1]!)
  const row2 = m2[2] ? parseInt(m2[2], 10) : sheet.getMaxRows()
  return { row, col, numRows: row2 - row + 1, numCols: col2 - col + 1 }
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
  private call(name: string): void {
    calls.push(
      `${this.sheet.name}.${name}(${this.row},${this.col},${this.numRows},${this.numCols})`,
    )
  }
  getRow(): number {
    return this.row
  }
  getColumn(): number {
    return this.col
  }
  getNumRows(): number {
    return this.numRows
  }
  getNumColumns(): number {
    return this.numCols
  }
  getLastRow(): number {
    return this.row + this.numRows - 1
  }
  getLastColumn(): number {
    return this.col + this.numCols - 1
  }
  getA1Notation(): string {
    const a = colToLetters(this.col) + this.row
    if (this.numRows === 1 && this.numCols === 1) return a
    return a + ':' + colToLetters(this.getLastColumn()) + this.getLastRow()
  }
  getCell(r: number, c: number): FakeRange {
    return new FakeRange(this.sheet, this.row + r - 1, this.col + c - 1, 1, 1)
  }
  getValues(): CellValue[][] {
    this.call('getValues')
    return this.sheet.readValues(this.row, this.col, this.numRows, this.numCols)
  }
  getDisplayValues(): string[][] {
    this.call('getDisplayValues')
    return this.sheet
      .readValues(this.row, this.col, this.numRows, this.numCols)
      .map((r) => r.map((v) => (v === null ? '' : String(v))))
  }
  getValue(): CellValue {
    return this.getValues()[0]![0]!
  }
  getDisplayValue(): string {
    return this.getDisplayValues()[0]![0]!
  }
  setValues(values: CellValue[][]): FakeRange {
    this.call('setValues')
    if (
      values.length !== this.numRows ||
      values.some((r) => r.length !== this.numCols)
    ) {
      throw new Error(
        `setValues size mismatch on ${this.getA1Notation()}: got ${values.length}x${values[0]?.length}`,
      )
    }
    this.sheet.writeValues(this.row, this.col, values)
    return this
  }
  setValue(v: CellValue): FakeRange {
    return this.setValues([[v]])
  }
  getFormulas(): string[][] {
    this.call('getFormulas')
    return this.sheet.readFormulas(
      this.row,
      this.col,
      this.numRows,
      this.numCols,
    )
  }
  getFormula(): string {
    return this.getFormulas()[0]![0]!
  }
  getBackgrounds(): (string | null)[][] {
    this.call('getBackgrounds')
    return this.sheet.readBackgrounds(
      this.row,
      this.col,
      this.numRows,
      this.numCols,
    )
  }
  setBackgrounds(bg: (string | null)[][]): FakeRange {
    this.call('setBackgrounds')
    if (
      bg.length !== this.numRows ||
      bg.some((r) => r.length !== this.numCols)
    ) {
      throw new Error(`setBackgrounds size mismatch on ${this.getA1Notation()}`)
    }
    this.sheet.writeBackgrounds(this.row, this.col, bg)
    return this
  }
  setBackground(color: string | null): FakeRange {
    this.call('setBackground')
    const bg = Array.from({ length: this.numRows }, () =>
      new Array<string | null>(this.numCols).fill(color),
    )
    this.sheet.writeBackgrounds(this.row, this.col, bg)
    return this
  }
  clearContent(): FakeRange {
    this.call('clearContent')
    const blank = Array.from({ length: this.numRows }, () =>
      new Array<CellValue>(this.numCols).fill(''),
    )
    this.sheet.writeValues(this.row, this.col, blank)
    return this
  }
  sort(spec: { column: number; ascending: boolean }): FakeRange {
    this.call('sort')
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

type Cell = { value: CellValue; formula: string; background: string | null }

export class FakeSheet {
  private cells = new Map<string, Cell>()
  hidden = false
  hiddenColumns = new Set<number>()
  hiddenRows = new Set<number>()
  private maxRows = 1000
  private maxCols = 26

  readonly spreadsheet: FakeSpreadsheet
  name: string
  constructor(spreadsheet: FakeSpreadsheet, name: string) {
    this.spreadsheet = spreadsheet
    this.name = name
  }

  private key(r: number, c: number): string {
    return r + ':' + c
  }
  private cell(r: number, c: number): Cell {
    let cell = this.cells.get(this.key(r, c))
    if (!cell) {
      cell = { value: '', formula: '', background: null }
      this.cells.set(this.key(r, c), cell)
    }
    if (r > this.maxRows) this.maxRows = r
    if (c > this.maxCols) this.maxCols = c
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
  backgroundAt(r: number, c: number): string | null {
    return this.cells.get(this.key(r, c))?.background ?? null
  }
  valueAt(r: number, c: number): CellValue {
    return this.cells.get(this.key(r, c))?.value ?? ''
  }

  readValues(row: number, col: number, nr: number, nc: number): CellValue[][] {
    const out: CellValue[][] = []
    for (let r = 0; r < nr; r++) {
      const line: CellValue[] = []
      for (let c = 0; c < nc; c++)
        line.push(this.cells.get(this.key(row + r, col + c))?.value ?? '')
      out.push(line)
    }
    return out
  }
  readFormulas(row: number, col: number, nr: number, nc: number): string[][] {
    const out: string[][] = []
    for (let r = 0; r < nr; r++) {
      const line: string[] = []
      for (let c = 0; c < nc; c++)
        line.push(this.cells.get(this.key(row + r, col + c))?.formula ?? '')
      out.push(line)
    }
    return out
  }
  readBackgrounds(
    row: number,
    col: number,
    nr: number,
    nc: number,
  ): (string | null)[][] {
    const out: (string | null)[][] = []
    for (let r = 0; r < nr; r++) {
      const line: (string | null)[] = []
      for (let c = 0; c < nc; c++)
        line.push(
          this.cells.get(this.key(row + r, col + c))?.background ?? null,
        )
      out.push(line)
    }
    return out
  }
  writeValues(row: number, col: number, values: CellValue[][]): void {
    values.forEach((line, r) =>
      line.forEach((v, c) => {
        const cell = this.cell(row + r, col + c)
        if (typeof v === 'string' && v.startsWith('=')) {
          cell.formula = v
          cell.value = v
        } else {
          cell.formula = ''
          cell.value = v
        }
      }),
    )
  }
  writeBackgrounds(row: number, col: number, bg: (string | null)[][]): void {
    bg.forEach((line, r) =>
      line.forEach((v, c) => (this.cell(row + r, col + c).background = v)),
    )
  }
  sortRows(
    row: number,
    col: number,
    nr: number,
    nc: number,
    byCol: number,
    ascending: boolean,
  ): void {
    const rows: Cell[][] = []
    for (let r = 0; r < nr; r++) {
      const line: Cell[] = []
      for (let c = 0; c < nc; c++) line.push({ ...this.cell(row + r, col + c) })
      rows.push(line)
    }
    const idx = byCol - col
    rows.sort((a, b) => {
      const av = a[idx]!.value
      const bv = b[idx]!.value
      const cmp =
        typeof av === 'number' && typeof bv === 'number'
          ? av - bv
          : String(av).localeCompare(String(bv))
      return ascending ? cmp : -cmp
    })
    rows.forEach((line, r) =>
      line.forEach((cell, c) =>
        Object.assign(this.cell(row + r, col + c), cell),
      ),
    )
  }

  // --- Sheet API ---
  getName(): string {
    calls.push(`${this.name}.getName`)
    return this.name
  }
  getSheetId(): number {
    return 0
  }
  getRange(a: number | string, b?: number, c?: number, d?: number): FakeRange {
    if (typeof a === 'string') {
      const p = parseA1(a, this)
      return new FakeRange(this, p.row, p.col, p.numRows, p.numCols)
    }
    return new FakeRange(this, a, b ?? 1, c ?? 1, d ?? 1)
  }
  getLastRow(): number {
    calls.push(`${this.name}.getLastRow`)
    let last = 0
    for (const [k, cell] of this.cells) {
      if (cell.value !== '' && cell.value !== null)
        last = Math.max(last, parseInt(k.split(':')[0]!, 10))
    }
    return last
  }
  getLastColumn(): number {
    calls.push(`${this.name}.getLastColumn`)
    let last = 0
    for (const [k, cell] of this.cells) {
      if (cell.value !== '' && cell.value !== null)
        last = Math.max(last, parseInt(k.split(':')[1]!, 10))
    }
    return last
  }
  getMaxRows(): number {
    return this.maxRows
  }
  getMaxColumns(): number {
    return this.maxCols
  }
  hideColumns(col: number, n = 1): void {
    calls.push(`${this.name}.hideColumns(${col},${n})`)
    for (let c = col; c < col + n; c++) this.hiddenColumns.add(c)
  }
  showColumns(col: number, n = 1): void {
    for (let c = col; c < col + n; c++) this.hiddenColumns.delete(c)
  }
  hideRows(row: number, n = 1): void {
    for (let r = row; r < row + n; r++) this.hiddenRows.add(r)
  }
  showRows(row: number, n = 1): void {
    for (let r = row; r < row + n; r++) this.hiddenRows.delete(r)
  }
  isColumnHiddenByUser(col: number): boolean {
    return this.hiddenColumns.has(col)
  }
  hideSheet(): void {
    calls.push(`${this.name}.hideSheet`)
    this.hidden = true
  }
  showSheet(): void {
    this.hidden = false
  }
  isSheetHidden(): boolean {
    return this.hidden
  }
  clear(): void {
    calls.push(`${this.name}.clear`)
    this.cells.clear()
  }
  insertRowsBefore(row: number, n: number): void {
    calls.push(`${this.name}.insertRowsBefore(${row},${n})`)
    const next = new Map<string, Cell>()
    for (const [k, cell] of this.cells) {
      const [r, c] = k.split(':').map(Number) as [number, number]
      next.set(this.key(r >= row ? r + n : r, c), cell)
    }
    this.cells = next
    this.maxRows += n
  }
  setColumnWidth(col: number, width: number): void {
    calls.push(`${this.name}.setColumnWidth(${col},${width})`)
  }
  deleteRows(row: number, n: number): void {
    calls.push(`${this.name}.deleteRows(${row},${n})`)
    const next = new Map<string, Cell>()
    for (const [k, cell] of this.cells) {
      const [r, c] = k.split(':').map(Number) as [number, number]
      if (r >= row && r < row + n) continue
      next.set(this.key(r >= row + n ? r - n : r, c), cell)
    }
    this.cells = next
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
    const s = new FakeSheet(this, name)
    this.sheets.push(s)
    return s
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
    return this.sheets.find((s) => s.name === name) ?? null
  }
  getSheets(): FakeSheet[] {
    return [...this.sheets]
  }
  insertSheet(name: string): FakeSheet {
    calls.push(`insertSheet(${name})`)
    return this.addSheet(name)
  }
  deleteSheet(sheet: FakeSheet): void {
    calls.push(`deleteSheet(${sheet.name})`)
    this.sheets = this.sheets.filter((s) => s !== sheet)
  }
  toast(body: string, title: string, timeout: number): void {
    calls.push('toast')
    toasts.push({ title, body, timeout })
  }
}

let activeSpreadsheet: FakeSpreadsheet | null = null
export function setActiveSpreadsheet(ss: FakeSpreadsheet): void {
  activeSpreadsheet = ss
}

const docProps = new Map<string, string>()

const g = globalThis as Record<string, unknown>
g['SpreadsheetApp'] = {
  getActiveSpreadsheet(): FakeSpreadsheet {
    if (!activeSpreadsheet) throw new Error('no active spreadsheet set in test')
    return activeSpreadsheet
  },
  flush(): void {
    calls.push('flush')
  },
}
g['Logger'] = {
  log(msg: unknown): void {
    logs.push(String(msg))
  },
}
g['PropertiesService'] = {
  getDocumentProperties() {
    return {
      getProperty: (k: string) => docProps.get(k) ?? null,
      setProperty: (k: string, v: string) => docProps.set(k, v),
      deleteProperty: (k: string) => docProps.delete(k),
    }
  },
}
g['Utilities'] = { sleep(): void {} }
g['LockService'] = {
  getDocumentLock() {
    return { waitLock(): void {}, releaseLock(): void {} }
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
function sheetById(ss: FakeSpreadsheet, id: number): FakeSheet {
  const s = ss.getSheets()[id - 100]
  if (!s) throw new Error('fake Sheets: no sheet with id ' + id)
  return s
}

function parseSheetRange(
  ss: FakeSpreadsheet,
  ref: string,
): {
  sheet: FakeSheet
  row: number
  col: number
  numRows: number
  numCols: number
} {
  const m = ref.match(/^(?:'((?:[^']|'')*)'|([^'!]+))!(.+)$/)
  if (!m) throw new Error('fake Sheets: bad range ' + ref)
  const name = (m[1] ?? m[2] ?? '').replace(/''/g, "'")
  const sheet = ss.getSheetByName(name)
  if (!sheet) throw new Error(`fake Sheets: Unable to parse range: ${ref}`)
  const a1 = m[3]!
  const lastRow = Math.max(sheet.getLastRow(), 1)
  const lastCol = Math.max(sheet.getLastColumn(), 1)
  let row: number, col: number, row2: number, col2: number
  const rows = a1.match(/^(\d+):(\d+)$/)
  const cols = a1.match(/^([A-Z]+):([A-Z]+)$/)
  if (rows) {
    row = parseInt(rows[1]!, 10)
    row2 = Math.min(parseInt(rows[2]!, 10), sheet.getMaxRows())
    col = 1
    col2 = lastCol
  } else if (cols) {
    col = lettersToCol(cols[1]!)
    col2 = lettersToCol(cols[2]!)
    row = 1
    row2 = lastRow
  } else {
    const [s1, s2] = a1.split(':') as [string, string | undefined]
    const p1 = s1.match(/^([A-Z]+)(\d+)$/)
    if (!p1) throw new Error('fake Sheets: bad A1 ' + a1)
    col = lettersToCol(p1[1]!)
    row = parseInt(p1[2]!, 10)
    if (!s2) {
      col2 = col
      row2 = row
    } else {
      const p2 = s2.match(/^([A-Z]+)(\d*)$/)
      if (!p2) throw new Error('fake Sheets: bad A1 ' + a1)
      col2 = lettersToCol(p2[1]!)
      row2 = p2[2] ? parseInt(p2[2], 10) : Math.max(lastRow, row)
    }
  }
  return {
    sheet,
    row,
    col,
    numRows: Math.max(0, row2 - row + 1),
    numCols: Math.max(0, col2 - col + 1),
  }
}

/** Trim like the API: drop trailing '' cells per row and trailing empty rows. */
function ragged(values: CellValue[][]): CellValue[][] {
  const rows = values.map((r) => {
    let end = r.length
    while (end > 0 && (r[end - 1] === '' || r[end - 1] === null)) end--
    return r.slice(0, end)
  })
  let n = rows.length
  while (n > 0 && rows[n - 1]!.length === 0) n--
  return rows.slice(0, n)
}

function hexOf(
  color: { red?: number; green?: number; blue?: number } | undefined,
): string | null {
  if (!color) return null
  const h = (x: number | undefined): string =>
    Math.round((x ?? 0) * 255)
      .toString(16)
      .padStart(2, '0')
  return '#' + h(color.red) + h(color.green) + h(color.blue)
}

function applyRequest(ss: FakeSpreadsheet, req: Record<string, unknown>): void {
  if ('updateCells' in req) {
    const u = req['updateCells'] as {
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
    if (!u.fields.includes('backgroundColor')) return
    const sheet = sheetById(ss, u.range['sheetId']!)
    u.rows.forEach((row, r) => {
      const bg = row.values.map((cell) =>
        hexOf(cell.userEnteredFormat?.backgroundColor),
      )
      sheet.writeBackgrounds(
        u.range['startRowIndex']! + 1 + r,
        u.range['startColumnIndex']! + 1,
        [bg],
      )
    })
    return
  }
  if ('repeatCell' in req) {
    const u = req['repeatCell'] as {
      range: Record<string, number>
      cell: {
        userEnteredFormat?: {
          backgroundColor?: { red?: number; green?: number; blue?: number }
        }
      }
      fields: string
    }
    if (!u.fields.includes('backgroundColor')) return
    const sheet = sheetById(ss, u.range['sheetId']!)
    const color = hexOf(u.cell.userEnteredFormat?.backgroundColor)
    const nr = u.range['endRowIndex']! - u.range['startRowIndex']!
    const nc = u.range['endColumnIndex']! - u.range['startColumnIndex']!
    const bg = Array.from({ length: nr }, () =>
      new Array<string | null>(nc).fill(color),
    )
    sheet.writeBackgrounds(
      u.range['startRowIndex']! + 1,
      u.range['startColumnIndex']! + 1,
      bg,
    )
    return
  }
  // Other request kinds are recorded only.
}

g['Sheets'] = {
  Spreadsheets: {
    get(_id: string, params: { fields?: string; ranges?: string[] }) {
      apiCalls.push({ method: 'spreadsheets.get', detail: params })
      const ss = (
        g['SpreadsheetApp'] as { getActiveSpreadsheet(): FakeSpreadsheet }
      ).getActiveSpreadsheet()
      return {
        spreadsheetId: ss.getId(),
        sheets: ss.getSheets().map((s) => ({
          properties: {
            sheetId: sheetIdOf(s),
            title: s.name,
            hidden: s.hidden,
            gridProperties: {
              rowCount: s.getMaxRows(),
              columnCount: s.getMaxColumns(),
            },
          },
        })),
      }
    },
    batchUpdate(body: { requests: Record<string, unknown>[] }, id: string) {
      apiCalls.push({
        method: 'spreadsheets.batchUpdate',
        detail: body.requests.length,
      })
      batchUpdates.push({ id, requests: body.requests })
      const ss = (
        g['SpreadsheetApp'] as { getActiveSpreadsheet(): FakeSpreadsheet }
      ).getActiveSpreadsheet()
      for (const r of body.requests) applyRequest(ss, r)
      return {}
    },
    Values: {
      batchGet(_id: string, params: { ranges: string[] }) {
        apiCalls.push({ method: 'values.batchGet', detail: params.ranges })
        const ss = (
          g['SpreadsheetApp'] as { getActiveSpreadsheet(): FakeSpreadsheet }
        ).getActiveSpreadsheet()
        return {
          valueRanges: params.ranges.map((ref) => {
            const p = parseSheetRange(ss, ref)
            const values = ragged(
              p.sheet.readValues(p.row, p.col, p.numRows, p.numCols),
            )
            return values.length ? { range: ref, values } : { range: ref }
          }),
        }
      },
      batchUpdate(
        body: { data: { range: string; values: CellValue[][] }[] },
        _id: string,
      ) {
        apiCalls.push({
          method: 'values.batchUpdate',
          detail: body.data.map((d) => d.range),
        })
        const ss = (
          g['SpreadsheetApp'] as { getActiveSpreadsheet(): FakeSpreadsheet }
        ).getActiveSpreadsheet()
        for (const d of body.data) {
          const p = parseSheetRange(ss, d.range)
          p.sheet.writeValues(p.row, p.col, d.values)
        }
        return {}
      },
    },
  },
}
