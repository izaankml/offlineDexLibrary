#!/usr/bin/env node
/**
 * Per-version bound-code update. Run from anywhere in the repo:
 *
 *   npm run update -- <scriptId-or-editor-url>   reconcile + push to a fresh copy
 *   npm run update -- --continue                 finish a conflicted merge, then push
 *   npm run update -- --abort                    abandon the in-progress merge
 *   npm run update                                is a new creator version out?
 *
 * Given only the fresh copy's bound Script ID (the in-sheet "Prepare Next
 * Version" dialog hands you the exact command), this:
 *
 *   1. resolves the ID → parent spreadsheet → name → version, using clasp's
 *      existing login (no second sign-in), and refuses IDs that don't belong to
 *      a fresh "Offline RogueDex X.YY" copy;
 *   2. writes bound/.clasp.json;
 *   3. pulls the creator's pristine code into a temporary git worktree of the
 *      `creator` branch (your checkout never leaves `main`), Prettier-normalizes
 *      it with the repo's .prettierrc.json, and commits it as the new baseline;
 *   4. 3-way merges `creator` into `main`;
 *   5. on a clean merge, runs `clasp push -f` so the copy has your code.
 *
 * On conflicts it stops, lists the files, and tells you to run `--continue`
 * after resolving. See UPDATING.md for the merge model.
 */

import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BOUND_DIR = join(REPO_ROOT, 'bound')
const CLASP_JSON = join(BOUND_DIR, '.clasp.json')
const PRETTIER_CONFIG = join(REPO_ROOT, '.prettierrc.json')

const MAIN_BRANCH = 'main'
const CREATOR_BRANCH = 'creator'

/** The bound files git tracks — the only ones that take part in the merge. */
const TRACKED_BOUND_FILES = [
  'onOpen.js',
  'LoadPlayerData.js',
  'UploadPlayerData.html',
  'appsscript.json',
]

/** Your copies are named like this; the version is parsed out of the name. */
const SHEET_NAME_RE = /^Offline RogueDex (\d+\.\d+)$/
/**
 * The creator's public spreadsheet is a single Drive file that gets renamed
 * on every release ("PUBLIC_Offline RogueDex 6.03"). Reading its title tells
 * us the newest version without any copy being made. Mirrors
 * PUBLIC_SHEET_FILE_ID in library/Setup.js.
 */
const PUBLIC_SHEET_FILE_ID = '1peZNMRqicwfGAMYYJq6aeA13_1ZFVKvl--_gVQOdfv0'
const VERSION_RE = /\d+\.\d+/

/** A marker that only ever appears in *your* code, never in the creator's. */
const CUSTOM_CODE_MARKER = 'OfflineDexLib'

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

class UserError extends Error {}

function fail(message: string): never {
  throw new UserError(message)
}

function step(message: string): void {
  console.log(`  ✓ ${message}`)
}

function note(message: string): void {
  console.log(`  · ${message}`)
}

type RunOptions = {
  cwd?: string
  /** Show the child's output live (clasp, prettier, merges). */
  inherit?: boolean
  /** Return instead of throwing on a non-zero exit. */
  allowFail?: boolean
}

type RunResult = { code: number; stdout: string; stderr: string }

function run(cmd: string, args: string[], opts: RunOptions = {}): RunResult {
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd ?? REPO_ROOT,
    encoding: 'utf8',
    stdio: opts.inherit ? 'inherit' : 'pipe',
  })
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') {
      fail(`\`${cmd}\` is not installed or not on your PATH.`)
    }
    throw result.error
  }
  const out: RunResult = {
    code: result.status ?? 1,
    stdout: (result.stdout ?? '').toString().trimEnd(),
    stderr: (result.stderr ?? '').toString().trimEnd(),
  }
  if (out.code !== 0 && !opts.allowFail) {
    fail(
      `\`${cmd} ${args.join(' ')}\` failed (exit ${out.code})` +
        (out.stderr || out.stdout ? `:\n${out.stderr || out.stdout}` : ''),
    )
  }
  return out
}

function git(args: string[], opts: RunOptions = {}): RunResult {
  return run('git', args, opts)
}

function gitOut(args: string[], opts: RunOptions = {}): string {
  return git(args, opts).stdout
}

function branchExists(name: string): boolean {
  return (
    git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], {
      allowFail: true,
    }).code === 0
  )
}

function currentBranch(): string {
  return gitOut(['rev-parse', '--abbrev-ref', 'HEAD'])
}

function treeDirty(cwd = REPO_ROOT): boolean {
  return gitOut(['status', '--porcelain'], { cwd }) !== ''
}

function mergeInProgress(): boolean {
  const gitDir = gitOut(['rev-parse', '--git-dir'])
  return existsSync(resolve(REPO_ROOT, gitDir, 'MERGE_HEAD'))
}

/** Version label baked into the most recent creator commit, if any. */
function lastBaselineVersion(): string | null {
  if (!branchExists(CREATOR_BRANCH)) return null
  const subject = gitOut(['log', '-1', '--format=%s', CREATOR_BRANCH])
  return subject.match(VERSION_RE)?.[0] ?? null
}

// ---------------------------------------------------------------------------
// Google APIs via clasp's stored login
// ---------------------------------------------------------------------------

type ClaspToken = {
  client_id: string
  client_secret: string
  refresh_token: string
  access_token?: string
  expiry_date?: number
}

let cachedAccessToken: string | null = null

/**
 * clasp keeps a standard `authorized_user` credential in ~/.clasprc.json.
 * We reuse it (refreshing if needed) rather than asking you to sign in twice.
 * The Apps Script + Drive-metadata calls below are all within clasp's scopes.
 */
async function accessToken(): Promise<string> {
  if (cachedAccessToken) return cachedAccessToken

  const rcPath = join(homedir(), '.clasprc.json')
  if (!existsSync(rcPath)) {
    fail('Not logged in to clasp. Run `clasp login` first.')
  }
  const rc = JSON.parse(readFileSync(rcPath, 'utf8')) as {
    tokens?: Record<string, ClaspToken>
  }
  const user = process.env['CLASP_USER'] ?? 'default'
  const token = rc.tokens?.[user]
  if (!token?.refresh_token) {
    fail(`No clasp credentials for user "${user}". Run \`clasp login\`.`)
  }

  const fresh =
    token.access_token &&
    token.expiry_date &&
    token.expiry_date - 60_000 > Date.now()
  if (fresh) {
    cachedAccessToken = token.access_token!
    return cachedAccessToken
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: token.client_id,
      client_secret: token.client_secret,
      refresh_token: token.refresh_token,
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) {
    fail(
      `Could not refresh clasp's Google login (${res.status}). ` +
        'Run `clasp login` again.',
    )
  }
  const body = (await res.json()) as { access_token: string }
  cachedAccessToken = body.access_token
  return cachedAccessToken
}

async function googleGet<T>(url: string, what: string): Promise<T> {
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${await accessToken()}` },
  })
  if (res.status === 404) fail(`${what}: not found (404). Check the ID.`)
  if (res.status === 403 || res.status === 401) {
    fail(
      `${what}: access denied (${res.status}). Are you logged in to clasp as the account that owns the sheet?`,
    )
  }
  if (!res.ok) fail(`${what}: HTTP ${res.status}\n${await res.text()}`)
  return (await res.json()) as T
}

type ScriptInfo = {
  scriptId: string
  scriptTitle: string
  sheetId: string
  sheetName: string
  version: string
  sheetCreated: Date
}

/** Script ID → parent spreadsheet → name → version. */
async function resolveScript(scriptId: string): Promise<ScriptInfo> {
  const project = await googleGet<{
    title?: string
    parentId?: string
  }>(
    `https://script.googleapis.com/v1/projects/${scriptId}`,
    'Apps Script project',
  )

  if (!project.parentId) {
    fail(
      `Script "${project.title ?? scriptId}" is a standalone project, not a script bound to a spreadsheet. ` +
        'Paste the Script ID of the fresh copy (Extensions → Apps Script → Project Settings).',
    )
  }

  const file = await googleGet<{
    id: string
    name: string
    createdTime: string
    trashed?: boolean
  }>(
    `https://www.googleapis.com/drive/v3/files/${project.parentId}?fields=id,name,createdTime,trashed&supportsAllDrives=true`,
    'Parent spreadsheet',
  )

  if (file.trashed) {
    fail(
      `That script belongs to "${file.name}" (${file.id}), which is in the trash. ` +
        'Use the Script ID of the live copy instead.',
    )
  }

  const match = file.name.match(SHEET_NAME_RE)
  if (!match) {
    fail(
      `That script belongs to "${file.name}", which isn't named like a copy ("Offline RogueDex X.YY"). ` +
        'Rename the copy first — the migrator finds sheets by that exact name.',
    )
  }

  return {
    scriptId,
    scriptTitle: project.title ?? '',
    sheetId: file.id,
    sheetName: file.name,
    version: match[1]!,
    sheetCreated: new Date(file.createdTime),
  }
}

/** Newest version the creator has published, read from the public file's title. */
async function publishedVersion(): Promise<{
  name: string
  version: string | null
}> {
  const file = await googleGet<{ name: string }>(
    `https://www.googleapis.com/drive/v3/files/${PUBLIC_SHEET_FILE_ID}?fields=name&supportsAllDrives=true`,
    "Creator's public spreadsheet",
  )
  return { name: file.name, version: file.name.match(VERSION_RE)?.[0] ?? null }
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

type Args = {
  target: string | null
  continueMerge: boolean
  abort: boolean
  push: boolean
  versionOverride: string | null
  help: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    target: null,
    continueMerge: false,
    abort: false,
    push: true,
    versionOverride: null,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--continue') args.continueMerge = true
    else if (a === '--abort') args.abort = true
    else if (a === '--no-push') args.push = false
    else if (a === '-h' || a === '--help') args.help = true
    else if (a === '--version') {
      const v = argv[++i]
      if (!v || !VERSION_RE.test(v)) fail('--version needs a value like 6.03')
      args.versionOverride = v
    } else if (a.startsWith('--version=')) {
      args.versionOverride = a.slice('--version='.length)
    } else if (a.startsWith('-')) fail(`Unknown option ${a}`)
    else if (args.target) fail('Only one Script ID / URL is expected.')
    else args.target = a
  }
  return args
}

/**
 * Accept a bare Script ID or any URL that contains one
 * (script.google.com/.../projects/<id>/edit, ?scriptId=..., etc.).
 */
function extractScriptId(target: string): string {
  const fromPath = target.match(/\/projects\/([A-Za-z0-9_-]{20,})/)
  if (fromPath) return fromPath[1]!
  const fromQuery = target.match(/[?&]scriptId=([A-Za-z0-9_-]{20,})/)
  if (fromQuery) return fromQuery[1]!
  if (/^[A-Za-z0-9_-]{20,}$/.test(target)) return target
  fail(
    `"${target}" doesn't look like a Script ID or an Apps Script editor URL.\n` +
      '  Get it from the "Prepare Next Version" dialog in your current sheet, or from\n' +
      '  the fresh copy: Extensions → Apps Script → Project Settings → Script ID.',
  )
}

function usage(): void {
  console.log(`Usage:
  npm run update -- <scriptId | editor URL>   reconcile creator code and push to a fresh copy
  npm run update -- --continue                 finish a conflicted merge, then push
  npm run update -- --abort                    abandon the in-progress merge
  npm run update                                check whether a new creator version is out

Options:
  --version X.YY   skip the Google lookup and use this version label (offline / fallback)
  --no-push        do everything except \`clasp push -f\`
`)
}

// ---------------------------------------------------------------------------
// The update itself
// ---------------------------------------------------------------------------

function checkPreconditions(): void {
  if (currentBranch() !== MAIN_BRANCH) {
    fail(
      `Run this from the ${MAIN_BRANCH} branch (you're on ${currentBranch()}).`,
    )
  }
  if (mergeInProgress()) {
    fail(
      'A merge is already in progress. Resolve the conflicts and run\n' +
        '  npm run update -- --continue\n' +
        'or throw it away with\n' +
        '  npm run update -- --abort',
    )
  }
  if (treeDirty()) {
    fail(
      'Working tree is dirty. Commit or stash your changes first — the merge needs a clean tree.',
    )
  }
  run('clasp', ['--version'])
  run('prettier', ['--version'])
  if (!existsSync(PRETTIER_CONFIG)) fail(`Missing ${PRETTIER_CONFIG}`)
  step('on main, tree clean, clasp + prettier available')
}

/**
 * Pull the creator's pristine code into a temporary worktree of `creator`,
 * normalize it, and commit it as the new baseline. Returns false if the pulled
 * code is byte-identical to the previous baseline (nothing to merge).
 */
function recordCreatorBaseline(scriptId: string, version: string): boolean {
  const bootstrap = !branchExists(CREATOR_BRANCH)
  const wt = mkdtempSync(join(tmpdir(), 'offlinedex-creator-'))
  rmSync(wt, { recursive: true, force: true }) // git wants to create it itself

  try {
    if (bootstrap) {
      git(['worktree', 'add', '--orphan', '-b', CREATOR_BRANCH, wt])
      note(
        `no \`${CREATOR_BRANCH}\` branch yet — bootstrapping it from this copy`,
      )
    } else {
      git(['worktree', 'add', wt, CREATOR_BRANCH])
    }
    // The orphan bootstrap worktree starts empty; without the repo's .gitignore
    // `git add` would sweep in .clasp.json (a Script ID) and the creator-only
    // files (ImportDB.js, ...). Older creator branches also predate some rules.
    if (!existsSync(join(wt, '.gitignore'))) {
      copyFileSync(join(REPO_ROOT, '.gitignore'), join(wt, '.gitignore'))
    }
    const wtBound = join(wt, 'bound')
    mkdirSync(wtBound, { recursive: true })
    writeFileSync(
      join(wtBound, '.clasp.json'),
      JSON.stringify({ scriptId, rootDir: '.' }, null, 2) + '\n',
    )

    console.log("\n── clasp pull (creator's pristine code) ───────")
    run('clasp', ['pull'], { cwd: wtBound, inherit: true })

    // A fresh creator copy never references the library. If it does, this copy
    // already had your code pushed to it and must NOT become the baseline.
    for (const f of readdirSync(wtBound)) {
      if (!/\.(js|html)$/.test(f)) continue
      if (readFileSync(join(wtBound, f), 'utf8').includes(CUSTOM_CODE_MARKER)) {
        fail(
          `${f} in the pulled code references ${CUSTOM_CODE_MARKER} — this copy already has your code pushed to it, ` +
            'so it cannot be recorded as the creator baseline. Point at a fresh, untouched copy.',
        )
      }
    }
    step('pulled creator code')

    const present = TRACKED_BOUND_FILES.filter((f) =>
      existsSync(join(wtBound, f)),
    )
    run(
      'prettier',
      [
        '--write',
        '--config',
        PRETTIER_CONFIG,
        '--log-level',
        'warn',
        ...present,
      ],
      { cwd: wtBound, inherit: true },
    )
    step(`prettier-normalized ${present.length} files`)

    if (!bootstrap && !treeDirty(wt)) {
      return false
    }
    git(['add', '-A', '.gitignore', 'bound'], { cwd: wt })
    git(
      [
        'commit',
        '-q',
        '-m',
        bootstrap ? `creator baseline (${version})` : `creator ${version}`,
      ],
      { cwd: wt },
    )
    step(
      `committed "${bootstrap ? 'creator baseline' : 'creator'} ${version}" on ${CREATOR_BRANCH}`,
    )
    return true
  } finally {
    git(['worktree', 'remove', '--force', wt], { allowFail: true })
    rmSync(wt, { recursive: true, force: true })
  }
}

/** Returns true when the merge completed cleanly, false when it left conflicts. */
function mergeCreator(version: string, bootstrap: boolean): boolean {
  console.log('\n── git merge creator → main ───────────────────')
  const args = [
    'merge',
    '--no-edit',
    '-m',
    `Merge creator ${version} into main`,
  ]
  if (bootstrap) args.push('--allow-unrelated-histories')
  args.push(CREATOR_BRANCH)
  const result = git(args, { inherit: true, allowFail: true })
  if (result.code === 0) {
    step('merged — no conflicts')
    return true
  }
  const conflicts = gitOut(['diff', '--name-only', '--diff-filter=U'])
  console.log(`
── Merge conflicts ────────────────────────────
  You and the creator changed the same lines in:
${conflicts
  .split('\n')
  .map((f) => `    ${f}`)
  .join('\n')}
${bootstrap ? "\n  (First-time bootstrap: whole-file conflicts are expected — combine the\n  creator's current code with your customizations once.)\n" : ''}
  Resolve each file keeping BOTH the creator's update and your edit, then:
    git add <files>
    npm run update -- --continue     # commits the merge and pushes

  To throw the merge away:  npm run update -- --abort
`)
  return false
}

function claspPush(): void {
  console.log('\n── clasp push -f ──────────────────────────────')
  run('clasp', ['push', '-f'], { cwd: BOUND_DIR, inherit: true })
  step('pushed bound code to the copy')
}

function printFinishSetup(sheetId: string | null, version: string): void {
  const where = sheetId
    ? `https://docs.google.com/spreadsheets/d/${sheetId}`
    : `"Offline RogueDex ${version}"`
  console.log(`
── Done ───────────────────────────────────────
  Open ${where}
  reload it once so the menu rebuilds, then:
    RogueDex Functions → Finish Setup
  (migrates from your previous version, then opens the save upload dialog)
`)
}

async function doUpdate(args: Args): Promise<void> {
  const scriptId = extractScriptId(args.target!)
  checkPreconditions()

  let info: ScriptInfo | null = null
  let version = args.versionOverride
  if (!version) {
    info = await resolveScript(scriptId)
    version = info.version
    const ageMin = Math.round(
      (Date.now() - info.sheetCreated.getTime()) / 60_000,
    )
    const age =
      ageMin < 90
        ? `${ageMin} min ago`
        : ageMin < 60 * 48
          ? `${Math.round(ageMin / 60)} h ago`
          : `${Math.round(ageMin / 60 / 24)} days ago`
    step(
      `script ${scriptId.slice(0, 8)}… → sheet "${info.sheetName}" (created ${age}) → version ${version}`,
    )
  } else {
    note(`using --version ${version}, skipping the Google lookup`)
  }

  const previous = lastBaselineVersion()
  if (previous === version) {
    fail(
      `A creator baseline for ${version} is already recorded on \`${CREATOR_BRANCH}\`.\n` +
        `  If the merge already happened, you're done — just \`clasp push -f\` from bound/ if needed.\n` +
        `  To redo the baseline on purpose: git branch -f ${CREATOR_BRANCH} ${CREATOR_BRANCH}~1  (then re-run).`,
    )
  }

  writeFileSync(
    CLASP_JSON,
    JSON.stringify({ scriptId, rootDir: '.' }, null, 2) + '\n',
  )
  step(`wrote bound/.clasp.json → ${scriptId.slice(0, 8)}…`)

  const bootstrap = !branchExists(CREATOR_BRANCH)
  const changed = recordCreatorBaseline(scriptId, version)

  if (!changed) {
    note(
      `creator's bound code is identical to the ${previous ?? 'previous'} baseline — nothing to merge` +
        (previous
          ? ` (they didn't change any of the tracked files between ${previous} and ${version})`
          : ''),
    )
    if (args.push) claspPush()
    printFinishSetup(info?.sheetId ?? null, version)
    return
  }

  const clean = mergeCreator(version, bootstrap)
  if (!clean) {
    process.exitCode = 1
    return
  }
  if (args.push) claspPush()
  else note('skipped clasp push (--no-push)')
  printFinishSetup(info?.sheetId ?? null, version)
}

function doContinue(args: Args): void {
  if (!mergeInProgress()) {
    fail(
      'No merge in progress — nothing to continue. (Already committed? Then just run `clasp push -f` in bound/.)',
    )
  }
  const unmerged = gitOut(['diff', '--name-only', '--diff-filter=U'])
  if (unmerged) {
    fail(
      `Still conflicted:\n${unmerged
        .split('\n')
        .map((f) => `    ${f}`)
        .join(
          '\n',
        )}\n  Resolve them, \`git add\` each file, then re-run --continue.`,
    )
  }
  git(['commit', '--no-edit', '-q'])
  step('merge committed')
  if (args.push) claspPush()
  const version = lastBaselineVersion() ?? '?'
  printFinishSetup(null, version)
}

function doAbort(): void {
  if (!mergeInProgress()) fail('No merge in progress — nothing to abort.')
  git(['merge', '--abort'])
  step(
    'merge aborted; main is back where it was (the creator baseline commit stays on `creator`)',
  )
}

async function doStatus(): Promise<void> {
  const local = lastBaselineVersion()
  const pub = await publishedVersion()
  console.log(`  creator's public sheet is titled "${pub.name}"`)
  if (!pub.version) {
    fail("Couldn't read a version out of that title.")
  }
  if (!local) {
    console.log(
      `  no creator baseline recorded locally yet — first update will bootstrap it.`,
    )
  } else if (local === pub.version) {
    console.log(`  up to date: your last baseline is ${local}.`)
    return
  } else {
    console.log(
      `  new version ${pub.version} is out (your last baseline is ${local}).`,
    )
  }
  console.log(`
  Next: in your current sheet run  RogueDex Functions → Prepare Next Version
  and paste the command it gives you (npm run update -- <scriptId>).
`)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) return usage()
  if (args.abort) return doAbort()
  if (args.continueMerge) return doContinue(args)
  if (args.target) return doUpdate(args)
  return doStatus()
}

main().catch((e: unknown) => {
  if (e instanceof UserError) {
    console.error(`\n  ✗ ${e.message}\n`)
  } else {
    console.error(e)
  }
  process.exitCode = 1
})
