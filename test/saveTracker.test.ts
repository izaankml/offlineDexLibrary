import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  apiCalls,
  calls,
  logs,
  resetFakes,
  setActiveSpreadsheet,
  toasts,
} from './fake-gas.ts'
import { LAYOUT_603, buildWorkbook } from './fixtures.ts'
import { TIMINGS_SHEET, resetToastProgress } from '../src/lib/progress.ts'
import { resolveFromBands } from '../src/lib/layout.ts'
import { HEADERS } from './fixtures.ts'
import {
  DEX_HIGHLIGHT_COLOR,
  INCREMENT_HIGHLIGHT_COLOR,
  QUICK_CHECKLIST_HIGHLIGHT_COLOR,
  TRACKER_SPECS,
  clearHighlights,
  decodeSnapshotChunks,
  describeLayout,
  diffBlocks,
  encodeSnapshotChunks,
  highlightChanges,
  outOfOrder,
  processChanges,
  snapshot,
  snapshotSheetName,
  toRuns,
} from '../src/lib/saveTracker.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const QUICK = LAYOUT_603.quick

beforeEach(() => resetFakes())

/**
 * The header-keyed probe must reproduce exactly the column maps the old
 * index-based TRACKERS produced for the 6.03 layout (golden-mappings.json was
 * generated from that code before the rewrite).
 */
test('golden: header-keyed layout reproduces the old index-based mappings on 6.03', () => {
  const golden = JSON.parse(
    readFileSync(join(HERE, 'fixtures', 'golden-mappings.json'), 'utf8'),
  ) as Record<
    string,
    {
      dataFirstRow: number
      displayFirstRow: number
      cells: [number, number, string][]
    }
  >
  for (const spec of TRACKER_SPECS) {
    const layout = resolveFromBands(
      spec,
      HEADERS[spec.dataSheet]!,
      HEADERS[
        spec.displaySheet === 'Quick Checklist'
          ? 'Quick Checklist (migrated)'
          : spec.displaySheet
      ]!,
    )
    const expected = golden[spec.key]!
    assert.equal(spec.dataFirstRow, expected.dataFirstRow)
    assert.equal(spec.displayFirstRow, expected.displayFirstRow)
    const actual = layout.cells
      .filter((cell) => cell.color !== null)
      .map((cell) => [
        cell.dataCol - layout.minDataCol,
        cell.displayCol,
        cell.color,
      ])
    assert.deepEqual(actual, expected.cells, spec.key)
  }
})

test('describeLayout reports every tracker (or the error) without throwing', () => {
  const spreadsheet = buildWorkbook({ rows: 3 })
  setActiveSpreadsheet(spreadsheet)
  const text = describeLayout()
  assert.match(text, /QuickChecklist: data D–K/)
  assert.match(text, /StarterDex: data L–EM .* → display D–EE \(shift -8\)/)
  spreadsheet.deleteSheet(spreadsheet.getSheetByName('FULL_DEX.data')!)
  assert.match(describeLayout(), /ERROR FULL_DEX.data not found/)
})

test('snapshot chunks round-trip and stay under the cell limit', () => {
  const rows = Array.from({ length: 1200 }, (_, rowIndex) =>
    Array.from({ length: 132 }, (_, colIndex) =>
      colIndex % 3 === 0 ? rowIndex : colIndex % 3 === 1 ? '' : 'x',
    ),
  )
  const chunks = encodeSnapshotChunks(rows)
  assert.ok(chunks.length > 1)
  assert.ok(chunks.every((chunk) => chunk.length <= 45000))
  assert.deepEqual(decodeSnapshotChunks(chunks), rows)
  assert.deepEqual(decodeSnapshotChunks(encodeSnapshotChunks([])), [])
})

test('toRuns collapses contiguous offsets', () => {
  assert.deepEqual(toRuns([]), [])
  assert.deepEqual(toRuns([0, 1, 2, 5, 7, 8]), [
    { start: 0, count: 3 },
    { start: 5, count: 1 },
    { start: 7, count: 2 },
  ])
})

test('diffBlocks: only tracked, non-excluded columns paint; only changed rows are returned', () => {
  const spec = TRACKER_SPECS[1]!
  const layout = resolveFromBands(
    spec,
    HEADERS[spec.dataSheet]!,
    HEADERS[
      spec.displaySheet === 'Quick Checklist'
        ? 'Quick Checklist (migrated)'
        : spec.displaySheet
    ]!,
  )
  const width = layout.maxDataCol - layout.minDataCol + 1
  const baselineRow = new Array(width).fill(0)
  const changedRow = [...baselineRow]
  changedRow[0] = 1 // Fought Flag → default colour
  changedRow[1] = 1 // Fought Count → excluded
  changedRow[22 - layout.minDataCol] = 5 // Caught Count → increment
  const diff = diffBlocks(
    layout,
    [baselineRow, baselineRow],
    [changedRow, baselineRow],
  )
  assert.deepEqual([...diff.rowColors.keys()], [0])
  const colors = diff.rowColors.get(0)!
  assert.equal(colors.length, layout.maxDisplayCol - layout.minDisplayCol + 1)
  assert.equal(colors[0], DEX_HIGHLIGHT_COLOR)
  assert.equal(colors[1], null)
  assert.equal(colors[14 - layout.minDisplayCol], INCREMENT_HIGHLIGHT_COLOR)
  assert.equal(diff.changedCells, 2)
})

test('outOfOrder: numeric ascending is in order; a swap or text-before-number is not', () => {
  assert.equal(outOfOrder([1, 2, 3, 10]), false)
  assert.equal(outOfOrder([1, 3, 2]), true)
  assert.equal(outOfOrder(['a', 1]), true)
  assert.equal(outOfOrder([1, 'a', '']), false)
  // Text numbers sort as text in Sheets ("1","10","2"): that IS Sheets' order.
  assert.equal(outOfOrder(['1', '10', '2', 'a', '']), false)
  assert.equal(outOfOrder(['1', '2', '10']), true)
})

test('snapshot → change → highlight paints the right display cells and nothing else', () => {
  const spreadsheet = buildWorkbook({ rows: 20 })
  setActiveSpreadsheet(spreadsheet)
  snapshot()
  for (const spec of TRACKER_SPECS) {
    const snapshotSheet = spreadsheet.getSheetByName(
      snapshotSheetName(spec.key),
    )!
    assert.ok(snapshotSheet.hidden)
    assert.match(String(snapshotSheet.valueAt(1, 1)), /^\{"v":3/)
  }

  const quickData = spreadsheet.getSheetByName('STARTER_CHECKLIST.data')!
  quickData.load(QUICK.dataFirstRow, QUICK.dataShinyCol, [[42]]) // Bulbasaur SHINY
  quickData.load(QUICK.dataFirstRow + 3, QUICK.dataMaxIvsCol, [[99]]) // row 15 Max IVs
  quickData.load(QUICK.dataFirstRow + 5, 12, [[7]]) // Ribbons: NOT tracked
  const starterData = spreadsheet.getSheetByName('STARTER_DEX.data')!
  starterData.load(3, 22, [[999]]) // Caught Count → N increment
  starterData.load(3, 13, [[999]]) // Fought Count → excluded
  const fullData = spreadsheet.getSheetByName('FULL_DEX.data')!
  fullData.load(4, 8, [[7]]) // Fought Flag row 4 → display row 5 col D

  highlightChanges()

  const quickDisplay = spreadsheet.getSheetByName('Quick Checklist')!
  assert.equal(
    quickDisplay.backgroundAt(12, QUICK.displayShinyCol),
    QUICK_CHECKLIST_HIGHLIGHT_COLOR,
  )
  assert.equal(
    quickDisplay.backgroundAt(15, QUICK.displayMaxIvsCol),
    QUICK_CHECKLIST_HIGHLIGHT_COLOR,
  )
  assert.equal(quickDisplay.backgroundAt(13, QUICK.displayShinyCol), null)
  assert.equal(
    quickDisplay.backgroundAt(17, QUICK.displayRibbonsCol),
    null,
    'Ribbons is outside the tracked block',
  )
  assert.equal(quickDisplay.valueAt(12, 17), '', 'no marker column any more')

  const starterDisplay = spreadsheet.getSheetByName('Starter DEX Checklist')!
  assert.equal(starterDisplay.backgroundAt(4, 14), INCREMENT_HIGHLIGHT_COLOR)
  assert.equal(
    starterDisplay.backgroundAt(4, 5),
    null,
    'Fought Count is excluded',
  )
  assert.equal(starterDisplay.backgroundAt(5, 14), null)
  assert.equal(
    spreadsheet.getSheetByName('Full DEX Checklist')!.backgroundAt(5, 4),
    DEX_HIGHLIGHT_COLOR,
  )

  // The painted rows are remembered for the next clear.
  const meta = JSON.parse(
    String(
      spreadsheet
        .getSheetByName(snapshotSheetName('QuickChecklist'))!
        .valueAt(1, 1),
    ),
  )
  assert.deepEqual(meta.painted, [
    { start: 0, count: 1 },
    { start: 3, count: 1 },
  ])
})

test('processChanges: full flow; a no-change upload clears old highlights in 4 API calls', () => {
  const spreadsheet = buildWorkbook({ rows: 20 })
  setActiveSpreadsheet(spreadsheet)
  spreadsheet
    .getSheetByName('Quick Checklist')!
    .writeBackgrounds(13, 8, [['#ff0000']]) // stale, unknown origin
  resetToastProgress('upload')
  processChanges()
  assert.equal(
    spreadsheet.getSheetByName('Quick Checklist')!.backgroundAt(13, 8),
    null,
    'first baseline clears the block once',
  )
  assert.ok(spreadsheet.getSheetByName(snapshotSheetName('QuickChecklist')))
  assert.equal(
    spreadsheet.getSheetByName(TIMINGS_SHEET)!.grid().at(-1)![3],
    'TOTAL (ok)',
  )

  spreadsheet.getSheetByName('STARTER_CHECKLIST.data')!.load(12, 4, [[42]])
  resetToastProgress('upload')
  processChanges()
  assert.equal(
    spreadsheet.getSheetByName('Quick Checklist')!.backgroundAt(12, 8),
    QUICK_CHECKLIST_HIGHLIGHT_COLOR,
  )

  apiCalls.length = 0
  calls.length = 0
  resetToastProgress('upload')
  processChanges()
  assert.equal(
    spreadsheet.getSheetByName('Quick Checklist')!.backgroundAt(12, 8),
    null,
    'previous highlight cleared',
  )
  assert.ok(
    logs.some((line) =>
      line.includes('QuickChecklist: highlighted 0 changed cells'),
    ),
  )
  const methods = apiCalls.map((call) => call.method)
  console.log(
    `      [info] API calls for a no-change upload: ${methods.join(', ')}`,
  )
  assert.deepEqual(methods, [
    'spreadsheets.get',
    'values.batchGet',
    'spreadsheets.batchUpdate',
    'values.batchUpdate',
  ])
  const heavyCalls = calls.filter(
    (call) =>
      /getValues|setValues|setBackground|sort\(/.test(call) &&
      !call.startsWith('_timings'),
  )
  assert.deepEqual(
    heavyCalls,
    [],
    'no SpreadsheetApp bulk I/O left: ' + heavyCalls.join(', '),
  )
})

test('an out-of-order display is re-sorted before painting', () => {
  const spreadsheet = buildWorkbook({ rows: 6 })
  setActiveSpreadsheet(spreadsheet)
  snapshot()
  const quickDisplay = spreadsheet.getSheetByName('Quick Checklist')!
  const reversedRows = quickDisplay.readValues(12, 1, 6, 17).reverse()
  quickDisplay.load(12, 1, reversedRows)
  spreadsheet.getSheetByName('STARTER_CHECKLIST.data')!.load(12, 4, [[42]]) // Bulbasaur (#1)
  highlightChanges()
  assert.equal(
    quickDisplay.valueAt(12, 1),
    1,
    'display re-sorted to canonical order',
  )
  assert.equal(
    quickDisplay.backgroundAt(12, 8),
    QUICK_CHECKLIST_HIGHLIGHT_COLOR,
  )
  assert.ok(calls.some((call) => call.startsWith('Quick Checklist.sort(')))
})

test('keep-baseline: highlights accumulate, and with no baseline nothing is written', () => {
  const spreadsheet = buildWorkbook({ rows: 5 })
  setActiveSpreadsheet(spreadsheet)
  resetToastProgress('upload')
  processChanges({ skipSnapshot: true })
  assert.equal(
    spreadsheet.getSheetByName(snapshotSheetName('QuickChecklist')),
    null,
    'no baseline created',
  )
  snapshot()
  spreadsheet.getSheetByName('STARTER_CHECKLIST.data')!.load(12, 4, [[42]])
  resetToastProgress('upload')
  processChanges({ skipSnapshot: true })
  spreadsheet.getSheetByName('STARTER_CHECKLIST.data')!.load(13, 4, [[43]])
  resetToastProgress('upload')
  processChanges({ skipSnapshot: true })
  const quickDisplay = spreadsheet.getSheetByName('Quick Checklist')!
  assert.equal(
    quickDisplay.backgroundAt(12, 8),
    QUICK_CHECKLIST_HIGHLIGHT_COLOR,
    'still highlighted against the kept baseline',
  )
  assert.equal(
    quickDisplay.backgroundAt(13, 8),
    QUICK_CHECKLIST_HIGHLIGHT_COLOR,
  )
})

test('clearHighlights blanks the whole tracked block (manual clear), nothing outside it', () => {
  const spreadsheet = buildWorkbook({ rows: 5 })
  setActiveSpreadsheet(spreadsheet)
  snapshot()
  spreadsheet.getSheetByName('STARTER_CHECKLIST.data')!.load(12, 4, [[42]])
  highlightChanges()
  const quickDisplay = spreadsheet.getSheetByName('Quick Checklist')!
  quickDisplay.writeBackgrounds(12, 2, [['#123456']]) // a creator fill in the image column
  quickDisplay.writeBackgrounds(14, 8, [['#abcdef']]) // a fill in a non-highlighted row of the block: left alone
  clearHighlights()
  assert.equal(quickDisplay.backgroundAt(12, 8), null)
  assert.equal(
    quickDisplay.backgroundAt(12, 2),
    '#123456',
    'untouched outside the block',
  )
  assert.equal(
    quickDisplay.backgroundAt(14, 8),
    null,
    'stray fills inside the block go too',
  )
})

test('a snapshot sheet without metadata counts as no baseline and is wiped on the first write', () => {
  const spreadsheet = buildWorkbook({ rows: 5 })
  setActiveSpreadsheet(spreadsheet)
  const staleSnapshot = spreadsheet.addSheet(
    snapshotSheetName('QuickChecklist'),
  )
  staleSnapshot.load(12, 4, [[1, 2, 3]]) // some old grid content
  const quickDisplay = spreadsheet.getSheetByName('Quick Checklist')!
  quickDisplay.writeBackgrounds(13, 8, [['#ff0000']]) // a stale highlight
  resetToastProgress('upload')
  processChanges()
  assert.ok(
    logs.some((line) => line.includes('QuickChecklist: no snapshot yet')),
  )
  assert.equal(
    quickDisplay.backgroundAt(13, 8),
    null,
    'block cleared once with the first baseline',
  )
  assert.match(String(staleSnapshot.valueAt(1, 1)), /^\{"v":3/)
  assert.equal(staleSnapshot.valueAt(12, 4), '', 'old grid wiped')
})

test('a missing sheet fails the flow visibly instead of leaving a sticky toast', () => {
  const spreadsheet = buildWorkbook({ rows: 5 })
  spreadsheet.deleteSheet(spreadsheet.getSheetByName('FULL_DEX.data')!)
  setActiveSpreadsheet(spreadsheet)
  resetToastProgress('upload')
  assert.throws(() => processChanges(), /FULL_DEX.data not found/)
  const lastToast = toasts.at(-1)!
  assert.equal(lastToast.title, 'Something went wrong')
  assert.notEqual(lastToast.timeout, -1)
})

test('a creator layout change stops the paint with a precise message', () => {
  const spreadsheet = buildWorkbook({ rows: 5 })
  setActiveSpreadsheet(spreadsheet)
  snapshot()
  const starterDisplay = spreadsheet.getSheetByName('Starter DEX Checklist')!
  starterDisplay.load(2, 4, [['Seen Flag']]) // creator renamed the anchor in the display
  resetToastProgress('upload')
  assert.throws(
    () => processChanges(),
    /could not find the header "Fought Flag" .* "Starter DEX Checklist"/,
  )
  assert.equal(starterDisplay.backgroundAt(4, 4), null)
})

test('a creator column insert between uploads is absorbed: the v3 snapshot is realigned', () => {
  const spreadsheet = buildWorkbook({ rows: 5 })
  setActiveSpreadsheet(spreadsheet)
  snapshot()
  // Creator inserts a column before "Fought Flag" in STARTER_DEX.data and its display.
  const starterData = spreadsheet.getSheetByName('STARTER_DEX.data')!
  const dataGrid = starterData.readValues(
    1,
    1,
    starterData.getLastRow(),
    starterData.getLastColumn(),
  )
  starterData.clear()
  starterData.load(
    1,
    1,
    dataGrid.map((row) => [...row.slice(0, 11), '', ...row.slice(11)]),
  )
  const starterDisplay = spreadsheet.getSheetByName('Starter DEX Checklist')!
  const displayGrid = starterDisplay.readValues(
    1,
    1,
    starterDisplay.getLastRow(),
    starterDisplay.getLastColumn(),
  )
  starterDisplay.clear()
  starterDisplay.load(
    1,
    1,
    displayGrid.map((row) => [...row.slice(0, 3), '', ...row.slice(3)]),
  )
  resetToastProgress('upload')
  processChanges()
  assert.ok(
    logs.some((line) =>
      line.includes('StarterDex: highlighted 0 changed cells'),
    ),
    logs.join('\n'),
  )
})
