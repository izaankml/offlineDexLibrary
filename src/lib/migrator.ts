/**
 * MIGRATOR
 *
 * Ports your customizations from an old OfflineDex spreadsheet to a new one.
 * Called from the destination spreadsheet's bound script via
 * OfflineDexLib.portAll(sourceVersion, destVersion).
 */

import { copyName } from '../shared/naming.ts'
import { finishFlow, finishStep, resetToastProgress, startStep } from './progress.ts'

type Spreadsheet = GoogleAppsScript.Spreadsheet.Spreadsheet
type Sheet = GoogleAppsScript.Spreadsheet.Sheet
type Range = GoogleAppsScript.Spreadsheet.Range
type ConditionalFormatRule = GoogleAppsScript.Spreadsheet.ConditionalFormatRule

// Quick Checklist column layout. Columns A-D (#, image, Dex#, name) are
// fixed; the data block ("Caught?" … "Ribbons", QUICK_CHECKLIST_DATA_COLUMNS
// wide) starts at E in creator 6.01 and at F from 6.03 on (the creator added
// a hidden junk column E). The migrator adopts the creator's layout as-is and
// locates each sheet's data block by the first non-blank cell in row 10 right
// of D. The Ribbons column (last of the block) is hidden after the port.
export const QUICK_CHECKLIST_FIXED_COLUMNS = 4
export const QUICK_CHECKLIST_DATA_COLUMNS = 11
export const QUICK_CHECKLIST_LOCATOR_ROW = 10
export const QUICK_CHECKLIST_TITLE_CELL = 'A1'
export const QUICK_CHECKLIST_TITLE_PREFIX = 'POKEROGUE DEX '
export const QUICK_CHECKLIST_IMAGE_COLUMN = 2

// Daily Mode has a custom column L (map-size inputs in L12:M14 feed the
// IMAGE formula in B16). Whether it's present is detected by a landmark: the
// creator's "Missing Gym Leader Voucher…" header, at N2 when the custom
// column exists (source) and at M2 when it doesn't (fresh copy).
export const DAILY_MODE_LANDMARK_WITH_L = 'N2'
export const DAILY_MODE_LANDMARK_WITHOUT_L = 'M2'
export const B16_MERGE_RANGE = 'B16:M131'
export const DAILY_MODE_FORMAT_RANGES = [B16_MERGE_RANGE, 'L12:M14']

// IV conditional formatting on the dex checklists: swap "yellow when = 31"
// for "red when NOT 31" over the same range.
export const DEX_IV_HIGHLIGHT_SHEETS = ['Starter Dex Checklist', 'Full Dex Checklist']
export const DEX_IV_PERFECT_VALUE = '31'
export const DEX_IV_IMPERFECT_COLOR = '#ea9999' // red

export type StepResult = { label: string; ok: boolean; error?: string }

/**
 * Top-level migration entry. Runs each step against the source and destination
 * spreadsheets, catching per-step errors so one failure doesn't block the rest.
 * Returns the per-step results (the caller decides how to surface them) and
 * logs an OK/ERR summary.
 */
export function portAll(sourceVersion: string, destVersion: string): StepResult[] {
  const ss = SpreadsheetApp.getActiveSpreadsheet()
  resetToastProgress('migration')

  startStep(ss, 'Looking up spreadsheets')
  const srcId = findFileIdByVersion(sourceVersion)
  Logger.log('Source: ' + sourceVersion + ' -> ' + srcId)
  Logger.log('Dest:   ' + destVersion + ' -> ' + ss.getId() + ' (active)')
  const src = SpreadsheetApp.openById(srcId)
  const dst = ss
  finishStep()

  const results: StepResult[] = []
  const safeRun = (label: string, fn: () => void): void => {
    startStep(ss, label)
    try {
      fn()
      results.push({ label, ok: true })
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      results.push({ label, ok: false, error })
    }
    finishStep()
  }

  safeRun('Formatting Quick Checklist', () => portQuickChecklistHeader(src, dst, destVersion))
  safeRun('Banding Quick Checklist images', () => portQuickChecklistImageBanding(dst))
  safeRun('Formatting Daily Mode', () => portDailyModeFormatting(src, dst))
  safeRun('Updating Daily Mode Cells', () => portDailyModeCells(src, dst))
  safeRun('Hiding sheets', () => portHiddenSheets(src, dst))
  safeRun('Updating dex IV highlights', () => portDexIvHighlight(dst))

  const failed = results.filter((r) => !r.ok).length
  finishFlow(ss, failed ? `Migration finished with ${failed} error(s)` : 'Migration complete', 10)
  Logger.log(formatResults(results))
  return results
}

/** "OK  label" / "ERR label: message" lines. */
export function formatResults(results: StepResult[]): string {
  return results.map((r) => (r.ok ? 'OK  ' + r.label : 'ERR ' + r.label + ': ' + r.error)).join('\n')
}

/**
 * Port rows 1-10 of the Quick Checklist sheet: cell formatting, row heights,
 * column widths, and row hidden states; formulas (falling back to values) for
 * row 1's data columns and all of row 10; hide the Ribbons column; stamp the
 * destination version into A1. Uses a temp copy of the source sheet inside
 * the destination because copyTo() can't cross spreadsheets.
 */
export function portQuickChecklistHeader(src: Spreadsheet, dst: Spreadsheet, destVersion: string): void {
  const sName = 'Quick Checklist'
  const sSheet = src.getSheetByName(sName)
  const dSheet = dst.getSheetByName(sName)
  if (!sSheet || !dSheet) throw new Error('Quick Checklist not found')

  const tempSheet = sSheet.copyTo(dst)
  try {
    const first = alignQuickChecklistTemp(tempSheet, dSheet)
    const lastData = first + QUICK_CHECKLIST_DATA_COLUMNS - 1

    const cols = tempSheet.getMaxColumns()
    const dCols = dSheet.getMaxColumns()
    if (dCols < cols) dSheet.insertColumnsAfter(dCols, cols - dCols)

    tempSheet
      .getRange(1, 1, 10, cols)
      .copyTo(dSheet.getRange(1, 1, 10, cols), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false)

    for (let r = 1; r <= 10; r++) {
      dSheet.setRowHeight(r, tempSheet.getRowHeight(r))
      if (tempSheet.isRowHiddenByUser(r)) dSheet.hideRows(r)
      else dSheet.showRows(r)
    }
    for (let c = 1; c <= cols; c++) {
      dSheet.setColumnWidth(c, tempSheet.getColumnWidth(c))
    }

    const portRowSlice = (rowNum: number, startCol: number, endCol: number): void => {
      const numCols = endCol - startCol + 1
      copyFormulasOrValues(tempSheet.getRange(rowNum, startCol, 1, numCols), dSheet.getRange(rowNum, startCol, 1, numCols))
    }
    portRowSlice(1, first, lastData)
    portRowSlice(10, 1, cols)

    dSheet.hideColumns(lastData) // Ribbons
  } finally {
    dst.deleteSheet(tempSheet)
  }

  setQuickChecklistTitle(dSheet, destVersion)
}

/**
 * Make the temp copy of the source Quick Checklist match the destination's
 * column layout, and return the (shared) column where the data block starts.
 */
export function alignQuickChecklistTemp(tempSheet: Sheet, dSheet: Sheet): number {
  const srcFirst = quickChecklistFirstDataColumn(tempSheet, 'source')
  const dstFirst = quickChecklistFirstDataColumn(dSheet, 'destination')
  const offset = dstFirst - srcFirst
  if (offset < 0) {
    throw new Error(
      `Quick Checklist: destination data block starts at column ${dstFirst}, left of the source's ${srcFirst}; layout unknown, nothing ported`,
    )
  }
  if (offset > 0) {
    tempSheet.insertColumnsBefore(srcFirst, offset)
    Logger.log(`Quick Checklist: source data block shifted right by ${offset} to match the destination (column ${dstFirst})`)
  }
  return dstFirst
}

/** Column where a Quick Checklist's data block starts (first non-blank in row 10 right of D). */
export function quickChecklistFirstDataColumn(sheet: Sheet, which: string): number {
  const start = QUICK_CHECKLIST_FIXED_COLUMNS + 1
  const width = sheet.getMaxColumns() - start + 1
  const row10 = sheet.getRange(QUICK_CHECKLIST_LOCATOR_ROW, start, 1, width).getDisplayValues()[0] ?? []
  const idx = row10.findIndex((v) => String(v).trim() !== '')
  if (idx === -1) {
    throw new Error(
      `Quick Checklist (${which}): row ${QUICK_CHECKLIST_LOCATOR_ROW} is blank right of column ${QUICK_CHECKLIST_FIXED_COLUMNS}; cannot locate the data block`,
    )
  }
  return start + idx
}

/** Stamp the destination's own version into A1 unless A1 holds a formula. */
export function setQuickChecklistTitle(dSheet: Sheet, destVersion: string): void {
  const cell = dSheet.getRange(QUICK_CHECKLIST_TITLE_CELL)
  if (cell.getFormula()) {
    Logger.log(`Quick Checklist: ${QUICK_CHECKLIST_TITLE_CELL} is a formula (${cell.getFormula()}); title left alone`)
    return
  }
  cell.setValue(QUICK_CHECKLIST_TITLE_PREFIX + destVersion)
}

/**
 * Extend the Quick Checklist's alternating-colour banding to cover the
 * Pokemon image column B. Falls back to widening row-parity CF rules.
 */
export function portQuickChecklistImageBanding(dst: Spreadsheet): void {
  const sheet = dst.getSheetByName('Quick Checklist')
  if (!sheet) throw new Error('Quick Checklist not found in destination')
  const IMG = QUICK_CHECKLIST_IMAGE_COLUMN

  const bandings = sheet.getBandings()
  const right = bandings.find((b) => b.getRange().getColumn() === IMG + 1)
  if (right) {
    const r = right.getRange()
    const left = bandings.find((b) => b !== right && b.getRange().getLastColumn() === IMG - 1)
    const startCol = left ? left.getRange().getColumn() : IMG
    if (left) left.remove()
    right.setRange(sheet.getRange(r.getRow(), startCol, r.getNumRows(), r.getLastColumn() - startCol + 1))
    sheet.getRange(r.getRow(), IMG, r.getNumRows(), 1).setBackground(null)
    Logger.log(`Quick Checklist: banding extended to column ${IMG}${left ? ' (merged with the A-only banding)' : ''}`)
    return
  }
  const spanning = bandings.find((b) => b.getRange().getColumn() <= IMG && b.getRange().getLastColumn() >= IMG)
  if (spanning) {
    const b = spanning.getRange()
    sheet.getRange(b.getRow(), IMG, b.getNumRows(), 1).setBackground(null)
    Logger.log(`Quick Checklist: banding already covers column ${IMG}; cleared its cell fills`)
    return
  }

  const parity = /ISEVEN\s*\(\s*ROW|ISODD\s*\(\s*ROW|MOD\s*\(\s*ROW/i
  let widened = 0
  const rules = sheet.getConditionalFormatRules().map((rule) => {
    const cond = rule.getBooleanCondition()
    const vals = cond ? cond.getCriteriaValues() : []
    if (!vals.length || !parity.test(String(vals[0]))) return rule
    let touched = false
    const ranges = rule.getRanges().map((rg) => {
      const c1 = rg.getColumn()
      const c2 = rg.getLastColumn()
      if (c1 <= IMG && c2 >= IMG) return rg
      if (c2 === IMG - 1 || c1 === IMG + 1) {
        touched = true
        const s = Math.min(c1, IMG)
        const e = Math.max(c2, IMG)
        return sheet.getRange(rg.getRow(), s, rg.getNumRows(), e - s + 1)
      }
      return rg
    })
    if (!touched) return rule
    widened++
    return rule.copy().setRanges(ranges).build()
  })
  if (widened) {
    sheet.setConditionalFormatRules(rules)
    Logger.log(`Quick Checklist: widened ${widened} row-parity CF rule(s) to include column ${IMG}`)
  } else {
    Logger.log(`Quick Checklist: no banding or row-parity CF adjacent to column ${IMG}; nothing changed`)
  }
}

/**
 * Port Daily Mode formatting for only the customized cells plus the column
 * L and M widths. Inserts the custom blank column L first when missing.
 * Conditional formatting is deliberately left alone.
 */
export function portDailyModeFormatting(src: Spreadsheet, dst: Spreadsheet): void {
  const name = 'Daily Mode'
  const sSheet = src.getSheetByName(name)
  const dSheet = dst.getSheetByName(name)
  if (!sSheet || !dSheet) throw new Error('Daily Mode not found')

  if (!dailyModeHasCustomColumn(sSheet, dSheet)) {
    dSheet.insertColumnBefore(12)
    Logger.log('Daily Mode: inserted custom column L')
  }

  const tempSheet = sSheet.copyTo(dst)
  try {
    DAILY_MODE_FORMAT_RANGES.forEach((a1) => {
      tempSheet.getRange(a1).copyTo(dSheet.getRange(a1), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false)
    })
    dSheet.setColumnWidth(12, tempSheet.getColumnWidth(12))
    dSheet.setColumnWidth(13, tempSheet.getColumnWidth(13))
  } finally {
    dst.deleteSheet(tempSheet)
  }
}

/**
 * Whether the destination Daily Mode already has the custom column L, judged
 * by where the creator's landmark label sits. Throws when the layout is
 * unrecognised so a changed creator layout fails loudly.
 */
export function dailyModeHasCustomColumn(sSheet: Sheet, dSheet: Sheet): boolean {
  const label = sSheet.getRange(DAILY_MODE_LANDMARK_WITH_L).getDisplayValue()
  if (!label) {
    throw new Error(
      `Daily Mode: landmark cell ${DAILY_MODE_LANDMARK_WITH_L} is blank in the source; cannot tell whether column L is present`,
    )
  }
  const withL = dSheet.getRange(DAILY_MODE_LANDMARK_WITH_L).getDisplayValue()
  const withoutL = dSheet.getRange(DAILY_MODE_LANDMARK_WITHOUT_L).getDisplayValue()
  if (withL === label) return true
  if (withoutL === label) return false
  throw new Error(
    `Daily Mode: landmark "${label}" is at neither ${DAILY_MODE_LANDMARK_WITH_L} nor ${DAILY_MODE_LANDMARK_WITHOUT_L} in the destination; layout changed, column L not touched`,
  )
}

/**
 * Port Daily Mode cell content that formatting alone doesn't carry: merge
 * B16:M131, copy the B16 formula/value (top-aligned) and L12:M14.
 */
export function portDailyModeCells(src: Spreadsheet, dst: Spreadsheet): void {
  const name = 'Daily Mode'
  const sSheet = src.getSheetByName(name)
  const dSheet = dst.getSheetByName(name)
  if (!sSheet || !dSheet) throw new Error('Daily Mode not found')
  if (!dailyModeHasCustomColumn(sSheet, dSheet)) {
    throw new Error('Daily Mode: custom column L is missing (did "Formatting Daily Mode" fail?); cells not ported')
  }

  const mergeRange = dSheet.getRange(B16_MERGE_RANGE)
  mergeRange.breakApart()
  mergeRange.merge()

  const b16Cell = dSheet.getRange('B16')
  copyFormulasOrValues(sSheet.getRange('B16'), b16Cell)
  b16Cell.setVerticalAlignment('top')

  copyFormulasOrValues(sSheet.getRange('L12:M14'), dSheet.getRange('L12:M14'))
}

/** Copy formulas (falling back to values) into a same-sized range; works across spreadsheets. */
export function copyFormulasOrValues(srcRange: Range, dstRange: Range): void {
  const formulas = srcRange.getFormulas()
  const values = srcRange.getValues()
  const merged = formulas.map((row, i) => row.map((f, j) => (f ? f : values[i]![j])))
  dstRange.setValues(merged)
}

/** For every sheet hidden in the source, hide the same-named destination sheet. */
export function portHiddenSheets(src: Spreadsheet, dst: Spreadsheet): void {
  const dstByName: Record<string, Sheet> = {}
  dst.getSheets().forEach((s) => {
    dstByName[s.getName()] = s
  })
  const hiddenList: string[] = []
  src.getSheets().forEach((s) => {
    const d = dstByName[s.getName()]
    if (s.isSheetHidden() && d) {
      d.hideSheet()
      hiddenList.push(s.getName())
    }
  })
  Logger.log('Hidden in dst: ' + (hiddenList.join(', ') || '(none)'))
}

/** Replace the "perfect IV" CF rule on each dex checklist with a "not 31 → red" rule. */
export function portDexIvHighlight(dst: Spreadsheet): void {
  DEX_IV_HIGHLIGHT_SHEETS.forEach((name) => {
    const sheet = dst.getSheetByName(name)
    if (!sheet) {
      Logger.log(`IV highlight: "${name}" not found, skipping`)
      return
    }
    const updated: ConditionalFormatRule[] = []
    let replaced = 0
    sheet.getConditionalFormatRules().forEach((rule) => {
      if (!isPerfectIvRule(rule)) {
        updated.push(rule)
        return
      }
      rule.getRanges().forEach((range) => {
        const topLeft = range.getCell(1, 1).getA1Notation()
        updated.push(
          SpreadsheetApp.newConditionalFormatRule()
            .whenFormulaSatisfied(`=TO_TEXT(${topLeft})<>"${DEX_IV_PERFECT_VALUE}"`)
            .setBackground(DEX_IV_IMPERFECT_COLOR)
            .setRanges([range])
            .build(),
        )
        replaced++
      })
    })
    if (replaced === 0) {
      Logger.log(`IV highlight: no "=${DEX_IV_PERFECT_VALUE}" rule found on "${name}", left unchanged`)
      return
    }
    sheet.setConditionalFormatRules(updated)
    Logger.log(`IV highlight: replaced ${replaced} rule(s) on "${name}"`)
  })
}

/** True if a CF rule is the "perfect IV" highlight (cell equals 31, text or number). */
export function isPerfectIvRule(rule: ConditionalFormatRule): boolean {
  const cond = rule.getBooleanCondition()
  if (!cond) return false
  const type = cond.getCriteriaType()
  const value = String(cond.getCriteriaValues()[0])
  const Crit = SpreadsheetApp.BooleanCriteria
  return (type === Crit.TEXT_EQUAL_TO || type === Crit.NUMBER_EQUAL_TO) && value === DEX_IV_PERFECT_VALUE
}

/** Every non-trashed spreadsheet in Drive with exactly this name. */
export function findSpreadsheetsNamed(name: string): GoogleAppsScript.Drive.File[] {
  const query =
    "title = '" +
    name.replace(/'/g, "\\'") +
    "' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false"
  const it = DriveApp.searchFiles(query)
  const out: GoogleAppsScript.Drive.File[] = []
  while (it.hasNext()) out.push(it.next())
  return out
}

/** Drive file ID of an Offline RogueDex spreadsheet by version (newest if several). */
export function findFileIdByVersion(version: string): string {
  const targetName = copyName(version)
  const matches = findSpreadsheetsNamed(targetName)
  if (matches.length === 0) {
    throw new Error(`No file found named "${targetName}". Check the version number, or rename your copy to match.`)
  }
  if (matches.length > 1) {
    matches.sort((a, b) => b.getLastUpdated().getTime() - a.getLastUpdated().getTime())
    Logger.log(
      `Multiple files named "${targetName}" found. Using newest: ${matches[0]!.getId()}. Others ignored: ${matches
        .slice(1)
        .map((f) => f.getId())
        .join(', ')}`,
    )
  }
  return matches[0]!.getId()
}
