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
import { resolveTracker } from '../src/lib/layout.ts'
import {
  DEX_HIGHLIGHT_COLOR,
  INCREMENT_HIGHLIGHT_COLOR,
  LEGACY_MARKERS_PROPERTY,
  QUICK_CHECKLIST_HIGHLIGHT_COLOR,
  SNAPSHOT_FORMAT_PROPERTY,
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
const Q = LAYOUT_603.quick

beforeEach(() => resetFakes())

const props = () => PropertiesService.getDocumentProperties()

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
  const ss = buildWorkbook({ rows: 3 })
  for (const spec of TRACKER_SPECS) {
    const r = resolveTracker(
      spec,
      ss.getSheetByName(spec.dataSheet)! as never,
      ss.getSheetByName(spec.displaySheet)! as never,
    )
    const g = golden[spec.key]!
    assert.equal(spec.dataFirstRow, g.dataFirstRow)
    assert.equal(spec.displayFirstRow, g.displayFirstRow)
    const actual = r.cells
      .filter((c) => c.color !== null)
      .map((c) => [c.dataCol - r.minDataCol, c.displayCol, c.color])
    assert.deepEqual(actual, g.cells, spec.key)
  }
})

test('describeLayout reports every tracker (or the error) without throwing', () => {
  const ss = buildWorkbook({ rows: 3 })
  setActiveSpreadsheet(ss)
  const text = describeLayout()
  assert.match(text, /QuickChecklist: data D–K/)
  assert.match(text, /StarterDex: data L–EM .* → display D–EE \(shift -8\)/)
  ss.deleteSheet(ss.getSheetByName('FULL_DEX.data')!)
  assert.match(describeLayout(), /ERROR FULL_DEX.data not found/)
})

test('snapshot chunks round-trip and stay under the cell limit', () => {
  const rows = Array.from({ length: 1200 }, (_, i) =>
    Array.from({ length: 132 }, (_, c) =>
      c % 3 === 0 ? i : c % 3 === 1 ? '' : 'x',
    ),
  )
  const chunks = encodeSnapshotChunks(rows)
  assert.ok(chunks.length > 1)
  assert.ok(chunks.every((c) => c.length <= 45000))
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
  const ss = buildWorkbook({ rows: 2 })
  const spec = TRACKER_SPECS[1]!
  const r = resolveTracker(
    spec,
    ss.getSheetByName(spec.dataSheet)! as never,
    ss.getSheetByName(spec.displaySheet)! as never,
  )
  const width = r.maxDataCol - r.minDataCol + 1
  const row = new Array(width).fill(0)
  const changed = [...row]
  changed[0] = 1 // Fought Flag → default colour
  changed[1] = 1 // Fought Count → excluded
  changed[22 - r.minDataCol] = 5 // Caught Count → increment
  const d = diffBlocks(r, [row, row], [changed, row])
  assert.deepEqual([...d.rowColors.keys()], [0])
  const colors = d.rowColors.get(0)!
  assert.equal(colors.length, r.maxDisplayCol - r.minDisplayCol + 1)
  assert.equal(colors[0], DEX_HIGHLIGHT_COLOR)
  assert.equal(colors[1], null)
  assert.equal(colors[14 - r.minDisplayCol], INCREMENT_HIGHLIGHT_COLOR)
  assert.equal(d.changed, 2)
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
  const ss = buildWorkbook({ rows: 20 })
  setActiveSpreadsheet(ss)
  snapshot()
  for (const t of TRACKER_SPECS) {
    const s = ss.getSheetByName(snapshotSheetName(t.key))!
    assert.ok(s.hidden)
    assert.match(String(s.valueAt(1, 1)), /^\{"v":3/)
  }
  assert.equal(props().getProperty(SNAPSHOT_FORMAT_PROPERTY), '3')

  const qData = ss.getSheetByName('STARTER_CHECKLIST.data')!
  qData.load(Q.dataFirstRow, Q.dataShinyCol, [[42]]) // Bulbasaur SHINY
  qData.load(Q.dataFirstRow + 3, Q.dataMaxIvsCol, [[99]]) // row 15 Max IVs
  qData.load(Q.dataFirstRow + 5, 12, [[7]]) // Ribbons: NOT tracked
  const sData = ss.getSheetByName('STARTER_DEX.data')!
  sData.load(3, 22, [[999]]) // Caught Count → N increment
  sData.load(3, 13, [[999]]) // Fought Count → excluded
  const fData = ss.getSheetByName('FULL_DEX.data')!
  fData.load(4, 8, [[7]]) // Fought Flag row 4 → display row 5 col D

  highlightChanges()

  const qDisp = ss.getSheetByName('Quick Checklist')!
  assert.equal(
    qDisp.backgroundAt(12, Q.displayShinyCol),
    QUICK_CHECKLIST_HIGHLIGHT_COLOR,
  )
  assert.equal(
    qDisp.backgroundAt(15, Q.displayMaxIvsCol),
    QUICK_CHECKLIST_HIGHLIGHT_COLOR,
  )
  assert.equal(qDisp.backgroundAt(13, Q.displayShinyCol), null)
  assert.equal(
    qDisp.backgroundAt(17, Q.displayRibbonsCol),
    null,
    'Ribbons is outside the tracked block',
  )
  assert.equal(qDisp.valueAt(12, 17), '', 'no marker column any more')

  const sDisp = ss.getSheetByName('Starter DEX Checklist')!
  assert.equal(sDisp.backgroundAt(4, 14), INCREMENT_HIGHLIGHT_COLOR)
  assert.equal(sDisp.backgroundAt(4, 5), null, 'Fought Count is excluded')
  assert.equal(sDisp.backgroundAt(5, 14), null)
  assert.equal(
    ss.getSheetByName('Full DEX Checklist')!.backgroundAt(5, 4),
    DEX_HIGHLIGHT_COLOR,
  )

  // The painted rows are remembered for the next clear.
  const meta = JSON.parse(
    String(
      ss.getSheetByName(snapshotSheetName('QuickChecklist'))!.valueAt(1, 1),
    ),
  )
  assert.deepEqual(meta.painted, [
    { start: 0, count: 1 },
    { start: 3, count: 1 },
  ])
})

test('processChanges: full flow; a no-change upload clears old highlights in 4 API calls', () => {
  const ss = buildWorkbook({ rows: 20 })
  setActiveSpreadsheet(ss)
  ss.getSheetByName('Quick Checklist')!.writeBackgrounds(13, 8, [['#ff0000']]) // stale, unknown origin
  resetToastProgress('upload')
  processChanges()
  assert.equal(
    ss.getSheetByName('Quick Checklist')!.backgroundAt(13, 8),
    null,
    'first baseline clears the block once',
  )
  assert.ok(ss.getSheetByName(snapshotSheetName('QuickChecklist')))
  assert.equal(
    ss.getSheetByName(TIMINGS_SHEET)!.grid().at(-1)![3],
    'TOTAL (ok)',
  )

  ss.getSheetByName('STARTER_CHECKLIST.data')!.load(12, 4, [[42]])
  resetToastProgress('upload')
  processChanges()
  assert.equal(
    ss.getSheetByName('Quick Checklist')!.backgroundAt(12, 8),
    QUICK_CHECKLIST_HIGHLIGHT_COLOR,
  )

  apiCalls.length = 0
  calls.length = 0
  resetToastProgress('upload')
  processChanges()
  assert.equal(
    ss.getSheetByName('Quick Checklist')!.backgroundAt(12, 8),
    null,
    'previous highlight cleared',
  )
  assert.ok(
    logs.some((l) => l.includes('QuickChecklist: highlighted 0 changed cells')),
  )
  const methods = apiCalls.map((c) => c.method)
  console.log(
    `      [info] API calls for a no-change upload: ${methods.join(', ')}`,
  )
  assert.deepEqual(methods, [
    'spreadsheets.get',
    'values.batchGet',
    'spreadsheets.batchUpdate',
    'values.batchUpdate',
  ])
  const heavy = calls.filter(
    (c) =>
      /getValues|setValues|setBackground|sort\(/.test(c) &&
      !c.startsWith('_timings'),
  )
  assert.deepEqual(
    heavy,
    [],
    'no SpreadsheetApp bulk I/O left: ' + heavy.join(', '),
  )
})

test('an out-of-order display is re-sorted before painting', () => {
  const ss = buildWorkbook({ rows: 6 })
  setActiveSpreadsheet(ss)
  snapshot()
  const qDisp = ss.getSheetByName('Quick Checklist')!
  const rows = qDisp.readValues(12, 1, 6, 17).reverse()
  qDisp.load(12, 1, rows)
  ss.getSheetByName('STARTER_CHECKLIST.data')!.load(12, 4, [[42]]) // Bulbasaur (#1)
  highlightChanges()
  assert.equal(qDisp.valueAt(12, 1), 1, 'display re-sorted to canonical order')
  assert.equal(qDisp.backgroundAt(12, 8), QUICK_CHECKLIST_HIGHLIGHT_COLOR)
  assert.ok(calls.some((c) => c.startsWith('Quick Checklist.sort(')))
})

test('keep-baseline: highlights accumulate, and with no baseline nothing is written', () => {
  const ss = buildWorkbook({ rows: 5 })
  setActiveSpreadsheet(ss)
  resetToastProgress('upload')
  processChanges({ skipSnapshot: true })
  assert.equal(
    ss.getSheetByName(snapshotSheetName('QuickChecklist')),
    null,
    'no baseline created',
  )
  snapshot()
  ss.getSheetByName('STARTER_CHECKLIST.data')!.load(12, 4, [[42]])
  resetToastProgress('upload')
  processChanges({ skipSnapshot: true })
  ss.getSheetByName('STARTER_CHECKLIST.data')!.load(13, 4, [[43]])
  resetToastProgress('upload')
  processChanges({ skipSnapshot: true })
  const q = ss.getSheetByName('Quick Checklist')!
  assert.equal(
    q.backgroundAt(12, 8),
    QUICK_CHECKLIST_HIGHLIGHT_COLOR,
    'still highlighted against the kept baseline',
  )
  assert.equal(q.backgroundAt(13, 8), QUICK_CHECKLIST_HIGHLIGHT_COLOR)
})

test('clearHighlights blanks the whole tracked block (manual clear), nothing outside it', () => {
  const ss = buildWorkbook({ rows: 5 })
  setActiveSpreadsheet(ss)
  snapshot()
  ss.getSheetByName('STARTER_CHECKLIST.data')!.load(12, 4, [[42]])
  highlightChanges()
  const q = ss.getSheetByName('Quick Checklist')!
  q.writeBackgrounds(12, 2, [['#123456']]) // a creator fill in the image column
  q.writeBackgrounds(14, 8, [['#abcdef']]) // a fill in a non-highlighted row of the block: left alone
  clearHighlights()
  assert.equal(q.backgroundAt(12, 8), null)
  assert.equal(q.backgroundAt(12, 2), '#123456', 'untouched outside the block')
  assert.equal(
    q.backgroundAt(14, 8),
    null,
    'stray fills inside the block go too',
  )
})

test('upgrade from a v2 grid snapshot: diffs once, converts to v3, clears the whole block once', () => {
  const ss = buildWorkbook({ rows: 5 })
  setActiveSpreadsheet(ss)
  props().setProperty(SNAPSHOT_FORMAT_PROPERTY, '2')
  // v2 layout: header band rows 1..firstRow-1, data at the data sheet's own rows
  for (const [key, name, col, first, last] of [
    ['QuickChecklist', 'STARTER_CHECKLIST.data', 4, 12, 11],
    ['StarterDex', 'STARTER_DEX.data', 12, 3, 143],
    ['FullDex', 'FULL_DEX.data', 8, 3, 139],
  ] as const) {
    const d = ss.getSheetByName(name)!
    const s = ss.addSheet(snapshotSheetName(key))
    const width = last - col + 1
    s.load(1, col, d.readValues(1, col, first - 1, width))
    s.load(first, col, d.readValues(first, col, 5, width))
  }
  const q = ss.getSheetByName('Quick Checklist')!
  q.load(12, 17, [['●'], [''], ['●'], [''], ['']]) // legacy markers
  q.writeBackgrounds(13, 8, [['#ff0000']]) // a stale highlight from the old flow

  ss.getSheetByName('STARTER_CHECKLIST.data')!.load(14, 4, [[42]])
  resetToastProgress('upload')
  processChanges()
  assert.equal(
    q.backgroundAt(14, 8),
    QUICK_CHECKLIST_HIGHLIGHT_COLOR,
    'diffed against the v2 rows',
  )
  assert.equal(
    q.backgroundAt(13, 8),
    null,
    'whole block cleared once on upgrade',
  )
  assert.equal(q.valueAt(12, 17), '', 'legacy markers cleared')
  assert.equal(props().getProperty(SNAPSHOT_FORMAT_PROPERTY), '3')
  assert.equal(props().getProperty(LEGACY_MARKERS_PROPERTY), 'true')
  const snap = ss.getSheetByName(snapshotSheetName('QuickChecklist'))!
  assert.match(String(snap.valueAt(1, 1)), /^\{"v":3/)
  assert.equal(snap.valueAt(1, 4), '', 'old grid cleared')

  resetToastProgress('upload')
  processChanges()
  assert.equal(q.backgroundAt(14, 8), null)
})

test('a display title the API spells differently is still found (via SpreadsheetApp + sheetId)', () => {
  const ss = buildWorkbook({ rows: 3 })
  setActiveSpreadsheet(ss)
  // Give the tab a trailing non-breaking space: SpreadsheetApp finds it by the plain name in
  // the fake only if names match, so emulate by renaming and registering an alias lookup.
  const disp = ss.getSheetByName('Starter DEX Checklist')!
  const original = ss.getSheetByName.bind(ss)
  disp.name = 'Starter DEX Checklist\u00a0'
  ;(
    ss as unknown as { getSheetByName: (n: string) => unknown }
  ).getSheetByName = (n: string) =>
    original(n) ?? (n === 'Starter DEX Checklist' ? disp : null)
  assert.match(describeLayout(), /StarterDex: data L–EM/)
  assert.ok(
    logs.some((l) =>
      l.includes('is titled "Starter DEX Checklist\u00a0" in the API'),
    ),
  )
})

test('a missing sheet fails the flow visibly instead of leaving a sticky toast', () => {
  const ss = buildWorkbook({ rows: 5 })
  ss.deleteSheet(ss.getSheetByName('FULL_DEX.data')!)
  setActiveSpreadsheet(ss)
  resetToastProgress('upload')
  assert.throws(() => processChanges(), /FULL_DEX.data not found/)
  const last = toasts.at(-1)!
  assert.equal(last.title, 'Something went wrong')
  assert.notEqual(last.timeout, -1)
})

test('a creator layout change stops the paint with a precise message', () => {
  const ss = buildWorkbook({ rows: 5 })
  setActiveSpreadsheet(ss)
  snapshot()
  const disp = ss.getSheetByName('Starter DEX Checklist')!
  disp.load(2, 4, [['Seen Flag']]) // creator renamed the anchor in the display
  resetToastProgress('upload')
  assert.throws(
    () => processChanges(),
    /could not find the header "Fought Flag" .* "Starter DEX Checklist"/,
  )
  assert.equal(disp.backgroundAt(4, 4), null)
})

test('a creator column insert between uploads is absorbed: the v3 snapshot is realigned', () => {
  const ss = buildWorkbook({ rows: 5 })
  setActiveSpreadsheet(ss)
  snapshot()
  // Creator inserts a column before "Fought Flag" in STARTER_DEX.data and its display.
  const d = ss.getSheetByName('STARTER_DEX.data')!
  const grid = d.readValues(1, 1, d.getLastRow(), d.getLastColumn())
  d.clear()
  d.load(
    1,
    1,
    grid.map((row) => [...row.slice(0, 11), '', ...row.slice(11)]),
  )
  const v = ss.getSheetByName('Starter DEX Checklist')!
  const vgrid = v.readValues(1, 1, v.getLastRow(), v.getLastColumn())
  v.clear()
  v.load(
    1,
    1,
    vgrid.map((row) => [...row.slice(0, 3), '', ...row.slice(3)]),
  )
  resetToastProgress('upload')
  processChanges()
  assert.ok(
    logs.some((l) => l.includes('StarterDex: highlighted 0 changed cells')),
    logs.join('\n'),
  )
})
