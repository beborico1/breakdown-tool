#!/usr/bin/env bash
#
# Confirm the confidential files are no longer served by the public repository.
#
# Checks the actual public URLs rather than the local clone, because that is what
# an outsider sees. Run after the force-push. Every line must read 404.
set -uo pipefail

OWNER="beborico1"
# Update if the repository has been renamed.
REPO="${1:-breakdown-tool}"

PATHS=(
  transcription.txt
  docs/gmail-template.html
  src/content/chat/sample.html
  kaigi-meeting-v1.2.0.zip
)

BRANCHES=(
  main
  v2-japanese-in-color
  feat-per-clause-hover-dots
  fix-meet-paint-and-rescan
  fix-universal-fake-furigana
  perf-reduce-resource-usage
)

printf '\033[1mChecking https://raw.githubusercontent.com/%s/%s\033[0m\n\n' "$OWNER" "$REPO"

bad=0
for b in "${BRANCHES[@]}"; do
  printf '  %s\n' "$b"
  for p in "${PATHS[@]}"; do
    code=$(curl -s -o /dev/null -w '%{http_code}' \
      "https://raw.githubusercontent.com/$OWNER/$REPO/$b/$p")
    if [ "$code" = "404" ]; then
      printf '    \033[32m404\033[0m  %s\n' "$p"
    elif [ "$code" = "200" ]; then
      printf '    \033[31m200 STILL PUBLIC\033[0m  %s\n' "$p"
      bad=1
    else
      # A missing branch also returns 404 for every path, so a different code
      # (e.g. 429 rate limit) must not be read as success.
      printf '    \033[33m%s\033[0m  %s (inconclusive)\n' "$code" "$p"
      bad=1
    fi
  done
done

echo
if [ "$bad" = "0" ]; then
  cat <<'EOF'
All paths return 404 on every branch.

Still outstanding — a rewrite cannot do these:
  - GitHub Support must garbage-collect the repository. Until then the files are
    still retrievable by anyone who has an old commit SHA. Verify by asking them
    to confirm, not by assuming.
  - Notify the colleague named in sample.html, and decide on the third-party
    addresses from gmail-template.html.
EOF
else
  echo "Not clean. Do not treat the exposure as closed."
  exit 1
fi
