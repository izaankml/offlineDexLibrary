import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { calls, logs, resetFakes, setActiveSpreadsheet, toasts } from './fake-gas.ts'
import { LAYOUT_603, buildWorkbook } from './fixtures.ts'
import { TIMINGS_SHEET, resetToastProgress } from '../src/lib/progress.ts'
import {
  DEX_HIGHLIGHT_COLOR,
  INCREMENT_HIGHLIGHT_COLOR,
  QUICK_CHECKLIST_HIGHLIGHT_COLOR,
  TRACKERS,
  cellMappingsFor,
  clearHighlights,
  diffChunk,
  highlightChanges,
  markerColumnFor,
  processChanges,
  snapshot,
  snapshotSheetName,
  toRuns,
} from '../src/lib/saveTracker.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

beforeEach(() => resetFakes())

/** What the 6.03 layout resolves to today. Guards the header-keyed rewrite. */
test('golden: tracker column mappings for the 6.03 layout', () => {
  const golden = JSON.parse(readFileSync(join(HERE, 'fixtures', 'golden-mappings.json'), 'utf8'))
  const actual = Object.fromEntries(
    TRACKERS.map((t) => [
      t.key,
      {
        dataFirstRow: t.dataFirstRow,
        displayFirstRow: t.displayFirstRow,
        marker: markerColumnFor(t),
        cells: cellMappingsFor(t).map((m) => [m.idx, m.displayIdx + 1, m.color]),
      },
    ]),
  )
  assert.deepEqual(actual, golden)
})

test('toRuns collapses contiguous offsets', () => {
  assert.deepEqual(toRuns([]), [])
  assert.deepEqual(toRuns([0, 1, 2, 5, 7, 8]), [
    { start: 0, count: 3 },
    { start: 5, count: 1 },
    { start: 7, count: 2 },
  ])
})

test('diffChunk paints changed cells in the mapped colour and flags rows', () => {
  const mappings = [
    { idx: 0, displayIdx: 2, color: 'red' },
    { idx: 1, displayIdx: 3, color: 'blue' },
  ]
  const r = diffChunk([[0, 1], [1, 1]], [[0, 2], [1, 1]], mappings, 5)
  assert.deepEqual(r.backgrounds, [
    [null, null, null, 'blue', null],
    [null, null, null, null, null],
  ])
  assert.deepEqual(r.rowChanged, [true, false])
  assert.equal(r.changed, 1)
})

test('snapshot → change → highlight paints the right display cells', () => {
  const ss = buildWorkbook({ rows: 20 })
  setActiveSpreadsheet(ss)
  snapshot()
  for (const t of TRACKERS) {
    const snap = ss.getSheetByName(snapshotSheetName(t.key))!
    assert.ok(snap.hidden, t.key + ' snapshot hidden')
  }

  const Q = LAYOUT_603.quick
  const qData = ss.getSheetByName('STARTER_CHECKLIST.data')!
  // Bulbasaur (row 12): SHINY 0 -> 1 ; row 15: Max IVs changes
  qData.load(Q.dataFirstRow, Q.dataShinyCol, [[1]])
  qData.load(Q.dataFirstRow + 3, Q.dataMaxIvsCol, [[99]])
  // Starter dex: row 3, "Caught Count" (data col 22 → display N=14) increments; "Fought Count" (excluded) changes too
  const sData = ss.getSheetByName('STARTER_DEX.data')!
  sData.load(3, 22, [[999]])
  sData.load(3, 13, [[999]])

  highlightChanges()

  const qDisp = ss.getSheetByName('Quick Checklist')!
  assert.equal(qDisp.backgroundAt(12, Q.displayShinyCol), QUICK_CHECKLIST_HIGHLIGHT_COLOR)
  assert.equal(qDisp.backgroundAt(15, Q.displayMaxIvsCol), QUICK_CHECKLIST_HIGHLIGHT_COLOR)
  assert.equal(qDisp.backgroundAt(13, Q.displayShinyCol), null)
  assert.equal(qDisp.valueAt(12, 17), '●', 'marker written on changed row')
  assert.equal(qDisp.valueAt(13, 17), '', 'no marker on unchanged row')

  const sDisp = ss.getSheetByName('Starter Dex Checklist')!
  assert.equal(sDisp.backgroundAt(4, 14), INCREMENT_HIGHLIGHT_COLOR, 'Caught Count is an increment column')
  assert.equal(sDisp.backgroundAt(4, 5), null, 'Fought Count is excluded')
  assert.equal(sDisp.backgroundAt(5, 14), null)

  // A plain unlock uses the dex colour
  const fData = ss.getSheetByName('FULL_DEX.data')!
  fData.load(4, 8, [[7]]) // Fought Flag row 4 → display row 5 col D
  highlightChanges()
  assert.equal(ss.getSheetByName('Full Dex Checklist')!.backgroundAt(5, 4), DEX_HIGHLIGHT_COLOR)
})

test('processChanges: full flow re-snapshots, sorts Form Checklist, logs timings; second run paints nothing', () => {
  const ss = buildWorkbook({ rows: 20 })
  setActiveSpreadsheet(ss)
  resetToastProgress('upload')
  processChanges()
  // First run: no snapshot yet → nothing painted, snapshot created
  assert.ok(ss.getSheetByName(snapshotSheetName('QuickChecklist')))
  const form = ss.getSheetByName('Form Checklist')!
  assert.deepEqual(form.grid().slice(1).map((r) => r[2]), ['☐', '☐', '☑', '☑'])
  assert.equal(ss.getSheetByName(TIMINGS_SHEET)!.grid().at(-1)![3], 'TOTAL (ok)')

  ss.getSheetByName('STARTER_CHECKLIST.data')!.load(12, 4, [[1]])
  resetToastProgress('upload')
  processChanges()
  assert.equal(ss.getSheetByName('Quick Checklist')!.backgroundAt(12, 8), QUICK_CHECKLIST_HIGHLIGHT_COLOR)

  // Same save again: the previous highlight is cleared, nothing new
  calls.length = 0
  resetToastProgress('upload')
  processChanges()
  assert.equal(ss.getSheetByName('Quick Checklist')!.backgroundAt(12, 8), null)
  assert.ok(logs.some((l) => l.includes('QuickChecklist: highlighted 0 changed cells')))
  console.log(`      [info] Sheets calls for one no-change upload (20 rows): ${calls.length}`)
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
  assert.equal(ss.getSheetByName('Quick Checklist')!.backgroundAt(12, 8), QUICK_CHECKLIST_HIGHLIGHT_COLOR, 'still highlighted against the kept baseline')
})

test('clearHighlights removes fills and markers', () => {
  const ss = buildWorkbook({ rows: 5 })
  setActiveSpreadsheet(ss)
  snapshot()
  ss.getSheetByName('STARTER_CHECKLIST.data')!.load(12, 4, [[1]])
  highlightChanges()
  clearHighlights()
  const q = ss.getSheetByName('Quick Checklist')!
  assert.equal(q.backgroundAt(12, 8), null)
  assert.equal(q.valueAt(12, 17), '')
})

test('a missing sheet fails the flow visibly instead of leaving a sticky toast', () => {
  const ss = buildWorkbook({ rows: 5 })
  ss.deleteSheet(ss.getSheetByName('FULL_DEX.data')!)
  setActiveSpreadsheet(ss)
  resetToastProgress('upload')
  assert.throws(() => processChanges(), /Required sheet not found for FullDex/)
  const last = toasts.at(-1)!
  assert.equal(last.title, 'Something went wrong')
  assert.notEqual(last.timeout, -1)
})
