#!/usr/bin/env bash
# One development cycle: decision datasets -> models -> train-page eval -> protocol -> validation eval.
set -euo pipefail
cd "$(dirname "$0")/.."
export PYTHONPATH=src
PY=${PY:-/root/.venvs/wheat_awn_rocm/bin/python}
METHOD=${METHOD:-pfg}
if [ "${SKIP_DATA:-0}" != "1" ]; then
  $PY scripts/build_link_dataset.py --split valid > runs/linkdata_valid.log
  $PY scripts/build_link_dataset.py --split train > runs/linkdata_train.log
fi
$PY scripts/fit_link_models.py | grep -v "valid 0\." 
$PY scripts/run_baseline.py --method "$METHOD" --split train | tail -1
$PY scripts/fit_protocol.py --method "$METHOD"
$PY scripts/run_baseline.py --method "$METHOD" --split valid | tail -2
