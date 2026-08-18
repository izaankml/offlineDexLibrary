/**
 * Toast progress + timing log shared by every flow (upload, migration, ...).
 *
 * A "flow" is one user-visible operation made of tracked steps. A single
 * replacing toast shows the current step; the body reports how long the
 * previous step took. When the flow finishes, every step's duration is
 * appended to the hidden `_timings` sheet in ONE write, so speed-ups and
 * regressions are measurable across versions.
 *
 * Module state persists for the length of one Apps Script execution, which is
 * exactly what lets `uploadFile` (bound) start a flow that `processChanges`
 * (library) continues.
 */

type Spreadsheet = GoogleAppsScript.Spreadsheet.Spreadsheet

export const TIMINGS_SHEET = '_timings'
const TIMINGS_HEADER = ['when', 'sheet', 'flow', 'step', 'ms']
/** Keep the timings sheet from growing forever: oldest rows are dropped past this. */
const TIMINGS_MAX_ROWS = 2000

type Step = { label: string; ms: number }
type Flow = {
  name: string
  start: number
  steps: Step[]
  current: { label: string; start: number } | null
}

let flow: Flow | null = null

/** Last completed step, for the toast body. */
function lastStepText(): string {
  const last = flow?.steps[flow.steps.length - 1]
  return last ? `${last.label} completed in ${(last.ms / 1000).toFixed(1)}s` : ''
}

/**
 * Start a new toast-tracked flow. Call once at the top of a multi-step
 * operation (e.g., uploadFile) before the first startStep.
 * @param name - short flow name recorded in the timing log ("upload",
 *   "migration", ...). Defaults to "upload" so the existing bound call keeps working.
 */
export function resetToastProgress(name = 'upload'): void {
  flow = { name, start: Date.now(), steps: [], current: null }
}

/** True while a flow is open (used to nest standalone entry points). */
export function flowActive(): boolean {
  return flow !== null
}

/**
 * Mark the start of a tracked step. Shows a sticky toast whose title is the
 * new step's label and whose body summarizes the previous step's timing.
 * Finishes any step still open (so a forgotten finishStep can't lose data).
 */
export function startStep(ss: Spreadsheet, label: string): void {
  if (!flow) resetToastProgress()
  finishStep()
  ss.toast(lastStepText(), label, -1)
  flow!.current = { label, start: Date.now() }
}

/** Record how long the in-progress step took. No-op if none is open. */
export function finishStep(): void {
  if (!flow?.current) return
  const { label, start } = flow.current
  flow.steps.push({ label, ms: Date.now() - start })
  flow.current = null
}

/**
 * Run `fn` as part of an outer flow if one exists, otherwise as a self-managed
 * standalone flow (reset before, completion toast + timing log after).
 */
export function runStandaloneIfNeeded(
  ss: Spreadsheet,
  label: string,
  fn: () => void,
): void {
  if (flow) {
    fn()
    return
  }
  resetToastProgress(label.toLowerCase())
  try {
    fn()
  } catch (e) {
    failFlow(ss, e)
    throw e
  }
  finishFlow(ss, `${label} done`)
}

/**
 * Show the final "X in Ns" toast, write the timing log, and close the flow.
 * @param title - the leading phrase; total elapsed is appended
 * @param timeoutSeconds - how long the toast stays up (default 5)
 */
export function finishFlow(
  ss: Spreadsheet,
  title: string,
  timeoutSeconds = 5,
): void {
  if (!flow) return
  finishStep()
  const total = Date.now() - flow.start
  ss.toast(lastStepText(), `${title} in ${(total / 1000).toFixed(1)}s`, timeoutSeconds)
  writeTimings(ss, flow, total, 'ok')
  flow = null
}

/**
 * Close the flow after an error: a visible (non-sticky) error toast, a log
 * line, and the timings so far are still written. Never throws.
 */
export function failFlow(ss: Spreadsheet, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  try {
    ss.toast(message, 'Something went wrong', 20)
  } catch {
    /* toast is best-effort */
  }
  Logger.log(`${flow?.name ?? 'flow'} failed: ${message}`)
  if (!flow) return
  finishStep()
  const total = Date.now() - flow.start
  try {
    writeTimings(ss, flow, total, `error: ${message}`)
  } catch (e) {
    Logger.log('timing log failed: ' + (e instanceof Error ? e.message : e))
  }
  flow = null
}

/** The rows a finished flow contributes to `_timings` (pure; tested). */
export function timingRows(
  f: Pick<Flow, 'name' | 'steps'>,
  totalMs: number,
  outcome: string,
  when: Date,
  sheetName: string,
): (string | number)[][] {
  const stamp = when.toISOString()
  const rows: (string | number)[][] = f.steps.map((s) => [
    stamp,
    sheetName,
    f.name,
    s.label,
    s.ms,
  ])
  rows.push([stamp, sheetName, f.name, `TOTAL (${outcome})`, totalMs])
  return rows
}

function writeTimings(ss: Spreadsheet, f: Flow, totalMs: number, outcome: string): void {
  let sheet = ss.getSheetByName(TIMINGS_SHEET)
  if (!sheet) {
    sheet = ss.insertSheet(TIMINGS_SHEET)
    sheet.hideSheet()
    sheet.getRange(1, 1, 1, TIMINGS_HEADER.length).setValues([TIMINGS_HEADER])
  }
  const rows = timingRows(f, totalMs, outcome, new Date(), ss.getName())
  const lastRow = sheet.getLastRow()
  sheet.getRange(lastRow + 1, 1, rows.length, TIMINGS_HEADER.length).setValues(rows)
  const excess = lastRow + 1 + rows.length - 1 - TIMINGS_MAX_ROWS
  if (excess > 0) sheet.deleteRows(2, excess)
}
