// ============================================================
// MIGRATOR MODULE (library file)
//
// Ports your customizations from an old OfflineDex spreadsheet
// to a new one. Called from the destination spreadsheet's bound
// script via OfflineDexLib.portAll(sourceVersion, destVersion).
// ============================================================

const FILE_NAME_PATTERN = 'Offline RogueDex {v}'

const INSERT_COLUMN_L_IN_DAILY_MODE = true
const DELETE_COLUMN_E_IN_QUICK_CHECKLIST = true
const B16_MERGE_RANGE = 'B16:M131'

// Daily Mode cells whose formatting I customized, copied from the old sheet:
// the merged B16:M131 block and L12:M14. After the column-L insertion the
// source and destination share the same column layout, so these A1 ranges line
// up without any remapping.
const DAILY_MODE_FORMAT_RANGES = [B16_MERGE_RANGE, 'L12:M14']

// IV conditional formatting on the dex checklists. The source sheets ship with
// a rule that fills a cell yellow when it equals 31 (a perfect IV); we swap it
// for one that fills red when the cell is NOT 31, over the same range.
const DEX_IV_HIGHLIGHT_SHEETS = ['Starter Dex Checklist', 'Full Dex Checklist']
const DEX_IV_PERFECT_VALUE = '31'
const DEX_IV_IMPERFECT_COLOR = '#ea9999' // red

/**
 * Top-level migration entry. Runs each step against the source and destination
 * spreadsheets, swallowing per-step errors so one failure doesn't block the
 * rest. Logs an OK/ERR summary at the end and shows a completion toast.
 * @param {string} sourceVersion - e.g. 'X.YY'
 * @param {string} destVersion - e.g. 'X.YY'
 */
function portAll(sourceVersion, destVersion) {
  const ss = SpreadsheetApp.getActiveSpreadsheet()
  resetToastProgress()

  startStep(ss, 'Looking up spreadsheets')
  const srcId = findFileIdByVersion(sourceVersion)
  const dstId = findFileIdByVersion(destVersion)
  Logger.log('Source: ' + sourceVersion + ' -> ' + srcId)
  Logger.log('Dest:   ' + destVersion + ' -> ' + dstId)
  const src = SpreadsheetApp.openById(srcId)
  const dst = SpreadsheetApp.openById(dstId)
  finishStep()

  const log = []
  const safeRun = (label, fn) => {
    startStep(ss, label)
    try {
      fn()
      finishStep()
      log.push('OK  ' + label)
    } catch (e) {
      finishStep()
      log.push('ERR ' + label + ': ' + e.message)
    }
  }

  safeRun('Formatting Quick Checklist', () =>
    portQuickChecklistHeader(src, dst)
  )
  safeRun('Formatting Form Checklist', () => sortFormChecklistByDone(dst))
  safeRun('Formatting Daily Mode', () => portDailyModeFormatting(src, dst))
  safeRun('Updating Daily Mode Cells', () => portDailyModeCells(src, dst))
  safeRun('Hiding sheets', () => portHiddenSheets(src, dst))
  safeRun('Updating dex IV highlights', () => portDexIvHighlight(dst))

  const totalElapsed = ((Date.now() - FLOW_START) / 1000).toFixed(1)
  const body = LAST_STEP_LABEL
    ? LAST_STEP_LABEL + ' completed in ' + LAST_STEP_ELAPSED + 's'
    : ''
  ss.toast(body, 'Migration complete in ' + totalElapsed + 's', 10)
  FLOW_START = 0

  Logger.log(log.join('\n'))
}

/**
 * Port rows 1-10 of the Quick Checklist sheet: cell formatting, row heights,
 * column widths, and row hidden states (column hidden states are NOT ported,
 * so columns are never hidden). Also ports formulas (falling back to values)
 * for row 1 columns E-O and all of row 10. Uses a temp copy of the source
 * sheet inside the destination because copyTo() can't cross spreadsheets.
 *
 * First deletes the destination's column E (when
 * `DELETE_COLUMN_E_IN_QUICK_CHECKLIST` is true and the destination is wider
 * than the source) so the new version's extra column doesn't shift everything
 * out of alignment before the formatting/formula port.
 * @param {Spreadsheet} src
 * @param {Spreadsheet} dst
 */
function portQuickChecklistHeader(src, dst) {
  const sName = 'Quick Checklist'
  const sSheet = src.getSheetByName(sName)
  const dSheet = dst.getSheetByName(sName)
  if (!sSheet || !dSheet) throw new Error('Quick Checklist not found')

  // The new version added a column E the old version lacks, shifting every
  // later column. Delete it so source and destination line up before we copy
  // across. Guarded by a column-count check so a re-run won't delete a real
  // column (mirrors the Daily Mode column-L insert).
  if (
    DELETE_COLUMN_E_IN_QUICK_CHECKLIST &&
    dSheet.getMaxColumns() > sSheet.getMaxColumns()
  ) {
    dSheet.deleteColumn(5)
  }

  const tempSheet = sSheet.copyTo(dst)
  try {
    const cols = Math.max(tempSheet.getMaxColumns(), dSheet.getMaxColumns())

    const srcRange = tempSheet.getRange(1, 1, 10, cols)
    const dstRange = dSheet.getRange(1, 1, 10, cols)
    srcRange.copyTo(dstRange, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false)

    for (let r = 1; r <= 10; r++) {
      dSheet.setRowHeight(r, tempSheet.getRowHeight(r))
      if (tempSheet.isRowHiddenByUser(r)) {
        dSheet.hideRows(r)
      } else {
        dSheet.showRows(r)
      }
    }
    // Column widths only — column hidden states are no longer ported, so the
    // migrator never hides Quick Checklist columns.
    for (let c = 1; c <= cols; c++) {
      dSheet.setColumnWidth(c, tempSheet.getColumnWidth(c))
    }

    const portRowSlice = (rowNum, startCol, endCol) => {
      const numCols = endCol - startCol + 1
      const srcRow = tempSheet.getRange(rowNum, startCol, 1, numCols)
      const formulas = srcRow.getFormulas()
      const values = srcRow.getValues()
      const merged = formulas.map((row, i) =>
        row.map((f, j) => (f ? f : values[i][j]))
      )
      dSheet.getRange(rowNum, startCol, 1, numCols).setValues(merged)
    }
    portRowSlice(1, 5, 15)
    portRowSlice(10, 1, cols)
  } finally {
    dst.deleteSheet(tempSheet)
  }
}

/**
 * Sort the Form Checklist sheet by column C ascending so unchecked rows
 * appear before checked rows. Header row is preserved.
 * @param {Spreadsheet} dst
 */
function sortFormChecklistByDone(dst) {
  const sheet = dst.getSheetByName('Form Checklist')
  if (!sheet) throw new Error('Form Checklist not found in destination')

  const lastRow = sheet.getLastRow()
  const lastCol = sheet.getLastColumn()
  if (lastRow < 2) return

  const range = sheet.getRange(2, 1, lastRow - 1, lastCol)
  range.sort({ column: 3, ascending: true })
}

/**
 * Port Daily Mode formatting for only the cells I customized
 * (`DAILY_MODE_FORMAT_RANGES`) plus the column L and M widths. When
 * `INSERT_COLUMN_L_IN_DAILY_MODE` is true and the destination is narrower than
 * the source, inserts a blank column L first.
 *
 * Deliberately does NOT touch conditional formatting: inserting column L
 * auto-shifts the destination's own CF ranges to match, so the new version's
 * rules already line up — copying the old version's rules over them would
 * overwrite the new version's (potentially updated) formatting.
 * @param {Spreadsheet} src
 * @param {Spreadsheet} dst
 */
function portDailyModeFormatting(src, dst) {
  const name = 'Daily Mode'
  const sSheet = src.getSheetByName(name)
  const dSheet = dst.getSheetByName(name)
  if (!sSheet || !dSheet) throw new Error('Daily Mode not found')

  if (
    INSERT_COLUMN_L_IN_DAILY_MODE &&
    dSheet.getMaxColumns() < sSheet.getMaxColumns()
  ) {
    dSheet.insertColumnBefore(12)
  }

  const tempSheet = sSheet.copyTo(dst)
  try {
    DAILY_MODE_FORMAT_RANGES.forEach((a1) => {
      tempSheet
        .getRange(a1)
        .copyTo(
          dSheet.getRange(a1),
          SpreadsheetApp.CopyPasteType.PASTE_FORMAT,
          false
        )
    })

    // Widths for the custom column L and the adjacent M (whose width I changed).
    dSheet.setColumnWidth(12, tempSheet.getColumnWidth(12))
    dSheet.setColumnWidth(13, tempSheet.getColumnWidth(13))
  } finally {
    dst.deleteSheet(tempSheet)
  }
}

/**
 * Port Daily Mode cell content that formatting alone doesn't carry:
 * unmerges + re-merges B16:M131, copies the B16 formula/value with top
 * vertical alignment, and copies L12:M14 formulas (falling back to values).
 * @param {Spreadsheet} src
 * @param {Spreadsheet} dst
 */
function portDailyModeCells(src, dst) {
  const name = 'Daily Mode'
  const sSheet = src.getSheetByName(name)
  const dSheet = dst.getSheetByName(name)
  if (!sSheet || !dSheet) throw new Error('Daily Mode not found')

  const mergeRange = dSheet.getRange(B16_MERGE_RANGE)
  mergeRange.breakApart()
  mergeRange.merge()

  const b16Cell = dSheet.getRange('B16')
  const b16Formula = sSheet.getRange('B16').getFormula()
  if (b16Formula) {
    b16Cell.setFormula(b16Formula)
  } else {
    b16Cell.setValue(sSheet.getRange('B16').getValue())
  }
  b16Cell.setVerticalAlignment('top')

  const srcBlock = sSheet.getRange('L12:M14')
  const formulas = srcBlock.getFormulas()
  const values = srcBlock.getValues()
  const merged = formulas.map((row, i) =>
    row.map((f, j) => (f ? f : values[i][j]))
  )
  dSheet.getRange('L12:M14').setValues(merged)
}

/**
 * For every sheet hidden in the source, hide the same-named sheet in the
 * destination (if it exists). Names not present in the destination are skipped.
 * @param {Spreadsheet} src
 * @param {Spreadsheet} dst
 */
function portHiddenSheets(src, dst) {
  const srcSheets = src.getSheets()
  const dstByName = {}
  dst.getSheets().forEach((s) => {
    dstByName[s.getName()] = s
  })

  const hiddenList = []
  srcSheets.forEach((s) => {
    if (s.isSheetHidden() && dstByName[s.getName()]) {
      dstByName[s.getName()].hideSheet()
      hiddenList.push(s.getName())
    }
  })
  Logger.log('Hidden in dst: ' + (hiddenList.join(', ') || '(none)'))
}

/**
 * Replace the "perfect IV" conditional-format rule on each dex checklist.
 * The freshly copied new version ships with a rule that fills a cell yellow
 * when it equals 31; this swaps that for a rule that fills red whenever the
 * cell is NOT 31, over the exact same range(s), leaving every other CF rule on
 * the sheet untouched. Each matched rule is rebuilt one-range-at-a-time so the
 * custom formula's relative reference stays anchored to that range's top-left.
 * @param {Spreadsheet} dst
 */
function portDexIvHighlight(dst) {
  DEX_IV_HIGHLIGHT_SHEETS.forEach((name) => {
    const sheet = dst.getSheetByName(name)
    if (!sheet) {
      Logger.log('IV highlight: "' + name + '" not found, skipping')
      return
    }

    const updated = []
    let replaced = 0
    sheet.getConditionalFormatRules().forEach((rule) => {
      if (!isPerfectIvRule(rule)) {
        updated.push(rule)
        return
      }
      rule.getRanges().forEach((range) => {
        const topLeft = range.getCell(1, 1).getA1Notation() // relative ref
        updated.push(
          SpreadsheetApp.newConditionalFormatRule()
            .whenFormulaSatisfied(
              '=TO_TEXT(' + topLeft + ')<>"' + DEX_IV_PERFECT_VALUE + '"'
            )
            .setBackground(DEX_IV_IMPERFECT_COLOR)
            .setRanges([range])
            .build()
        )
        replaced++
      })
    })

    if (replaced === 0) {
      Logger.log(
        'IV highlight: no "=' +
          DEX_IV_PERFECT_VALUE +
          '" rule found on "' +
          name +
          '", left unchanged'
      )
      return
    }
    sheet.setConditionalFormatRules(updated)
    Logger.log('IV highlight: replaced ' + replaced + ' rule(s) on "' + name + '"')
  })
}

/**
 * True if a CF rule is the "perfect IV" highlight: a boolean condition that
 * matches when the cell equals 31, as text ("Text is exactly 31") or number.
 * Gradient/color-scale rules have no boolean condition and never match.
 * @param {ConditionalFormatRule} rule
 * @return {boolean}
 */
function isPerfectIvRule(rule) {
  const cond = rule.getBooleanCondition()
  if (!cond) return false
  const type = cond.getCriteriaType()
  const value = String(cond.getCriteriaValues()[0])
  const Crit = SpreadsheetApp.BooleanCriteria
  return (
    (type === Crit.TEXT_EQUAL_TO || type === Crit.NUMBER_EQUAL_TO) &&
    value === DEX_IV_PERFECT_VALUE
  )
}

/**
 * Look up the Drive file ID of an Offline RogueDex spreadsheet by version.
 * Searches by name using FILE_NAME_PATTERN, ignores `PUBLIC_*` copies, and
 * if multiple matches exist returns the most recently updated one (logging
 * the others). Throws if no file matches.
 * @param {string} version - e.g. 'X.YY'
 * @return {string} Drive file ID
 */
function findFileIdByVersion(version) {
  const targetName = FILE_NAME_PATTERN.replace('{v}', version)
  const query =
    "title = '" +
    targetName.replace(/'/g, "\\'") +
    "' " +
    "and mimeType = 'application/vnd.google-apps.spreadsheet' " +
    'and trashed = false'

  const files = DriveApp.searchFiles(query)
  const matches = []
  while (files.hasNext()) {
    const f = files.next()
    if (f.getName().indexOf('PUBLIC_') === 0) continue
    matches.push(f)
  }

  if (matches.length === 0) {
    throw new Error(
      'No file found named "' +
        targetName +
        '". ' +
        'Check the version number, or rename your copy to match.'
    )
  }
  if (matches.length > 1) {
    matches.sort((a, b) => b.getLastUpdated() - a.getLastUpdated())
    Logger.log(
      'Multiple files named "' +
        targetName +
        '" found. Using newest: ' +
        matches[0].getId() +
        '. Others ignored: ' +
        matches
          .slice(1)
          .map((f) => f.getId())
          .join(', ')
    )
  }
  return matches[0].getId()
}
