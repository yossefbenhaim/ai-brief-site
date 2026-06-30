#!/bin/bash
# Keep only the most recent RETAIN_DAYS AI briefs in the briefs dir + the quartz mirror.
set -euo pipefail
DIR="${BRIEFS_DIR:-/home/yossef7875/.openclaw/workspace/insights/briefs}"
KEEP="${RETAIN_DAYS:-7}"
cd "$DIR"
ls -1 *-ai-brief.md 2>/dev/null | sort -r | tail -n +$((KEEP+1)) | while read -r f; do
  echo "pruning old brief: $f"; rm -f "$f"
  rm -f "/home/yossef7875/quartz/content/insights/$f" 2>/dev/null || true
done
echo "kept $(ls -1 *-ai-brief.md 2>/dev/null | wc -l) briefs"
