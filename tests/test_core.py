import math

import numpy as np
from shapely.geometry import box

from awnstudio.calibration import Calibration
from awnstudio.geometry import angle_between, end_direction
from awnstudio.layout import SlotTemplate, ordered_match
from awnstudio.measurement import measure_path_mm, simplify_path, trim_root
from awnstudio.tracer import Trace, Tracer


def test_anisotropic_length():
    cal = Calibration(x_period_px=50.0, y_period_px=100.0)  # 0.1 mm/px in x, 0.05 in y
    assert math.isclose(cal.length_mm([(0, 0), (10, 0)]), 1.0)
    assert math.isclose(cal.length_mm([(0, 0), (0, 10)]), 0.5)


def test_simplify_keeps_endpoints():
    path = [(0, 0), (1, 0.4), (2, 0), (3, 0.4), (4, 0)]
    out = simplify_path(path, 1.0)
    assert out[0] == (0.0, 0.0) and out[-1] == (4.0, 0.0)
    assert math.isclose(measure_path_mm(path, Calibration(5.0, 5.0)), 4.0)


def test_trim_root_starts_at_spikelet_exit():
    spikelet = box(0, 0, 10, 10)
    path = [(5, 5), (5, 8), (5, 12), (5, 20)]
    out = trim_root(path, spikelet)
    assert out[0] == (5.0, 10.0)
    assert out[-1] == (5.0, 20.0)
    assert trim_root([(5, 12), (5, 20)], spikelet) == [(5.0, 12.0), (5.0, 20.0)]


def test_ordered_match_preserves_order_and_leaves_gaps():
    anchors = (0.15, 0.41, 0.71)
    # left and right present, middle empty: must not be squeezed into middle
    assert ordered_match([0.14, 0.72], anchors, 0.33) == [0, 2]
    assert ordered_match([0.15, 0.40, 0.70], anchors, 0.33) == [0, 1, 2]
    # an extra far-off object is left unassigned
    assert ordered_match([0.15, 0.40, 0.70, 1.6], anchors, 0.33) == [0, 1, 2, None]


def test_end_direction_and_angles():
    path = np.array([[0, 0], [1, 0], [2, 0], [3, 0]], float)
    assert np.allclose(end_direction(path), [1, 0])
    assert math.isclose(angle_between(np.array([1, 0]), np.array([0, 1])), 90.0)


def test_median_trace_is_length_median():
    traces = [Trace([], 0.2, 10.0), Trace([], 0.25, 20.0), Trace([], 0.55, 30.0)]
    assert Tracer.median_trace(traces).length_mm == 30.0
    traces = [Trace([], 0.6, 10.0), Trace([], 0.4, 30.0)]
    assert Tracer.median_trace(traces).length_mm == 10.0
