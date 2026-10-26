"""光伏板缓存堆叠单元 · 示意三维（build123d）

用途：给画布方案配一套可打开的三维，让「链条升降 + 30 层非接触堆叠」看得见。
边界（必须写清楚）：
  - 这是**机构示意**：立柱/横梁/链轨/托架/层板按尺寸摆位，不是供应商真实结构，不含焊缝、导轨副、链轮张紧细节。
  - 单板 2400×1200×35mm/32kg。堆叠本体 1500(X)×1400(Y)×1800mm、30 层 × 40mm 层距；
    前后各接 900mm 长进出料皮带段（输送面 900mm），整机包络 3300×1750×1800mm。
  - 质量按体积 × 材料密度估算，非称重值。
"""
import os
import math
from build123d import Box, Cylinder, Pos, Rot, Compound, export_step, export_stl

OUT = "/root/.config/AutomationCAD/projects/光伏缓存堆叠单元"
PARTS = os.path.join(OUT, "parts")
os.makedirs(PARTS, exist_ok=True)

# 主尺度（mm）
FRAME_X, FRAME_Y, FRAME_H = 1500.0, 1400.0, 1800.0
POST = 80.0            # 立柱 80×80
BEAM = 80.0
LAYER_PITCH = 40.0     # 层距
LAYER_COUNT = 30
LAYER_T = 4.0          # 层板厚
PLATE_X, PLATE_Y = 1400.0, 1200.0   # 层板（承托托架）略小于占地
CHAIN_X, CHAIN_W, CHAIN_T = 1200.0, 60.0, 20.0

parts = []  # (filename, name, shape, density_kg_mm3, material)


def add(name, shape, density, material):
    parts.append((name, shape, density, material))


# 1) 4 根立柱
hx, hy = FRAME_X / 2 - POST / 2, FRAME_Y / 2 - POST / 2
for label, sx, sy in (("左前", -hx, -hy), ("右前", hx, -hy), ("左后", -hx, hy), ("右后", hx, hy)):
    add(f"立柱-{label}", Pos(sx, sy, FRAME_H / 2) * Box(POST, POST, FRAME_H), 2.7e-6, "铝型材 6063-T5")

# 2) 上下横梁（每边一根，共 8 根）
for z, tag in ((FRAME_H - BEAM / 2, "顶"), (BEAM / 2, "底")):
    add(f"{tag}横梁-X1", Pos(0, -hy, z) * Box(FRAME_X, BEAM, BEAM), 2.7e-6, "铝型材 6063-T5")
    add(f"{tag}横梁-X2", Pos(0, hy, z) * Box(FRAME_X, BEAM, BEAM), 2.7e-6, "铝型材 6063-T5")
    add(f"{tag}横梁-Y1", Pos(-hx, 0, z) * Box(BEAM, FRAME_Y, BEAM), 2.7e-6, "铝型材 6063-T5")
    add(f"{tag}横梁-Y2", Pos(hx, 0, z) * Box(BEAM, FRAME_Y, BEAM), 2.7e-6, "铝型材 6063-T5")

# 3) 两条链条升降轨（每侧两根 12mm 厚导轨 + 一条 20mm 宽链条）
RAIL_T = 8.0
for side, y in (("近侧", -CHAIN_W - 40), ("远侧", CHAIN_W + 40)):
    for offset, tag in ((-CHAIN_W / 2 + 10, "外"), (CHAIN_W / 2 - 10, "内")):
        add(f"链轨-{side}-{tag}", Pos(0, y + offset, FRAME_H / 2) * Box(CHAIN_X, RAIL_T, FRAME_H - 2 * BEAM), 2.7e-6, "铝型材 6063-T5")
    # 链条按 20×8 扁条示意（真实滚子链不是实心块，实心建模会严重高估质量）
    add(f"链条-{side}", Pos(0, y, FRAME_H / 2) * Box(CHAIN_X - 200, CHAIN_T, 8), 7.85e-6, "链条 40Cr")

# 4) 30 层托架（非接触堆叠：每层 4 根 40mm 宽托条，不铺整板，避免接触板面工作区）
z0 = 120.0
SUPPORT_W = 40.0
SUPPORT_T = 3.0
for i in range(LAYER_COUNT):
    z = z0 + i * LAYER_PITCH
    for j, y in enumerate((-PLATE_Y / 2 + 150, -PLATE_Y / 6, PLATE_Y / 6, PLATE_Y / 2 - 150), 1):
        add(f"托条-L{i+1:02d}-{j}", Pos(0, y, z) * Box(PLATE_X, SUPPORT_W, SUPPORT_T), 7.85e-6, "Q235 钢板")

# 5) 升降托架底板
add("升降托架底板", Pos(0, 0, z0 - 60) * Box(PLATE_X, 200, 40), 7.85e-6, "Q235 钢板")

# 6) 伺服减速机座（升降驱动）
add("驱动座", Pos(hx - 120, 0, 300) * Box(240, 200, 160), 7.85e-6, "Q235 钢板")

# 7) 进出料机构：入口/出口各一段皮带输送（900 长），带滚筒、侧板、支腿、驱动电机、光电支架、挡停
CONV_LEN = 900.0
CONV_W = 1200.0          # 皮带有效宽度
CONV_TOP = 900.0         # 输送面高度（与画布工位高度一致）
BELT_T = 6.0
SIDE_T = 20.0
SIDE_H = 120.0
LEG = 80.0
ROLLER_R = 30.0  # Ø60 滚筒（实心建模，比真实管件偏重）


def add_conveyor(sign, label):
    """sign=-1 入口（-X 侧），+1 出口（+X 侧）"""
    cx = sign * (FRAME_X / 2 + CONV_LEN / 2)
    add(f"{label}-皮带", Pos(cx, 0, CONV_TOP - BELT_T / 2) * Box(CONV_LEN, CONV_W, BELT_T), 1.2e-6, "PVC 皮带")
    for side, y in (("近侧", -(CONV_W / 2 + SIDE_T / 2)), ("远侧", CONV_W / 2 + SIDE_T / 2)):
        add(f"{label}-侧板-{side}", Pos(cx, y, CONV_TOP - SIDE_H / 2) * Box(CONV_LEN, SIDE_T, SIDE_H), 2.7e-6, "铝型材 6063-T5")
    for idx, dx in enumerate((-CONV_LEN / 2 + ROLLER_R + 10, CONV_LEN / 2 - ROLLER_R - 10), 1):
        add(f"{label}-滚筒-{idx}", Pos(cx + dx, 0, CONV_TOP - BELT_T - ROLLER_R) * Rot(90, 0, 0) * Cylinder(ROLLER_R, CONV_W + 40), 7.85e-6, "45# 钢")
    for side, x in (("近侧", cx - sign * (CONV_LEN / 2 - 100)), ("远侧", cx + sign * (CONV_LEN / 2 - 100))):
        for idx, y in enumerate((-(CONV_W / 2 + 90), CONV_W / 2 + 90), 1):
            add(f"{label}-支腿-{side}{idx}", Pos(x, y, (CONV_TOP - SIDE_H) / 2) * Box(LEG, LEG, CONV_TOP - SIDE_H), 2.7e-6, "铝型材 6063-T5")
    # 驱动电机 + 减速机（挂在远侧侧板外）
    add(f"{label}-减速机", Pos(cx, CONV_W / 2 + 120, CONV_TOP - 200) * Box(180, 160, 160), 7.85e-6, "铸铁")
    add(f"{label}-驱动电机", Pos(cx, CONV_W / 2 + 300, CONV_TOP - 200) * Rot(0, 0, 0) * Cylinder(70, 200), 7.85e-6, "电机 750W")
    # 入口对射光电（E3Z-T81）：两侧立柱 + 发射/接收头
    if sign < 0:
        for side, y in (("近侧", -(CONV_W / 2 + 60)), ("远侧", CONV_W / 2 + 60)):
            add(f"光电支架-{side}", Pos(cx + 120, y, CONV_TOP + 150) * Box(40, 40, 300), 2.7e-6, "铝型材 6063-T5")
            add(f"对射光电-{side}", Pos(cx + 120, y - (60 if y > 0 else -60), CONV_TOP + 280) * Box(30, 60, 40), 2.7e-6, "E3Z-T81")
    # 出口挡停（放行机构）：气缸 + 挡板
    if sign > 0:
        add(f"{label}-挡停气缸", Pos(cx - sign * 200, -(CONV_W / 2 + 80), CONV_TOP + 40) * Box(60, 60, 220), 2.7e-6, "薄型气缸")
        add(f"{label}-挡板", Pos(cx - sign * 200, -(CONV_W / 2 - 20), CONV_TOP + 120) * Box(20, 400, 100), 7.85e-6, "Q235 钢板")


add_conveyor(-1, "入料段")
add_conveyor(1, "出料段")

print("PARTS_COUNT", len(parts))

# 导出逐件 STL + 合并 STEP/STL
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
