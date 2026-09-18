#!/usr/bin/env bash
# ULTRON LiveKit worker launcher (Windows Git Bash / Linux / macOS)
# Usage: ./start.sh [dev]
set -e
cd "$(dirname "$0")"

if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required — install it first:  https://docs.astral.sh/uv/"
  exit 1
fi

uv sync
MODE="${1:-dev}"
exec uv run agent.py "$MODE"
