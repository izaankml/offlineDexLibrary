import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
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
  describeLayout,
  diffBlocks,
  highlightChanges,
  outOfOrder,
  processChanges,
  snapshot,
  snapshotSheetName,
} from '../src/lib/saveTracker.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const Q = LAYOUT_603.quick

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

test('describeLayout reports every tracker (or its error) without throwing', () => {
  const ss = buildWorkbook({ rows: 3 })
  setActiveSpreadsheet(ss)
  const text = describeLayout()
  assert.match(text, /QuickChecklist: data D–K/)
  assert.match(text, /StarterDex: data L–EM .* → display D–EE \(shift -8\)/)
  ss.deleteSheet(ss.getSheetByName('FULL_DEX.data')!)
  assert.match(describeLayout(), /FullDex: ERROR FULL_DEX.data not found/)
})

test('diffBlocks: only tracked, non-excluded columns paint; width is the display block', () => {
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
  const d = diffBlocks(r, [row], [changed])
  assert.equal(d.backgrounds[0]!.length, r.maxDisplayCol - r.minDisplayCol + 1)
  assert.equal(d.backgrounds[0]![0], DEX_HIGHLIGHT_COLOR)
  assert.equal(d.backgrounds[0]![1], null)
  assert.equal(
    d.backgrounds[0]![14 - r.minDisplayCol],
    INCREMENT_HIGHLIGHT_COLOR,
  )
  assert.equal(d.changed, 2)
})

test('outOfOrder: numeric ascending is in order; a swap or text-before-number is not', () => {
  assert.equal(outOfOrder([1, 2, 3, 10]), false)
  assert.equal(outOfOrder([1, 3, 2]), true)
  assert.equal(outOfOrder(['a', 1]), true)
  assert.equal(outOfOrder([1, 'a', '']), false)
})

test('snapshot → change → highlight paints the right display cells and nothing else', () => {
  const ss = buildWorkbook({ rows: 20 })
  setActiveSpreadsheet(ss)
  snapshot()
  for (const t of TRACKER_SPECS)
    assert.ok(ss.getSheetByName(snapshotSheetName(t.key))!.hidden)

  const qData = ss.getSheetByName('STARTER_CHECKLIST.data')!
  qData.load(Q.dataFirstRow, Q.dataShinyCol, [[1]]) // Bulbasaur SHINY
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

  const sDisp = ss.getSheetByName('Starter Dex Checklist')!
  assert.equal(sDisp.backgroundAt(4, 14), INCREMENT_HIGHLIGHT_COLOR)
  assert.equal(sDisp.backgroundAt(4, 5), null, 'Fought Count is excluded')
  assert.equal(sDisp.backgroundAt(5, 14), null)
  assert.equal(
    ss.getSheetByName('Full Dex Checklist')!.backgroundAt(5, 4),
    DEX_HIGHLIGHT_COLOR,
  )

  // Painting never touches columns left of the block (creator's A–G / A–C).
  assert.ok(
    !calls.some((c) => /Quick Checklist\.setBackgrounds\(\d+,[1-7],/.test(c)),
    'no writes into A–G',
  )
})

test('processChanges: full flow; a no-change upload clears old highlights and costs few calls', () => {
  const ss = buildWorkbook({ rows: 20 })
  setActiveSpreadsheet(ss)
  resetToastProgress('upload')
  processChanges()
  assert.ok(ss.getSheetByName(snapshotSheetName('QuickChecklist')))
  const form = ss.getSheetByName('Form Checklist')!
  assert.deepEqual(
    form
      .grid()
      .slice(1)
      .map((r) => r[2]),
    ['☐', '☐', '☑', '☑'],
  )
  assert.equal(
    ss.getSheetByName(TIMINGS_SHEET)!.grid().at(-1)![3],
    'TOTAL (ok)',
  )

  ss.getSheetByName('STARTER_CHECKLIST.data')!.load(12, 4, [[1]])
  resetToastProgress('upload')
  processChanges()
  assert.equal(
    ss.getSheetByName('Quick Checklist')!.backgroundAt(12, 8),
    QUICK_CHECKLIST_HIGHLIGHT_COLOR,
  )

  calls.length = 0
  resetToastProgress('upload')
  processChanges()
  assert.equal(
    ss.getSheetByName('Quick Checklist')!.backgroundAt(12, 8),
    null,
    'previous highlight cleared by the paint',
  )
  assert.ok(
    logs.some((l) => l.includes('QuickChecklist: highlighted 0 changed cells')),
  )
  const sheetCalls = calls.filter(
    (c) =>
      !c.startsWith('toast') &&
      !c.startsWith('_timings') &&
      !c.startsWith('getSheetByName'),
  )
  console.log(
    `      [info] Sheets calls for one no-change upload (20 rows): ${sheetCalls.length} (+${calls.length - sheetCalls.length} toasts/timings/lookups)`,
  )
  assert.ok(
    sheetCalls.length <= 45,
    `expected ≤45 sheet calls, got ${sheetCalls.length}:\n${sheetCalls.join('\n')}`,
  )
  assert.equal(
    calls.filter((c) => c.includes('.sort(')).length,
    1,
    'only the Form Checklist sort; displays were in order',
  )
})

test('an out-of-order display is re-sorted before painting', () => {
  const ss = buildWorkbook({ rows: 6 })
  setActiveSpreadsheet(ss)
  snapshot()
  const qDisp = ss.getSheetByName('Quick Checklist')!
  // Reverse the display rows (as a slicer sort would)
  const rows = qDisp.readValues(12, 1, 6, 17).reverse()
  qDisp.load(12, 1, rows)
  ss.getSheetByName('STARTER_CHECKLIST.data')!.load(12, 4, [[1]]) // Bulbasaur (#1)
  highlightChanges()
  assert.equal(qDisp.valueAt(12, 1), 1, 'display re-sorted to canonical order')
  assert.equal(qDisp.backgroundAt(12, 8), QUICK_CHECKLIST_HIGHLIGHT_COLOR)
  assert.ok(calls.some((c) => c.startsWith('Quick Checklist.sort(')))
})

test('processChanges with skipSnapshot keeps the baseline', () => {
  const ss = buildWorkbook({ rows: 5 })
  setActiveSpreadsheet(ss)
  snapshot()
  ss.getSheetByName('STARTER_CHECKLIST.data')!.load(12, 4, [[1]])
  resetToastProgress('upload')
  processChanges({ skipSnapshot: true })
  resetToastProgress('upload')
  processChanges({ skipSnapshot: true })
  assert.equal(
    ss.getSheetByName('Quick Checklist')!.backgroundAt(12, 8),
    QUICK_CHECKLIST_HIGHLIGHT_COLOR,
  )
})

test('clearHighlights blanks the tracked block only', () => {
  const ss = buildWorkbook({ rows: 5 })
  setActiveSpreadsheet(ss)
  snapshot()
  ss.getSheetByName('STARTER_CHECKLIST.data')!.load(12, 4, [[1]])
  highlightChanges()
  const q = ss.getSheetByName('Quick Checklist')!
  q.load(12, 2, [['x']])
  q.writeBackgrounds(12, 2, [['#123456']]) // a creator fill in the image column
  clearHighlights()
  assert.equal(q.backgroundAt(12, 8), null)
  assert.equal(q.backgroundAt(12, 2), '#123456', 'untouched outside the block')
})

test('upgrade: a v1 snapshot (header-offset rows) diffs correctly once, then v2 is written', () => {
  const ss = buildWorkbook({ rows: 5 })
  setActiveSpreadsheet(ss)
  // Hand-build the old layout: Quick snapshot header in row 1, data from row 2 (headerRows 1 + 1)
  const data = ss.getSheetByName('STARTER_CHECKLIST.data')!
  const old = ss.addSheet(snapshotSheetName('QuickChecklist'))
  old.load(1, 4, [data.readValues(1, 4, 1, 8)[0]!])
  old.load(2, 4, data.readValues(12, 4, 5, 8))
  // Dex snapshots: two header rows, data from row 3
  for (const [key, name, col] of [
    ['StarterDex', 'STARTER_DEX.data', 12],
    ['FullDex', 'FULL_DEX.data', 8],
  ] as const) {
    const d = ss.getSheetByName(name)!
    const s = ss.addSheet(snapshotSheetName(key))
    const width = d.getLastColumn() - col + 1
    s.load(1, col, d.readValues(1, col, 2, width))
    s.load(3, col, d.readValues(3, col, 5, width))
  }
  // Legacy markers in the old marker columns
  ss.getSheetByName('Quick Checklist')!.load(12, 17, [
    ['●'],
    [''],
    ['●'],
    [''],
    [''],
  ])

  data.load(14, 4, [[42]]) // row 14 SHINY changes
  resetToastProgress('upload')
  processChanges()
  const q = ss.getSheetByName('Quick Checklist')!
  assert.equal(
    q.backgroundAt(14, 8),
    QUICK_CHECKLIST_HIGHLIGHT_COLOR,
    'diffed against the v1 rows',
  )
  assert.equal(q.backgroundAt(12, 8), null)
  assert.equal(q.valueAt(12, 17), '', 'legacy markers cleared')
  const props = PropertiesService.getDocumentProperties()
  assert.equal(props.getProperty(SNAPSHOT_FORMAT_PROPERTY), '2')
  assert.equal(props.getProperty(LEGACY_MARKERS_PROPERTY), 'true')
  // v2 layout: data at row 12
  assert.equal(
    ss.getSheetByName(snapshotSheetName('QuickChecklist'))!.valueAt(14, 4),
    42,
  )

  // Second upload, no change → nothing painted
  resetToastProgress('upload')
  processChanges()
  assert.equal(q.backgroundAt(14, 8), null)
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
  const disp = ss.getSheetByName('Starter Dex Checklist')!
  disp.load(2, 4, [['Seen Flag']]) // creator renamed the anchor in the display
  resetToastProgress('upload')
  assert.throws(
    () => processChanges(),
    /could not find the header "Fought Flag" .* "Starter Dex Checklist"/,
  )
  assert.equal(disp.backgroundAt(4, 4), null)
})
