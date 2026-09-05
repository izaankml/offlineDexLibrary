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
  /** Include the Party Checklist, the sheet highlighted by hand (default true). */
  handHighlightedSheets?: boolean
}

/** Deterministic pseudo-random 0/1/count values so diffs are reproducible. */
function syntheticValue(row: number, col: number): CellValue {
  const hash = (row * 31 + col * 17) % 7
  return hash < 3 ? 0 : hash < 6 ? 1 : row + col
}

function loadHeaders(sheet: FakeSheet, headerRows: string[][]): void {
  sheet.load(1, 1, headerRows)
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
  starter: {
    dataFirstRow: 3,
    displayFirstRow: 4,
    dataFoughtFlagCol: 12,
    dataLastCol: 143,
  },
  full: {
    dataFirstRow: 3,
    displayFirstRow: 4,
    dataFoughtFlagCol: 8,
    dataLastCol: 139,
  },
} as const

export function buildWorkbook(options: WorkbookOptions = {}): FakeSpreadsheet {
  const rowCount = options.rows ?? 25
  const spreadsheet = new FakeSpreadsheet('Offline RogueDex 6.03')

  // --- Quick Checklist -----------------------------------------------------
  const quickData = spreadsheet.addSheet('STARTER_CHECKLIST.data')
  loadHeaders(quickData, HEADERS['STARTER_CHECKLIST.data']!)
  for (let rowOffset = 0; rowOffset < rowCount; rowOffset++) {
    const row = LAYOUT_603.quick.dataFirstRow + rowOffset
    const line: CellValue[] = [rowOffset + 1] // Dex # in A
    for (let col = 2; col <= 12; col++) line.push(syntheticValue(row, col))
    quickData.load(row, 1, [line])
  }
  const quickDisplay = spreadsheet.addSheet('Quick Checklist')
  loadHeaders(quickDisplay, HEADERS['Quick Checklist (migrated)']!.slice(0, 11))
  for (let rowOffset = 0; rowOffset < rowCount; rowOffset++) {
    const row = LAYOUT_603.quick.displayFirstRow + rowOffset
    const line: CellValue[] = [
      rowOffset + 1,
      '',
      String(rowOffset + 1).padStart(4, '0'),
      'Mon ' + (rowOffset + 1),
      '#REF!',
    ]
    for (let col = 6; col <= 16; col++) line.push('☑')
    quickDisplay.load(row, 1, [line])
  }

  // --- Dex sheets ------------------------------------------------------------
  const addDexPair = (
    dataName: string,
    displayName: string,
    layout: {
      dataFirstRow: number
      displayFirstRow: number
      dataFoughtFlagCol: number
      dataLastCol: number
    },
  ): void => {
    const dataSheet = spreadsheet.addSheet(dataName)
    loadHeaders(dataSheet, HEADERS[dataName]!)
    for (let rowOffset = 0; rowOffset < rowCount; rowOffset++) {
      const row = layout.dataFirstRow + rowOffset
      const line: CellValue[] = []
      for (let col = layout.dataFoughtFlagCol; col <= layout.dataLastCol; col++)
        line.push(syntheticValue(row, col))
      dataSheet.load(row, layout.dataFoughtFlagCol, [line])
    }
    const displaySheet = spreadsheet.addSheet(displayName)
    loadHeaders(displaySheet, HEADERS[displayName]!)
    for (let rowOffset = 0; rowOffset < rowCount; rowOffset++) {
      const row = layout.displayFirstRow + rowOffset
      const line: CellValue[] = [rowOffset + 1, 'MON' + (rowOffset + 1), 3]
      for (let col = 4; col <= 135; col++) line.push('☑')
      displaySheet.load(row, 1, [line])
    }
  }
  addDexPair('STARTER_DEX.data', 'Starter DEX Checklist', LAYOUT_603.starter)
  addDexPair('FULL_DEX.data', 'Full DEX Checklist', LAYOUT_603.full)

  // --- Sheet highlighted by hand (cleared on upload) -------------------------
  if (options.handHighlightedSheets ?? true) {
    const partyChecklist = spreadsheet.addSheet('Party Checklist')
    partyChecklist.load(1, 1, [
      ['', '', '', '', 'Fought', 'Fought'],
      [
        'Pokemon',
        'Dex #',
        'Starter',
        'Starter Cost',
        'Fought Flag',
        'Fought Count',
      ],
    ])
    partyChecklist.load(3, 1, [
      ['Arceus', 493, 'Arceus', 9, '☐', 0],
      ['Charcadet', 935, 'Charcadet', 4, '☑', 19],
    ])
  }

  return spreadsheet
}
