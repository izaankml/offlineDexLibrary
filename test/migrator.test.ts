import assert from 'node:assert/strict'
import { test } from 'node:test'
import './fake-gas.ts'
import {
  type DestInfo,
  type SourceInfo,
  applyPlan,
  buildPlan,
  describePlan,
  planQuickChecklist,
  shiftMergeForInsert,
} from '../src/lib/migrator.ts'
import type {
  CellData,
  CellFormat,
  GridData,
  Request,
  SheetInfo,
  SheetsClient,
  SpreadsheetInfo,
} from '../src/lib/sheetsApi.ts'

// ---------------------------------------------------------------------------
// Fixture builders (shapes as the Sheets API returns them)
// ---------------------------------------------------------------------------

const fmt = (bg: string): CellFormat => ({
  backgroundColor: { red: 1, green: 1, blue: 1 },
  note: bg,
})
const str = (s: string, format?: CellFormat): CellData => ({
  userEnteredValue: { stringValue: s },
  formattedValue: s,
  ...(format ? { userEnteredFormat: format } : {}),
})
const num = (n: number): CellData => ({
  userEnteredValue: { numberValue: n },
  formattedValue: String(n),
})
const formula = (f: string, shown = ''): CellData => ({
  userEnteredValue: { formulaValue: f },
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
  opts: Partial<SheetInfo> & { columnCount?: number; hidden?: boolean } = {},
): SheetInfo {
  const { columnCount, hidden, ...rest } = opts
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
  for (let r = 0; r < 10; r++)
    rows.push(
      Array.from({ length: 15 }, (_, c) =>
        r === 0 && c === 0
          ? str('POKEROGUE DEX 6.01', fmt('title'))
          : { userEnteredFormat: fmt(`r${r}c${c}`) },
      ),
    )
  // Row 1 block E..O: my stat formulas
  for (let c = 4; c < 15; c++)
    rows[0]![c] = formula(
      `=COUNTIF(${String.fromCharCode(65 + c)}12:${String.fromCharCode(65 + c)},"☑")`,
      '572',
    )
  // Row 10: "Stats:" in D, numbers in the block, a cross-sheet formula in A
  rows[9]![0] = formula("='STATIC:VERSION'!A1", 'x')
  rows[9]![3] = str('Stats:')
  for (let c = 4; c < 15; c++) rows[9]![c] = formula(`=E1+$A$10`, '1')
  return grid(0, 0, rows, {
    rowMetadata: Array.from({ length: 10 }, (_, r) => ({
      pixelSize: 20 + r,
      ...(r === 2 ? { hiddenByUser: true } : {}),
    })),
    columnMetadata: Array.from({ length: 15 }, (_, c) => ({
      pixelSize: 100 + c,
    })),
  })
}

/** Destination Quick Checklist header rows 1–10 for a FRESH 6.03 copy (junk E, block at F, 16 columns). */
function freshDestQuickGrid(): GridData {
  const rows: CellData[][] = []
  for (let r = 0; r < 10; r++)
    rows.push(Array.from({ length: 16 }, () => empty()))
  rows[0]![0] = str('POKEROGUE DEX 6.01')
  rows[9]![3] = str('Stats (out of 572):')
  for (let c = 5; c < 16; c++) rows[9]![c] = num(0)
  return grid(0, 0, rows)
}

/** Destination Quick Checklist that was already migrated (block at F, "Stats:" at D10). */
function migratedDestQuickGrid(): GridData {
  const g = freshDestQuickGrid()
  g.rowData![9]!.values![3] = str('Stats:')
  g.rowData![0]!.values![0] = str('POKEROGUE DEX 6.03')
  return g
}

const LANDMARK = 'Missing Gym Leader Voucher…'

function source(): SourceInfo {
  const dailyB16: CellData[][] = []
  for (let r = 0; r < 116; r++)
    dailyB16.push(
      Array.from({ length: 12 }, () => ({ userEnteredFormat: fmt('daily') })),
    )
  dailyB16[0]![0] = {
    ...formula('=IMAGE("https://wiki/daily.jpg",4,L12,M12)', ''),
    userEnteredFormat: fmt('b16'),
  }
  const inputs: CellData[][] = [
    [num(1), num(2)],
    [str('w'), str('h')],
    [formula('=L12*2'), empty()],
  ]
  return {
    meta: {
      sheets: [
        sheet('Quick Checklist', 1, { columnCount: 15 }),
        sheet('Daily Mode', 2),
        sheet('newJSON', 3, { hidden: true }),
        sheet('IMPORT:data.SPECIES', 4, { hidden: true }),
        sheet('_snapshot_QuickChecklist', 5, { hidden: true }),
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
            grid(15, 1, dailyB16, {
              columnMetadata: Array.from({ length: 12 }, (_, c) => ({
                pixelSize: 50 + c,
              })),
            }),
            grid(11, 11, inputs),
            grid(1, 13, [[str(LANDMARK)]]),
          ],
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
        sheet('Daily Mode', 12, {
          merges: [
            {
              sheetId: 12,
              startRowIndex: 15,
              endRowIndex: 131,
              startColumnIndex: 1,
              endColumnIndex: 12,
            },
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
      ],
    },
  }
}

function migratedDest(): DestInfo {
  const d = freshDest()
  d.grid.sheets![0]!.data = [migratedDestQuickGrid()]
  d.grid.sheets![1]!.data = [grid(1, 12, [[empty(), str(LANDMARK)]])]
  d.meta.sheets![0]!.bandedRanges = [
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
  d.meta.sheets![1]!.merges = [
    {
      sheetId: 12,
      startRowIndex: 15,
      endRowIndex: 131,
      startColumnIndex: 1,
      endColumnIndex: 13,
    },
  ]
  d.meta.sheets![3]!.properties.hidden = true
  d.meta.sheets![2]!.properties.hidden = true
  d.meta.sheets![4]!.conditionalFormats = [
    d.meta.sheets![4]!.conditionalFormats![0]!,
  ]
  d.meta.sheets![5]!.conditionalFormats = []
  return d
}

const reqOf = (ops: { requests: Request[] }[], kind: string): Request[] =>
  ops.flatMap((op) => op.requests).filter((r) => kind in r)

// ---------------------------------------------------------------------------

test('fresh 6.03 copy: block shifted +1, column L inserted, merges/banding/CF handled', () => {
  const { ops, notes } = buildPlan(source(), freshDest(), '6.03')
  const labels = ops.map((o) => o.label)
  assert.deepEqual(labels, [
    'Quick Checklist header (rows 1–10)',
    'Quick Checklist title',
    'Quick Checklist banding over the image column',
    'Daily Mode: insert custom column L',
    'Daily Mode: formats of B16:M131',
    'Daily Mode: formats of L12:M14',
    'Daily Mode: widths of columns L and M',
    'Daily Mode: merge B16:M131',
    'Daily Mode: B16 formula',
    'Daily Mode: L12:M14 inputs',
    'Hide 1 sheet(s)',
    'Starter DEX Checklist: IV highlight → red when not 31',
    'Full DEX Checklist: IV highlight → red when not 31',
  ])
  assert.deepEqual(notes, [])

  // Quick Checklist: ported up to the block end (E..O = 15) + offset 1 = 16 needed; dest has 16 → no append.
  assert.equal(reqOf(ops, 'appendDimension').length, 0)
  assert.match(ops[0]!.note!, /row heights 20\/21\/22h\/23/)
  const cellWrites = reqOf(ops, 'updateCells').map(
    (r) =>
      r['updateCells'] as {
        range: Record<string, number>
        rows: { values: CellData[] }[]
        fields: string
      },
  )
  // Row 1 block: written at F..P (0-based 5..16), formulas shifted E→F.
  const row1 = cellWrites.find(
    (w) =>
      w.fields === 'userEnteredValue' &&
      w.range['startRowIndex'] === 0 &&
      w.range['startColumnIndex'] === 5,
  )!
  assert.equal(row1.range['endColumnIndex'], 16)
  assert.equal(
    row1.rows[0]!.values[0]!.userEnteredValue!.formulaValue,
    '=COUNTIF(F12:F,"☑")',
  )
  // Row 10 left segment (A–D) written in place; A10 cross-sheet formula unchanged; block segment shifted; $A$10 stays.
  const row10left = cellWrites.find(
    (w) =>
      w.fields === 'userEnteredValue' &&
      w.range['startRowIndex'] === 9 &&
      w.range['startColumnIndex'] === 0,
  )!
  assert.equal(
    row10left.rows[0]!.values[0]!.userEnteredValue!.formulaValue,
    "='STATIC:VERSION'!A1",
  )
  const row10block = cellWrites.find(
    (w) =>
      w.fields === 'userEnteredValue' &&
      w.range['startRowIndex'] === 9 &&
      w.range['startColumnIndex'] === 5,
  )!
  assert.equal(
    row10block.rows[0]!.values[0]!.userEnteredValue!.formulaValue,
    '=F1+$A$10',
  )
  // Formats: two segments, A–D in place and E..O → F..P, 10 rows each, padded to full width.
  const fmts = cellWrites.filter(
    (w) => w.fields === 'userEnteredFormat' && w.range['endRowIndex'] === 10,
  )
  assert.deepEqual(
    fmts.map((w) => [w.range['startColumnIndex'], w.range['endColumnIndex']]),
    [
      [0, 4],
      [5, 16],
    ],
  )
  assert.equal(fmts[1]!.rows.length, 10)
  assert.equal(fmts[1]!.rows[0]!.values.length, 11)
  // Ribbons hidden at P (0-based 15); widths mapped with the offset; row 3 hidden.
  const dims = reqOf(ops, 'updateDimensionProperties').map(
    (r) =>
      r['updateDimensionProperties'] as {
        range: Record<string, unknown>
        properties: Record<string, unknown>
        fields: string
      },
  )
  assert.ok(
    dims.some(
      (d) =>
        d.range['dimension'] === 'COLUMNS' &&
        d.range['startIndex'] === 15 &&
        d.properties['hiddenByUser'] === true &&
        d.fields === 'hiddenByUser',
    ),
  )
  assert.ok(
    dims.some(
      (d) =>
        d.range['dimension'] === 'COLUMNS' &&
        d.range['startIndex'] === 5 &&
        d.properties['pixelSize'] === 104,
    ),
    'source E width lands on F',
  )
  assert.ok(
    dims.some(
      (d) =>
        d.range['dimension'] === 'ROWS' &&
        d.range['startIndex'] === 2 &&
        d.properties['hiddenByUser'] === true,
    ),
  )
  // Title stamped with the DEST version.
  const title = cellWrites.find(
    (w) =>
      w.range['startRowIndex'] === 0 &&
      w.range['endColumnIndex'] === 1 &&
      w.range['startColumnIndex'] === 0 &&
      w.rows[0]!.values[0]!.userEnteredValue?.stringValue,
  )!
  assert.equal(
    title.rows[0]!.values[0]!.userEnteredValue!.stringValue,
    'POKEROGUE DEX 6.03',
  )
  // Banding extended left to B and B fills cleared.
  const band = reqOf(ops, 'updateBanding')[0]!['updateBanding'] as {
    bandedRange: { range: Record<string, number> }
  }
  assert.equal(band.bandedRange.range['startColumnIndex'], 1)
  assert.equal(reqOf(ops, 'repeatCell').length, 1)
  // Daily Mode: insert at L (0-based 11); creator's B16:L131 merge is widened by the insert → unmerged, then merged as B16:M131.
  const ins = reqOf(ops, 'insertDimension')[0]!['insertDimension'] as {
    range: Record<string, unknown>
  }
  assert.equal(ins.range['startIndex'], 11)
  const unmerge = reqOf(ops, 'unmergeCells')[0]!['unmergeCells'] as {
    range: Record<string, number>
  }
  assert.equal(unmerge.range['endColumnIndex'], 13)
  const merge = reqOf(ops, 'mergeCells')[0]!['mergeCells'] as {
    range: Record<string, number>
  }
  assert.deepEqual(
    [
      merge.range['startRowIndex'],
      merge.range['endRowIndex'],
      merge.range['startColumnIndex'],
      merge.range['endColumnIndex'],
    ],
    [15, 131, 1, 13],
  )
  // B16 formula copied, top-aligned; L12:M14 values.
  const b16 = cellWrites.find(
    (w) => w.fields === 'userEnteredValue,userEnteredFormat.verticalAlignment',
  )!
  assert.match(
    b16.rows[0]!.values[0]!.userEnteredValue!.formulaValue!,
    /^=IMAGE/,
  )
  const inputs = cellWrites.find(
    (w) =>
      w.fields === 'userEnteredValue' &&
      w.range['startRowIndex'] === 11 &&
      w.range['startColumnIndex'] === 11,
  )!
  assert.equal(
    inputs.rows[2]!.values[0]!.userEnteredValue!.formulaValue,
    '=L12*2',
  )
  assert.deepEqual(inputs.rows[2]!.values[1], {})
  // Hidden sheets: newJSON gets hidden; IMPORT already hidden; _snapshot_ has no counterpart.
  const hide = reqOf(ops, 'updateSheetProperties')
  assert.equal(hide.length, 1)
  assert.equal(
    (hide[0]!['updateSheetProperties'] as { properties: { sheetId: number } })
      .properties.sheetId,
    13,
  )
  // IV: Starter rule index 1 (2 ranges) → delete 1 + add 2; Full rule index 0 (1 range) → delete 1 + add 1.
  assert.equal(reqOf(ops, 'deleteConditionalFormatRule').length, 2)
  const adds = reqOf(ops, 'addConditionalFormatRule').map(
    (r) =>
      r['addConditionalFormatRule'] as {
        index: number
        rule: {
          ranges: Record<string, number>[]
          booleanRule: { condition: { values: { userEnteredValue: string }[] } }
        }
      },
  )
  assert.equal(adds.length, 3)
  assert.deepEqual(
    adds.map((a) => a.index),
    [1, 2, 0],
  )
  assert.equal(
    adds[0]!.rule.booleanRule.condition.values[0]!.userEnteredValue,
    '=TO_TEXT(V4)<>"31"',
  )
  assert.equal(
    adds[1]!.rule.booleanRule.condition.values[0]!.userEnteredValue,
    '=TO_TEXT(AE4)<>"31"',
  )

  assert.match(
    describePlan({
      srcId: 's',
      dstId: 'd',
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
  assert.equal(reqOf(ops, 'insertDimension').length, 0)
  assert.equal(reqOf(ops, 'deleteConditionalFormatRule').length, 0)
  assert.equal(reqOf(ops, 'updateBanding').length, 0)
  assert.equal(reqOf(ops, 'repeatCell').length, 1, 'B fills still cleared')
  assert.equal(reqOf(ops, 'updateSheetProperties').length, 0)
  const qc = ops[0]!
  // The source block is at E (5) and the migrated dest at F (6): still a +1 shift of the SOURCE formulas.
  assert.match(qc.note!, /source block at column 5, destination at 6/)
  const row1 = qc.requests.find(
    (r) =>
      (r['updateCells'] as { fields: string; range: { startRowIndex: number } })
        ?.fields === 'userEnteredValue' &&
      (r['updateCells'] as { range: { startRowIndex: number } }).range
        .startRowIndex === 0,
  )!['updateCells'] as { rows: { values: CellData[] }[] }
  assert.equal(
    row1.rows[0]!.values[0]!.userEnteredValue!.formulaValue,
    '=COUNTIF(F12:F,"☑")',
  )
  assert.ok(
    notes.some((n) =>
      n.startsWith('Daily Mode: custom column L already present'),
    ),
  )
  assert.ok(
    notes.some((n) => n.includes('no "= 31" rule on "Starter DEX Checklist"')),
  )
  assert.ok(notes.some((n) => n.startsWith('Hidden sheets: nothing to hide')))
})

test('a 6.03 → 6.03 port (same layout, block at F in both) needs no formula shift', () => {
  const src = source()
  const g = migratedDestQuickGrid()
  // Give the source the migrated 6.03 header (block at F) with formulas referencing F.
  g.rowData![0]!.values![5] = formula('=COUNTIF(F12:F,"☑")')
  src.grid.sheets![0]!.data = [g]
  src.meta.sheets![0]!.properties.gridProperties!.columnCount = 16
  const ops = planQuickChecklist(src, migratedDest(), '6.03')
  const row1 = ops[0]!.requests.find(
    (r) =>
      (r['updateCells'] as { fields: string; range: { startRowIndex: number } })
        ?.fields === 'userEnteredValue' &&
      (r['updateCells'] as { range: { startRowIndex: number } }).range
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
      srcId: 's',
      dstId: 'dest-id',
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
    ops.reduce((n, o) => n + o.requests.length, 0),
  )
})

test('shiftMergeForInsert', () => {
  const m = { sheetId: 1, startColumnIndex: 1, endColumnIndex: 12 }
  assert.deepEqual(shiftMergeForInsert(m, 11), {
    sheetId: 1,
    startColumnIndex: 1,
    endColumnIndex: 13,
  })
  assert.deepEqual(
    shiftMergeForInsert(
      { sheetId: 1, startColumnIndex: 12, endColumnIndex: 14 },
      11,
    ),
    { sheetId: 1, startColumnIndex: 13, endColumnIndex: 15 },
  )
  assert.deepEqual(
    shiftMergeForInsert(
      { sheetId: 1, startColumnIndex: 0, endColumnIndex: 11 },
      11,
    ),
    { sheetId: 1, startColumnIndex: 0, endColumnIndex: 11 },
  )
})
