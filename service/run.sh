#!/usr/bin/env bash
# Start the AwnStudio service from WSL with the ROCm environment.
#   service/run.sh [--device 0] [--port 8790] [--no-model]
set -euo pipefail
cd "$(dirname "$0")/.."
export HSA_ENABLE_DXG_DETECTION=1
export PYTHONPATH=src
exec "${AWNSTUDIO_PYTHON:-/root/.venvs/wheat_awn_rocm/bin/python}" service/server.py "$@"
