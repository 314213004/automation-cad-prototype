"""P9-4 handoff check: solved sketch vertices -> build123d polyline -> face -> extrude.

Run from this directory after `pip install build123d==0.13.0`:
    .venv/bin/python check-build123d.py
Reads result.json (written by `npm run solve`), falls back to the measured rectangle.
"""
import json
import time
from pathlib import Path

from build123d import BuildLine, BuildPart, BuildSketch, Plane, Polyline, extrude, make_face

HEIGHT = 8.0
expected_vertices = [[0.0, 0.0], [120.0, 0.0], [120.0, 80.0], [0.0, 80.0]]
result_path = Path(__file__).with_name("result.json")
vertices = (
    json.loads(result_path.read_text(encoding="utf-8"))["vertices"]
    if result_path.exists()
    else expected_vertices
)

started = time.perf_counter()
with BuildPart() as part:
    with BuildSketch(Plane.XY):
        with BuildLine():
            Polyline(*[(x, y) for x, y in vertices], close=True)
        make_face()
    extrude(amount=HEIGHT)
elapsed_ms = (time.perf_counter() - started) * 1000

solid = part.part
bbox = solid.bounding_box()
summary = {
    "build123d": __import__("build123d").__version__,
    "vertices": vertices,
    "height": HEIGHT,
    "volumeMm3": round(solid.volume, 6),
    "bbox": {
        "x": [round(bbox.min.X, 6), round(bbox.max.X, 6)],
        "y": [round(bbox.min.Y, 6), round(bbox.max.Y, 6)],
        "z": [round(bbox.min.Z, 6), round(bbox.max.Z, 6)],
    },
    "faces": len(solid.faces()),
    "edges": len(solid.edges()),
    "solids": len(solid.solids()),
    "buildMs": round(elapsed_ms, 2),
}
print(json.dumps(summary, ensure_ascii=False, indent=2))

assert abs(solid.volume - 120 * 80 * HEIGHT) < 1e-6, solid.volume
assert abs((bbox.max.X - bbox.min.X) - 120) < 1e-6
assert abs((bbox.max.Y - bbox.min.Y) - 80) < 1e-6
assert abs((bbox.max.Z - bbox.min.Z) - HEIGHT) < 1e-6
