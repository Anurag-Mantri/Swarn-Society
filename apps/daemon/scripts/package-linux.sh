#!/usr/bin/env bash
set -euo pipefail

if [[ $(uname -s) != Linux || $# != 1 || $1 != /* || -e $1 || -L $1 ]]; then
  echo 'Run on Linux with one absolute path to a new package directory.' >&2
  exit 1
fi

target=$1
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
cd "$repo"

corepack pnpm --filter @swarmroom/protocol build
corepack pnpm --filter @swarmroom/daemon build
corepack pnpm --filter @swarmroom/daemon deploy --prod --legacy "$target"
