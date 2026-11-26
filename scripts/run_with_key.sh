#!/usr/bin/env bash
# Zero-Custody Local Secret Launcher (POSIX) — RAM only, never written to disk.
set -euo pipefail
if [ "$#" -lt 2 ]; then
  echo "Usage: $0 ENV_VAR_NAME executable [args...]" >&2
  exit 2
fi
VAR_NAME="$1"
shift
if [[ ! "$VAR_NAME" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
  echo "Invalid environment variable name: $VAR_NAME" >&2
  exit 2
fi
printf "Paste value for %s (input hidden): " "$VAR_NAME" >&2
IFS= read -r -s SECRET_VAL
printf "\n" >&2
export "${VAR_NAME}=${SECRET_VAL}"
unset SECRET_VAL
trap 'unset "$VAR_NAME"' EXIT
"$@"
