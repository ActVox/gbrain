#!/usr/bin/env bash
# Compatibility wrapper. ATX-HUB is legacy; ActVox production now tracks master.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "⚠ scripts/sync-from-master.sh is deprecated; use scripts/sync-from-upstream.sh" >&2
exec "$DIR/sync-from-upstream.sh" "$@"
