"""CadQuery spike: 参数化支架 + 参数重建 + 导出 STEP/STL，量时间与体积。"""
import time, json, pathlib
import cadquery as cq

OUT = pathlib.Path(__file__).parent / "out"
OUT.mkdir(exist_ok=True)

def build(hole_d=6.0, rib_t=6.0, plate_t=8.0):
    L, W = 120.0, 80.0
    p = (
        cq.Workplane("XY")
        .box(L, W, plate_t, centered=(True, True, False))
        .edges("|Z").fillet(6.0)
        # 四角安装孔
        .faces(">Z").workplane()
        .rect(L - 32, W - 32, forConstruction=True)
        .vertices()
        .hole(hole_d)
        # 中央减重槽
        .faces(">Z").workplane()
        .slot2D(50, 18)
        .cutThruAll()
        # 立筋
        .faces(">Z").workplane(offset=0)
        .center(0, W / 2 - rib_t / 2)
        .rect(L - 20, rib_t)
        .extrude(40)
        .edges("|X").fillet(2.0)
    )
    return p

def stats(shape):
    bb = shape.val().BoundingBox()
    return {
        "volume_mm3": round(shape.val().Volume(), 1),
        "bbox": [round(bb.xlen, 2), round(bb.ylen, 2), round(bb.zlen, 2)],
        "faces": len(shape.val().Faces()),
        "edges": len(shape.val().Edges()),
        "solids": len(shape.solids().vals()),
    }

results = {}
t0 = time.perf_counter()
part = build()
t1 = time.perf_counter()
results["build_initial_ms"] = round((t1 - t0) * 1000, 1)
results["initial"] = stats(part)

t2 = time.perf_counter()
part2 = build(hole_d=8.0, rib_t=10.0)
t3 = time.perf_counter()
results["rebuild_param_change_ms"] = round((t3 - t2) * 1000, 1)
results["changed"] = stats(part2)

for name, shape in (("bracket_v1", part), ("bracket_v2", part2)):
    t = time.perf_counter()
    cq.exporters.export(shape, str(OUT / f"{name}.step"))
    results[f"step_ms_{name}"] = round((time.perf_counter() - t) * 1000, 1)
    t = time.perf_counter()
    cq.exporters.export(shape, str(OUT / f"{name}.stl"), tolerance=0.1)
    results[f"stl_ms_{name}"] = round((time.perf_counter() - t) * 1000, 1)

results["files"] = {p.name: p.stat().st_size for p in sorted(OUT.iterdir())}
print(json.dumps(results, ensure_ascii=False, indent=1))
