import assert from 'node:assert/strict'
import { test } from 'node:test'
import './fake-gas.ts'
import {
  DAILY_UNLOCKS_LANDMARKS,
  type DestInfo,
  type SourceInfo,
  applyPlan,
  buildPlan,
  describePlan,
  planQuickChecklist,
  shiftMergeForColumnInsert,
  shiftMergeForRowInsert,
} from '../src/lib/migrator.ts'
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

const LANDMARK = 'Missing Gym Leader Voucher…'

/** The creator's AG3 on Daily Mode Unlocks, and ours with the category marker. */
const CREATOR_AG_FORMULA =
  '=ArrayFormula(IF(M3:M="",, "w" & M3:M & " " & P3:P))'
const USER_AG_FORMULA =
  '=ArrayFormula(IF(M3:M="",, "w" & M3:M & " " & P3:P & IF(D3:D<>"", " [Caught]", "")))'

/** Daily Mode Unlocks A1:AG3: the header landmarks in rows 1-2, the map-string formula at AG3. */
function dailyUnlocksHeaderGrid(agFormula: string): GridData {
  const rows: CellData[][] = Array.from({ length: 3 }, () =>
    Array.from({ length: 33 }, () => empty()),
  )
  for (const landmark of DAILY_UNLOCKS_LANDMARKS)
    rows[landmark.row - 1]![landmark.column - 1] = str(landmark.label)
  rows[2]![32] = formula(agFormula)
  return grid(0, 0, rows)
}

const range = (
  sheetId: number,
  startRowIndex: number,
  endRowIndex: number,
  startColumnIndex: number,
  endColumnIndex: number,
): GridRange => ({
  sheetId,
  startRowIndex,
  endRowIndex,
  startColumnIndex,
  endColumnIndex,
})

/**
 * Daily Mode merges of a source (or already-migrated) copy: the three header
 * blocks run to row 15, the creator's wiki-link row sits at 16, and the map
 * image is B17:M132. B8:K10 is outside the ported region.
 */
const sourceDailyMerges = (sheetId: number): GridRange[] => [
  range(sheetId, 7, 10, 1, 11), // B8:K10, above the ported region
  range(sheetId, 11, 15, 1, 5), // B12:E15
  range(sheetId, 11, 15, 5, 8), // F12:H15
  range(sheetId, 11, 15, 8, 11), // I12:K15
  range(sheetId, 15, 16, 1, 10), // B16:J16, the creator's wiki link
  range(sheetId, 16, 132, 1, 13), // B17:M132, the map image
]

function source(): SourceInfo {
  const dailyImage: CellData[][] = []
  for (let rowIndex = 0; rowIndex < 116; rowIndex++)
    dailyImage.push(
      Array.from({ length: 12 }, () => ({ userEnteredFormat: fmt('daily') })),
    )
  dailyImage[0]![0] = {
    ...formula('=IMAGE("https://wiki/daily.jpg",4,L12,M12)', ''),
    userEnteredFormat: fmt('b17'),
  }
  const inputs: CellData[][] = [
    [num(1), num(2)],
    [str('w'), str('h')],
    [formula('=L12*2'), empty()],
    [str('Rows'), num(24)],
  ]
  return {
    meta: {
      sheets: [
        sheet('Quick Checklist', 1, { columnCount: 15 }),
        sheet('Daily Mode', 2, { merges: sourceDailyMerges(2) }),
        sheet('newJSON', 3, { hidden: true }),
        sheet('IMPORT:data.SPECIES', 4, { hidden: true }),
        sheet('_snapshot_QuickChecklist', 5, { hidden: true }),
        sheet('Daily Mode Unlocks', 6, { columnCount: 40 }),
      ],
    },
    grid: {
      sheets: [
        sheet('Quick Checklist', 1, {
          columnCount: 15,
          data: [sourceQuickGrid()],
        }),
        sheet('Daily Mode', 2, {
          data: [
            grid(16, 1, dailyImage, {
              columnMetadata: Array.from({ length: 12 }, (_, colIndex) => ({
                pixelSize: 50 + colIndex,
              })),
            }),
            grid(11, 11, inputs, {
              rowMetadata: [{}, {}, {}, { pixelSize: 42 }],
            }),
            grid(1, 13, [[str(LANDMARK)]]),
          ],
        }),
        sheet('Daily Mode Unlocks', 6, {
          columnCount: 40,
          data: [grid(2, 32, [[formula(USER_AG_FORMULA)]])],
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
        // Creator coordinates: no custom column L, no custom row 15, so the
        // header blocks stop at row 14, the wiki link is at 15 and the image
        // merge starts at B16 (running to L, which the insert widens to M).
        sheet('Daily Mode', 12, {
          merges: [
            range(12, 7, 10, 1, 11), // B8:K10
            range(12, 11, 14, 1, 5), // B12:E14
            range(12, 11, 14, 5, 8), // F12:H14
            range(12, 11, 14, 8, 11), // I12:K14
            range(12, 14, 15, 1, 10), // B15:J15
            range(12, 15, 131, 1, 12), // B16:L131
          ],
        }),
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
        sheet('Daily Mode', 12, {
          data: [grid(1, 12, [[str(LANDMARK), empty()]])],
        }),
        sheet('Daily Mode Unlocks', 18, {
          columnCount: 40,
          data: [dailyUnlocksHeaderGrid(CREATOR_AG_FORMULA)],
        }),
      ],
    },
  }
}

function migratedDest(): DestInfo {
  const dest = freshDest()
  dest.grid.sheets![0]!.data = [migratedDestQuickGrid()]
  dest.grid.sheets![1]!.data = [grid(1, 12, [[empty(), str(LANDMARK)]])]
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
  dest.meta.sheets![1]!.merges = sourceDailyMerges(12)
  dest.meta.sheets![3]!.properties.hidden = true
  dest.meta.sheets![2]!.properties.hidden = true
  dest.meta.sheets![4]!.conditionalFormats = [
    dest.meta.sheets![4]!.conditionalFormats![0]!,
  ]
  dest.meta.sheets![5]!.conditionalFormats = []
  dest.meta.sheets![6]!.conditionalFormats = [
    {
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
          type: 'TEXT_CONTAINS',
          values: [{ userEnteredValue: '[' }],
        },
        format: { backgroundColor: { red: 0.72, green: 0.88, blue: 0.8 } },
      },
    },
  ]
  dest.grid.sheets![2]!.data = [dailyUnlocksHeaderGrid(USER_AG_FORMULA)]
  return dest
}

const requestsOfKind = (
  ops: { requests: Request[] }[],
  kind: string,
): Request[] =>
  ops.flatMap((op) => op.requests).filter((request) => kind in request)

// ---------------------------------------------------------------------------

test('fresh 6.03 copy: block shifted +1, column L inserted, merges/banding/CF handled', () => {
  const { ops, notes } = buildPlan(source(), freshDest(), '6.03')
  const labels = ops.map((op) => op.label)
  assert.deepEqual(labels, [
    'Quick Checklist header (rows 1–10)',
    'Quick Checklist title',
    'Quick Checklist banding over the image column',
    'Daily Mode: insert custom column L',
    'Daily Mode: insert custom row 15',
    'Daily Mode: formats of B17:M132',
    'Daily Mode: formats of L12:M15',
    'Daily Mode: widths of columns L and M, height of row 15',
    'Daily Mode: 5 merge(s) in B12:M132',
    'Daily Mode: B17 formula',
    'Daily Mode: L12:M15 inputs',
    'Hide 1 sheet(s)',
    'Starter DEX Checklist: IV highlight → red when not 31',
    'Full DEX Checklist: IV highlight → red when not 31',
    'Daily Unlock Map: highlight cells with a bracketed unlock',
    'Daily Mode Unlocks: AG3 formula',
  ])
  assert.deepEqual(notes, [])

  // Daily Mode Unlocks: our AG3 formula replaces the creator's, nothing else on that sheet.
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
  assert.equal(unlocksWrites.length, 1)
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
    USER_AG_FORMULA,
  )

  // Unlock map: one "text contains [" rule at index 0 over E2 to the grid's end.
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
  assert.equal(unlockMapRules.length, 1)
  const unlockMapRule = unlockMapRules[0]!
  assert.equal(unlockMapRule.index, 0)
  assert.deepEqual(unlockMapRule.rule.ranges, [
    {
      sheetId: 17,
      startRowIndex: 1,
      endRowIndex: 1000,
      startColumnIndex: 4,
      endColumnIndex: 10,
    },
  ])
  assert.equal(unlockMapRule.rule.booleanRule.condition.type, 'TEXT_CONTAINS')
  assert.equal(
    unlockMapRule.rule.booleanRule.condition.values[0]!.userEnteredValue,
    '[',
  )
  assert.ok(
    unlockMapRule.rule.booleanRule.format.backgroundColor['green']! >
      unlockMapRule.rule.booleanRule.format.backgroundColor['red']!,
    'tint is green',
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
  // Daily Mode: column L inserted at 0-based 11, row 15 at 0-based 14.
  const inserts = requestsOfKind(ops, 'insertDimension').map(
    (request) =>
      (request['insertDimension'] as { range: Record<string, unknown> }).range,
  )
  assert.deepEqual(
    inserts.map((insert) => [insert['dimension'], insert['startIndex']]),
    [
      ['COLUMNS', 11],
      ['ROWS', 14],
    ],
  )
  assert.ok(
    dimensionUpdates.some(
      (update) =>
        update.range['dimension'] === 'ROWS' &&
        update.range['startIndex'] === 14 &&
        update.properties['pixelSize'] === 42,
    ),
    "the inserted row gets the source's height",
  )
  // Every destination merge overlapping one of the five ported ones is
  // unmerged in post-insert coordinates (B8:K10 is outside and survives);
  // then the source's merges are applied.
  const asTuple = (range: Record<string, number>): number[] => [
    range['startRowIndex']!,
    range['endRowIndex']!,
    range['startColumnIndex']!,
    range['endColumnIndex']!,
  ]
  assert.deepEqual(
    requestsOfKind(ops, 'unmergeCells').map((request) =>
      asTuple(
        (request['unmergeCells'] as { range: Record<string, number> }).range,
      ),
    ),
    [
      [11, 14, 1, 5], // B12:E14
      [11, 14, 5, 8], // F12:H14
      [11, 14, 8, 11], // I12:K14
      [15, 16, 1, 10], // B15:J15 → B16:J16
      [16, 132, 1, 13], // B16:L131 → B17:M132 (widened by the column insert)
    ],
  )
  assert.deepEqual(
    requestsOfKind(ops, 'mergeCells').map((request) =>
      asTuple(
        (request['mergeCells'] as { range: Record<string, number> }).range,
      ),
    ),
    [
      [11, 15, 1, 5], // B12:E15
      [11, 15, 5, 8], // F12:H15
      [11, 15, 8, 11], // I12:K15
      [15, 16, 1, 10], // B16:J16
      [16, 132, 1, 13], // B17:M132
    ],
  )
  // B17 formula copied, top-aligned; L12:M15 values.
  const imageCell = cellWrites.find(
    (write) =>
      write.fields === 'userEnteredValue,userEnteredFormat.verticalAlignment',
  )!
  assert.equal(imageCell.range['startRowIndex'], 16)
  assert.match(
    imageCell.rows[0]!.values[0]!.userEnteredValue!.formulaValue!,
    /^=IMAGE/,
  )
  const inputs = cellWrites.find(
    (write) =>
      write.fields === 'userEnteredValue' &&
      write.range['startRowIndex'] === 11 &&
      write.range['startColumnIndex'] === 11,
  )!
  assert.equal(inputs.range['endRowIndex'], 15)
  assert.equal(
    inputs.rows[2]!.values[0]!.userEnteredValue!.formulaValue,
    '=L12*2',
  )
  assert.deepEqual(inputs.rows[2]!.values[1], {})
  assert.equal(inputs.rows[3]!.values[1]!.userEnteredValue!.numberValue, 24)
  // Hidden sheets: newJSON gets hidden; IMPORT already hidden; _snapshot_ has no counterpart.
  const hide = requestsOfKind(ops, 'updateSheetProperties')
  assert.equal(hide.length, 1)
  assert.equal(
    (hide[0]!['updateSheetProperties'] as { properties: { sheetId: number } })
      .properties.sheetId,
    13,
  )
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

test('already-migrated destination: idempotent plan (no insert, no shift, banding/CF already done)', () => {
  const { ops, notes } = buildPlan(source(), migratedDest(), '6.03')
  assert.equal(requestsOfKind(ops, 'insertDimension').length, 0)
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
      note.startsWith('Daily Mode: custom column L already present'),
    ),
  )
  assert.ok(
    notes.some((note) =>
      note.startsWith('Daily Mode: custom row 15 already present'),
    ),
  )
  // The merges already match the source's: each is unmerged and re-applied.
  assert.equal(requestsOfKind(ops, 'unmergeCells').length, 5)
  assert.equal(requestsOfKind(ops, 'mergeCells').length, 5)
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
      note.startsWith('Unlock map highlight: rule already present'),
    ),
  )
  assert.ok(
    notes.some((note) =>
      note.startsWith('Daily Mode Unlocks: AG3 formula already matching'),
    ),
  )
  assert.equal(
    requestsOfKind(ops, 'updateCells').filter(
      (request) =>
        (request['updateCells'] as { range: GridRange }).range.sheetId === 18,
    ).length,
    0,
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

test('planning refuses unknown layouts before anything is written', () => {
  const noLandmark = freshDest()
  noLandmark.grid.sheets![1]!.data = [grid(1, 12, [[empty(), empty()]])]
  assert.throws(
    () => buildPlan(source(), noLandmark, '6.03'),
    /landmark "Missing Gym Leader Voucher…" is at neither N2 nor M2/,
  )

  // The map image block is located by the merge it is; without one, nothing is ported.
  const sourceWithoutImageMerge = source()
  sourceWithoutImageMerge.meta.sheets![1]!.merges = sourceDailyMerges(2).filter(
    (merge) => merge.startRowIndex !== 16,
  )
  assert.throws(
    () => buildPlan(sourceWithoutImageMerge, freshDest(), '6.03'),
    /no merged cell starts at B17 in the source/,
  )

  const destImageMergeMoved = freshDest()
  destImageMergeMoved.meta.sheets![1]!.merges = [range(12, 20, 40, 1, 12)]
  assert.throws(
    () => buildPlan(source(), destImageMergeMoved, '6.03'),
    /map image merge starts at neither B17 nor B16 in the destination/,
  )

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

  // Daily Mode Unlocks: a moved header, or no formula at AG3 on either side, stops the port.
  const waveMoved = freshDest()
  waveMoved.grid.sheets![2]!.data![0]!.rowData![1]!.values![12] = str('Floor')
  assert.throws(
    () => buildPlan(source(), waveMoved, '6.03'),
    /Daily Mode Unlocks: expected "Wave" at M2 in the destination, found "Floor"/,
  )
  const noCreatorFormula = freshDest()
  noCreatorFormula.grid.sheets![2]!.data![0]!.rowData![2]!.values![32] =
    str('w13 Dartrix')
  assert.throws(
    () => buildPlan(source(), noCreatorFormula, '6.03'),
    /AG3 holds no formula in the destination/,
  )
  const sourceWithoutFormula = source()
  sourceWithoutFormula.grid.sheets![2]!.data = [grid(2, 32, [[str('')]])]
  assert.throws(
    () => buildPlan(sourceWithoutFormula, freshDest(), '6.03'),
    /AG3 holds no formula in the source/,
  )
  const sourceWithoutSheet = source()
  sourceWithoutSheet.grid.sheets = sourceWithoutSheet.grid.sheets!.filter(
    (sheetInfo) => sheetInfo.properties.title !== 'Daily Mode Unlocks',
  )
  assert.throws(
    () => buildPlan(sourceWithoutSheet, freshDest(), '6.03'),
    /Daily Mode Unlocks not found in the source/,
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

test('shiftMergeForColumnInsert', () => {
  const merge = { sheetId: 1, startColumnIndex: 1, endColumnIndex: 12 }
  assert.deepEqual(shiftMergeForColumnInsert(merge, 11), {
    sheetId: 1,
    startColumnIndex: 1,
    endColumnIndex: 13,
  })
  assert.deepEqual(
    shiftMergeForColumnInsert(
      { sheetId: 1, startColumnIndex: 12, endColumnIndex: 14 },
      11,
    ),
    { sheetId: 1, startColumnIndex: 13, endColumnIndex: 15 },
  )
  assert.deepEqual(
    shiftMergeForColumnInsert(
      { sheetId: 1, startColumnIndex: 0, endColumnIndex: 11 },
      11,
    ),
    { sheetId: 1, startColumnIndex: 0, endColumnIndex: 11 },
  )
})

test('shiftMergeForRowInsert', () => {
  // Starts at or below the inserted row: moves down whole (B15:J15 → B16:J16).
  assert.deepEqual(
    shiftMergeForRowInsert(
      { sheetId: 1, startRowIndex: 14, endRowIndex: 15 },
      14,
    ),
    { sheetId: 1, startRowIndex: 15, endRowIndex: 16 },
  )
  // Ends exactly at the inserted row: untouched (B12:E14 stays B12:E14).
  assert.deepEqual(
    shiftMergeForRowInsert(
      { sheetId: 1, startRowIndex: 11, endRowIndex: 14 },
      14,
    ),
    { sheetId: 1, startRowIndex: 11, endRowIndex: 14 },
  )
  // Spans the inserted row: grows by one.
  assert.deepEqual(
    shiftMergeForRowInsert(
      { sheetId: 1, startRowIndex: 11, endRowIndex: 16 },
      14,
    ),
    { sheetId: 1, startRowIndex: 11, endRowIndex: 17 },
  )
})
