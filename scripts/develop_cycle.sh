#!/usr/bin/env bash
# One development cycle: decision datasets -> models -> train-page eval -> protocol -> validation eval.
set -euo pipefail
cd "$(dirname "$0")/.."
export PYTHONPATH=src
PY=${PY:-/root/.venvs/wheat_awn_rocm/bin/python}
METHOD=${METHOD:-pfg}
DET=${DETECTOR:+--detector $DETECTOR}  # DETECTOR=<id> runs the cycle for another detector
if [ "${SKIP_DATA:-0}" != "1" ]; then
  $PY scripts/build_link_dataset.py --split valid $DET > runs/linkdata_valid${DETECTOR:+_$DETECTOR}.log
  $PY scripts/build_link_dataset.py --split train $DET > runs/linkdata_train${DETECTOR:+_$DETECTOR}.log
fi
$PY scripts/fit_link_models.py $DET | grep -v "valid 0\." 
$PY scripts/run_baseline.py --method "$METHOD" --split train $DET | tail -1
$PY scripts/fit_protocol.py --method "$METHOD" $DET
$PY scripts/run_baseline.py --method "$METHOD" --split valid $DET | tail -2
