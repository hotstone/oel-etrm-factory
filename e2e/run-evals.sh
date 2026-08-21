#!/usr/bin/env bash
# Run the eval sweep against the DEPLOYED runtime. Optionally pass case ids.
# Full sweep costs real money (one pipeline run per pr-expected case).
set -euo pipefail
cd "$(dirname "$0")/../src/runtime"
npx tsx src/eval-runner.ts "$@"
