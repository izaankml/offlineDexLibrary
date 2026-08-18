// ============================================================
// MIGRATOR MODULE (library file)
//
// Ports your customizations from an old OfflineDex spreadsheet
// to a new one. Called from the destination spreadsheet's bound
// script via OfflineDexLib.portAll(sourceVersion, destVersion).
// ============================================================

// Quick Checklist column layout. Columns A-D (#, image, Dex#, name) are
// fixed; the data block ("Caught?" … "Ribbons", QUICK_CHECKLIST_DATA_COLUMNS
// wide) starts at E in creator 6.01 and at F from 6.03 on (the creator added
// a hidden junk column E). The migrator adopts the creator's layout as-is —
// so consecutive versions port 1:1 — and locates each sheet's data block by
// the first non-blank cell in row 10 right of D (see
// quickChecklistFirstDataColumn). The Ribbons column (last of the block) is
// hidden after the port; the SaveTracker's marker column sits one past it.
const QUICK_CHECKLIST_FIXED_COLUMNS = 4
const QUICK_CHECKLIST_DATA_COLUMNS = 11
const QUICK_CHECKLIST_LOCATOR_ROW = 10
// Title cell + prefix ("POKEROGUE DEX 6.03"); the creator's copy can lag a
// version behind, so the migrator stamps the destination's own version.
const QUICK_CHECKLIST_TITLE_CELL = 'A1'
const QUICK_CHECKLIST_TITLE_PREFIX = 'POKEROGUE DEX '
// The Pokemon image column, which the alternating-colour banding is extended
// to cover (see portQuickChecklistImageBanding).
const QUICK_CHECKLIST_IMAGE_COLUMN = 2

// Daily Mode has a custom column L (map-size inputs in L12:M14 feed the
// IMAGE formula in B16). A fresh creator copy lacks it, so we insert one.
// Whether it's present is detected by a landmark rather than a column count:
// the creator's "Missing Gym Leader Voucher…" block header, at N2 when the
// custom column exists (source) and at M2 when it doesn't (fresh copy).
const DAILY_MODE_LANDMARK_WITH_L = 'N2'
const DAILY_MODE_LANDMARK_WITHOUT_L = 'M2'
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
 * @param {string} destVersion - e.g. 'X.YY' (the destination is always the active
 *   spreadsheet; the version is stamped into the Quick Checklist title)
 */
function portAll(sourceVersion, destVersion) {
  const ss = SpreadsheetApp.getActiveSpreadsheet()
  resetToastProgress()

  startStep(ss, 'Looking up spreadsheets')
  const srcId = findFileIdByVersion(sourceVersion)
  Logger.log('Source: ' + sourceVersion + ' -> ' + srcId)
  // The destination is always the sheet this runs in — never looked up by
  // name, so a stray duplicate copy with the same name can't be picked.
  Logger.log('Dest:   ' + destVersion + ' -> ' + ss.getId() + ' (active)')
  const src = SpreadsheetApp.openById(srcId)
  const dst = ss
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
    portQuickChecklistHeader(src, dst, destVersion),
  )
  safeRun('Banding Quick Checklist images', () =>
    portQuickChecklistImageBanding(dst),
  )
  // The Form Checklist "unchecked first" sort is applied by the SaveTracker
  // after each save upload (see sortFormChecklistByDone), not here: on a
  // fresh copy every row is still unchecked, so sorting now would be a no-op.
  safeRun('Formatting Daily Mode', () => portDailyModeFormatting(src, dst))
  safeRun('Updating Daily Mode Cells', () => portDailyModeCells(src, dst))
  safeRun('Hiding sheets', () => portHiddenSheets(src, dst))
  safeRun('Updating dex IV highlights', () => portDexIvHighlight(dst))

  finishFlow(ss, 'Migration complete', 10)
  Logger.log(log.join('\n'))
}

/**
 * Port rows 1-10 of the Quick Checklist sheet: cell formatting, row heights,
 * column widths, and row hidden states. Also ports formulas (falling back to
 * values) for row 1's data columns (Caught? … Ribbons) and all of row 10,
 * hides the Ribbons column, and stamps `destVersion` into the A1 title.
 * Uses a temp copy of the source sheet inside the destination because
 * copyTo() can't cross spreadsheets.
 *
 * The creator's column layout is adopted as-is (so consecutive versions
 * migrate 1:1); if the destination's data block starts further right than
 * the source's — 6.03 added a hidden junk column E — the temp copy gets the
 * same blank column(s) inserted first, so it lines up with the destination
 * and its own same-sheet references shift with it (see
 * alignQuickChecklistTemp). Everything after that is a same-position copy.
 * @param {Spreadsheet} src
 * @param {Spreadsheet} dst
 * @param {string} destVersion - e.g. '6.03'
 */
function portQuickChecklistHeader(src, dst, destVersion) {
  const sName = 'Quick Checklist'
  const sSheet = src.getSheetByName(sName)
  const dSheet = dst.getSheetByName(sName)
  if (!sSheet || !dSheet) throw new Error('Quick Checklist not found')

  const tempSheet = sSheet.copyTo(dst)
  try {
    const first = alignQuickChecklistTemp(tempSheet, dSheet)
    const lastData = first + QUICK_CHECKLIST_DATA_COLUMNS - 1

    // Work in the (now aligned) source's width; pad the destination if it's
    // narrower, and never read past the temp sheet's own last column.
    const cols = tempSheet.getMaxColumns()
    const dCols = dSheet.getMaxColumns()
    if (dCols < cols) dSheet.insertColumnsAfter(dCols, cols - dCols)

    tempSheet
      .getRange(1, 1, 10, cols)
      .copyTo(
        dSheet.getRange(1, 1, 10, cols),
        SpreadsheetApp.CopyPasteType.PASTE_FORMAT,
        false,
      )

    for (let r = 1; r <= 10; r++) {
      dSheet.setRowHeight(r, tempSheet.getRowHeight(r))
      if (tempSheet.isRowHiddenByUser(r)) {
        dSheet.hideRows(r)
      } else {
        dSheet.showRows(r)
      }
    }
    // Column widths only. Hidden states are the creator's (e.g. the junk
    // column E) plus the Ribbons hide below — not the source's, whose hidden
    // columns also include the SaveTracker's marker column.
    for (let c = 1; c <= cols; c++) {
      dSheet.setColumnWidth(c, tempSheet.getColumnWidth(c))
    }

    const portRowSlice = (rowNum, startCol, endCol) => {
      const numCols = endCol - startCol + 1
      copyFormulasOrValues(
        tempSheet.getRange(rowNum, startCol, 1, numCols),
        dSheet.getRange(rowNum, startCol, 1, numCols),
      )
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
 * The data block ("Caught?" … "Ribbons") is located in each sheet by the
 * first non-blank cell in row 10 to the right of column D — that's the
 * creator's stats row on a fresh copy and my "Stats:" row on a migrated one,
 * so it works for both. If the destination's block starts further right,
 * blank columns are inserted into the temp copy in front of its block, which
 * shifts the temp's own same-sheet references (row 1/row 10 formulas) along
 * with it while leaving references to other sheets alone — exactly the
 * adjustment the port needs. Throws if the destination's block starts to the
 * LEFT of the source's (columns would have to be deleted; unexpected).
 * @param {Sheet} tempSheet - copy of the source Quick Checklist, inside dst
 * @param {Sheet} dSheet - destination Quick Checklist
 * @return {number} 1-based column of the data block in both sheets
 */
function alignQuickChecklistTemp(tempSheet, dSheet) {
  const srcFirst = quickChecklistFirstDataColumn(tempSheet, 'source')
  const dstFirst = quickChecklistFirstDataColumn(dSheet, 'destination')
  const offset = dstFirst - srcFirst
  if (offset < 0) {
    throw new Error(
      'Quick Checklist: destination data block starts at column ' +
        dstFirst +
        ", left of the source's " +
        srcFirst +
        '; layout unknown, nothing ported',
    )
  }
  if (offset > 0) {
    tempSheet.insertColumnsBefore(srcFirst, offset)
    Logger.log(
      'Quick Checklist: source data block shifted right by ' +
        offset +
        ' to match the destination (column ' +
        dstFirst +
        ')',
    )
  }
  return dstFirst
}

/**
 * Column where a Quick Checklist's data block starts: the first non-blank
 * cell in row 10 right of the fixed A-D block (see alignQuickChecklistTemp).
 * @param {Sheet} sheet
 * @param {string} which - 'source' | 'destination', for the error message
 * @return {number}
 */
function quickChecklistFirstDataColumn(sheet, which) {
  const start = QUICK_CHECKLIST_FIXED_COLUMNS + 1
  const width = sheet.getMaxColumns() - start + 1
  const row10 = sheet
    .getRange(QUICK_CHECKLIST_LOCATOR_ROW, start, 1, width)
    .getDisplayValues()[0]
  const idx = row10.findIndex((v) => String(v).trim() !== '')
  if (idx === -1) {
    throw new Error(
      'Quick Checklist (' +
        which +
        '): row ' +
        QUICK_CHECKLIST_LOCATOR_ROW +
        ' is blank right of column ' +
        QUICK_CHECKLIST_FIXED_COLUMNS +
        '; cannot locate the data block',
    )
  }
  return start + idx
}

/**
 * Stamp the destination's own version into the Quick Checklist title cell
 * (A1, "POKEROGUE DEX X.YY"). The creator's copy sometimes still carries the
 * previous version's label. Skipped (with a log line) if A1 holds a formula,
 * since then the creator drives it and we shouldn't sever that.
 * @param {Sheet} dSheet - destination Quick Checklist
 * @param {string} destVersion - e.g. '6.03'
 */
function setQuickChecklistTitle(dSheet, destVersion) {
  const cell = dSheet.getRange(QUICK_CHECKLIST_TITLE_CELL)
  if (cell.getFormula()) {
    Logger.log(
      'Quick Checklist: ' +
        QUICK_CHECKLIST_TITLE_CELL +
        ' is a formula (' +
        cell.getFormula() +
        '); title left alone',
    )
    return
  }
  cell.setValue(QUICK_CHECKLIST_TITLE_PREFIX + destVersion)
}

/**
 * Extend the Quick Checklist's alternating-colour banding to cover the
 * Pokemon image column B, which the creator leaves out. Handles the two
 * layouts we expect: one banding starting at C (extend it left to B), or a
 * separate A-only banding plus one from C (drop the A-only one and stretch
 * the other to A). B's own cell fills are cleared over the banded rows so the
 * banding shows through. If no banding starts at C, falls back to widening
 * any row-parity conditional-format rules (ISEVEN/ISODD/MOD(ROW()...)) whose
 * ranges skip B. Logs which path it took.
 * @param {Spreadsheet} dst
 */
function portQuickChecklistImageBanding(dst) {
  const sheet = dst.getSheetByName('Quick Checklist')
  if (!sheet) throw new Error('Quick Checklist not found in destination')
  const IMG = QUICK_CHECKLIST_IMAGE_COLUMN

  const bandings = sheet.getBandings()
  const right = bandings.find((b) => b.getRange().getColumn() === IMG + 1)
  if (right) {
    const r = right.getRange()
    const left = bandings.find(
      (b) => b !== right && b.getRange().getLastColumn() === IMG - 1,
    )
    const startCol = left ? left.getRange().getColumn() : IMG
    if (left) left.remove()
    right.setRange(
      sheet.getRange(
        r.getRow(),
        startCol,
        r.getNumRows(),
        r.getLastColumn() - startCol + 1,
      ),
    )
    sheet.getRange(r.getRow(), IMG, r.getNumRows(), 1).setBackground(null)
    Logger.log(
      'Quick Checklist: banding extended to column ' +
        IMG +
        (left ? ' (merged with the A-only banding)' : ''),
    )
    return
  }
  if (
    bandings.some(
      (b) =>
        b.getRange().getColumn() <= IMG && b.getRange().getLastColumn() >= IMG,
    )
  ) {
    // Banding already spans B; only a cell fill can be hiding it.
    const b = bandings
      .find(
        (b) =>
          b.getRange().getColumn() <= IMG &&
          b.getRange().getLastColumn() >= IMG,
      )
      .getRange()
    sheet.getRange(b.getRow(), IMG, b.getNumRows(), 1).setBackground(null)
    Logger.log(
      'Quick Checklist: banding already covers column ' +
        IMG +
        '; cleared its cell fills',
    )
    return
  }

  // No banding object: maybe the stripes are conditional formatting.
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
    Logger.log(
      'Quick Checklist: widened ' +
        widened +
        ' row-parity CF rule(s) to include column ' +
        IMG,
    )
  } else {
    Logger.log(
      'Quick Checklist: no banding or row-parity CF adjacent to column ' +
        IMG +
        '; nothing changed',
    )
  }
}

/**
 * Port Daily Mode formatting for only the cells I customized
 * (`DAILY_MODE_FORMAT_RANGES`) plus the column L and M widths. Inserts the
 * custom blank column L first when the destination lacks it (see
 * `dailyModeHasCustomColumn`).
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

  if (!dailyModeHasCustomColumn(sSheet, dSheet)) {
    dSheet.insertColumnBefore(12)
    Logger.log('Daily Mode: inserted custom column L')
  }

  const tempSheet = sSheet.copyTo(dst)
  try {
    DAILY_MODE_FORMAT_RANGES.forEach((a1) => {
      tempSheet
        .getRange(a1)
        .copyTo(
          dSheet.getRange(a1),
          SpreadsheetApp.CopyPasteType.PASTE_FORMAT,
          false,
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
 * Whether the destination Daily Mode already has the custom column L, judged
 * by where the creator's landmark label (read from the source at
 * `DAILY_MODE_LANDMARK_WITH_L`) sits in the destination: same cell → present;
 * one column left (`DAILY_MODE_LANDMARK_WITHOUT_L`) → absent. Throws when the
 * landmark is blank in the source or in neither destination cell, so a
 * changed creator layout fails loudly instead of being ported one column off.
 * @param {Sheet} sSheet - source Daily Mode
 * @param {Sheet} dSheet - destination Daily Mode
 * @return {boolean}
 */
function dailyModeHasCustomColumn(sSheet, dSheet) {
  const label = sSheet.getRange(DAILY_MODE_LANDMARK_WITH_L).getDisplayValue()
  if (!label) {
    throw new Error(
      'Daily Mode: landmark cell ' +
        DAILY_MODE_LANDMARK_WITH_L +
        ' is blank in the source; cannot tell whether column L is present',
    )
  }
  const withL = dSheet.getRange(DAILY_MODE_LANDMARK_WITH_L).getDisplayValue()
  const withoutL = dSheet
    .getRange(DAILY_MODE_LANDMARK_WITHOUT_L)
    .getDisplayValue()
  if (withL === label) return true
  if (withoutL === label) return false
  throw new Error(
    'Daily Mode: landmark "' +
      label +
      '" is at neither ' +
      DAILY_MODE_LANDMARK_WITH_L +
      ' nor ' +
      DAILY_MODE_LANDMARK_WITHOUT_L +
      ' in the destination; layout changed, column L not touched',
  )
}

/**
 * Port Daily Mode cell content that formatting alone doesn't carry:
 * unmerges + re-merges B16:M131, copies the B16 formula/value with top
 * vertical alignment, and copies L12:M14 formulas (falling back to values).
 * Refuses to run until the custom column L is in place (see
 * `portDailyModeFormatting`): without it the merge and the L12:M14 write
 * would land on the creator's own columns.
 * @param {Spreadsheet} src
 * @param {Spreadsheet} dst
 */
function portDailyModeCells(src, dst) {
  const name = 'Daily Mode'
  const sSheet = src.getSheetByName(name)
  const dSheet = dst.getSheetByName(name)
  if (!sSheet || !dSheet) throw new Error('Daily Mode not found')
  if (!dailyModeHasCustomColumn(sSheet, dSheet)) {
    throw new Error(
      'Daily Mode: custom column L is missing (did "Formatting Daily Mode" fail?); cells not ported',
    )
  }

  const mergeRange = dSheet.getRange(B16_MERGE_RANGE)
  mergeRange.breakApart()
  mergeRange.merge()

  const b16Cell = dSheet.getRange('B16')
  copyFormulasOrValues(sSheet.getRange('B16'), b16Cell)
  b16Cell.setVerticalAlignment('top')

  copyFormulasOrValues(sSheet.getRange('L12:M14'), dSheet.getRange('L12:M14'))
}

/**
 * Copy a range's formulas into another same-sized range, falling back to the
 * plain value wherever a source cell has no formula. Works across
 * spreadsheets (unlike Range.copyTo).
 * @param {Range} srcRange
 * @param {Range} dstRange
 */
function copyFormulasOrValues(srcRange, dstRange) {
  const formulas = srcRange.getFormulas()
  const values = srcRange.getValues()
  const merged = formulas.map((row, i) =>
    row.map((f, j) => (f ? f : values[i][j])),
  )
  dstRange.setValues(merged)
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
              '=TO_TEXT(' + topLeft + ')<>"' + DEX_IV_PERFECT_VALUE + '"',
            )
            .setBackground(DEX_IV_IMPERFECT_COLOR)
            .setRanges([range])
            .build(),
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
          '", left unchanged',
      )
      return
    }
    sheet.setConditionalFormatRules(updated)
    Logger.log(
      'IV highlight: replaced ' + replaced + ' rule(s) on "' + name + '"',
    )
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
 * Every non-trashed spreadsheet in Drive with exactly this name (an exact
 * `title =` match, so the creator's `PUBLIC_…` file never matches a copy's
 * name). Unsorted; callers order by whatever date they care about.
 * @param {string} name
 * @return {File[]}
 */
function findSpreadsheetsNamed(name) {
  const query =
    "title = '" +
    name.replace(/'/g, "\\'") +
    "' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false"
  const it = DriveApp.searchFiles(query)
  const out = []
  while (it.hasNext()) out.push(it.next())
  return out
}

/**
 * Look up the Drive file ID of an Offline RogueDex spreadsheet by version.
 * Searches by name (see copyName in Setup.js) and, if multiple matches exist,
 * returns the most recently updated one (logging the others). Throws if no
 * file matches.
 * @param {string} version - e.g. 'X.YY'
 * @return {string} Drive file ID
 */
function findFileIdByVersion(version) {
  const targetName = copyName(version)
  const matches = findSpreadsheetsNamed(targetName)

  if (matches.length === 0) {
    throw new Error(
      'No file found named "' +
        targetName +
        '". ' +
        'Check the version number, or rename your copy to match.',
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
          .join(', '),
    )
  }
  return matches[0].getId()
}
