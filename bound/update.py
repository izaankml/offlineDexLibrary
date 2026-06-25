#!/usr/bin/env python3
"""
Per-version bound-code reconciliation. Run from the bound/ directory.

Pulls the creator's fresh code from a newly-copied spreadsheet and 3-way MERGES
it with your customizations, so creator changes AND your edits both survive.

How it works
------------
A dedicated `creator` branch holds the creator's *pristine* bound code, one commit
per version. `main` holds your customized versions. Each update:

    1. (you) point bound/.clasp.json at a FRESH copy of the new public sheet
    2. checkout creator → clasp pull → commit the pristine code
    3. checkout main   → git merge creator   (3-way: creator delta + your edits)

Because the `creator` branch records what the upstream looked like last version,
git merges the creator's *delta* onto your customizations. You only resolve a
conflict where you and the creator edited the SAME lines. Creator changes to code
you never touched (e.g. a rewritten checkVersion) merge in automatically; your
custom functions the creator never touched are preserved automatically.

First run bootstraps the `creator` branch (orphan + one reconciling merge) — see
UPDATING.md. This is the ONLY run where you reconcile the whole file by hand,
because no pristine baseline existed in history before now.

Usage
-----
    cd bound
    python3 update.py [VERSION]      # e.g. python3 update.py 6.01

VERSION is just a label for the creator commit message; prompted for if omitted.
"""

import subprocess
import sys

CREATOR_BRANCH = "creator"
MAIN_BRANCH = "main"


def git(*args, check=True, capture=False):
    """Run a git command at the repo root (one level up from bound/)."""
    cmd = ["git", "-C", ".."] + list(args)
    result = subprocess.run(cmd, capture_output=True, text=True)
    out = (result.stdout or "").rstrip()
    err = (result.stderr or "").rstrip()
    if capture:
        if check and result.returncode != 0:
            fail(f"git {' '.join(args)} failed:\n{err or out}")
        return result.returncode, out, err
    if out:
        print(out)
    if err and result.returncode != 0:
        print(err, file=sys.stderr)
    if check and result.returncode != 0:
        fail(f"git {' '.join(args)} failed (exit {result.returncode})")
    return result.returncode


def clasp_pull():
    """clasp pull runs in bound/ (the current working directory)."""
    result = subprocess.run(["clasp", "pull"], capture_output=True, text=True)
    if result.stdout:
        print(result.stdout.rstrip())
    if result.returncode != 0:
        fail(f"clasp pull failed:\n{result.stderr.rstrip()}")


def fail(msg):
    print(f"\n  ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def current_branch():
    _, out, _ = git("rev-parse", "--abbrev-ref", "HEAD", capture=True)
    return out


def branch_exists(name):
    code, _, _ = git("rev-parse", "--verify", "--quiet", f"refs/heads/{name}",
                     check=False, capture=True)
    return code == 0


def tree_dirty():
    _, out, _ = git("status", "--porcelain", capture=True)
    return bool(out.strip())


def confirm(prompt):
    return input(prompt).strip().lower() in ("y", "yes")


def report_merge_result(code):
    if code == 0:
        print("\n── Merge clean ────────────────────────────────")
        print("  Creator changes merged with your customizations, no conflicts.")
        print("\n── Next steps ─────────────────────────────────")
        print("  1. Review the diff:   git -C .. diff HEAD~1")
        print("  2. Push to the copy:  clasp push -f")
        return
    # Non-zero → conflicts. Leave the merge in progress for manual resolution.
    _, conflicts, _ = git("diff", "--name-only", "--diff-filter=U", capture=True)
    print("\n── Merge conflicts ────────────────────────────")
    print("  You and the creator changed the same lines in:")
    for f in conflicts.splitlines():
        print(f"    {f}")
    print("\n  Resolve each (keep BOTH the creator's update and your edit), then:")
    print("    git -C .. add <files>")
    print("    git -C .. commit            # completes the merge")
    print("    clasp push -f               # upload reconciled code to the copy")
    print("\n  To abandon and start over:  git -C .. merge --abort")


def bootstrap(version):
    """First run: create the orphan `creator` baseline and reconcile once."""
    print("── First-time setup: creating the `creator` branch ──")
    print(
        "\n  This records the creator's CURRENT pristine code as the baseline.\n"
        "  bound/.clasp.json MUST point at a FRESH copy of the public sheet\n"
        "  (creator's unmodified code) — NOT a copy you've pushed edits to.\n"
    )
    if not confirm("  Does .clasp.json point at a fresh, unmodified copy? [y/N] "):
        fail("Point .clasp.json at a fresh copy first, then re-run. See UPDATING.md.")

    # Orphan branch starts from main's working tree; clasp pull overwrites bound/
    # with pristine code, which we commit as the baseline.
    git("checkout", "--orphan", CREATOR_BRANCH)
    print("\n── Pulling creator's pristine code ────────────")
    clasp_pull()
    git("add", "-A")
    git("commit", "-m", f"creator baseline ({version})")

    git("checkout", MAIN_BRANCH)
    print("\n── Reconciling with your customizations ───────")
    print("  (one-time: whole-file conflicts expected on the files you customize)")
    code = git("merge", "--allow-unrelated-histories", "--no-edit",
               "-m", f"Merge creator {version} into main", CREATOR_BRANCH,
               check=False)
    report_merge_result(code)


def update(version):
    """Subsequent runs: pull pristine code onto `creator`, 3-way merge into main."""
    git("checkout", CREATOR_BRANCH)
    try:
        print("\n── Pulling creator's pristine code ────────────")
        clasp_pull()
        if not tree_dirty():
            print("\n  Creator code unchanged from last version — nothing to merge.")
            return
        git("add", "-A")
        git("commit", "-m", f"creator {version}")
    finally:
        # Always get back to main, even if the pull/commit failed.
        if current_branch() != MAIN_BRANCH:
            git("checkout", MAIN_BRANCH, check=False)

    print("\n── Merging creator changes into your code ─────")
    code = git("merge", "--no-edit",
               "-m", f"Merge creator {version} into main", CREATOR_BRANCH,
               check=False)
    report_merge_result(code)


def main():
    version = sys.argv[1] if len(sys.argv) > 1 else input("New version label (e.g. 6.01): ").strip()
    if not version:
        fail("A version label is required (used in the creator commit message).")

    if current_branch() != MAIN_BRANCH:
        fail(f"Run this from the {MAIN_BRANCH} branch (currently on {current_branch()}).")
    if tree_dirty():
        fail("Working tree is dirty. Commit or stash your changes first "
             "(the merge needs a clean tree).")

    if branch_exists(CREATOR_BRANCH):
        update(version)
    else:
        bootstrap(version)


if __name__ == "__main__":
    main()
