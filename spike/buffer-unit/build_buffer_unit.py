"""光伏板缓存堆叠单元 · 示意三维（build123d）

用途：给画布方案配一套可打开的三维，让「链条升降 + 30 层非接触堆叠 + 机内进出料」看得见。
布置原则：**进出料机构在机器内部** —— 皮带、滚筒、驱动、挡停、光电全部落在 1500×1400 机架内，
整机包络 1500×1400×1800mm，不外伸，装线时按一个工位占位。

边界（必须写清楚）：
  - 这是**机构示意**：立柱/横梁/链轨/托条按尺寸摆位，不是供应商真实结构，不含焊缝、导轨副、链轮张紧细节。
  - 单板 2400×1200×35mm/32kg。皮带 1100 宽（板两侧各悬 50mm），托条托在板长边（y=±600，580~620），
    侧板 550~570、链轨 634~650，互不干涉；皮带面 900mm，托条层位 120+40i 不落在 894~900 区间。
  - 质量按体积 × 材料密度估算，且按实心建模（型材/链条/滚筒非空腔），**偏保守偏高**，非称重值。
"""
import os
from build123d import Box, Cylinder, Pos, Rot, Compound, export_step, export_stl

OUT = "/root/.config/AutomationCAD/projects/光伏缓存堆叠单元"
PARTS = os.path.join(OUT, "parts")
os.makedirs(PARTS, exist_ok=True)

# 主尺度（mm）
FRAME_X, FRAME_Y, FRAME_H = 1500.0, 1400.0, 1800.0
POST = 80.0
BEAM = 80.0
LAYER_PITCH = 40.0
LAYER_COUNT = 30
CONV_TOP = 900.0            # 输送面高（与画布工位一致）
BELT_X, BELT_Y, BELT_T = 1400.0, 1100.0, 6.0
ROLLER_R = 30.0             # Ø60 滚筒（实心建模，比真实管件偏重）
SIDE_T, SIDE_H = 20.0, 120.0
RAIL_Y = 600.0              # 托条托在板长边（580~620），位于侧板外侧
CHAIN_Y = 642.0             # 链条/链轨再往外一点，仍在机架内（内边界 670）

parts = []  # (name, shape, density_kg_per_mm3, material)


def add(name, shape, density, material):
    parts.append((name, shape, density, material))


# 1) 机架：4 立柱 + 上下各 4 横梁
hx, hy = FRAME_X / 2 - POST / 2, FRAME_Y / 2 - POST / 2
for label, sx, sy in (("左前", -hx, -hy), ("右前", hx, -hy), ("左后", -hx, hy), ("右后", hx, hy)):
    add(f"立柱-{label}", Pos(sx, sy, FRAME_H / 2) * Box(POST, POST, FRAME_H), 2.7e-6, "铝型材 6063-T5")
for z, tag in ((FRAME_H - BEAM / 2, "顶"), (BEAM / 2, "底")):
    add(f"{tag}横梁-X1", Pos(0, -hy, z) * Box(FRAME_X, BEAM, BEAM), 2.7e-6, "铝型材 6063-T5")
    add(f"{tag}横梁-X2", Pos(0, hy, z) * Box(FRAME_X, BEAM, BEAM), 2.7e-6, "铝型材 6063-T5")
    add(f"{tag}横梁-Y1", Pos(-hx, 0, z) * Box(BEAM, FRAME_Y, BEAM), 2.7e-6, "铝型材 6063-T5")
    add(f"{tag}横梁-Y2", Pos(hx, 0, z) * Box(BEAM, FRAME_Y, BEAM), 2.7e-6, "铝型材 6063-T5")

# 2) 机内输送：皮带 + 两端滚筒 + 两侧板 + 驱动（全部在机架内）
add("输送-皮带", Pos(0, 0, CONV_TOP - BELT_T / 2) * Box(BELT_X, BELT_Y, BELT_T), 1.2e-6, "PVC 皮带")
for side, y in (("近侧", -(BELT_Y / 2 + SIDE_T / 2)), ("远侧", BELT_Y / 2 + SIDE_T / 2)):
    add(f"输送-侧板-{side}", Pos(0, y, CONV_TOP - SIDE_H / 2) * Box(BELT_X, SIDE_T, SIDE_H), 2.7e-6, "铝型材 6063-T5")
for idx, dx in enumerate((-(BELT_X / 2 - ROLLER_R - 20), BELT_X / 2 - ROLLER_R - 20), 1):
    add(f"输送-滚筒-{idx}", Pos(dx, 0, CONV_TOP - BELT_T - ROLLER_R) * Rot(90, 0, 0) * Cylinder(ROLLER_R, BELT_Y + 40), 7.85e-6, "45# 钢")
# 驱动：减速机 + 电机，挂在机内（不伸出机架）
add("输送-减速机", Pos(-420, 520, 260) * Box(180, 160, 160), 7.85e-6, "铸铁")
add("输送-驱动电机", Pos(-420, 520, 430) * Cylinder(70, 200), 7.85e-6, "电机 750W")
add("输送-传动链罩", Pos(-420, 560, 620) * Box(60, 40, 340), 2.7e-6, "铝型材 6063-T5")

# 3) 链条升降：两侧链轨 + 链条（在皮带外侧、机架内侧）
for side, y in (("近侧", -CHAIN_Y), ("远侧", CHAIN_Y)):
    for offset, tag in ((-30, "外"), (30, "内")):
        add(f"链轨-{side}-{tag}", Pos(0, y + offset, FRAME_H / 2) * Box(1200, 8, FRAME_H - 2 * BEAM), 2.7e-6, "铝型材 6063-T5")
    add(f"链条-{side}", Pos(0, y, FRAME_H / 2) * Box(1000, 20, 8), 7.85e-6, "链条 40Cr")

# 4) 30 层非接触托条：每层 2 根，托板长边（皮带外侧，不穿输送面）
z0 = 120.0
SUPPORT_W, SUPPORT_T = 40.0, 3.0
for i in range(LAYER_COUNT):
    z = z0 + i * LAYER_PITCH
    for j, y in enumerate((-RAIL_Y, RAIL_Y), 1):
        add(f"托条-L{i+1:02d}-{j}", Pos(0, y, z) * Box(1400, SUPPORT_W, SUPPORT_T), 7.85e-6, "Q235 钢板")

# 5) 升降托架（连接两侧托条）+ 驱动座
add("升降托架-横梁", Pos(0, 0, z0 - 60) * Box(200, 2 * RAIL_Y, 40), 7.85e-6, "Q235 钢板")
add("升降驱动座", Pos(hx - 140, 0, 300) * Box(240, 200, 160), 7.85e-6, "Q235 钢板")

# 6) 机内进出料辅助机构：入口对射光电（E3Z-T81）+ 出口挡停
for side, sx in (("近侧", -(BELT_X / 2 - 80)), ("远侧", BELT_X / 2 - 80)):
    add(f"对射光电-{side}", Pos(sx, -(BELT_Y / 2 - 60), CONV_TOP + 260) * Box(30, 60, 40), 2.7e-6, "E3Z-T81")
    add(f"光电支架-{side}", Pos(sx, -(BELT_Y / 2 + 40), CONV_TOP + 130) * Box(40, 40, 300), 2.7e-6, "铝型材 6063-T5")
add("挡停气缸", Pos(BELT_X / 2 - 120, -(BELT_Y / 2 - 40), CONV_TOP + 40) * Box(60, 60, 220), 2.7e-6, "薄型气缸")
add("挡停挡板", Pos(BELT_X / 2 - 120, 0, CONV_TOP + 120) * Box(20, 900, 100), 7.85e-6, "Q235 钢板")

print("PARTS_COUNT", len(parts))

files = []
volume_total = 0.0
mass_total = 0.0
shapes = []
for index, (name, shape, density, material) in enumerate(parts, 1):
    filename = f"{index:02d}-{name}.stl"
    export_stl(shape, os.path.join(PARTS, filename))
    files.append({"file": filename, "name": name, "material": material})
    volume_total += shape.volume
    mass_total += shape.volume * density
    shapes.append(shape)

compound = Compound(children=shapes)
export_step(compound, os.path.join(OUT, "model.step"))
export_stl(compound, os.path.join(OUT, "model.stl"))

bbox = compound.bounding_box()
print("VOLUME_MM3", round(volume_total, 1))
print("MASS_KG", round(mass_total, 1))
print("ENVELOPE", [round(bbox.max.X - bbox.min.X, 1), round(bbox.max.Y - bbox.min.Y, 1), round(bbox.max.Z - bbox.min.Z, 1)])
print("SOLIDS", len(compound.solids()))
print("PARTS", len(files))
