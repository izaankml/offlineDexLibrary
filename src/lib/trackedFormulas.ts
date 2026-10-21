/**
 * TRACKED FORMULAS
 *
 * The cell formulas we added to the creator's sheet. This file is their
 * reference copy: the migrator writes them into every new version, so an edit
 * made by hand in the sheet belongs here as well.
 *
 * Sheet names are spelled the way Sheets stores them (unquoted where it allows,
 * in the sheet's own case), so a formula read back compares equal.
 */

import { a1 } from './sheetsApi.ts'

/**
 * Daily Mode Unlocks!AG3: each unlock's map string (wave, Pokémon, lures, shiny
 * and hidden ability details, one category marker). An IV unlock is marked only
 * when a stat rolls 31 that the starter's owned IVs on DAILY_MODE.data (AA:AF)
 * lack; owned IVs are looked up by species ID (column A here, BY there), and a
 * species missing from that tab gets no marker.
 */
export const DAILY_UNLOCKS_AG3_FORMULA = String.raw`=ArrayFormula(LET(
  wave, M3:M,
  pokemon, P3:P,
  lures, REGEXREPLACE(R3:R, " |ures", ""),
  charms, IF(S3:S = "", , " " & S3:S),
  shinyVariant, T3:T,
  speciesHasVariants, IFERROR(VLOOKUP(A3:A, 'STATIC:data.SPECIES'!A:AK, 37, FALSE) & "", "") = "TRUE",
  isDefaultWithVariants, (F3:F <> "") * (shinyVariant = "Default Shiny") * speciesHasVariants,
  shinyText, IF(F3:F = "", ,
    " - " & IF(isDefaultWithVariants, shinyVariant, REGEXREPLACE(shinyVariant, " Shiny", " (Shiny)")) & charms
  ),
  hiddenAbilityText, IF(H3:H = "", , " - HA" & charms),
  speciesId, A3:A & "",
  dataSpeciesId, DAILY_MODE.data!$BY$2:$BY & "",
  ownedIv, LAMBDA(ownedColumn, IFERROR(XLOOKUP(speciesId, dataSpeciesId, ownedColumn), 31)),
  isNewMaxIv, (L3:L <> "") * (
    (U3:U = 31) * (ownedIv(DAILY_MODE.data!$AA$2:$AA) < 31) +
    (V3:V = 31) * (ownedIv(DAILY_MODE.data!$AB$2:$AB) < 31) +
    (W3:W = 31) * (ownedIv(DAILY_MODE.data!$AC$2:$AC) < 31) +
    (X3:X = 31) * (ownedIv(DAILY_MODE.data!$AD$2:$AD) < 31) +
    (Y3:Y = 31) * (ownedIv(DAILY_MODE.data!$AE$2:$AE) < 31) +
    (Z3:Z = 31) * (ownedIv(DAILY_MODE.data!$AF$2:$AF) < 31)
  ),
  marker,
    IF(D3:D <> "", " (Caught)",
    IF(E3:E <> "", " (Fought)",
    IF(H3:H <> "", " (Hidden Ability)",
    IF(G3:G <> "", " (Ability)",
    IF(J3:J <> "", " (Form)",
    IF(K3:K <> "", " (Gender)",
    IF(isNewMaxIv, " (IV)",
    ""))))))),
  IF(wave = "", ,
    "w" & wave & " " & pokemon & " " & lures & shinyText & hiddenAbilityText & marker
  )
))`

/** Daily Unlock Map row holding one formula per map column. */
export const UNLOCK_MAP_FORMULA_ROW = 2

/**
 * The map's columns: each lists the biomes of its own DAILY_MODE_MAP.data
 * column and reads its first wave from its own header cell, so the formula
 * cannot be filled across.
 */
export const UNLOCK_MAP_FORMULA_COLUMNS: {
  column: number
  biomeColumn: string
}[] = [
  { column: 5, biomeColumn: 'AF' }, // E
  { column: 6, biomeColumn: 'AG' }, // F
  { column: 7, biomeColumn: 'AH' }, // G
  { column: 8, biomeColumn: 'AI' }, // H
  { column: 9, biomeColumn: 'AJ' }, // I
]

/** The biome range a map column lists, e.g. DAILY_MODE_MAP.data!AF2:AF. */
export function unlockMapBiomeRange(biomeColumn: string): string {
  return `DAILY_MODE_MAP.data!${biomeColumn}2:${biomeColumn}`
}

/**
 * One Daily Unlock Map cell: the biome name, then every unlock string from
 * Daily Mode Unlocks!AG and every ability/shiny charm override from Daily Mode
 * (G3:G6, K3:K6) whose wave falls in the column's ten waves, sorted by wave and
 * padded to three lines.
 */
export function unlockMapColumnFormula(
  column: number,
  biomeColumn: string,
): string {
  const headerCell = a1(1, column)
  return String.raw`=BYROW(${unlockMapBiomeRange(biomeColumn)}, LAMBDA(biome, IF(biome="",,
LET(
  firstWave, ${headerCell},
  nextWave, ${headerCell} + 10,
  charmLine, LAMBDA(waveCell, label,
    IF((waveCell <> "") * (waveCell >= firstWave) * (waveCell < nextWave), "w" & waveCell & " [" & label & "]", "")),
  monLines, IFNA(FILTER('Daily Mode Unlocks'!$AG$3:$AG, 'Daily Mode Unlocks'!$N$3:$N = biome, 'Daily Mode Unlocks'!$M$3:$M >= firstWave, 'Daily Mode Unlocks'!$M$3:$M < nextWave)),
  allLines, VSTACK(
    monLines,
    charmLine('Daily Mode'!$G$3, "Ability Charm"),
    charmLine('Daily Mode'!$G$4, "Ability Charm"),
    charmLine('Daily Mode'!$G$5, "Ability Charm"),
    charmLine('Daily Mode'!$G$6, "Ability Charm"),
    charmLine('Daily Mode'!$K$3, "Shiny Charm"),
    charmLine('Daily Mode'!$K$4, "Shiny Charm"),
    charmLine('Daily Mode'!$K$5, "Shiny Charm"),
    charmLine('Daily Mode'!$K$6, "Shiny Charm")),
  lineWaves, ARRAYFORMULA(IFERROR(VALUE(REGEXEXTRACT(allLines, "^w(\d+)")), nextWave)),
  lines, TEXTJOIN(CHAR(10), TRUE, SORT(allLines, lineWaves, TRUE)),
  lineCount, IF(lines = "", 0, LEN(lines) - LEN(SUBSTITUTE(lines, CHAR(10), "")) + 1),
  biome &
  IF(lines = "", , CHAR(10) & lines) &
  REPT(CHAR(10), MAX(0, 3 - lineCount))
))))`
}

/**
 * A formula reduced to what decides its behaviour: outside string literals,
 * whitespace and sheet-name quotes are dropped and case is folded, since Sheets
 * requotes and recases sheet names and hand edits reflow lines. String
 * literals are kept as they are.
 */
export function normalizeFormula(formula: string): string {
  let normalized = ''
  let insideString = false
  for (const character of formula) {
    if (character === '"') {
      insideString = !insideString
      normalized += character
    } else if (insideString) {
      normalized += character
    } else if (!/\s/.test(character) && character !== "'") {
      normalized += character.toLowerCase()
    }
  }
  return normalized
}

export function sameFormula(left: string, right: string): boolean {
  return normalizeFormula(left) === normalizeFormula(right)
}
