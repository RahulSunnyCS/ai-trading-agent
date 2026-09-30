#!/usr/bin/env bash
# Rebuild the Parquet cache from the raw JSON committed under data/raw/.
#
# data/cache/ is gitignored ("Derived from data/raw/ — never commit, regenerate
# via `obt ingest`"), so a fresh checkout has no cache and every test that reads
# one fails with {"error": "no_data"}. CI therefore has to build it before pytest.
#
# The date range is derived from the raw filenames (…__<from>_<to>.json) so this
# does not rot when the fixtures are refreshed.
set -euo pipefail
cd "$(dirname "$0")/.."

from=$(ls data/raw/algotest/*/*/*/*.json | sed -E 's/.*__([0-9-]{10})_([0-9-]{10})\.json/\1/' | sort | head -1)
to=$(ls data/raw/algotest/*/*/*/*.json | sed -E 's/.*__([0-9-]{10})_([0-9-]{10})\.json/\2/' | sort | tail -1)
echo "building cache for $from .. $to"

d="$from"; n=0
while [[ "$d" < "$to" || "$d" == "$to" ]]; do
  # Weekdays only; a market holiday simply ingests nothing and is skipped.
  # `date -d` is GNU-only (no `gdate` on a bare macOS install either) — python3's
  # stdlib does both the weekday check and the +1 day increment portably.
  weekday=$(python3 -c "from datetime import date; print(date.fromisoformat('$d').isoweekday())")
  if [ "$weekday" -le 5 ]; then
    uv run obt ingest --date "$d" --underlying NIFTY >/dev/null 2>&1 && n=$((n + 1)) || true
  fi
  d=$(python3 -c "from datetime import date, timedelta; print(date.fromisoformat('$d') + timedelta(days=1))")
done
echo "ingested $n day(s); $(find data/cache -type f | wc -l) cache file(s)"
