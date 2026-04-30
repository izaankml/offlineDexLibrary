#!/usr/bin/env python3
"""
Per-version setup script. Run from the bound/ directory.
Pulls the creator's files, merges any manifest changes, and restores your edits.
"""

import json
import subprocess
import sys

# Fields to take from the creator's manifest (not ours)
MERGE_FROM_CREATOR = ['sheets']

# Fields to warn about if they changed (we don't auto-merge these)
WARN_IF_CHANGED = ['oauthScopes', 'runtimeVersion']


def run(cmd):
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if result.stdout:
        print(result.stdout.rstrip())
    if result.stderr and result.returncode != 0:
        print(result.stderr.rstrip(), file=sys.stderr)
    if result.returncode != 0:
        print(f'Command failed: {cmd}', file=sys.stderr)
        sys.exit(result.returncode)


def main():
    print('── Pulling creator files ──────────────────────')
    run('clasp pull')

    with open('appsscript.json') as f:
        creator = json.load(f)

    print('\n── Restoring your files ───────────────────────')
    run('git -C .. restore bound/')

    with open('appsscript.json') as f:
        ours = json.load(f)

    merged = []
    warned = []

    for field in MERGE_FROM_CREATOR:
        creator_val = creator.get(field)
        our_val = ours.get(field)
        if creator_val != our_val:
            if creator_val is None:
                del ours[field]
            else:
                ours[field] = creator_val
            merged.append(field)

    for field in WARN_IF_CHANGED:
        if creator.get(field) != ours.get(field):
            warned.append(field)

    with open('appsscript.json', 'w') as f:
        json.dump(ours, f, indent=2)
        f.write('\n')

    print('\n── Result ─────────────────────────────────────')
    if merged:
        print(f'  Merged from creator:  {", ".join(merged)}')
        print('  Review appsscript.json and commit if it looks right.')
    else:
        print('  Manifest unchanged.')

    if warned:
        print(f'\n  WARNING: creator changed {", ".join(warned)} — check manually.')

    print('\n── Next steps ─────────────────────────────────')
    print('  1. Update PREVIOUS_VERSION in onOpen.js')
    print('  2. clasp push -f')


if __name__ == '__main__':
    main()
