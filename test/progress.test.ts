import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { calls, resetFakes, setActiveSpreadsheet, toasts } from './fake-gas.ts'
import { buildWorkbook } from './fixtures.ts'
import {
  TIMINGS_SHEET,
  failFlow,
  finishFlow,
  finishStep,
  flowActive,
  resetToastProgress,
  runStandaloneIfNeeded,
  startStep,
  timingRows,
} from '../src/lib/progress.ts'

beforeEach(() => resetFakes())

test('timingRows: one row per step plus a TOTAL row', () => {
  const rows = timingRows(
    { name: 'upload', steps: [{ label: 'a', ms: 10 }, { label: 'b', ms: 20 }] },
    35,
    'ok',
    new Date('2026-08-18T00:00:00Z'),
    'Offline RogueDex 6.03',
  )
  assert.deepEqual(rows, [
    ['2026-08-18T00:00:00.000Z', 'Offline RogueDex 6.03', 'upload', 'a', 10],
    ['2026-08-18T00:00:00.000Z', 'Offline RogueDex 6.03', 'upload', 'b', 20],
    ['2026-08-18T00:00:00.000Z', 'Offline RogueDex 6.03', 'upload', 'TOTAL (ok)', 35],
  ])
})

test('a flow writes _timings once, hidden, with a header, and closes', () => {
  const ss = buildWorkbook({ rows: 3 })
  setActiveSpreadsheet(ss)
  resetToastProgress('upload')
  startStep(ss as never, 'one')
  finishStep()
  startStep(ss as never, 'two')
  finishFlow(ss as never, 'Done')
  assert.equal(flowActive(), false)
  const t = ss.getSheetByName(TIMINGS_SHEET)!
  assert.ok(t.hidden)
  assert.deepEqual(t.grid()[0], ['when', 'sheet', 'flow', 'step', 'ms'])
  assert.equal(t.getLastRow(), 4) // header + 2 steps + TOTAL
  assert.equal(calls.filter((c) => c.startsWith('_timings.setValues')).length, 2) // header + rows
  assert.equal(toasts.at(-1)!.title.startsWith('Done in'), true)
})

test('failFlow shows a non-sticky error toast and still records timings', () => {
  const ss = buildWorkbook({ rows: 3 })
  setActiveSpreadsheet(ss)
  resetToastProgress('upload')
  startStep(ss as never, 'boom')
  failFlow(ss as never, new Error('kaput'))
  const last = toasts.at(-1)!
  assert.equal(last.title, 'Something went wrong')
  assert.equal(last.body, 'kaput')
  assert.ok(last.timeout > 0)
  const rows = ss.getSheetByName(TIMINGS_SHEET)!.grid()
  assert.equal(rows.at(-1)![3], 'TOTAL (error: kaput)')
  assert.equal(flowActive(), false)
})

test('runStandaloneIfNeeded nests inside an open flow, stands alone otherwise', () => {
  const ss = buildWorkbook({ rows: 3 })
  setActiveSpreadsheet(ss)
  let ran = 0
  runStandaloneIfNeeded(ss as never, 'Solo', () => ran++)
  assert.equal(ran, 1)
  assert.equal(flowActive(), false)
  resetToastProgress('outer')
  runStandaloneIfNeeded(ss as never, 'Inner', () => ran++)
  assert.equal(ran, 2)
  assert.equal(flowActive(), true) // outer flow still open
  finishFlow(ss as never, 'Outer done')
})
