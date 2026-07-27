#!/usr/bin/env bash
#
# Strip confidential files from every commit in this repository's history.
#
# WHY: github.com/beborico1/breakdown-tool is a PUBLIC repository, and four files
# were committed to it that should never have been published:
#
#   transcription.txt              254 lines of a real Japanese work meeting
#   docs/gmail-template.html       8.1 MB captured Gmail page; 8 real third-party
#                                  email addresses, 36 internal-hostname references
#   src/content/chat/sample.html   real chat messages naming a colleague
#   kaigi-meeting-v1.2.0.zip       a stale build artifact
#
# Deleting them in a later commit is not enough: every earlier commit still holds
# them, and on a public repo that means they stay readable. This rewrites history
# so the blobs are unreachable from any ref.
#
# WHAT THIS SCRIPT DOES NOT DO: push. It prepares a rewritten mirror and prints the
# commands. Force-pushing a public repository is destructive and irreversible from
# the outside, so a human runs that step.
#
# WHAT A REWRITE STILL DOES NOT FIX: GitHub keeps unreferenced objects reachable by
# their SHA until it garbage-collects. Until you ask GitHub Support to run gc on the
# repository, the old commit hashes continue to serve these files to anyone who has
# one. That request is part of the job, not an optional extra.
#
# Usage:  bash scripts/purge-history.sh
set -euo pipefail

REMOTE_URL="https://github.com/beborico1/breakdown-tool.git"
V2_BRANCH="v2-japanese-in-color"
WORK="${TMPDIR:-/tmp}/jic-purge-$(date +%Y%m%d-%H%M%S)"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PATHS=(
  transcription.txt
  docs/gmail-template.html
  src/content/chat/sample.html
  kaigi-meeting-v1.2.0.zip
)

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

say "Preconditions"
command -v git-filter-repo >/dev/null || {
  echo "git-filter-repo not found. brew install git-filter-repo"; exit 1
}
git -C "$REPO_ROOT" diff --quiet && git -C "$REPO_ROOT" diff --cached --quiet || {
  echo "Working tree at $REPO_ROOT is dirty. Commit or stash first."; exit 1
}
git -C "$REPO_ROOT" rev-parse --verify "$V2_BRANCH" >/dev/null || {
  echo "Branch $V2_BRANCH not found locally."; exit 1
}
echo "ok: filter-repo present, working tree clean, $V2_BRANCH exists"

say "Cloning a mirror of the remote into $WORK"
# A mirror carries every branch and tag, which is what has to be rewritten — the
# files are reachable from all six remote branches, not just main.
git clone --mirror "$REMOTE_URL" "$WORK"

say "Adding the local $V2_BRANCH so it is rewritten in the same pass"
# v2 must go through the rewrite too. Rewriting it separately would produce
# different SHAs for the same content and leave main unable to fast-forward.
git -C "$WORK" remote add local "$REPO_ROOT"
git -C "$WORK" fetch local "refs/heads/$V2_BRANCH:refs/heads/$V2_BRANCH"

say "Refs before the rewrite"
git -C "$WORK" for-each-ref --format='  %(refname:short)' refs/heads

say "Confirming each path is actually present in history"
for p in "${PATHS[@]}"; do
  n=$(git -C "$WORK" log --oneline --all -- "$p" | wc -l | tr -d ' ')
  printf '  %-32s %s commits\n' "$p" "$n"
done

say "Rewriting history"
FR_ARGS=(--invert-paths)
for p in "${PATHS[@]}"; do FR_ARGS+=(--path "$p"); done
# --force: the mirror is a fresh clone, but filter-repo cannot tell that a mirror
# with an added remote is still pristine.
git -C "$WORK" filter-repo "${FR_ARGS[@]}" --force

say "Verifying the blobs are gone from every ref"
fail=0
for p in "${PATHS[@]}"; do
  n=$(git -C "$WORK" log --oneline --all -- "$p" | wc -l | tr -d ' ')
  if [ "$n" = "0" ]; then
    printf '  \033[32mgone\033[0m  %s\n' "$p"
  else
    printf '  \033[31mSTILL PRESENT\033[0m  %s (%s commits)\n' "$p" "$n"
    fail=1
  fi
done
# Belt and braces: no object anywhere in the rewritten repo may have these names.
leaked=$(git -C "$WORK" rev-list --objects --all \
  | grep -E 'transcription\.txt|gmail-template\.html|sample\.html|kaigi-meeting-v1\.2\.0\.zip' || true)
if [ -n "$leaked" ]; then
  echo "  OBJECTS STILL REACHABLE:"; echo "$leaked" | sed 's/^/    /'; fail=1
else
  echo "  no matching object names reachable from any ref"
fi
[ "$fail" = "0" ] || { echo "Rewrite did not fully succeed. Not proceeding."; exit 1; }

say "Fast-forwarding main to the rewritten $V2_BRANCH"
# v2 is a strict descendant of main (verified: 0 commits in main that are not in
# v2), so this is a fast-forward and needs no merge commit.
if git -C "$WORK" merge-base --is-ancestor refs/heads/main "refs/heads/$V2_BRANCH"; then
  git -C "$WORK" update-ref refs/heads/main "refs/heads/$V2_BRANCH"
  echo "  main -> $(git -C "$WORK" rev-parse --short refs/heads/main) (was fast-forwarded)"
else
  echo "  main and $V2_BRANCH have diverged after the rewrite; merge them by hand in $WORK"
  exit 1
fi

say "Result"
git -C "$WORK" for-each-ref --format='  %(refname:short) %(objectname:short)' refs/heads
echo
echo "  history size: $(git -C "$WORK" count-objects -vH | awk '/size-pack/{print $2, $3}')"
echo "  main version: $(git -C "$WORK" show refs/heads/main:manifest.json | sed -n 's/.*"version": "\([^"]*\)".*/\1/p' | head -1)"

cat <<EOF

$(printf '\033[1m== YOUR TURN ==\033[0m')

The rewritten repository is ready at:
  $WORK

Review it first — this is the last point at which nothing has changed on GitHub:
  git -C "$WORK" log --oneline main | head
  git -C "$WORK" show main:PRIVACY_POLICY.md | head -5     # must be the v2 policy

Then publish the rewrite. This overwrites all branches on the public remote:
  git -C "$WORK" push --force --mirror origin

Afterwards, in this working copy:
  git fetch origin --prune
  git reset --hard origin/main        # your local SHAs are now stale

Then two things the rewrite cannot do for you:
  1. Open a GitHub Support request asking them to garbage-collect
     beborico1/breakdown-tool. Until they do, the old commit SHAs still serve
     the files to anyone holding one.
  2. Tell the colleague whose messages were in sample.html, and decide whether
     the third-party addresses in gmail-template.html need disclosing.

Verify with:
  bash scripts/verify-purge.sh
EOF
