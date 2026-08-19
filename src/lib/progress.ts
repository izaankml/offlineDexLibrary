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
 * exactly what lets `uploadFileTracked` (bound) start a flow that
 * `processChanges` (library) continues.
 */

type Spreadsheet = GoogleAppsScript.Spreadsheet.Spreadsheet

export const TIMINGS_SHEET = '_timings'
const TIMINGS_HEADER = ['when', 'sheet', 'flow', 'step', 'ms']
/** Pixel widths so the ISO timestamp, sheet name and step labels are readable without resizing. */
const TIMINGS_COLUMN_WIDTHS = [220, 200, 90, 300, 90]
const TIMINGS_WIDTHS_PROPERTY = 'OFFLINEDEX_TIMINGS_WIDTHS'
/** Keep the timings sheet from growing forever: oldest rows are dropped past this. */
const TIMINGS_MAX_ROWS = 2000

type Step = { label: string; ms: number }
type Flow = {
  name: string
  startedAt: number
  steps: Step[]
  currentStep: { label: string; startedAt: number } | null
}

let activeFlow: Flow | null = null

/** Last completed step, for the toast body. */
function lastStepText(): string {
  const lastStep = activeFlow?.steps[activeFlow.steps.length - 1]
  return lastStep
    ? `${lastStep.label} completed in ${(lastStep.ms / 1000).toFixed(1)}s`
    : ''
}

/**
 * Start a new toast-tracked flow. Call once at the top of a multi-step
 * operation (e.g., uploadFileTracked) before the first startStep.
 * @param name - short flow name recorded in the timing log ("upload",
 *   "migration", ...).
 */
export function resetToastProgress(name: string): void {
  activeFlow = { name, startedAt: Date.now(), steps: [], currentStep: null }
}

/** True while a flow is open (used to nest standalone entry points). */
export function flowActive(): boolean {
  return activeFlow !== null
}

/**
 * Mark the start of a tracked step. Shows a sticky toast whose title is the
 * new step's label and whose body summarizes the previous step's timing.
 * Finishes any step still open (so a forgotten finishStep can't lose data).
 */
export function startStep(spreadsheet: Spreadsheet, label: string): void {
  if (!activeFlow) resetToastProgress('flow')
  finishStep()
  spreadsheet.toast(lastStepText(), label, -1)
  activeFlow!.currentStep = { label, startedAt: Date.now() }
}

/** Record how long the in-progress step took. No-op if none is open. */
export function finishStep(): void {
  if (!activeFlow?.currentStep) return
  const { label, startedAt } = activeFlow.currentStep
  activeFlow.steps.push({ label, ms: Date.now() - startedAt })
  activeFlow.currentStep = null
}

/**
 * Run `work` as part of an outer flow if one exists, otherwise as a self-managed
 * standalone flow (reset before, completion toast + timing log after).
 */
export function runStandaloneIfNeeded(
  spreadsheet: Spreadsheet,
  label: string,
  work: () => void,
): void {
  if (activeFlow) {
    work()
    return
  }
  resetToastProgress(label.toLowerCase())
  try {
    work()
  } catch (error) {
    failFlow(spreadsheet, error)
    throw error
  }
  finishFlow(spreadsheet, `${label} done`)
}

/**
 * Show the final "X in Ns" toast, write the timing log, and close the flow.
 * @param title - the leading phrase; total elapsed is appended
 * @param timeoutSeconds - how long the toast stays up (default 5)
 */
export function finishFlow(
  spreadsheet: Spreadsheet,
  title: string,
  timeoutSeconds = 5,
): void {
  if (!activeFlow) return
  finishStep()
  const totalMs = Date.now() - activeFlow.startedAt
  spreadsheet.toast(
    lastStepText(),
    `${title} in ${(totalMs / 1000).toFixed(1)}s`,
    timeoutSeconds,
  )
  writeTimings(spreadsheet, activeFlow, totalMs, 'ok')
  activeFlow = null
}

/**
 * Close the flow after an error: a visible (non-sticky) error toast, a log
 * line, and the timings so far are still written. Never throws.
 */
export function failFlow(spreadsheet: Spreadsheet, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  try {
    spreadsheet.toast(message, 'Something went wrong', 20)
  } catch {
    /* toast is best-effort */
  }
  Logger.log(`${activeFlow?.name ?? 'flow'} failed: ${message}`)
  if (!activeFlow) return
  finishStep()
  const totalMs = Date.now() - activeFlow.startedAt
  try {
    writeTimings(spreadsheet, activeFlow, totalMs, `error: ${message}`)
  } catch (writeError) {
    Logger.log(
      'timing log failed: ' +
        (writeError instanceof Error ? writeError.message : writeError),
    )
  }
  activeFlow = null
}

/** The rows a finished flow contributes to `_timings` (pure; tested). */
export function timingRows(
  flow: Pick<Flow, 'name' | 'steps'>,
  totalMs: number,
  outcome: string,
  when: Date,
  sheetName: string,
): (string | number)[][] {
  const timestamp = when.toISOString()
  const rows: (string | number)[][] = flow.steps.map((step) => [
    timestamp,
    sheetName,
    flow.name,
    step.label,
    step.ms,
  ])
  rows.push([timestamp, sheetName, flow.name, `TOTAL (${outcome})`, totalMs])
  return rows
}

function writeTimings(
  spreadsheet: Spreadsheet,
  flow: Flow,
  totalMs: number,
  outcome: string,
): void {
  let timingsSheet = spreadsheet.getSheetByName(TIMINGS_SHEET)
  if (!timingsSheet) {
    timingsSheet = spreadsheet.insertSheet(TIMINGS_SHEET)
    timingsSheet.hideSheet()
    timingsSheet
      .getRange(1, 1, 1, TIMINGS_HEADER.length)
      .setValues([TIMINGS_HEADER])
  }
  // Column widths, once per workbook (also fixes sheets created before widths existed).
  const docProps = PropertiesService.getDocumentProperties()
  if (docProps.getProperty(TIMINGS_WIDTHS_PROPERTY) !== '1') {
    TIMINGS_COLUMN_WIDTHS.forEach((width, index) =>
      timingsSheet!.setColumnWidth(index + 1, width),
    )
    docProps.setProperty(TIMINGS_WIDTHS_PROPERTY, '1')
  }
  // Newest flow on top: its rows go right under the header, followed by a
  // blank separator row so consecutive flows are easy to tell apart.
  const rows = timingRows(
    flow,
    totalMs,
    outcome,
    new Date(),
    spreadsheet.getName(),
  )
  const block: (string | number)[][] = [...rows, TIMINGS_HEADER.map(() => '')]
  timingsSheet.insertRowsBefore(2, block.length)
  timingsSheet
    .getRange(2, 1, block.length, TIMINGS_HEADER.length)
    .setValues(block)
  const lastRow = timingsSheet.getLastRow()
  if (lastRow > TIMINGS_MAX_ROWS) {
    timingsSheet.deleteRows(TIMINGS_MAX_ROWS + 1, lastRow - TIMINGS_MAX_ROWS)
  }
}
