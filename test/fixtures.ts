/**
 * Builds an in-memory workbook shaped like the real 6.03 copy: the header
 * rows are the ones captured from Drive (test/fixtures/headers-6.03.json),
 * the data rows are synthetic but deterministic.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FakeSpreadsheet, type CellValue, type FakeSheet } from './fake-gas.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
export const HEADERS: Record<string, string[][]> = JSON.parse(
  readFileSync(join(HERE, 'fixtures', 'headers-6.03.json'), 'utf8'),
)

export type WorkbookOptions = {
  /** Number of Pokémon rows per sheet (default 25). */
  rows?: number
  /** Use the creator's fresh Quick Checklist header (labels in row 1) instead of the migrated one. */
  freshQuickChecklist?: boolean
  /** Sheet name for the workbook (drives version detection). */
  name?: string
}

/** Deterministic pseudo-random 0/1/count values so diffs are reproducible. */
function synth(row: number, col: number): CellValue {
  const h = (row * 31 + col * 17) % 7
  return h < 3 ? 0 : h < 6 ? 1 : row + col
}

function loadHeaders(sheet: FakeSheet, rows: string[][]): void {
  sheet.load(1, 1, rows)
}

/**
 * The layout facts the fixture encodes (all 1-based). These mirror the real
 * 6.03 sheets and are what the header-keyed layout probe must rediscover.
 */
export const LAYOUT_603 = {
  quick: {
    dataFirstRow: 12,
    displayFirstRow: 12,
    /** STARTER_CHECKLIST.data: Dex # A, Caught flag B, …, SHINY D … Max IVs K, Ribbons L */
    dataShinyCol: 4,
    dataMaxIvsCol: 11,
    /** Quick Checklist: block Caught? F … Max IVs O, Ribbons P (junk hidden E) */
    displayShinyCol: 8,
    displayMaxIvsCol: 15,
    displayRibbonsCol: 16,
  },
  starter: { dataFirstRow: 3, displayFirstRow: 4, dataFoughtFlagCol: 12, displayFoughtFlagCol: 4, dataLastCol: 143 },
  full: { dataFirstRow: 3, displayFirstRow: 4, dataFoughtFlagCol: 8, displayFoughtFlagCol: 4, dataLastCol: 139 },
} as const

export function buildWorkbook(opts: WorkbookOptions = {}): FakeSpreadsheet {
  const n = opts.rows ?? 25
  const ss = new FakeSpreadsheet(opts.name ?? 'Offline RogueDex 6.03')

  // --- Quick Checklist -----------------------------------------------------
  const qData = ss.addSheet('STARTER_CHECKLIST.data')
  loadHeaders(qData, HEADERS['STARTER_CHECKLIST.data']!)
  for (let i = 0; i < n; i++) {
    const row = LAYOUT_603.quick.dataFirstRow + i
    const line: CellValue[] = [i + 1] // Dex # in A
    for (let c = 2; c <= 12; c++) line.push(synth(row, c))
    qData.load(row, 1, [line])
  }
  const qDisp = ss.addSheet('Quick Checklist')
  loadHeaders(
    qDisp,
    HEADERS[opts.freshQuickChecklist ? 'Quick Checklist (fresh PUBLIC)' : 'Quick Checklist (migrated)']!.slice(0, 11),
  )
  for (let i = 0; i < n; i++) {
    const row = LAYOUT_603.quick.displayFirstRow + i
    const line: CellValue[] = [i + 1, '', String(i + 1).padStart(4, '0'), 'Mon ' + (i + 1), '#REF!']
    for (let c = 6; c <= 16; c++) line.push('☑')
    qDisp.load(row, 1, [line])
  }

  // --- Dex sheets ------------------------------------------------------------
  const dex = (
    dataName: string,
    displayName: string,
    L: { dataFirstRow: number; displayFirstRow: number; dataFoughtFlagCol: number; dataLastCol: number },
  ): void => {
    const d = ss.addSheet(dataName)
    loadHeaders(d, HEADERS[dataName]!)
    for (let i = 0; i < n; i++) {
      const row = L.dataFirstRow + i
      const line: CellValue[] = []
      for (let c = L.dataFoughtFlagCol; c <= L.dataLastCol; c++) line.push(synth(row, c))
      d.load(row, L.dataFoughtFlagCol, [line])
    }
    const v = ss.addSheet(displayName)
    loadHeaders(v, HEADERS[displayName]!)
    for (let i = 0; i < n; i++) {
      const row = L.displayFirstRow + i
      const line: CellValue[] = [i + 1, 'MON' + (i + 1), 3]
      for (let c = 4; c <= 135; c++) line.push('☑')
      v.load(row, 1, [line])
    }
  }
  dex('STARTER_DEX.data', 'Starter Dex Checklist', LAYOUT_603.starter)
  dex('FULL_DEX.data', 'Full Dex Checklist', LAYOUT_603.full)

  // --- Form Checklist ----------------------------------------------------------
  const form = ss.addSheet('Form Checklist')
  form.load(1, 1, [['DEX#', 'Pokemon', 'Done', 'Default (A)']])
  form.load(2, 1, [
    [3, 'Venusaur', '☑', ''],
    [6, 'Charizard', '☐', ''],
    [9, 'Blastoise', '☑', ''],
    [25, 'Pikachu', '☐', ''],
  ])

  return ss
}
