#!/usr/bin/env bash

set -o errexit
set -o nounset
set -o pipefail

usage() {
  echo "Usage: $(basename "$0") [--by input|output|cache-read|cache-write] [models-store.json]" >&2
}

sort_field="input"
file="models-store.json"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --by)
      [[ $# -ge 2 ]] || { usage; exit 1; }
      case "$2" in
        input) sort_field="input" ;;
        output) sort_field="output" ;;
        cache-read) sort_field="cacheRead" ;;
        cache-write) sort_field="cacheWrite" ;;
        *)
          echo "Invalid sort field: $2" >&2
          usage
          exit 1
          ;;
      esac
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    -*)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
    *)
      [[ "$file" == "models-store.json" ]] || { usage; exit 1; }
      file="$1"
      shift
      ;;
  esac
done

[[ -f "$file" ]] || { echo "File not found: $file" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
command -v column >/dev/null || { echo "column is required" >&2; exit 1; }

jq -r --arg sortField "$sort_field" '
  [to_entries[] as $provider
   | $provider.value.models[]
   | . + {provider: $provider.key}]
  | sort_by(.cost[$sortField], .cost.output, .provider, .id)
  | (["Model", "Provider", "Input $/M", "Output $/M", "Cache read $/M", "Cache write $/M", "Higher-input tiers"] | @tsv),
    (.[]
     | [
         .id,
         .provider,
         (.cost.input | tostring),
         (.cost.output | tostring),
         (.cost.cacheRead | tostring),
         (.cost.cacheWrite | tostring),
         (.cost.tiers // []
          | map("above \(.inputTokensAbove): \(.input)/\(.output)/\(.cacheRead)/\(.cacheWrite)")
          | join("; "))
       ]
     | @tsv)
' "$file" | column -t -s $'\t'
