#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-8787}"
exec uv run uvicorn main:app --host 127.0.0.1 --port "$PORT" "$@"
