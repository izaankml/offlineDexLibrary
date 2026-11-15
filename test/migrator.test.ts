import assert from 'node:assert/strict'
import { test } from 'node:test'
import './fake-gas.ts'
import {
  AG3_LOOKUP_SHEETS,
  DAILY_UNLOCKS_FILTER_FIRST_COLUMN,
  DAILY_UNLOCKS_FILTER_LABELS,
  DAILY_UNLOCKS_FILTER_ROW,
  DAILY_UNLOCKS_LANDMARKS,
  type DestInfo,
  type SourceInfo,
  applyPlan,
  buildPlan,
  describePlan,
  planQuickChecklist,
  planSheetOrder,
} from '../src/lib/migrator.ts'
import {
  DAILY_UNLOCKS_AG3_FORMULA,
  UNLOCK_MAP_FORMULA_COLUMNS,
  unlockMapBiomeRange,
  unlockMapColumnFormula,
} from '../src/lib/trackedFormulas.ts'
import type {
  CellData,
  CellFormat,
  GridData,
  GridRange,
  Request,
  SheetInfo,
  SheetsClient,
  SpreadsheetInfo,
} from '../src/lib/sheetsApi.ts'

// ---------------------------------------------------------------------------
// Fixture builders (shapes as the Sheets API returns them)
// ---------------------------------------------------------------------------

const fmt = (marker: string): CellFormat => ({
  backgroundColor: { red: 1, green: 1, blue: 1 },
  note: marker,
})
const str = (text: string, format?: CellFormat): CellData => ({
  userEnteredValue: { stringValue: text },
  formattedValue: text,
  ...(format ? { userEnteredFormat: format } : {}),
})
const num = (value: number): CellData => ({
  userEnteredValue: { numberValue: value },
  formattedValue: String(value),
})
const checkbox = (checked: boolean): CellData => ({
  userEnteredValue: { boolValue: checked },
  formattedValue: checked ? 'TRUE' : 'FALSE',
})
const formula = (formulaText: string, shown = ''): CellData => ({
  userEnteredValue: { formulaValue: formulaText },
  formattedValue: shown,
})
const empty = (): CellData => ({})

function grid(
  startRow: number,
  startColumn: number,
  rows: CellData[][],
  extra: Partial<GridData> = {},
): GridData {
  return {
    startRow,
    startColumn,
    rowData: rows.map((values) => ({ values })),
    ...extra,
  }
}

function sheet(
  title: string,
  sheetId: number,
  options: Partial<SheetInfo> & { columnCount?: number; hidden?: boolean } = {},
): SheetInfo {
  const { columnCount, hidden, ...rest } = options
  return {
    properties: {
      sheetId,
      title,
      gridProperties: { rowCount: 1000, columnCount: columnCount ?? 26 },
      ...(hidden ? { hidden } : {}),
    },
    ...rest,
  }
}

/** Source Quick Checklist header (6.01 layout: block at E, 15 columns) rows 1–10. */
function sourceQuickGrid(): GridData {
  const rows: CellData[][] = []
  for (let rowIndex = 0; rowIndex < 10; rowIndex++)
    rows.push(
      Array.from({ length: 15 }, (_, colIndex) =>
        rowIndex === 0 && colIndex === 0
          ? str('POKEROGUE DEX 6.01', fmt('title'))
          : { userEnteredFormat: fmt(`r${rowIndex}c${colIndex}`) },
      ),
    )
  // Row 1 block E..O: my stat formulas
  for (let colIndex = 4; colIndex < 15; colIndex++)
    rows[0]![colIndex] = formula(
      `=COUNTIF(${String.fromCharCode(65 + colIndex)}12:${String.fromCharCode(65 + colIndex)},"☑")`,
      '572',
    )
  // Row 10: "Stats:" in D, numbers in the block, a cross-sheet formula in A
  rows[9]![0] = formula("='STATIC:VERSION'!A1", 'x')
  rows[9]![3] = str('Stats:')
  for (let colIndex = 4; colIndex < 15; colIndex++)
    rows[9]![colIndex] = formula(`=E1+$A$10`, '1')
  return grid(0, 0, rows, {
    rowMetadata: Array.from({ length: 10 }, (_, rowIndex) => ({
      pixelSize: 20 + rowIndex,
      ...(rowIndex === 2 ? { hiddenByUser: true } : {}),
    })),
    columnMetadata: Array.from({ length: 15 }, (_, colIndex) => ({
      pixelSize: 100 + colIndex,
    })),
  })
}

/** Destination Quick Checklist header rows 1–10 for a FRESH 6.03 copy (junk E, block at F, 16 columns). */
function freshDestQuickGrid(): GridData {
  const rows: CellData[][] = []
  for (let rowIndex = 0; rowIndex < 10; rowIndex++)
    rows.push(Array.from({ length: 16 }, () => empty()))
  rows[0]![0] = str('POKEROGUE DEX 6.01')
  rows[9]![3] = str('Stats (out of 572):')
  for (let colIndex = 5; colIndex < 16; colIndex++) rows[9]![colIndex] = num(0)
  return grid(0, 0, rows)
}

/** Destination Quick Checklist that was already migrated (block at F, "Stats:" at D10). */
function migratedDestQuickGrid(): GridData {
  const migratedGrid = freshDestQuickGrid()
  migratedGrid.rowData![9]!.values![3] = str('Stats:')
  migratedGrid.rowData![0]!.values![0] = str('POKEROGUE DEX 6.03')
  return migratedGrid
}

/** The creator's AG3 on Daily Mode Unlocks. */
const CREATOR_AG_FORMULA =
  '=ArrayFormula(IF(M3:M="",, "w" & M3:M & " " & P3:P))'

/** The repo's AG3 as Sheets might hand it back: sheet names requoted and recased, lines reflowed. */
const REQUOTED_AG_FORMULA = DAILY_UNLOCKS_AG3_FORMULA.replaceAll(
  'DAILY_MODE.data!',
  "'DAILY_MODE.DATA'!",
).replaceAll('\n  ', '\n')

/** Daily Unlock Map E2:I2 holding one formula per column, starting at E2. */
function unlockMapFormulaGrid(
  formulaFor: (column: number, biomeColumn: string) => string,
): GridData {
  return grid(1, 4, [
    UNLOCK_MAP_FORMULA_COLUMNS.map(({ column, biomeColumn }) =>
      formula(formulaFor(column, biomeColumn)),
    ),
  ])
}

/** The creator's map formula: biome names only, from the same biome column as ours. */
const creatorMapFormula = (_column: number, biomeColumn: string): string =>
  `=BYROW(${unlockMapBiomeRange(biomeColumn)}, LAMBDA(biome, IF(biome="",, biome)))`

/** The creator's D2:L2 filter checkboxes on Daily Mode Unlocks, some unchecked. */
const CREATOR_FILTERS = [
  true,
  true,
  false,
  true,
  true,
  false,
  true,
  true,
  false,
]
const ALL_FILTERS_CHECKED = DAILY_UNLOCKS_FILTER_LABELS.map(() => true)

/**
 * Daily Mode Unlocks A1:AG3: the header landmarks in rows 1-2, the filter
 * headers over their checkboxes in D1:L2, the map-string formula at AG3.
 */
function dailyUnlocksHeaderGrid(
  agFormula: string,
  filtersChecked: boolean[],
): GridData {
  const rows: CellData[][] = Array.from({ length: 3 }, () =>
    Array.from({ length: 33 }, () => empty()),
  )
  for (const landmark of DAILY_UNLOCKS_LANDMARKS)
    rows[landmark.row - 1]![landmark.column - 1] = str(landmark.label)
  DAILY_UNLOCKS_FILTER_LABELS.forEach((label, offset) => {
    const columnIndex = DAILY_UNLOCKS_FILTER_FIRST_COLUMN - 1 + offset
    rows[DAILY_UNLOCKS_FILTER_ROW - 2]![columnIndex] = str(label)
    rows[DAILY_UNLOCKS_FILTER_ROW - 1]![columnIndex] = checkbox(
      filtersChecked[offset]!,
    )
  })
  rows[2]![32] = formula(agFormula)
  return grid(0, 0, rows)
}

/** Daily Mode H2:L6: the two "Override wave numbers" headers and the waves under them. */
function dailyModeOverrideGrid(
  abilityOverrides: CellData[],
  shinyOverrides: CellData[],
): GridData {
  const rows: CellData[][] = Array.from({ length: 5 }, () =>
    Array.from({ length: 5 }, () => empty()),
  )
  rows[0]![0] = str('Override wave numbers') // H2
  rows[0]![4] = str('Override wave numbers') // L2
  for (let rowOffset = 0; rowOffset < 4; rowOffset++) {
    rows[rowOffset + 1]![0] = abilityOverrides[rowOffset] ?? empty()
    rows[rowOffset + 1]![4] = shinyOverrides[rowOffset] ?? empty()
  }
  return grid(1, 7, rows)
}

function source(): SourceInfo {
  return {
    meta: {
      sheets: [
        sheet('Quick Checklist', 1, { columnCount: 15 }),
        sheet('Daily Mode', 2),
        sheet('newJSON', 3, { hidden: true }),
        sheet('IMPORT:data.SPECIES', 4, { hidden: true }),
        sheet('_snapshot_QuickChecklist', 5, { hidden: true }),
        sheet('Daily Mode Unlocks', 6, { columnCount: 40 }),
        sheet('Daily Unlock Map', 7, { columnCount: 10 }),
      ],
    },
    grid: {
      sheets: [
        sheet('Quick Checklist', 1, {
          columnCount: 15,
          data: [sourceQuickGrid()],
        }),
        sheet('Daily Mode Unlocks', 6, {
          columnCount: 40,
          data: [grid(2, 32, [[formula(DAILY_UNLOCKS_AG3_FORMULA)]])],
        }),
        sheet('Daily Unlock Map', 7, {
          columnCount: 10,
          data: [unlockMapFormulaGrid(unlockMapColumnFormula)],
        }),
      ],
    },
  }
}

function freshDest(): DestInfo {
  return {
    meta: {
      sheets: [
        sheet('Quick Checklist', 11, {
          columnCount: 16,
          bandedRanges: [
            {
              bandedRangeId: 7,
              range: {
                sheetId: 11,
                startRowIndex: 11,
                endRowIndex: 700,
                startColumnIndex: 2,
                endColumnIndex: 16,
              },
            },
          ],
        }),
        sheet('Daily Mode', 12),
        sheet('newJSON', 13),
        sheet('IMPORT:data.SPECIES', 14, { hidden: true }),
        sheet('Starter DEX Checklist', 15, {
          conditionalFormats: [
            {
              ranges: [
                {
                  sheetId: 15,
                  startRowIndex: 3,
                  endRowIndex: 700,
                  startColumnIndex: 0,
                  endColumnIndex: 1,
                },
              ],
              booleanRule: { condition: { type: 'NOT_BLANK' }, format: {} },
            },
            {
              ranges: [
                {
                  sheetId: 15,
                  startRowIndex: 3,
                  endRowIndex: 700,
                  startColumnIndex: 21,
                  endColumnIndex: 27,
                },
                {
                  sheetId: 15,
                  startRowIndex: 3,
                  endRowIndex: 700,
                  startColumnIndex: 30,
                  endColumnIndex: 31,
                },
              ],
              booleanRule: {
                condition: {
                  type: 'TEXT_EQ',
                  values: [{ userEnteredValue: '31' }],
                },
                format: { backgroundColor: { red: 1, green: 1 } },
              },
            },
          ],
        }),
        sheet('Full DEX Checklist', 16, {
          conditionalFormats: [
            {
              ranges: [
                {
                  sheetId: 16,
                  startRowIndex: 3,
                  endRowIndex: 1200,
                  startColumnIndex: 21,
                  endColumnIndex: 27,
                },
              ],
              booleanRule: {
                condition: {
                  type: 'NUMBER_EQ',
                  values: [{ userEnteredValue: '31' }],
                },
                format: {},
              },
            },
          ],
        }),
        sheet('Daily Unlock Map', 17, { columnCount: 10 }),
        sheet('Daily Mode Unlocks', 18, { columnCount: 40 }),
      ],
    },
    grid: {
      sheets: [
        sheet('Quick Checklist', 11, {
          columnCount: 16,
          data: [freshDestQuickGrid()],
        }),
        sheet('Daily Mode Unlocks', 18, {
          columnCount: 40,
          data: [dailyUnlocksHeaderGrid(CREATOR_AG_FORMULA, CREATOR_FILTERS)],
        }),
        ...lookupSheets(),
        sheet('Daily Unlock Map', 17, {
          columnCount: 10,
          data: [unlockMapFormulaGrid(creatorMapFormula)],
        }),
        sheet('Daily Mode', 12, {
          data: [dailyModeOverrideGrid([num(15), empty(), num(42)], [num(23)])],
        }),
      ],
    },
  }
}

/** The header row of each sheet AG3 looks up, as read for the landmark check. */
function lookupSheets(): SheetInfo[] {
  return AG3_LOOKUP_SHEETS.map((lookup, lookupIndex) => {
    const headerRow = Array.from({ length: lookup.lastColumn }, () => empty())
    for (const landmark of lookup.landmarks)
      headerRow[landmark.column - 1] = str(landmark.label)
    return sheet(lookup.title, 20 + lookupIndex, {
      columnCount: lookup.lastColumn,
      data: [grid(lookup.headerRow - 1, 0, [headerRow])],
    })
  })
}

function migratedDest(): DestInfo {
  const dest = freshDest()
  dest.grid.sheets![0]!.data = [migratedDestQuickGrid()]
  dest.meta.sheets![0]!.bandedRanges = [
    {
      bandedRangeId: 7,
      range: {
        sheetId: 11,
        startRowIndex: 11,
        endRowIndex: 700,
        startColumnIndex: 1,
        endColumnIndex: 16,
      },
    },
  ]
  dest.meta.sheets![3]!.properties.hidden = true
  dest.meta.sheets![2]!.properties.hidden = true
  dest.meta.sheets![4]!.conditionalFormats = [
    dest.meta.sheets![4]!.conditionalFormats![0]!,
  ]
  dest.meta.sheets![5]!.conditionalFormats = []
  dest.meta.sheets![6]!.conditionalFormats = [
    ['=REGEXMATCH(E2, "\\([A-Z]")', { red: 0.72, green: 0.88, blue: 0.8 }],
    ['=REGEXMATCH(E2, "\\[[A-Z]")', { red: 0.98, green: 0.8, blue: 0.61 }],
  ].map(([formula, backgroundColor]) => ({
    ranges: [
      {
        sheetId: 17,
        startRowIndex: 1,
        endRowIndex: 1000,
        startColumnIndex: 4,
        endColumnIndex: 10,
      },
    ],
    booleanRule: {
      condition: {
        type: 'CUSTOM_FORMULA',
        values: [{ userEnteredValue: formula as string }],
      },
      format: { backgroundColor: backgroundColor as Record<string, number> },
    },
  }))
  dest.grid.sheets![1]!.data = [
    dailyUnlocksHeaderGrid(REQUOTED_AG_FORMULA, ALL_FILTERS_CHECKED),
  ]
  dest.grid.sheets![4]!.data = [unlockMapFormulaGrid(unlockMapColumnFormula)]
  dest.grid.sheets![5]!.data = [dailyModeOverrideGrid([], [])]
  // Tabs already in the source's order, with the creator's DEX sheets in place.
  const tabOrder = [
    'Quick Checklist',
    'Daily Mode',
    'newJSON',
    'IMPORT:data.SPECIES',
    'Starter DEX Checklist',
    'Full DEX Checklist',
    'Daily Mode Unlocks',
    'Daily Unlock Map',
  ]
  for (const sheetInfo of dest.meta.sheets!)
    sheetInfo.properties.index = tabOrder.indexOf(sheetInfo.properties.title)
  return dest
}

const requestsOfKind = (
  ops: { requests: Request[] }[],
  kind: string,
): Request[] =>
  ops.flatMap((op) => op.requests).filter((request) => kind in request)

// ---------------------------------------------------------------------------

test('fresh 6.03 copy: block shifted +1, banding/CF handled, Daily Mode overrides cleared', () => {
  const { ops, notes } = buildPlan(source(), freshDest(), '6.03')
  const labels = ops.map((op) => op.label)
  assert.deepEqual(labels, [
    'Quick Checklist header (rows 1–10)',
    'Quick Checklist title',
    'Quick Checklist banding over the image column',
    'Hide 1 sheet(s)',
    'Sheet order: match the previous version',
    'Starter DEX Checklist: IV highlight → red when not 31',
    'Full DEX Checklist: IV highlight → red when not 31',
    'Daily Unlock Map: highlight cells with a marker',
    'Daily Mode Unlocks: AG3 formula',
    'Daily Mode Unlocks: D2:L2 filters',
    'Daily Mode: clear wave overrides',
    'Daily Unlock Map: column formulas',
  ])
  assert.deepEqual(notes, [])

  // Daily Unlock Map: the repo's formula replaces the creator's in each of E2:I2.
  const mapWrites = requestsOfKind(ops, 'updateCells')
    .map(
      (request) =>
        request['updateCells'] as {
          range: GridRange
          rows: { values: CellData[] }[]
        },
    )
    .filter((write) => write.range.sheetId === 17)
  assert.deepEqual(
    mapWrites.map((write) => [
      write.range.startRowIndex,
      write.range.startColumnIndex,
      write.rows[0]!.values[0]!.userEnteredValue!.formulaValue,
    ]),
    UNLOCK_MAP_FORMULA_COLUMNS.map(({ column, biomeColumn }) => [
      1,
      column - 1,
      unlockMapColumnFormula(column, biomeColumn),
    ]),
  )
  assert.match(
    unlockMapColumnFormula(6, 'AG'),
    /^=BYROW\(DAILY_MODE_MAP\.data!AG2:AG, [\s\S]*firstWave, F1,\n {2}nextWave, F1 \+ 10,[\s\S]*"\^w\(\\d\+\)"/,
    'each column reads its own biome column and header cell; the wave regex keeps its backslash',
  )

  // Daily Mode Unlocks: the repo's AG3 formula replaces the creator's, and
  // every D2:L2 filter is checked; nothing else on that sheet.
  const unlocksWrites = requestsOfKind(ops, 'updateCells')
    .map(
      (request) =>
        request['updateCells'] as {
          range: GridRange
          rows: { values: CellData[] }[]
          fields: string
        },
    )
    .filter((write) => write.range.sheetId === 18)
  assert.equal(unlocksWrites.length, 2)
  assert.deepEqual(unlocksWrites[0]!.range, {
    sheetId: 18,
    startRowIndex: 2,
    endRowIndex: 3,
    startColumnIndex: 32,
    endColumnIndex: 33,
  })
  assert.equal(unlocksWrites[0]!.fields, 'userEnteredValue')
  assert.equal(
    unlocksWrites[0]!.rows[0]!.values[0]!.userEnteredValue!.formulaValue,
    DAILY_UNLOCKS_AG3_FORMULA,
  )
  assert.deepEqual(unlocksWrites[1]!.range, {
    sheetId: 18,
    startRowIndex: 1,
    endRowIndex: 2,
    startColumnIndex: 3,
    endColumnIndex: 12,
  })
  assert.equal(unlocksWrites[1]!.fields, 'userEnteredValue')
  assert.deepEqual(
    unlocksWrites[1]!.rows[0]!.values.map((cell) => cell.userEnteredValue),
    Array.from({ length: 9 }, () => ({ boolValue: true })),
  )

  // Unlock map: the unlock rule at index 0, the charm rule under it, both over
  // E2 to the grid's end.
  const unlockMapRules = requestsOfKind(ops, 'addConditionalFormatRule')
    .map(
      (request) =>
        request['addConditionalFormatRule'] as {
          index: number
          rule: {
            ranges: GridRange[]
            booleanRule: {
              condition: {
                type: string
                values: { userEnteredValue: string }[]
              }
              format: { backgroundColor: Record<string, number> }
            }
          }
        },
    )
    .filter(({ rule }) => rule.ranges[0]!.sheetId === 17)
  assert.equal(unlockMapRules.length, 2)
  const [unlockMapRule, charmRule] = unlockMapRules as [
    (typeof unlockMapRules)[number],
    (typeof unlockMapRules)[number],
  ]
  assert.equal(unlockMapRule.index, 0)
  assert.equal(charmRule.index, 1)
  for (const { rule } of unlockMapRules) {
    assert.deepEqual(rule.ranges, [
      {
        sheetId: 17,
        startRowIndex: 1,
        endRowIndex: 1000,
        startColumnIndex: 4,
        endColumnIndex: 10,
      },
    ])
    assert.equal(rule.booleanRule.condition.type, 'CUSTOM_FORMULA')
  }
  assert.equal(
    unlockMapRule.rule.booleanRule.condition.values[0]!.userEnteredValue,
    '=REGEXMATCH(E2, "\\([A-Z]")',
  )
  assert.equal(
    charmRule.rule.booleanRule.condition.values[0]!.userEnteredValue,
    '=REGEXMATCH(E2, "\\[[A-Z]")',
  )
  assert.ok(
    unlockMapRule.rule.booleanRule.format.backgroundColor['green']! >
      unlockMapRule.rule.booleanRule.format.backgroundColor['red']!,
    'unlock tint is green',
  )
  assert.ok(
    charmRule.rule.booleanRule.format.backgroundColor['red']! >
      charmRule.rule.booleanRule.format.backgroundColor['green']! &&
      charmRule.rule.booleanRule.format.backgroundColor['green']! >
        charmRule.rule.booleanRule.format.backgroundColor['blue']!,
    'charm tint is orange',
  )

  // Quick Checklist: ported up to the block end (E..O = 15) + offset 1 = 16 needed; dest has 16 → no append.
  assert.equal(requestsOfKind(ops, 'appendDimension').length, 0)
  const autoFit = requestsOfKind(ops, 'autoResizeDimensions').map(
    (request) =>
      (
        request['autoResizeDimensions'] as {
          dimensions: { startIndex: number }
        }
      ).dimensions.startIndex,
  )
  assert.deepEqual(
    autoFit,
    [1],
    'the default-height, non-hidden source row is auto-fitted',
  )
  const cellWrites = requestsOfKind(ops, 'updateCells').map(
    (request) =>
      request['updateCells'] as {
        range: Record<string, number>
        rows: { values: CellData[] }[]
        fields: string
      },
  )
  // Row 1 block: written at F..P (0-based 5..16), formulas shifted E→F.
  const row1 = cellWrites.find(
    (write) =>
      write.fields === 'userEnteredValue' &&
      write.range['startRowIndex'] === 0 &&
      write.range['startColumnIndex'] === 5,
  )!
  assert.equal(row1.range['endColumnIndex'], 16)
  assert.equal(
    row1.rows[0]!.values[0]!.userEnteredValue!.formulaValue,
    '=COUNTIF(F12:F,"☑")',
  )
  // Row 10 left segment (A–D) written in place; A10 cross-sheet formula unchanged; block segment shifted; $A$10 stays.
  const row10left = cellWrites.find(
    (write) =>
      write.fields === 'userEnteredValue' &&
      write.range['startRowIndex'] === 9 &&
      write.range['startColumnIndex'] === 0,
  )!
  assert.equal(
    row10left.rows[0]!.values[0]!.userEnteredValue!.formulaValue,
    "='STATIC:VERSION'!A1",
  )
  const row10block = cellWrites.find(
    (write) =>
      write.fields === 'userEnteredValue' &&
      write.range['startRowIndex'] === 9 &&
      write.range['startColumnIndex'] === 5,
  )!
  assert.equal(
    row10block.rows[0]!.values[0]!.userEnteredValue!.formulaValue,
    '=F1+$A$10',
  )
  // Formats: two segments, A–D in place and E..O → F..P, 10 rows each, padded to full width.
  const formatWrites = cellWrites.filter(
    (write) =>
      write.fields === 'userEnteredFormat' && write.range['endRowIndex'] === 10,
  )
  assert.deepEqual(
    formatWrites.map((write) => [
      write.range['startColumnIndex'],
      write.range['endColumnIndex'],
    ]),
    [
      [0, 4],
      [5, 16],
    ],
  )
  assert.equal(formatWrites[1]!.rows.length, 10)
  assert.equal(formatWrites[1]!.rows[0]!.values.length, 11)
  // Ribbons hidden at P (0-based 15); widths mapped with the offset; row 3 hidden.
  const dimensionUpdates = requestsOfKind(ops, 'updateDimensionProperties').map(
    (request) =>
      request['updateDimensionProperties'] as {
        range: Record<string, unknown>
        properties: Record<string, unknown>
        fields: string
      },
  )
  assert.ok(
    dimensionUpdates.some(
      (update) =>
        update.range['dimension'] === 'COLUMNS' &&
        update.range['startIndex'] === 15 &&
        update.properties['hiddenByUser'] === true &&
        update.fields === 'hiddenByUser',
    ),
  )
  assert.ok(
    dimensionUpdates.some(
      (update) =>
        update.range['dimension'] === 'COLUMNS' &&
        update.range['startIndex'] === 5 &&
        update.properties['pixelSize'] === 104,
    ),
    'source E width lands on F',
  )
  assert.ok(
    dimensionUpdates.some(
      (update) =>
        update.range['dimension'] === 'ROWS' &&
        update.range['startIndex'] === 2 &&
        update.properties['hiddenByUser'] === true,
    ),
  )
  // Title stamped with the DEST version.
  const title = cellWrites.find(
    (write) =>
      write.range['startRowIndex'] === 0 &&
      write.range['endColumnIndex'] === 1 &&
      write.range['startColumnIndex'] === 0 &&
      write.rows[0]!.values[0]!.userEnteredValue?.stringValue,
  )!
  assert.equal(
    title.rows[0]!.values[0]!.userEnteredValue!.stringValue,
    'POKEROGUE DEX 6.03',
  )
  // Banding extended left to B and B fills cleared.
  const band = requestsOfKind(ops, 'updateBanding')[0]!['updateBanding'] as {
    bandedRange: { range: Record<string, number> }
  }
  assert.equal(band.bandedRange.range['startColumnIndex'], 1)
  assert.equal(requestsOfKind(ops, 'repeatCell').length, 1)
  // Daily Mode (sheet 12): only the values of the wave overrides that hold
  // any are cleared, formats kept; nothing else on that sheet.
  const dailyModeOp = ops.find(
    (op) => op.label === 'Daily Mode: clear wave overrides',
  )!
  assert.equal(dailyModeOp.note, 'H3:H6, L3:L6')
  assert.deepEqual(dailyModeOp.requests, [
    {
      updateCells: {
        range: {
          sheetId: 12,
          startRowIndex: 2,
          endRowIndex: 6,
          startColumnIndex: 7,
          endColumnIndex: 8,
        },
        fields: 'userEnteredValue',
      },
    },
    {
      updateCells: {
        range: {
          sheetId: 12,
          startRowIndex: 2,
          endRowIndex: 6,
          startColumnIndex: 11,
          endColumnIndex: 12,
        },
        fields: 'userEnteredValue',
      },
    },
  ])
  assert.ok(
    !ops.some(
      (op) =>
        op !== dailyModeOp &&
        /"sheetId":12\b/.test(JSON.stringify(op.requests)),
    ),
    'no other request touches Daily Mode',
  )
  // Hidden sheets: newJSON gets hidden; IMPORT already hidden; _snapshot_ has no counterpart.
  const hide = requestsOfKind(ops, 'updateSheetProperties').filter(
    (request) =>
      (request['updateSheetProperties'] as { fields: string }).fields ===
      'hidden',
  )
  assert.equal(hide.length, 1)
  assert.equal(
    (hide[0]!['updateSheetProperties'] as { properties: { sheetId: number } })
      .properties.sheetId,
    13,
  )
  // Sheet order: the source has Daily Mode Unlocks before the map, the fresh
  // copy after it, so Daily Mode Unlocks moves left one tab.
  const orderOp = ops.find(
    (op) => op.label === 'Sheet order: match the previous version',
  )!
  assert.equal(orderOp.note, 'moved Daily Mode Unlocks')
  assert.deepEqual(orderOp.requests, [
    {
      updateSheetProperties: {
        properties: { sheetId: 18, index: 6 },
        fields: 'index',
      },
    },
  ])
  // IV: Starter rule index 1 (2 ranges) → delete 1 + add 2; Full rule index 0 (1 range) → delete 1 + add 1.
  // The unlock map's own added rule (sheet 17) is checked above.
  assert.equal(requestsOfKind(ops, 'deleteConditionalFormatRule').length, 2)
  const addedRules = requestsOfKind(ops, 'addConditionalFormatRule')
    .map(
      (request) =>
        request['addConditionalFormatRule'] as {
          index: number
          rule: {
            ranges: Record<string, number>[]
            booleanRule: {
              condition: { values: { userEnteredValue: string }[] }
            }
          }
        },
    )
    .filter((added) => added.rule.ranges[0]!['sheetId'] !== 17)
  assert.equal(addedRules.length, 3)
  assert.deepEqual(
    addedRules.map((added) => added.index),
    [1, 2, 0],
  )
  assert.equal(
    addedRules[0]!.rule.booleanRule.condition.values[0]!.userEnteredValue,
    '=TO_TEXT(V4)<>"31"',
  )
  assert.equal(
    addedRules[1]!.rule.booleanRule.condition.values[0]!.userEnteredValue,
    '=TO_TEXT(AE4)<>"31"',
  )

  assert.match(
    describePlan({
      sourceSpreadsheetId: 's',
      destSpreadsheetId: 'd',
      sourceVersion: '6.01',
      destVersion: '6.03',
      ops,
      notes,
    }),
    /formulas shifted right by 1/,
  )
})

test('already-migrated destination: idempotent plan (banding/CF already done)', () => {
  const { ops, notes } = buildPlan(source(), migratedDest(), '6.03')
  assert.equal(requestsOfKind(ops, 'deleteConditionalFormatRule').length, 0)
  assert.equal(requestsOfKind(ops, 'updateBanding').length, 0)
  assert.equal(
    requestsOfKind(ops, 'repeatCell').length,
    1,
    'B fills still cleared',
  )
  assert.equal(requestsOfKind(ops, 'updateSheetProperties').length, 0)
  const quickChecklistOp = ops[0]!
  // The source block is at E (5) and the migrated dest at F (6): still a +1 shift of the SOURCE formulas.
  assert.match(
    quickChecklistOp.note!,
    /source block at column 5, destination at 6/,
  )
  const row1 = quickChecklistOp.requests.find(
    (request) =>
      (
        request['updateCells'] as {
          fields: string
          range: { startRowIndex: number }
        }
      )?.fields === 'userEnteredValue' &&
      (request['updateCells'] as { range: { startRowIndex: number } }).range
        .startRowIndex === 0,
  )!['updateCells'] as { rows: { values: CellData[] }[] }
  assert.equal(
    row1.rows[0]!.values[0]!.userEnteredValue!.formulaValue,
    '=COUNTIF(F12:F,"☑")',
  )
  assert.ok(
    notes.some((note) =>
      note.includes('no "= 31" rule on "Starter DEX Checklist"'),
    ),
  )
  assert.ok(
    notes.some((note) => note.startsWith('Hidden sheets: nothing to hide')),
  )
  assert.equal(requestsOfKind(ops, 'addConditionalFormatRule').length, 0)
  assert.ok(
    notes.some((note) =>
      note.startsWith('Unlock map highlight: rules already present'),
    ),
  )
  // The tracked formulas already match the repo's, AG3 despite its requoted sheet names.
  assert.ok(
    notes.includes(
      "Daily Mode Unlocks: AG3 formula already matching the repo's",
    ),
  )
  assert.ok(
    notes.includes(
      "Daily Unlock Map: E2:I2 formulas already matching the repo's",
    ),
  )
  assert.ok(
    notes.includes('Daily Mode Unlocks: D2:L2 filters already all checked'),
  )
  assert.ok(
    notes.includes('Daily Mode: H3:H6 and L3:L6 overrides already empty'),
  )
  assert.ok(
    notes.includes('Sheet order: already matching the previous version'),
  )
  assert.equal(
    requestsOfKind(ops, 'updateCells').filter((request) =>
      [17, 18].includes(
        (request['updateCells'] as { range: GridRange }).range.sheetId,
      ),
    ).length,
    0,
  )
})

test("tracked formulas: the repo's copy is written, and a source that differs is noted", () => {
  const editedSource = source()
  editedSource.grid.sheets![1]!.data = [grid(2, 32, [[formula('=1')]])]
  editedSource.grid.sheets![2]!.data = [
    unlockMapFormulaGrid((column, biomeColumn) =>
      column === 6 ? '=2' : unlockMapColumnFormula(column, biomeColumn),
    ),
  ]
  const { ops, notes } = buildPlan(editedSource, migratedDest(), '6.03')
  assert.deepEqual(
    notes.filter((note) => note.includes('differs from the repo')),
    [
      "Daily Mode Unlocks: AG3 in the source differs from the repo's copy in trackedFormulas.ts, which is what gets written; copy the source's into the repo first to keep its changes",
      "Daily Unlock Map: F2 in the source differs from the repo's copy in trackedFormulas.ts, which is what gets written; copy the source's into the repo first to keep its changes",
    ],
  )
  assert.ok(
    !ops.some((op) =>
      [
        'Daily Mode Unlocks: AG3 formula',
        'Daily Unlock Map: column formulas',
      ].includes(op.label),
    ),
    "a destination already holding the repo's copies is left alone",
  )

  // A destination differing in one map cell gets only that cell.
  const oneCellStale = migratedDest()
  oneCellStale.grid.sheets![4]!.data = [
    unlockMapFormulaGrid((column, biomeColumn) =>
      column === 8
        ? creatorMapFormula(column, biomeColumn)
        : unlockMapColumnFormula(column, biomeColumn),
    ),
  ]
  const mapOp = buildPlan(source(), oneCellStale, '6.03').ops.find(
    (op) => op.label === 'Daily Unlock Map: column formulas',
  )!
  assert.equal(mapOp.note, "H2 from the repo's copy")
  assert.equal(mapOp.requests.length, 1)

  // A source without the tracked sheets plans the same, with nothing to compare.
  const sourceWithoutSheets = source()
  sourceWithoutSheets.grid.sheets = sourceWithoutSheets.grid.sheets!.filter(
    (sheetInfo) =>
      !['Daily Mode Unlocks', 'Daily Unlock Map'].includes(
        sheetInfo.properties.title,
      ),
  )
  const withoutSheetsPlan = buildPlan(sourceWithoutSheets, freshDest(), '6.03')
  assert.deepEqual(withoutSheetsPlan.notes, [])
  assert.ok(
    withoutSheetsPlan.ops.some(
      (op) => op.label === 'Daily Mode Unlocks: AG3 formula',
    ),
  )

  // A destination without the map sheet skips its formulas.
  const withoutMap = freshDest()
  withoutMap.meta.sheets = withoutMap.meta.sheets!.filter(
    (sheetInfo) => sheetInfo.properties.title !== 'Daily Unlock Map',
  )
  withoutMap.grid.sheets = withoutMap.grid.sheets!.filter(
    (sheetInfo) => sheetInfo.properties.title !== 'Daily Unlock Map',
  )
  assert.ok(
    buildPlan(source(), withoutMap, '6.03').notes.includes(
      'Unlock map formulas: "Daily Unlock Map" not found, skipping',
    ),
  )
})

test('a 6.03 → 6.03 port (same layout, block at F in both) needs no formula shift', () => {
  const src = source()
  const migratedQuickGrid = migratedDestQuickGrid()
  // Give the source the migrated 6.03 header (block at F) with formulas referencing F.
  migratedQuickGrid.rowData![0]!.values![5] = formula('=COUNTIF(F12:F,"☑")')
  src.grid.sheets![0]!.data = [migratedQuickGrid]
  src.meta.sheets![0]!.properties.gridProperties!.columnCount = 16
  const ops = planQuickChecklist(src, migratedDest(), '6.03')
  const row1 = ops[0]!.requests.find(
    (request) =>
      (
        request['updateCells'] as {
          fields: string
          range: { startRowIndex: number }
        }
      )?.fields === 'userEnteredValue' &&
      (request['updateCells'] as { range: { startRowIndex: number } }).range
        .startRowIndex === 0,
  )!['updateCells'] as { rows: { values: CellData[] }[] }
  assert.equal(
    row1.rows[0]!.values[0]!.userEnteredValue!.formulaValue,
    '=COUNTIF(F12:F,"☑")',
  )
})

/**
 * Apply index moves the way the Sheets API does: the requested index counts
 * positions before the move, so a sheet moving right lands one left of it.
 */
function applyIndexMoves(order: number[], requests: Request[]): number[] {
  const result = [...order]
  for (const request of requests) {
    const { sheetId, index } = (
      request['updateSheetProperties'] as {
        properties: { sheetId: number; index: number }
      }
    ).properties
    const fromIndex = result.indexOf(sheetId)
    result.splice(fromIndex, 1)
    result.splice(index > fromIndex ? index - 1 : index, 0, sheetId)
  }
  return result
}

test('sheet order: shared tabs follow the source, tabs only in the new copy stay put', () => {
  const sheetsTitled = (titles: string[], firstSheetId: number): SheetInfo[] =>
    titles.map((title, offset) => sheet(title, firstSheetId + offset))
  const sourceInfo: SourceInfo = {
    meta: {
      sheets: sheetsTitled(
        [
          'Daily Mode',
          'Quick Checklist',
          'Party Checklist',
          'My Notes',
          'Full DEX Checklist',
          'Starter DEX Checklist',
        ],
        1,
      ),
    },
    grid: {},
  }
  const destSheets = sheetsTitled(
    [
      'Quick Checklist',
      'Starter DEX Checklist',
      'Full DEX Checklist',
      'Daily Mode',
      'Creator New Sheet',
      'Party Checklist',
    ],
    11,
  )
  destSheets.forEach((sheetInfo, tabIndex) => {
    sheetInfo.properties.index = tabIndex
  })
  // The API's sheet list order is not relied on; the index property is.
  const destInfo: DestInfo = {
    meta: { sheets: [...destSheets].reverse() },
    grid: {},
  }

  const { 0: orderOp } = planSheetOrder(sourceInfo, destInfo, [])
  const titleOf = new Map(
    destSheets.map((sheetInfo) => [
      sheetInfo.properties.sheetId,
      sheetInfo.properties.title,
    ]),
  )
  const finalOrder = applyIndexMoves(
    destSheets.map((sheetInfo) => sheetInfo.properties.sheetId),
    orderOp!.requests,
  ).map((sheetId) => titleOf.get(sheetId))
  assert.deepEqual(finalOrder, [
    'Daily Mode',
    'Quick Checklist',
    'Party Checklist',
    'Full DEX Checklist',
    'Creator New Sheet',
    'Starter DEX Checklist',
  ])
  assert.equal(
    orderOp!.note,
    'moved Daily Mode, Party Checklist, Full DEX Checklist, Creator New Sheet',
  )

  // Planning again on the reordered copy changes nothing.
  const reorderedSheets = finalOrder.map((title) =>
    destSheets.find((sheetInfo) => sheetInfo.properties.title === title)!,
  )
  reorderedSheets.forEach((sheetInfo, tabIndex) => {
    sheetInfo.properties.index = tabIndex
  })
  const notes: string[] = []
  assert.deepEqual(
    planSheetOrder(
      sourceInfo,
      { meta: { sheets: reorderedSheets }, grid: {} },
      notes,
    ),
    [],
  )
  assert.deepEqual(notes, [
    'Sheet order: already matching the previous version',
  ])
})

test('planning refuses unknown layouts before anything is written', () => {
  const blankRow10 = freshDest()
  blankRow10.grid.sheets![0]!.data![0]!.rowData![9]!.values = Array.from(
    { length: 16 },
    () => empty(),
  )
  assert.throws(
    () => buildPlan(source(), blankRow10, '6.03'),
    /Quick Checklist \(destination\): row 10 is blank/,
  )

  const blockLeft = freshDest()
  blockLeft.grid.sheets![0]!.data![0]!.rowData![9]!.values![4] = num(1) // dest block at E, source at E → offset 0 fine; make dest at D? D is fixed; move source right instead
  const srcRight = source()
  srcRight.grid.sheets![0]!.data![0]!.rowData![9]!.values![4] = empty()
  srcRight.grid.sheets![0]!.data![0]!.rowData![9]!.values![5] = empty()
  srcRight.grid.sheets![0]!.data![0]!.rowData![9]!.values![6] = num(1) // source block at G, dest at F
  assert.throws(
    () => buildPlan(srcRight, freshDest(), '6.03'),
    /left of the source's/,
  )

  // Daily Mode Unlocks: a moved header, or no formula at AG3, stops the port.
  const waveMoved = freshDest()
  waveMoved.grid.sheets![1]!.data![0]!.rowData![1]!.values![12] = str('Floor')
  assert.throws(
    () => buildPlan(source(), waveMoved, '6.03'),
    /Daily Mode Unlocks: expected "Wave" at M2 in the destination, found "Floor"/,
  )
  const noCreatorFormula = freshDest()
  noCreatorFormula.grid.sheets![1]!.data![0]!.rowData![2]!.values![32] =
    str('w13 Dartrix')
  assert.throws(
    () => buildPlan(source(), noCreatorFormula, '6.03'),
    /AG3 holds no formula in the destination/,
  )

  // Daily Mode Unlocks filters: a moved "New …" header, or a cell without a
  // checkbox under one, stops the port.
  const natureMoved = freshDest()
  natureMoved.grid.sheets![1]!.data![0]!.rowData![0]!.values![8] =
    str('New Moves')
  assert.throws(
    () => buildPlan(source(), natureMoved, '6.03'),
    /Daily Mode Unlocks: expected "New Nature" at I1 in the destination, found "New Moves"; layout changed, D2:L2 filters not checked/,
  )
  const filterNotCheckbox = freshDest()
  filterNotCheckbox.grid.sheets![1]!.data![0]!.rowData![1]!.values![11] =
    str('All')
  assert.throws(
    () => buildPlan(source(), filterNotCheckbox, '6.03'),
    /Daily Mode Unlocks: L2 holds no checkbox in the destination/,
  )

  // Daily Mode: a moved "Override wave numbers" header stops the port; a
  // destination without Daily Mode skips the clear with a note.
  const overrideHeaderMoved = freshDest()
  overrideHeaderMoved.grid.sheets![5]!.data![0]!.rowData![0]!.values![4] =
    str('Shiny Charm')
  assert.throws(
    () => buildPlan(source(), overrideHeaderMoved, '6.03'),
    /Daily Mode: expected "Override wave numbers" at L2 in the destination, found "Shiny Charm"; layout changed, H3:H6 and L3:L6 overrides not cleared/,
  )
  const withoutDailyMode = freshDest()
  withoutDailyMode.grid.sheets = withoutDailyMode.grid.sheets!.filter(
    (sheetInfo) => sheetInfo.properties.title !== 'Daily Mode',
  )
  assert.ok(
    buildPlan(source(), withoutDailyMode, '6.03').notes.includes(
      'Daily Mode overrides: "Daily Mode" not found, skipping',
    ),
  )

  // The sheets AG3 looks up: a moved header, or a missing sheet, stops the port too.
  const variantsMoved = freshDest()
  variantsMoved.grid.sheets![2]!.data![0]!.rowData![0]!.values![36] =
    str('hasForms')
  assert.throws(
    () => buildPlan(source(), variantsMoved, '6.03'),
    /STATIC:data\.SPECIES: expected "hasVariants" at AK1 in the destination, found "hasForms"/,
  )
  const ownedIvsMoved = freshDest()
  ownedIvsMoved.grid.sheets![3]!.data![0]!.rowData![0]!.values![26] = str('ATK')
  assert.throws(
    () => buildPlan(source(), ownedIvsMoved, '6.03'),
    /DAILY_MODE\.data: expected "HP" at AA1 in the destination, found "ATK"/,
  )
  const speciesIdMoved = freshDest()
  speciesIdMoved.grid.sheets![3]!.data![0]!.rowData![0]!.values![76] =
    str('Form ID')
  assert.throws(
    () => buildPlan(source(), speciesIdMoved, '6.03'),
    /DAILY_MODE\.data: expected "Species ID" at BY1 in the destination, found "Form ID"/,
  )
  const withoutLookupSheet = freshDest()
  withoutLookupSheet.grid.sheets = withoutLookupSheet.grid.sheets!.filter(
    (sheetInfo) => sheetInfo.properties.title !== 'DAILY_MODE.data',
  )
  assert.throws(
    () => buildPlan(source(), withoutLookupSheet, '6.03'),
    /"DAILY_MODE\.data" not found in the destination/,
  )

  // Daily Unlock Map: a cell without a formula, or listing another biome column, stops the port.
  const mapCellBlank = freshDest()
  mapCellBlank.grid.sheets![4]!.data![0]!.rowData![0]!.values![2] = empty()
  assert.throws(
    () => buildPlan(source(), mapCellBlank, '6.03'),
    /Daily Unlock Map: G2 holds no formula in the destination/,
  )
  const mapBiomesMoved = freshDest()
  mapBiomesMoved.grid.sheets![4]!.data = [
    unlockMapFormulaGrid((column, biomeColumn) =>
      creatorMapFormula(column, column === 5 ? 'AK' : biomeColumn),
    ),
  ]
  assert.throws(
    () => buildPlan(source(), mapBiomesMoved, '6.03'),
    /Daily Unlock Map: E2 does not list DAILY_MODE_MAP\.data!AF2:AF in the destination/,
  )
})

test('applyPlan sends every request in one batchUpdate to the destination', () => {
  const sent: { id: string; requests: Request[] }[] = []
  const client: SheetsClient = {
    get: () => ({}) as SpreadsheetInfo,
    batchUpdate: (id, requests) => sent.push({ id, requests }),
    valuesBatchGet: () => [],
    valuesBatchUpdate: () => {},
  }
  const { ops, notes } = buildPlan(source(), freshDest(), '6.03')
  applyPlan(
    {
      sourceSpreadsheetId: 's',
      destSpreadsheetId: 'dest-id',
      sourceVersion: '6.01',
      destVersion: '6.03',
      ops,
      notes,
    },
    client,
  )
  assert.equal(sent.length, 1)
  assert.equal(sent[0]!.id, 'dest-id')
  assert.equal(
    sent[0]!.requests.length,
    ops.reduce((total, op) => total + op.requests.length, 0),
  )
})
