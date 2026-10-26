from shapely.geometry import LineString, box

from awnstudio.calibration import Calibration
from awnstudio.diagnose import break_polygon, classify_path, truth_awns
from awnstudio.truth import TruthInstance

CAL = Calibration(50.0, 50.0)  # 0.1 mm / px


def _scene():
    # Spikelet at the bottom; awn A goes straight up, awn B is a separate awn to the right.
    spikelet = TruthInstance("s", "spikelet", box(90, 400, 110, 460))
    a = TruthInstance("a", "awn", LineString([(100, 400), (100, 100)]).buffer(3))
    b = TruthInstance("b", "awn", LineString([(160, 400), (160, 100)]).buffer(3))
    truth = [spikelet, a, b]
    awns, spikelets = truth_awns(truth, CAL)
    evidence = a.geometry.union(b.geometry)
    return awns, spikelets[0], evidence


def _classify(path):
    awns, spikelet, evidence = _scene()
    return classify_path(path, awns, spikelet.buffer(4), evidence, CAL)


def test_truth_axis_oriented_and_attached():
    awns, _, _ = _scene()
    assert awns[0].spikelet == 0 and awns[0].axis.coords[0][1] > awns[0].axis.coords[-1][1]
    assert 28 < awns[0].length_mm < 31


def test_ok_short_jump_false():
    assert _classify([(100, 430), (100, 105)])["cls"] == "OK"
    r = _classify([(100, 430), (100, 250)])
    assert r["cls"] == "SHORT" and r["detail"] == "evidence_continues"
    assert _classify([(100, 430), (100, 250), (160, 240), (160, 100)])["cls"] == "JUMP"
    r = _classify([(100, 430), (100, 100), (100, 20)])
    assert r["cls"] == "FALSE_LINK" and r["detail"] == "empty_space/tip_overshoot"


def test_break_polygon_cuts_every_10mm():
    poly = LineString([(0, 0), (0, 300)]).buffer(3)  # 30 mm at 0.1 mm/px
    assert len(break_polygon(poly, 0.1)) == 3
