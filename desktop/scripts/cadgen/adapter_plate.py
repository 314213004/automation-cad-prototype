"""cadgen sidecar: full FeatureDoc translation of the canonical demo adapter.

Source: desktop/src/canvas/adapter-model.ts adapterFeatureDoc()
for the demo node (demo-adapter-check.mjs / demo-graph.ts SLIDER60->BODY48):
  plate 90 x 90 x 12 mm, material 6061-T6, flat_through
  from-port (counterbore, top face): 4 x dia 5.5 mm through holes on a
    60 x 60 mm pitch (+-30, +-30), each with a dia 8.5 x 5 mm deep
    counterbore (M5 head: headDia 8.5, headHeight 5,
    depth = min(5, 12-1) = 5)
  to-port (plain through): 4 x dia 5.5 mm holes on a 48 x 36 mm pitch
    (+-24, +-18)
  dowelDiaMm = 0 -> no dowel holes
  fillet: four vertical edges only, R3 (edges '|Z',
    radius = min(3, 12) = 3)

Plate is centred at the origin: X/Y in [-45, 45], Z in [-6, 6],
top face at Z = +6, so a counterbore spans Z in [1, 6] (centre 3.5).

Expected (hand calculation, from v1 94,919.2 mm^3):
  counterbore extra removal: 4 * pi * (4.25^2 - 2.75^2) * 5 = 659.7 mm^3
  fillet removal: 4 * (3^2 - pi*3^2/4) * 12 = 92.7 mm^3
  expected volume ~94,167 mm^3, mass ~0.2543 kg (6061, 2.7 g/cm^3)
  bounds unchanged: 90 x 90 x 12 mm
"""
import build123d as bd
from cadgen import materials, model


def adapter_plate_body():
    plate = bd.Box(90, 90, 12)
    plate.label = "adapter_plate"
    plate.color = "#4a6fa5"
    plate.material = materials.aluminium_6061
    # From-port: through holes + top-face counterbores.
    for x, y in [(-30, -30), (30, -30), (-30, 30), (30, 30)]:
        plate = plate - bd.Pos(x, y, 0) * bd.Cylinder(5.5 / 2, 14)
        plate = plate - bd.Pos(x, y, 3.5) * bd.Cylinder(8.5 / 2, 5)
    # To-port: plain through holes.
    for x, y in [(-24, -18), (24, -18), (-24, 18), (24, 18)]:
        plate = plate - bd.Pos(x, y, 0) * bd.Cylinder(5.5 / 2, 14)
    # Fillet: four vertical edges only. Note: bd.fillet returns a new
    # shape, dropping the label/material set above, so re-apply them.
    plate = bd.fillet(plate.edges().filter_by(bd.Axis.Z), radius=3)
    plate.label = "adapter_plate"
    plate.color = "#4a6fa5"
    plate.material = materials.aluminium_6061
    return plate


@model
def adapter_plate():
    return adapter_plate_body()


if __name__ == "__main__":
    adapter_plate()
