# -*- coding: utf-8 -*-
"""
AutomationCAD · FreeCAD 无界面后台作业：零件工程图（TechDraw）。

运行方式（由主进程 desktop/electron/freecad.ts 调用，独立进程，LGPL 组件只做进程级调用）：

    AUTOMATIONCAD_FREECAD_JOB=/abs/job.json  freecadcmd  techdraw_job.py

也支持 `freecadcmd techdraw_job.py --pass /abs/job.json`（部分 FreeCAD 版本会把多余参数当文件打开，
因此主进程默认只用环境变量）。纯逻辑自检（不需要 FreeCAD）：

    python3 techdraw_job.py --self-test

协议（与 build123d sidecar 一样是内核无关 JSON）：
  输入  automationcad.drawing-job/1   见 desktop/src/drawings/protocol.ts
  输出  outputDir/result.json         automationcad.drawing-result/1
  进度  stdout 行 `@@ACAD {json}`      part-start / part-done

边界：只读入 STEP（特征树 JSON 才是主数据），不反向编辑；不 import build123d（两份 OCCT 冲突）。
只用 FreeCAD 1.0 自带的 Part / TechDraw 工作台，不依赖 A2plus 等第三方插件。
"""

from __future__ import annotations

import json
import math
import os
import re
import sys
import time
import traceback

PROTOCOL = "automationcad.drawing-job/1"
RESULT_PROTOCOL = "automationcad.drawing-result/1"
SCRIPT_VERSION = "1.1.1"
EVENT_PREFIX = "@@ACAD "

# ---------------------------------------------------------------------------
# 纯逻辑：图幅、比例、布局（不依赖 FreeCAD，可在普通 python3 下自检）
# ---------------------------------------------------------------------------

# GB/T 14689 基本幅面（横放），留装订边：a=25，c=5（A3/A4）
PAPERS = {
    "A4": {"w": 297.0, "h": 210.0, "a": 25.0, "c": 5.0},
    "A3": {"w": 420.0, "h": 297.0, "a": 25.0, "c": 5.0},
}
PAPER_ORDER = ("A4", "A3")

# GB/T 14690 比例：优先系列 + 允许系列（缩小），从大到小
SCALES = (
    (5.0, "5:1"), (2.0, "2:1"), (1.0, "1:1"), (1 / 1.5, "1:1.5"), (0.5, "1:2"), (1 / 2.5, "1:2.5"),
    (1 / 3.0, "1:3"), (0.25, "1:4"), (0.2, "1:5"), (0.1, "1:10"), (0.05, "1:20"), (0.02, "1:50"),
    (0.01, "1:100"),
)

TITLE_W = 180.0  # GB/T 10609.1 标题栏 180 × 56
TITLE_H = 56.0
GAP = 18.0       # 视图间距（容纳尺寸线）
ISO_DIR = (1.0, -1.0, 1.0)
ISO_XDIR = (1.0, 1.0, 0.0)


def scale_label(value: float) -> str:
    for scale, label in SCALES:
        if abs(scale - value) < 1e-9:
            return label
    if value >= 1:
        return f"{value:g}:1"
    return f"1:{1 / value:g}"


def parse_scale(text) -> float | None:
    """'1:2' → 0.5；'2:1' → 2；'auto'/None → None。"""
    if text is None:
        return None
    if isinstance(text, (int, float)):
        return float(text) if text > 0 else None
    raw = str(text).strip().lower()
    if raw in ("", "auto"):
        return None
    m = re.fullmatch(r"(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)", raw)
    if not m:
        raise ValueError(f"比例格式无效：{text}（应为 1:2、2:1 或 auto）")
    a, b = float(m.group(1)), float(m.group(2))
    if a <= 0 or b <= 0:
        raise ValueError(f"比例必须为正：{text}")
    return a / b


def iso_extent(size) -> tuple[float, float]:
    """包围盒 (L,W,H) 在等轴测方向上的投影宽、高（未缩放）。"""
    L, W, H = size
    d = _norm(ISO_DIR)
    x = _norm(ISO_XDIR)
    y = _cross(d, x)
    xs, ys = [], []
    for cx in (0, L):
        for cy in (0, W):
            for cz in (0, H):
                xs.append(cx * x[0] + cy * x[1] + cz * x[2])
                ys.append(cx * y[0] + cy * y[1] + cz * y[2])
    return max(xs) - min(xs), max(ys) - min(ys)


def _norm(v):
    n = math.sqrt(sum(c * c for c in v))
    return tuple(c / n for c in v)


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def drawing_area(paper: str) -> dict:
    p = PAPERS[paper]
    return {"x0": p["a"], "y0": p["c"], "x1": p["w"] - p["c"], "y1": p["h"] - p["c"]}


def _overlap(a, b) -> bool:
    return not (a[2] <= b[0] or b[2] <= a[0] or a[3] <= b[1] or b[3] <= a[1])


def _inside(r, area) -> bool:
    return r[0] >= area["x0"] and r[1] >= area["y0"] and r[2] <= area["x1"] and r[3] <= area["y1"]


def plan_layout(size, paper: str, scale: float, with_iso: bool = True, annot=None):
    """
    第一角投影（GB）：主视图左上，左视图在主视图右侧，俯视图在主视图下方；标题栏右下。
    坐标为页面毫米，原点左下（与 TechDraw 页面一致）。返回各视图中心与占位矩形；放不下返回 None。
    annot（孔标注预留，页面毫米，与比例无关）：left/bottom/right = 俯视图四周孔位尺寸与孔标注区；
    section = 是否放全剖视图 A-A（在俯视图标注区下方）；table = (w, h) 孔位表。
    """
    annot = annot or {}
    L, W, H = (max(float(v), 1e-6) for v in size)
    area = drawing_area(paper)
    title = (area["x1"] - TITLE_W, area["y0"], area["x1"], area["y0"] + TITLE_H)
    fw, fh = L * scale, H * scale        # 主视图（XZ）
    lw, lh = W * scale, H * scale        # 左视图（YZ）
    tw, th = L * scale, W * scale        # 俯视图（XY）
    ml, mb, mr = (float(annot.get(k) or 0.0) for k in ("left", "bottom", "right"))
    # 主视图左上角从绘图区左上角留出 GAP（上方放长度尺寸，左方放高度尺寸）；俯视图左侧孔位尺寸更宽时整体右移
    fx0 = area["x0"] + max(GAP, ml + 3.0)
    fy1 = area["y1"] - GAP
    front = (fx0, fy1 - fh, fx0 + fw, fy1)
    left = (front[2] + GAP, front[1], front[2] + GAP + lw, front[3])
    top = (front[0], front[1] - GAP - th, front[0] + tw, front[1] - GAP)
    rects = {"front": front, "left": left, "top": top}
    for name, r in rects.items():
        if not _inside(r, area):
            return None
        if _overlap(r, title):
            return None
    # 左视图上方要放宽度尺寸
    if left[3] + GAP * 0.6 > area["y1"]:
        return None
    zones = {}
    if ml or mb or mr:
        zone = (top[0] - ml, top[1] - mb, top[2] + mr, top[3])
        if not _inside(zone, area) or _overlap(zone, title) or _overlap(zone, left):
            return None
        zones["top"] = zone
    blockers = list(rects.values()) + list(zones.values())
    if annot.get("section"):
        base = zones.get("top", top)
        sec = (top[0], base[1] - GAP * 0.6 - fh, top[0] + fw, base[1] - GAP * 0.6)
        lab = (sec[0], sec[1], sec[2], sec[3] + 6)
        if not _inside(lab, area) or _overlap(lab, title) or any(_overlap(lab, b) for b in blockers):
            return None
        rects["section"] = sec
        blockers.append(lab)
    if annot.get("table"):
        tw_, th_ = annot["table"]
        base = zones.get("top", top)
        found = None
        for x0, y0 in ((title[2] - tw_, title[3] + 4), (base[2] + 6, base[3] - th_), (base[0], base[1] - 6 - th_),
                       (left[2] + GAP * 0.5, left[3] - th_)):
            r = (x0, y0, x0 + tw_, y0 + th_)
            if _inside(r, area) and not _overlap(r, title) and not any(_overlap(r, b) for b in blockers):
                found = r
                break
        if not found:
            return None
        rects["table"] = found
        blockers.append(found)
    iso = None
    iso_scale = None
    if with_iso:
        iw0, ih0 = iso_extent((L, W, H))
        for factor in (1.0, 0.5):
            s = scale * factor
            iw, ih = iw0 * s, ih0 * s
            # 候选位置：左视图右侧、标题栏正上方右对齐、俯视图右侧
            candidates = [
                (left[2] + GAP, area["y1"] - GAP - ih),
                (area["x1"] - GAP * 0.5 - iw, title[3] + GAP * 0.5),
                (top[2] + GAP, top[1]),
            ]
            for x0, y0 in candidates:
                r = (x0, y0, x0 + iw, y0 + ih)
                if not _inside(r, area) or _overlap(r, title):
                    continue
                pad = GAP * 0.4
                grown = (r[0] - pad, r[1] - pad, r[2] + pad, r[3] + pad)
                if any(_overlap(grown, other) for other in list(rects.values()) + blockers):
                    continue
                iso = r
                iso_scale = s
                break
            if iso:
                break
    centers = {k: ((r[0] + r[2]) / 2, (r[1] + r[3]) / 2) for k, r in rects.items()}
    out = {"paper": paper, "scale": scale, "rects": dict(rects), "centers": centers, "title": title,
           "iso": None, "zones": zones}
    if iso:
        out["rects"]["iso"] = iso
        out["centers"]["iso"] = ((iso[0] + iso[2]) / 2, (iso[1] + iso[3]) / 2)
        out["iso"] = {"scale": iso_scale}
    return out


def choose_sheet(size, paper_opt: str = "auto", scale_opt=None, with_iso: bool = True, annot=None):
    """带孔标注预留的选图：剖视图是可选的——带剖视的比例不比不带剖视小一档以上才保留，否则省略并告警。"""
    if annot and annot.get("section"):
        without = _choose_sheet({k: v for k, v in annot.items() if k != "section"}, size, paper_opt, scale_opt, with_iso)
        withsec = _choose_sheet(annot, size, paper_opt, scale_opt, with_iso)
        if not withsec.get("forced") and withsec["scale"] >= without["scale"] * 0.66 - 1e-12:
            return withsec
        without.setdefault("warnings", []).append("剖视图 A-A 在当前图幅放不下，已省略")
        return without
    return _choose_sheet(annot, size, paper_opt, scale_opt, with_iso)


def _choose_sheet(annot, size, paper_opt: str = "auto", scale_opt=None, with_iso: bool = True):
    """
    自动选图幅/比例：A4 能以 ≥1:1 放下就用 A4；否则取能给出更大比例的幅面（相同比例取小幅面）。
    指定了 paper/scale 时只在指定范围内找。返回 plan_layout 结果（附 warnings）。
    """
    papers = PAPER_ORDER if paper_opt in (None, "", "auto") else (paper_opt,)
    for p in papers:
        if p not in PAPERS:
            raise ValueError(f"不支持的图幅：{p}（仅 A4/A3/auto）")
    fixed = parse_scale(scale_opt)
    best = {}
    for p in papers:
        candidates = [(fixed, scale_label(fixed))] if fixed else SCALES
        for s, _ in candidates:
            plan = plan_layout(size, p, s, with_iso, annot)
            if plan:
                best[p] = plan
                break
    warnings = []
    if not best:
        # 实在放不下：最大图幅 + 最小比例，给出警告但仍出图
        p = papers[-1]
        s = fixed or SCALES[-1][0]
        plan = plan_layout(size, p, s, False) or {
            "paper": p, "scale": s, "rects": {}, "centers": {}, "title": None, "iso": None, "zones": {}
        }
        warnings.append(f"零件尺寸超出 {p} 图幅可用范围，已按 {scale_label(s)} 强制出图，请人工调整")
        plan["warnings"] = warnings
        plan["forced"] = True
        return plan
    if len(best) == 1:
        chosen = next(iter(best.values()))
    else:
        a4, a3 = best.get("A4"), best.get("A3")
        if a4 and a4["scale"] >= 1.0:
            chosen = a4
        elif a3 and (not a4 or a3["scale"] > a4["scale"] + 1e-12):
            chosen = a3
        else:
            chosen = a4 or a3
    if with_iso and not chosen.get("iso"):
        warnings.append("等轴测视图在当前图幅放不下，已省略")
    chosen["warnings"] = warnings
    return chosen


def format_mm(value: float) -> str:
    v = round(float(value), 2)
    if abs(v - round(v)) < 1e-9:
        return str(int(round(v)))
    return f"{v:.2f}".rstrip("0").rstrip(".")


def safe_file_stem(value: str) -> str:
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", str(value or "")).strip("-.")[:60]
    return stem or "part"


def validate_job(job) -> list[str]:
    errors = []
    if not isinstance(job, dict):
        return ["作业必须是 JSON 对象"]
    if job.get("protocol") != PROTOCOL:
        errors.append(f"协议不匹配：期望 {PROTOCOL}")
    if job.get("kind") != "techdraw":
        errors.append("kind 必须是 techdraw")
    if not isinstance(job.get("outputDir"), str) or not job.get("outputDir"):
        errors.append("outputDir 缺失")
    parts = job.get("parts")
    if not isinstance(parts, list) or not parts:
        errors.append("parts 必须是非空数组")
    else:
        seen = set()
        for i, part in enumerate(parts, 1):
            if not isinstance(part, dict):
                errors.append(f"第 {i} 个零件不是对象")
                continue
            pid = part.get("partId")
            if not isinstance(pid, str) or not pid:
                errors.append(f"第 {i} 个零件缺少 partId")
            elif pid in seen:
                errors.append(f"partId 重复：{pid}")
            else:
                seen.add(pid)
            if not isinstance(part.get("step"), str) or not part.get("step"):
                errors.append(f"第 {i} 个零件缺少 step 路径")
            if not isinstance(part.get("fileStem"), str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", part.get("fileStem") or ""):
                errors.append(f"第 {i} 个零件 fileStem 非法")
    return errors


# ---------------------------------------------------------------------------
# SVG 页面合成（GB 风格边框 + 标题栏 + 视图 + 外形尺寸）
# ---------------------------------------------------------------------------

def _esc(text) -> str:
    return (str(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;"))


def title_block_cells(meta: dict, plan: dict) -> list[dict]:
    """标题栏表格（简化 GB/T 10609.1）：返回线段与文字，坐标相对标题栏左下角，y 向上。"""
    W, H = TITLE_W, TITLE_H
    lines = [
        # 外框（粗）
        (0, 0, W, 0, "thick"), (0, H, W, H, "thick"), (0, 0, 0, H, "thick"), (W, 0, W, H, "thick"),
        # 左区 4 行签字栏，宽 80
        (80, 0, 80, H, "thick"),
        (0, 14, 80, 14, "thin"), (0, 28, 80, 28, "thin"), (0, 42, 80, 42, "thin"),
        (12, 0, 12, H, "thin"), (40, 0, 40, H, "thin"), (52, 0, 52, H, "thin"),
        # 右区上半：名称 | 单位 / 投影符号+张数；下半：图号/材料 | 比例 | 数量
        (80, 28, W, 28, "thick"), (130, 28, 130, H, "thin"), (130, 42, W, 42, "thin"),
        (80, 14, W, 14, "thin"), (130, 0, 130, 28, "thin"), (155, 0, 155, 28, "thin"),
    ]
    designer = meta.get("designer") or ""
    date = meta.get("date") or ""
    company = meta.get("company") or ""
    texts = [
        # 签字栏
        (6, 49, "设计", 3.5, "middle"), (26, 49, designer, 3.5, "middle"), (46, 49, "日期", 3.5, "middle"),
        (66, 49, date, 3.0, "middle"),
        (6, 35, "审核", 3.5, "middle"), (46, 35, "日期", 3.5, "middle"),
        (6, 21, "工艺", 3.5, "middle"), (46, 21, "日期", 3.5, "middle"),
        (6, 7, "批准", 3.5, "middle"), (46, 7, "日期", 3.5, "middle"),
        # 名称、单位、张数
        (105, 42, meta.get("name") or "", 7.0, "middle"),
        (155, 49, company, 3.5, "middle"),
        (161, 35, "共1张 第1张", 3.0, "middle"),
        # 图号 / 材料
        (82, 21, "图号", 3.5, "start"), (111, 21, meta.get("drawingNo") or "", 5.0, "middle"),
        (82, 7, "材料", 3.5, "start"), (111, 7, meta.get("material") or "", 3.5, "middle"),
        # 比例 / 数量
        (142.5, 21, "比例", 3.5, "middle"), (142.5, 7, plan.get("scaleLabel") or "", 3.5, "middle"),
        (167.5, 21, "数量", 3.5, "middle"), (167.5, 7, str(meta.get("quantity") or 1), 3.5, "middle"),
    ]
    return [{"lines": lines, "texts": texts}]


def first_angle_symbol(x: float, cy: float, s: float = 0.6) -> list:
    """第一角投影识别符号（GB/T 14692 / ISO 5456-2）：截锥在左（大端朝左），同心圆在右；SVG 坐标（y 向下）。"""
    h = 6 * s
    trap = (f"M{x:.2f},{cy - h / 2:.2f} L{x + 12 * s:.2f},{cy - h / 4:.2f} "
            f"L{x + 12 * s:.2f},{cy + h / 4:.2f} L{x:.2f},{cy + h / 2:.2f} Z")
    return [
        f'<path d="{trap}" class="thin"/>',
        f'<circle cx="{x + 18 * s:.2f}" cy="{cy:.2f}" r="{h / 2:.2f}" class="thin"/>',
        f'<circle cx="{x + 18 * s:.2f}" cy="{cy:.2f}" r="{h / 4:.2f}" class="thin"/>',
    ]


def compose_svg(paper: str, plan: dict, views: dict, dims: list, meta: dict, font_family: str, prims=None) -> str:
    """
    views: name → {"visible": [[(x,y),...],...], "hidden": [...], "center": (cx, cy)}，
           点坐标为视图局部毫米（已按比例，y 向下，TechDraw 约定），center 为页面坐标（y 向上）。
    dims:  [{"p1":(x,y),"p2":(x,y),"offset":(dx,dy),"text":str,"orient":"h"|"v"}] 页面坐标 y 向上。
    """
    p = PAPERS[paper]
    PW, PH = p["w"], p["h"]
    area = drawing_area(paper)
    out = []
    out.append(f'<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="{PW:g}mm" height="{PH:g}mm" '
               f'viewBox="0 0 {PW:g} {PH:g}">')
    out.append("<style>.thick{fill:none;stroke:#000;stroke-width:0.5;stroke-linecap:round;stroke-linejoin:round}"
               ".thin{fill:none;stroke:#000;stroke-width:0.25}"
               ".hidden{fill:none;stroke:#000;stroke-width:0.25;stroke-dasharray:3,1}"
               ".dim{fill:none;stroke:#000;stroke-width:0.18}"
               ".center{fill:none;stroke:#000;stroke-width:0.18;stroke-dasharray:6,1.2,1,1.2}"
               ".hatch{fill:none;stroke:#000;stroke-width:0.13}"
               ".cutm{fill:none;stroke:#000;stroke-width:0.6}"
               ".arrow{fill:#000;stroke:none}</style>")
    out.append(f'<rect x="0" y="0" width="{PW:g}" height="{PH:g}" fill="#fff"/>')
    # 图纸边界（细）与图框（粗）
    out.append(f'<rect x="0.2" y="0.2" width="{PW - 0.4:g}" height="{PH - 0.4:g}" class="thin"/>')
    fx, fy = area["x0"], PH - area["y1"]
    out.append(f'<rect x="{fx:g}" y="{fy:g}" width="{area["x1"] - area["x0"]:g}" height="{area["y1"] - area["y0"]:g}" '
               f'style="fill:none;stroke:#000;stroke-width:0.7"/>')

    def Y(y):  # 页面 y 向上 → SVG y 向下
        return PH - y

    def text_el(x, y, txt, size, anchor="middle"):
        if txt is None or txt == "":
            return ""
        return (f'<text x="{x:.2f}" y="{y:.2f}" font-family="{_esc(font_family)}" font-size="{size:g}" '
                f'text-anchor="{anchor}" fill="#000">{_esc(txt)}</text>')

    # 视图
    for name, view in views.items():
        cx, cy = view["center"]
        ox, oy = cx, Y(cy)
        for cls, key in (("hidden", "hidden"), ("thick", "visible")):
            for poly in view.get(key) or []:
                if len(poly) < 2:
                    continue
                d = " ".join(f"{'M' if i == 0 else 'L'}{ox + px:.3f},{oy + py:.3f}" for i, (px, py) in enumerate(poly))
                out.append(f'<path d="{d}" class="{cls}"/>')
        if view.get("label"):
            lx, ly = view["labelAt"]
            out.append(text_el(lx, Y(ly), view["label"], 3.5))

    # 尺寸（GB：细实线，实心箭头，数字在尺寸线上方/左侧）
    for dim in dims:
        (x1, y1), (x2, y2) = dim["p1"], dim["p2"]
        if dim["orient"] == "h":
            yl = dim["at"]
            out.append(f'<path d="M{x1:.2f},{Y(y1):.2f} L{x1:.2f},{Y(yl + 1.5 * _sgn(yl - y1)):.2f}" class="dim"/>')
            out.append(f'<path d="M{x2:.2f},{Y(y2):.2f} L{x2:.2f},{Y(yl + 1.5 * _sgn(yl - y2)):.2f}" class="dim"/>')
            out.append(f'<path d="M{x1:.2f},{Y(yl):.2f} L{x2:.2f},{Y(yl):.2f}" class="dim"/>')
            out.append(_arrow(x1, Y(yl), 1, 0))
            out.append(_arrow(x2, Y(yl), -1, 0))
            out.append(text_el((x1 + x2) / 2, Y(yl) - 1.0, dim["text"], 3.5))
        else:
            xl = dim["at"]
            out.append(f'<path d="M{x1:.2f},{Y(y1):.2f} L{xl + 1.5 * _sgn(xl - x1):.2f},{Y(y1):.2f}" class="dim"/>')
            out.append(f'<path d="M{x2:.2f},{Y(y2):.2f} L{xl + 1.5 * _sgn(xl - x2):.2f},{Y(y2):.2f}" class="dim"/>')
            out.append(f'<path d="M{xl:.2f},{Y(y1):.2f} L{xl:.2f},{Y(y2):.2f}" class="dim"/>')
            out.append(_arrow(xl, Y(y1), 0, -1 if Y(y1) > Y(y2) else 1))
            out.append(_arrow(xl, Y(y2), 0, 1 if Y(y1) > Y(y2) else -1))
            my = (Y(y1) + Y(y2)) / 2
            out.append(f'<g transform="translate({xl - 1.0:.2f},{my:.2f}) rotate(-90)">'
                       + text_el(0, 0, dim["text"], 3.5) + "</g>")

    # 孔标注、孔位尺寸、中心线、剖面线、孔位表（与 DXF 同一份图元）
    if prims:
        out.extend(prims_to_svg(prims, PH, font_family))

    # 标题栏
    title = plan.get("title")
    if title:
        tx0, ty0 = title[0], title[1]
        for block in title_block_cells(meta, plan):
            for (x1, y1, x2, y2, cls) in block["lines"]:
                out.append(f'<path d="M{tx0 + x1:.2f},{Y(ty0 + y1):.2f} L{tx0 + x2:.2f},{Y(ty0 + y2):.2f}" class="{cls}"/>')
            for (x, y, txt, size, anchor) in block["texts"]:
                out.append(text_el(tx0 + x, Y(ty0 + y) + size * 0.35, txt, size, anchor))
        out.extend(first_angle_symbol(tx0 + 132, Y(ty0 + 35)))
    out.append("</svg>")
    return "\n".join(s for s in out if s)


def _sgn(v: float) -> float:
    return 1.0 if v >= 0 else -1.0


def _arrow(x: float, y: float, dx: float, dy: float, length: float = 3.0, width: float = 1.0) -> str:
    """箭头尖在 (x,y)，沿 (dx,dy) 指向尺寸线内侧展开（SVG 坐标）。"""
    bx, by = x + dx * length, y + dy * length
    nx, ny = -dy * width / 2, dx * width / 2
    return (f'<path d="M{x:.2f},{y:.2f} L{bx + nx:.2f},{by + ny:.2f} L{bx - nx:.2f},{by - ny:.2f} Z" '
            f'class="arrow"/>')


# ---------------------------------------------------------------------------
# DXF 后处理：在 TechDraw writeDXFPage 的产物里补图框与标题栏（R14，需句柄）
# ---------------------------------------------------------------------------

def dxf_text_escape(text: str) -> str:
    out = []
    for ch in str(text):
        code = ord(ch)
        if 32 <= code < 127:
            out.append(ch)
        else:
            out.append(f"\\U+{code:04X}")
    return "".join(out)


def dxf_append_entities(content: str, lines: list, texts: list, layer: str = "0") -> str:
    """lines: [(x1,y1,x2,y2)]；texts: [(x,y,text,height)]，页面坐标 y 向上。"""
    rows = content.replace("\r\n", "\n").split("\n")
    # 去掉末尾空行便于成对读取
    while rows and rows[-1] == "":
        rows.pop()
    pairs = [(rows[i].strip(), rows[i + 1]) for i in range(0, len(rows) - 1, 2)]
    # HEADER 段里 $HANDSEED 也用组码 5，不能算作实体句柄
    header_end = next((i for i, (c, v) in enumerate(pairs) if c == "0" and v.strip() == "ENDSEC"), -1)
    handles = [int(v.strip(), 16) for i, (c, v) in enumerate(pairs)
               if i > header_end and c == "5" and re.fullmatch(r"[0-9A-Fa-f]+", v.strip() or "x")]
    next_handle = (max(handles) + 1) if handles else 0x100
    # 模型空间 BLOCK_RECORD 句柄
    owner = None
    for i, (c, v) in enumerate(pairs):
        if c == "0" and v.strip() == "BLOCK_RECORD":
            h, name = None, None
            for c2, v2 in pairs[i + 1:i + 12]:
                if c2 == "5":
                    h = v2.strip()
                if c2 == "2":
                    name = v2.strip()
                    break
            if name and name.lower() == "*model_space":
                owner = h
                break
    # 找 ENTITIES 段的 ENDSEC
    in_entities = False
    insert_at = None
    for i, (c, v) in enumerate(pairs):
        if c == "2" and v.strip() == "ENTITIES" and i > 0 and pairs[i - 1][0] == "0" and pairs[i - 1][1].strip() == "SECTION":
            in_entities = True
            continue
        if in_entities and c == "0" and v.strip() == "ENDSEC":
            insert_at = i
            break
    if insert_at is None:
        raise ValueError("DXF 缺少 ENTITIES 段")
    added = []

    def emit(code, value):
        added.append((str(code), str(value)))

    for (x1, y1, x2, y2) in lines:
        emit(0, "LINE"); emit(5, f"{next_handle:X}"); next_handle += 1
        if owner:
            emit(330, owner)
        emit(100, "AcDbEntity"); emit(8, layer); emit(100, "AcDbLine")
        emit(10, f"{x1:.4f}"); emit(20, f"{y1:.4f}"); emit(30, "0")
        emit(11, f"{x2:.4f}"); emit(21, f"{y2:.4f}"); emit(31, "0")
    for (x, y, text, height) in texts:
        if text is None or str(text) == "":
            continue
        emit(0, "TEXT"); emit(5, f"{next_handle:X}"); next_handle += 1
        if owner:
            emit(330, owner)
        emit(100, "AcDbEntity"); emit(8, layer); emit(100, "AcDbText")
        emit(10, f"{x:.4f}"); emit(20, f"{y:.4f}"); emit(30, "0"); emit(40, f"{height:g}")
        emit(1, dxf_text_escape(text)); emit(100, "AcDbText")
    new_pairs = pairs[:insert_at] + added + pairs[insert_at:]
    # $HANDSEED 必须大于所有句柄
    for i, (c, v) in enumerate(new_pairs):
        if c == "9" and v.strip() == "$HANDSEED" and i + 1 < len(new_pairs):
            code, val = new_pairs[i + 1]
            try:
                current = int(val.strip(), 16)
            except ValueError:
                current = 0
            if current <= next_handle:
                new_pairs[i + 1] = (code, f"{next_handle + 1:X}")
            break
    text_rows = []
    for c, v in new_pairs:
        text_rows.append(c.rjust(3))
        text_rows.append(v)
    return "\n".join(text_rows) + "\n"


def frame_and_title_dxf(paper: str, plan: dict, meta: dict):
    p = PAPERS[paper]
    area = drawing_area(paper)
    lines = [
        (0, 0, p["w"], 0), (p["w"], 0, p["w"], p["h"]), (p["w"], p["h"], 0, p["h"]), (0, p["h"], 0, 0),
        (area["x0"], area["y0"], area["x1"], area["y0"]), (area["x1"], area["y0"], area["x1"], area["y1"]),
        (area["x1"], area["y1"], area["x0"], area["y1"]), (area["x0"], area["y1"], area["x0"], area["y0"]),
    ]
    texts = []
    title = plan.get("title")
    if title:
        tx0, ty0 = title[0], title[1]
        for block in title_block_cells(meta, plan):
            for (x1, y1, x2, y2, _cls) in block["lines"]:
                lines.append((tx0 + x1, ty0 + y1, tx0 + x2, ty0 + y2))
            for (x, y, txt, size, anchor) in block["texts"]:
                if not txt:
                    continue
                width = _text_width(txt, size)
                sx = x if anchor == "start" else x - width / 2
                texts.append((tx0 + sx, ty0 + y - size * 0.35, txt, size))
    return lines, texts


def _text_width(text: str, size: float) -> float:
    w = 0.0
    for ch in str(text):
        w += size if ord(ch) > 0x2E7F else size * 0.6
    return w


# ---------------------------------------------------------------------------
# 孔标注纯逻辑（不依赖 FreeCAD，--self-test / --plan-holes 可测）
#   特征树 holes[]（优先）/ 圆柱面几何识别（兜底）→ 同规格分组 → 标注文本
#   → 孔位尺寸方案（对称 / 基准坐标）→ 页面布局（避让、过密退化孔位表）
# 坐标：模型 mm（零件坐标，孔轴 +Z）；页面 mm（原点左下，y 向上）。
# ---------------------------------------------------------------------------

HOLE_TOL = 0.02
TEXT_H = 3.5            # 标注字高
TIER = 7.0              # 尺寸线层间距
DIM_OFFSET = 8.0        # 第一道尺寸线离视图
EXT_GAP = 1.5           # 尺寸界线离视图轮廓的间隙（不压图线）
CALLOUT_GAP = 8.0       # 孔标注文字列离视图
CALLOUT_PITCH = 6.5     # 孔标注行距
ORD_PITCH = 4.4         # 坐标尺寸文字最小间距
ORD_MAX_SHIFT = 7.0     # 坐标尺寸文字允许的最大错位，超过判过密
MAX_TIERS = 4
MAX_ORDINATES = 9
MAX_CALLOUTS = 7
TABLE_ROW = 6.0
TABLE_COLS = (12.0, 18.0, 18.0, 42.0)
# 沉孔/深度用中文文字而不是 GB/ISO 符号（U+2334 / U+21A7）：图纸默认字体 Noto Sans CJK SC 等常见中文字体
# 没有这两个字形，真机出图会显示成方块；Ø（U+00D8）与 ×（U+00D7）各字体都有，保留符号。
TXT_CB = "沉孔"
TXT_DEPTH = "深"
SYM_DIA = "\u00d8"      # Ø


def _num_ok(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def normalize_hole_specs(raw):
    """作业里 part.holes 的清洗：None = 未提供（走几何识别）；非法条目丢弃并返回警告。"""
    if raw is None:
        return None, []
    if not isinstance(raw, list):
        return [], ["holes 不是数组，已忽略"]
    out, warnings = [], []
    for i, spec in enumerate(raw, 1):
        if not isinstance(spec, dict) or spec.get("kind") not in ("hole", "counterbore", "slot"):
            warnings.append(f"第 {i} 组孔语义无效，已忽略")
            continue
        pos = []
        for p in spec.get("positions") or []:
            if isinstance(p, (list, tuple)) and len(p) == 2 and all(_num_ok(c) for c in p):
                pos.append((float(p[0]), float(p[1])))
        if not pos:
            warnings.append(f"第 {i} 组孔没有有效孔位，已忽略")
            continue
        item = {"kind": spec["kind"], "positions": pos, "through": spec.get("through") is not False,
                "featureId": str(spec.get("featureId") or ""), "source": "features"}
        for key in ("diameter", "depth", "cbDiameter", "cbDepth", "threadDepth", "length", "width"):
            if _num_ok(spec.get(key)) and spec[key] > 0:
                item[key] = float(spec[key])
        if isinstance(spec.get("thread"), str) and re.fullmatch(r"M\d+(\.\d+)?(×\d+(\.\d+)?)?", spec["thread"]):
            item["thread"] = spec["thread"]
        if not item["through"] and "depth" not in item:
            item["through"] = True
            warnings.append(f"第 {i} 组孔缺少孔深，按通孔标注")
        if item["kind"] == "slot" and ("length" not in item or "width" not in item):
            warnings.append(f"第 {i} 组腰形槽缺少长宽，已忽略")
            continue
        if item["kind"] != "slot" and "diameter" not in item:
            warnings.append(f"第 {i} 组孔缺少直径，已忽略")
            continue
        if item["kind"] == "counterbore" and ("cbDiameter" not in item or "cbDepth" not in item):
            warnings.append(f"第 {i} 组沉孔缺少沉孔直径/深度，已忽略")
            continue
        if "angle" in spec and _num_ok(spec["angle"]):
            item["angle"] = float(spec["angle"])
        out.append(item)
    return out, warnings


def _r(v):
    return None if v is None else round(float(v), 3)


def hole_key(spec) -> tuple:
    """同规格判定键：类型、直径、通/盲、孔深、沉孔、螺纹、槽长宽（不含位置/来源特征）。"""
    return (spec["kind"], _r(spec.get("diameter")), bool(spec.get("through")),
            None if spec.get("through") else _r(spec.get("depth")),
            _r(spec.get("cbDiameter")), _r(spec.get("cbDepth")), spec.get("thread"), _r(spec.get("threadDepth")),
            _r(spec.get("length")), _r(spec.get("width")), _r(spec.get("angle")))


def detect_pattern(positions):
    """阵列识别：circular（等半径等分角，≥3）/ grid（行×列满格，≥4）/ None。"""
    n = len(positions)
    if n < 3:
        return None
    cx = sum(p[0] for p in positions) / n
    cy = sum(p[1] for p in positions) / n
    radii = [math.hypot(p[0] - cx, p[1] - cy) for p in positions]
    rm = sum(radii) / n
    if rm > 0.5 and max(abs(r - rm) for r in radii) <= max(0.02, rm * 0.002):
        angles = sorted((math.degrees(math.atan2(p[1] - cy, p[0] - cx)) + 360.0) % 360.0 for p in positions)
        step = 360.0 / n
        diffs = [angles[i + 1] - angles[i] for i in range(n - 1)] + [angles[0] + 360.0 - angles[-1]]
        if all(abs(d - step) < 0.2 for d in diffs):
            start = angles[0] % step
            return {"type": "circular", "center": (round(cx, 4), round(cy, 4)), "radius": round(rm, 4),
                    "count": n, "start": round(start, 3)}
    xs = _unique([p[0] for p in positions])
    ys = _unique([p[1] for p in positions])
    if n >= 4 and len(xs) >= 2 and len(ys) >= 2 and len(xs) * len(ys) == n:
        return {"type": "grid", "xs": xs, "ys": ys}
    return None


def _unique(values, tol: float = HOLE_TOL):
    out = []
    for v in sorted(values):
        if not out or abs(v - out[-1]) > tol:
            out.append(v)
    return out


def group_holes(specs):
    """同规格合并（跨特征），保留首次出现的顺序；每组附阵列识别与标注文本。"""
    groups, index = [], {}
    for spec in specs:
        key = hole_key(spec)
        if key not in index:
            index[key] = len(groups)
            groups.append({**{k: v for k, v in spec.items() if k not in ("positions", "featureId")},
                           "positions": [], "featureIds": [], "sources": set()})
        g = groups[index[key]]
        for p in spec["positions"]:
            if not any(abs(p[0] - q[0]) < HOLE_TOL and abs(p[1] - q[1]) < HOLE_TOL for q in g["positions"]):
                g["positions"].append(p)
        if spec.get("featureId"):
            g["featureIds"].append(spec["featureId"])
        g["sources"].add(spec.get("source") or "features")
    for i, g in enumerate(groups):
        g["sources"] = sorted(g["sources"])
        g["pattern"] = detect_pattern(g["positions"])
        g["letter"] = chr(ord("A") + i) if i < 26 else f"Z{i}"
        g["callout"] = callout_text(g)
    return groups


def callout_text(g) -> str:
    """GB 风格孔标注（文字版）：4×Ø6.6 沉孔Ø11深6.5、2×M6-6H深10 孔深12、6×Ø9 通孔 均布、腰形槽 60×12 通。"""
    n = len(g["positions"])
    pre = f"{n}×" if n > 1 else ""
    fm = format_mm
    if g["kind"] == "slot":
        text = f"{pre}腰形槽 {fm(g['length'])}×{fm(g['width'])}" + (" 通" if g.get("through") else f"{TXT_DEPTH}{fm(g['depth'])}")
    elif g.get("thread"):
        thr = f"{g['thread']}-6H"
        if g.get("through"):
            text = f"{pre}{thr} 通孔"
        elif g.get("threadDepth") and abs(g["threadDepth"] - g["depth"]) > 1e-6:
            text = f"{pre}{thr}{TXT_DEPTH}{fm(g['threadDepth'])} 孔{TXT_DEPTH}{fm(g['depth'])}"
        else:
            text = f"{pre}{thr}{TXT_DEPTH}{fm(g['depth'])}"
    else:
        base = f"{pre}{SYM_DIA}{fm(g['diameter'])}"
        if g["kind"] == "counterbore":
            depth = "" if g.get("through") else f"{TXT_DEPTH}{fm(g['depth'])}"
            text = f"{base}{depth} {TXT_CB}{SYM_DIA}{fm(g['cbDiameter'])}{TXT_DEPTH}{fm(g['cbDepth'])}"
        else:
            text = base + (" 通孔" if g.get("through") else f"{TXT_DEPTH}{fm(g['depth'])}")
    if g.get("pattern") and g["pattern"]["type"] == "circular":
        text += " 均布"
    return text


def plan_hole_positions(groups, bbox2d):
    """
    孔位尺寸方案（模型坐标）：每个轴向独立判定——孔心坐标关于零件中心对称则「对称标注」（孔距，
    对称于中心线），否则「基准坐标」（以左/下外边为 0）。圆周阵列只标节圆直径与均布，不进 X/Y。
    """
    xmin, ymin, xmax, ymax = bbox2d
    xc, yc = (xmin + xmax) / 2, (ymin + ymax) / 2
    pts, circles = [], []
    for g in groups:
        pat = g.get("pattern")
        if pat and pat["type"] == "circular":
            circles.append({"center": pat["center"], "radius": pat["radius"], "letter": g["letter"],
                            "text": f"节圆{SYM_DIA}{format_mm(pat['radius'] * 2)}"})
            c = pat["center"]
            if abs(c[0] - xc) > HOLE_TOL or abs(c[1] - yc) > HOLE_TOL:
                pts.append(tuple(c))
            continue
        pts.extend(g["positions"])
    out = {"center": (xc, yc), "circles": circles, "points": pts}
    for axis, (lo, hi, mid) in (("x", (xmin, xmax, xc)), ("y", (ymin, ymax, yc))):
        k = 0 if axis == "x" else 1
        vals = _unique([p[k] for p in pts])
        if not vals:
            out[axis] = {"mode": "none", "dims": []}
            continue
        symmetric = all(any(abs((2 * mid - v) - w) < HOLE_TOL for w in vals) for v in vals)
        if symmetric:
            ds = _unique([abs(v - mid) for v in vals if abs(v - mid) > HOLE_TOL])
            out[axis] = {"mode": "sym", "dims": [{"a": mid - d, "b": mid + d, "text": format_mm(2 * d)} for d in ds]}
        else:
            ords = [{"value": lo, "text": "0"}] + [{"value": v, "text": format_mm(v - lo)} for v in vals if v - lo > HOLE_TOL]
            out[axis] = {"mode": "ord", "dims": ords}
    return out


def spread(desired, gap: float, lo=None, hi=None):
    """一维避让：保持顺序、相邻至少 gap、总位移最小（相邻冲突合并成簇居中）；返回新位置（与输入同序）。"""
    if not desired:
        return []
    order = sorted(range(len(desired)), key=lambda i: desired[i])
    clusters = []  # [start, [indices]]
    for i in order:
        clusters.append([desired[i], [i]])
        while len(clusters) > 1:
            a, b = clusters[-2], clusters[-1]
            if a[0] + gap * len(a[1]) <= b[0] + 1e-9:
                break
            idx = a[1] + b[1]
            mean = sum(desired[j] for j in idx) / len(idx)
            start = mean - gap * (len(idx) - 1) / 2
            clusters[-2:] = [[start, idx]]
    out = [0.0] * len(desired)
    for start, idx in clusters:
        for k, j in enumerate(idx):
            out[j] = start + gap * k
    if lo is not None and out and min(out) < lo:
        shift = lo - min(out)
        out = [v + shift for v in out]
    if hi is not None and out and max(out) > hi:
        shift = max(out) - hi
        out = [v - shift for v in out]
    return out


def annotation_needs(groups, positions_plan, mode: str = "dims") -> dict:
    """页面上俯视图四周要预留的毫米数（与比例无关）；mode=table 时给出孔位表尺寸。"""
    if not groups:
        return {}
    need = {"left": 0.0, "bottom": 0.0, "right": 0.0}
    if mode == "table":
        rows = sum(len(g["positions"]) for g in groups)
        need["table"] = (sum(TABLE_COLS), TABLE_ROW * (rows + 2))
        return need
    for axis, side in (("x", "bottom"), ("y", "left")):
        plan = positions_plan.get(axis) or {}
        dims = plan.get("dims") or []
        if plan.get("mode") == "sym" and dims:
            need[side] = DIM_OFFSET + TIER * (len(dims) - 1) + TEXT_H + 2
        elif plan.get("mode") == "ord" and dims:
            need[side] = 6.0 + max(_text_width(d["text"], TEXT_H) for d in dims) + 2
    texts = [g["callout"] for g in groups] + [c["text"] for c in positions_plan.get("circles") or []]
    need["right"] = CALLOUT_GAP + max(_text_width(t, TEXT_H) for t in texts) + 3
    return need


def crowding_reason(groups, positions_plan, scale: float):
    """在给定比例下是否过密（需退化为孔位表）；返回原因或 None。"""
    callouts = len(groups) + len(positions_plan.get("circles") or [])
    if callouts > MAX_CALLOUTS:
        return f"孔规格 {callouts} 种，超过 {MAX_CALLOUTS} 种"
    for axis in ("x", "y"):
        plan = positions_plan.get(axis) or {}
        dims = plan.get("dims") or []
        if plan.get("mode") == "sym":
            if len(dims) > MAX_TIERS:
                return f"{axis.upper()} 向孔距 {len(dims)} 道，超过 {MAX_TIERS} 道"
            for d in dims:
                if (d["b"] - d["a"]) * scale < 6.0:
                    return f"孔距 {d['text']} 在 {scale_label(scale)} 下过小"
        elif plan.get("mode") == "ord":
            if len(dims) > MAX_ORDINATES:
                return f"{axis.upper()} 向坐标 {len(dims)} 个，超过 {MAX_ORDINATES} 个"
            want = [d["value"] * scale for d in dims]
            got = spread(want, ORD_PITCH)
            if max(abs(a - b) for a, b in zip(want, got)) > ORD_MAX_SHIFT:
                return f"{axis.upper()} 向孔心坐标过密"
    return None


def choose_section_line(groups):
    """有沉孔/盲孔/螺纹孔时选一条过孔心、平行 X 的剖切线 y（覆盖最多「需看深度」的孔）；无需剖视返回 None。"""
    special = [g for g in groups if g["kind"] == "counterbore" or g.get("thread") or not g.get("through")]
    if not special:
        return None
    cands = _unique([p[1] for g in special for p in g["positions"]])
    best = None
    for y in cands:
        score = sum(1 for g in special for p in g["positions"] if abs(p[1] - y) < HOLE_TOL) * 10 \
            + sum(1 for g in groups for p in g["positions"] if abs(p[1] - y) < HOLE_TOL)
        if best is None or score > best[0] or (score == best[0] and abs(y) < abs(best[1])):
            best = (score, y)
    return best[1]


def hatch_lines(polys, spacing: float = 3.0, angle_deg: float = 45.0):
    """剖面线：多边形组（奇偶规则，可含内孔）内的平行线段；页面坐标。纯函数，SVG/DXF 共用。"""
    if not polys:
        return []
    a = math.radians(angle_deg)
    ca, sa = math.cos(a), math.sin(a)
    # 旋转到剖面线水平：u = x·cos + y·sin，v = −x·sin + y·cos
    rp = [[(x * ca + y * sa, -x * sa + y * ca) for x, y in poly] for poly in polys if len(poly) >= 3]
    vs = [v for poly in rp for _, v in poly]
    if not vs:
        return []
    out = []
    v = math.floor(min(vs) / spacing) * spacing + spacing / 2
    while v < max(vs):
        xs = []
        for poly in rp:
            for i in range(len(poly)):
                (u1, v1), (u2, v2) = poly[i], poly[(i + 1) % len(poly)]
                if (v1 <= v < v2) or (v2 <= v < v1):
                    xs.append(u1 + (v - v1) * (u2 - u1) / (v2 - v1))
        xs.sort()
        for i in range(0, len(xs) - 1, 2):
            if xs[i + 1] - xs[i] > 0.05:
                p1 = (xs[i] * ca - v * sa, xs[i] * sa + v * ca)
                p2 = (xs[i + 1] * ca - v * sa, xs[i + 1] * sa + v * ca)
                out.append((p1, p2))
        v += spacing
    return out


class SegmentIndex:
    """线段网格索引：判定 DXF 图元是否落在隐藏线/可见线上（用于隐藏线分层）。"""

    def __init__(self, polylines, cell: float = 2.0):
        self.cell = cell
        self.grid = {}
        for poly in polylines:
            for i in range(len(poly) - 1):
                seg = (poly[i], poly[i + 1])
                x0, x1 = sorted((seg[0][0], seg[1][0]))
                y0, y1 = sorted((seg[0][1], seg[1][1]))
                for gx in range(int(math.floor(x0 / cell)), int(math.floor(x1 / cell)) + 1):
                    for gy in range(int(math.floor(y0 / cell)), int(math.floor(y1 / cell)) + 1):
                        self.grid.setdefault((gx, gy), []).append(seg)

    def distance(self, p) -> float:
        gx, gy = int(math.floor(p[0] / self.cell)), int(math.floor(p[1] / self.cell))
        best = float("inf")
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for (a, b) in self.grid.get((gx + dx, gy + dy), ()):
                    best = min(best, _seg_dist(p, a, b))
        return best


def _seg_dist(p, a, b) -> float:
    vx, vy = b[0] - a[0], b[1] - a[1]
    L2 = vx * vx + vy * vy
    t = 0.0 if L2 < 1e-12 else max(0.0, min(1.0, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L2))
    return math.hypot(p[0] - a[0] - t * vx, p[1] - a[1] - t * vy)


# ---- 页面图元（SVG 与 DXF 共用同一份，保证三种输出一致） -------------------------------
# {"t":"line","pts":[(x,y),...],"cls":c} / {"t":"circle","c":(x,y),"r":r,"cls":c}
# {"t":"arc","c":(x,y),"r":r,"a0":deg,"a1":deg,"cls":c}（逆时针）/ {"t":"arrow","tip":(x,y),"dir":(dx,dy)}
# {"t":"text","at":(x,y),"text":s,"size":h,"anchor":"start|middle|end","rot":0|90,"cls":c}
# cls → DXF 图层：dim→DIM、center→CENTER、hatch→HATCH、thread→THREAD、note→NOTES、thick→OUTLINE、cut→CENTER

CLS_LAYER = {"dim": "DIM", "center": "CENTER", "hatch": "HATCH", "thread": "THREAD", "note": "NOTES",
             "thick": "OUTLINE", "cut": "CENTER", "cutmark": "DIM"}


def prim_line(pts, cls="dim"):
    return {"t": "line", "pts": [tuple(p) for p in pts], "cls": cls}


def prim_text(x, y, text, anchor="middle", rot=0, size=TEXT_H, cls="dim"):
    return {"t": "text", "at": (x, y), "text": text, "size": size, "anchor": anchor, "rot": rot, "cls": cls}


def prim_arrow(tip, toward):
    """箭头尖在 tip，箭身朝 toward 方向展开（页面坐标）。"""
    dx, dy = toward[0] - tip[0], toward[1] - tip[1]
    n = math.hypot(dx, dy) or 1.0
    return {"t": "arrow", "tip": tuple(tip), "dir": (dx / n, dy / n)}


def center_cross(c, arm, cls="center"):
    x, y = c
    return [prim_line([(x - arm, y), (x + arm, y)], cls), prim_line([(x, y - arm), (x, y + arm)], cls)]


def linear_dim(p1, p2, orient: str, at: float, text: str, ext_from=None):
    """线性尺寸图元：orient=h（水平尺寸线位于 y=at）/ v（竖直尺寸线位于 x=at）。ext_from=尺寸界线起点（视图边外）。"""
    out = []
    if orient == "h":
        y0 = ext_from if ext_from is not None else p1[1]
        s = 1.0 if at < y0 else -1.0
        for x in (p1[0], p2[0]):
            out.append(prim_line([(x, y0), (x, at - 1.5 * s)]))
        out.append(prim_line([(p1[0], at), (p2[0], at)]))
        out.append(prim_arrow((p1[0], at), (p2[0], at)))
        out.append(prim_arrow((p2[0], at), (p1[0], at)))
        w = _text_width(text, TEXT_H)
        mid = (p1[0] + p2[0]) / 2
        if abs(p2[0] - p1[0]) < w + 7:
            mid = max(p1[0], p2[0]) + 2 + w / 2
            out.append(prim_line([(max(p1[0], p2[0]), at), (mid + w / 2, at)]))
        out.append(prim_text(mid, at + 1.0, text))
    else:
        x0 = ext_from if ext_from is not None else p1[0]
        s = 1.0 if at < x0 else -1.0
        for y in (p1[1], p2[1]):
            out.append(prim_line([(x0, y), (at - 1.5 * s, y)]))
        out.append(prim_line([(at, p1[1]), (at, p2[1])]))
        out.append(prim_arrow((at, p1[1]), (at, p2[1])))
        out.append(prim_arrow((at, p2[1]), (at, p1[1])))
        w = _text_width(text, TEXT_H)
        mid = (p1[1] + p2[1]) / 2
        if abs(p2[1] - p1[1]) < w + 7:
            mid = max(p1[1], p2[1]) + 2 + w / 2
            out.append(prim_line([(at, max(p1[1], p2[1])), (at, mid + w / 2)]))
        out.append(prim_text(at - 1.0, mid, text, rot=90))
    return out


def prims_bbox(prims):
    """图元占位（文字按估算宽度）；用于自检「不重叠/不压视图」。"""
    boxes = []
    for p in prims:
        if p["t"] == "text":
            w, h = _text_width(p["text"], p["size"]), p["size"]
            x, y = p["at"]
            x0 = x - (w if p["anchor"] == "end" else w / 2 if p["anchor"] == "middle" else 0)
            if p.get("rot") == 90:
                boxes.append(("text", (x - h, x0 - x + y, x, x0 - x + y + w), p["text"]))
            else:
                boxes.append(("text", (x0, y, x0 + w, y + h), p["text"]))
    return boxes


def layout_hole_annotations(groups, positions_plan, view_rect, bbox2d, scale: float, mode: str = "dims"):
    """
    俯视图（孔可见）上的孔标注图元：孔标注引线、孔位尺寸（对称/坐标）、中心标记、节圆、孔位表标签。
    view_rect 为俯视图页面占位（x0,y0,x1,y1）；返回 (prims, info)。
    """
    xmin, ymin, xmax, ymax = bbox2d
    vx0, vy0, vx1, vy1 = view_rect

    def P(x, y):
        return (vx0 + (x - xmin) * scale, vy0 + (y - ymin) * scale)

    prims, info = [], {"callouts": [], "mode": mode}
    xc, yc = positions_plan["center"]
    cxp, cyp = P(xc, yc)
    # 零件中心线（对称轴向）
    if (positions_plan.get("x") or {}).get("mode") == "sym" or positions_plan.get("circles"):
        prims.append(prim_line([(cxp, vy0 - 3), (cxp, vy1 + 3)], "center"))
    if (positions_plan.get("y") or {}).get("mode") == "sym" or positions_plan.get("circles"):
        prims.append(prim_line([(vx0 - 3, cyp), (vx1 + 3, cyp)], "center"))
    # 中心标记 / 槽中心线 / 螺纹大径 3/4 细实线圆 / 节圆
    for g in groups:
        for (x, y) in g["positions"]:
            px, py = P(x, y)
            if g["kind"] == "slot":
                ang = math.radians(g.get("angle") or 0.0)
                half = (g["length"] - g["width"]) / 2 * scale
                ux, uy = math.cos(ang), math.sin(ang)
                ends = [(px - ux * half, py - uy * half), (px + ux * half, py + uy * half)]
                arm = g["width"] / 2 * scale + 2
                prims.append(prim_line([(ends[0][0] - ux * arm, ends[0][1] - uy * arm),
                                        (ends[1][0] + ux * arm, ends[1][1] + uy * arm)], "center"))
                for e in ends:
                    prims.append(prim_line([(e[0] + uy * arm, e[1] - ux * arm), (e[0] - uy * arm, e[1] + ux * arm)], "center"))
            else:
                r = max(g.get("cbDiameter") or 0, _thread_major(g) or 0, g["diameter"]) / 2 * scale
                prims.extend(center_cross((px, py), r + 2.0))
                major = _thread_major(g)
                if major:
                    prims.append({"t": "arc", "c": (px, py), "r": major / 2 * scale, "a0": 0.0, "a1": 270.0, "cls": "thread"})
    for c in positions_plan.get("circles") or []:
        px, py = P(*c["center"])
        prims.append({"t": "circle", "c": (px, py), "r": c["radius"] * scale, "cls": "center"})

    if mode == "table":
        n = 0
        for g in groups:
            for i, (x, y) in enumerate(g["positions"], 1):
                px, py = P(x, y)
                r = (g.get("cbDiameter") or g.get("diameter") or g.get("width") or 4) / 2 * scale
                prims.append(prim_text(px + r * 0.75 + 0.6, py + r * 0.75 + 0.6, f"{g['letter']}{i}", "start", size=2.5, cls="note"))
                n += 1
        info["callouts"] = [g["callout"] for g in groups]
        return prims, info

    # ---- 孔标注：右侧文字列，引线指到该组最右侧的一个孔 ----
    col = vx1 + CALLOUT_GAP
    items = []
    for g in groups:
        tx, ty = max((P(x, y) for x, y in g["positions"]), key=lambda q: (q[0], q[1]))
        if g["kind"] == "slot":
            ang = math.radians(g.get("angle") or 0.0)
            half = g["length"] / 2 * scale
            edge = (tx + math.cos(ang) * half, ty + math.sin(ang) * half)
            items.append({"text": g["callout"], "target": (tx, ty), "edge": edge, "r": 0.0})
        else:
            items.append({"text": g["callout"], "target": (tx, ty), "edge": None, "r": g["diameter"] / 2 * scale})
    for c in positions_plan.get("circles") or []:
        px, py = P(*c["center"])
        rr = c["radius"] * scale
        a = math.radians(-12.0)
        items.append({"text": c["text"], "target": (px + rr * math.cos(a), py + rr * math.sin(a)),
                      "edge": (px + rr * math.cos(a), py + rr * math.sin(a)), "r": 0.0})
    want = [it["target"][1] + 2.5 for it in items]
    got = spread(want, CALLOUT_PITCH, lo=vy0 - TEXT_H, hi=vy1 + 6)
    for it, ty in zip(items, got):
        w = _text_width(it["text"], TEXT_H)
        elbow = (col - 1.5, ty)
        if it["edge"] is None:
            dx, dy = elbow[0] - it["target"][0], elbow[1] - it["target"][1]
            n = math.hypot(dx, dy) or 1.0
            tip = (it["target"][0] + dx / n * it["r"], it["target"][1] + dy / n * it["r"])
        else:
            tip = it["edge"]
        prims.append(prim_line([tip, elbow, (col + w + 0.5, ty)]))
        prims.append(prim_arrow(tip, elbow))
        prims.append(prim_text(col, ty + 0.8, it["text"], "start"))
        info["callouts"].append(it["text"])

    # ---- 孔位尺寸：X 在视图下方，Y 在视图左侧 ----
    for axis in ("x", "y"):
        plan = positions_plan.get(axis) or {}
        dims = plan.get("dims") or []
        if not dims:
            continue
        if plan["mode"] == "sym":
            for tier, d in enumerate(dims):
                if axis == "x":
                    a, b = P(d["a"], yc)[0], P(d["b"], yc)[0]
                    prims.extend(linear_dim((a, vy0), (b, vy0), "h", vy0 - DIM_OFFSET - TIER * tier, d["text"], vy0 - EXT_GAP))
                else:
                    a, b = P(xc, d["a"])[1], P(xc, d["b"])[1]
                    prims.extend(linear_dim((vx0, a), (vx0, b), "v", vx0 - DIM_OFFSET - TIER * tier, d["text"], vx0 - EXT_GAP))
        else:
            if axis == "x":
                want = [P(d["value"], ymin)[0] for d in dims]
                got = spread(want, ORD_PITCH)
                for d, w0, t in zip(dims, want, got):
                    prims.append(prim_line([(w0, vy0 - EXT_GAP), (w0, vy0 - 4.0), (t, vy0 - 5.5)]))
                    prims.append(prim_text(t + TEXT_H / 2 - 0.3, vy0 - 6.0, d["text"], "end", rot=90))
            else:
                want = [P(xmin, d["value"])[1] for d in dims]
                got = spread(want, ORD_PITCH)
                for d, w0, t in zip(dims, want, got):
                    prims.append(prim_line([(vx0 - EXT_GAP, w0), (vx0 - 4.0, w0), (vx0 - 5.5, t)]))
                    prims.append(prim_text(vx0 - 6.0, t - TEXT_H / 2 + 0.3, d["text"], "end"))
    return prims, info


def single_callout(g) -> str:
    """单个孔的规格（孔位表用）：不带数量前缀与「均布」。"""
    return callout_text({**g, "positions": g["positions"][:1], "pattern": None})


def _thread_major(g):
    if not g.get("thread"):
        return None
    m = re.match(r"M(\d+(?:\.\d+)?)", g["thread"])
    return float(m.group(1)) if m else None


def hole_table_prims(groups, bbox2d, origin):
    """孔位表（孔号 + X/Y（以左下角为原点）+ 规格）；origin 为表左下角页面坐标。"""
    xmin, ymin = bbox2d[0], bbox2d[1]
    rows = [(f"{g['letter']}{i}", format_mm(x - xmin), format_mm(y - ymin), single_callout(g))
            for g in groups for i, (x, y) in enumerate(g["positions"], 1)]
    W = sum(TABLE_COLS)
    H = TABLE_ROW * (len(rows) + 2)
    x0, y0 = origin
    prims = [prim_text(x0 + W / 2, y0 + H - TABLE_ROW + 1.6, "孔位表（原点：左下角）", cls="note"),
             prim_line([(x0, y0), (x0 + W, y0), (x0 + W, y0 + H - TABLE_ROW), (x0, y0 + H - TABLE_ROW), (x0, y0)], "note")]
    heads = ("孔号", "X", "Y", "规格")
    for r in range(len(rows) + 1):
        y = y0 + H - TABLE_ROW * (r + 2)
        if r > 0:
            prims.append(prim_line([(x0, y + TABLE_ROW), (x0 + W, y + TABLE_ROW)], "note"))
        cells = heads if r == 0 else rows[r - 1]
        cx = x0
        for wcol, txt in zip(TABLE_COLS, cells):
            prims.append(prim_text(cx + wcol / 2, y + 1.7, txt, size=3.0, cls="note"))
            cx += wcol
    cx = x0
    for wcol in TABLE_COLS[:-1]:
        cx += wcol
        prims.append(prim_line([(cx, y0), (cx, y0 + H - TABLE_ROW)], "note"))
    return prims


def cut_line_prims(view_rect, y_page: float, letter: str = "A"):
    """俯视图上的剖切符号：两端粗短划 + 箭头（投射方向 +Y，即朝页面上方）+ 字母。"""
    x0, _, x1, _ = view_rect
    out = []
    for xa, xb in ((x0 - 7, x0 - 2), (x1 + 2, x1 + 7)):
        out.append(prim_line([(xa, y_page), (xb, y_page)], "cutmark"))
        xm = (xa + xb) / 2
        out.append(prim_line([(xm, y_page), (xm, y_page + 5)], "cutmark"))
        out.append(prim_arrow((xm, y_page + 5), (xm, y_page)))
        out.append(prim_text(xm + (-2.5 if xa < x0 else 2.5), y_page + 1.2, letter, size=TEXT_H))
    return out


# ---------------------------------------------------------------------------
# 图元渲染：SVG 片段与 DXF 分层后处理（纯逻辑，--self-test 覆盖）
# ---------------------------------------------------------------------------

SVG_CLS = {"dim": "dim", "center": "center", "hatch": "hatch", "thread": "thin", "note": "thin", "thick": "thick",
           "cut": "center", "cutmark": "cutm"}

# DXF 图层：名称、颜色、线型
DXF_LAYERS = (
    ("OUTLINE", 7, "CONTINUOUS"), ("HIDDEN", 2, "HIDDEN"), ("CENTER", 1, "CENTER"), ("DIM", 3, "CONTINUOUS"),
    ("HATCH", 8, "CONTINUOUS"), ("THREAD", 4, "CONTINUOUS"), ("NOTES", 7, "CONTINUOUS"), ("FRAME", 7, "CONTINUOUS"),
)
DXF_LTYPES = (
    ("CENTER", "Center ____ _ ____ _", (12.0, -3.0, 2.0, -3.0)),
    ("HIDDEN", "Hidden __ __ __", (3.0, -1.5)),
)


def _arc_points(c, r, a0, a1, step_deg: float = 6.0):
    span = (a1 - a0) % 360.0 or 360.0
    n = max(4, int(math.ceil(span / step_deg)))
    return [(c[0] + r * math.cos(math.radians(a0 + span * i / n)), c[1] + r * math.sin(math.radians(a0 + span * i / n)))
            for i in range(n + 1)]


def prims_to_svg(prims, PH: float, font_family: str) -> list:
    """页面图元 → SVG 元素（页面 y 向上 → SVG y 向下）。"""
    out = []

    def Y(y):
        return PH - y

    for p in prims:
        t = p["t"]
        cls = SVG_CLS.get(p.get("cls") or "dim", "dim")
        if t == "line":
            pts = p["pts"]
            d = " ".join(f"{'M' if i == 0 else 'L'}{x:.3f},{Y(y):.3f}" for i, (x, y) in enumerate(pts))
            out.append(f'<path d="{d}" class="{cls}"/>')
        elif t == "circle":
            out.append(f'<circle cx="{p["c"][0]:.3f}" cy="{Y(p["c"][1]):.3f}" r="{p["r"]:.3f}" class="{cls}"/>')
        elif t == "arc":
            pts = _arc_points(p["c"], p["r"], p["a0"], p["a1"])
            d = " ".join(f"{'M' if i == 0 else 'L'}{x:.3f},{Y(y):.3f}" for i, (x, y) in enumerate(pts))
            out.append(f'<path d="{d}" class="{cls}"/>')
        elif t == "arrow":
            x, y = p["tip"]
            out.append(_arrow(x, Y(y), p["dir"][0], -p["dir"][1]))
        elif t == "text":
            if not p["text"]:
                continue
            x, y = p["at"]
            anchor = p.get("anchor") or "middle"
            el = (f'<text x="0" y="0" font-family="{_esc(font_family)}" font-size="{p["size"]:g}" '
                  f'text-anchor="{anchor}" fill="#000">{_esc(p["text"])}</text>')
            rot = " rotate(-90)" if p.get("rot") == 90 else ""
            out.append(f'<g transform="translate({x:.3f},{Y(y):.3f}){rot}">{el}</g>')
    return out


def _dxf_pairs(content: str):
    rows = content.replace("\r\n", "\n").split("\n")
    while rows and rows[-1] == "":
        rows.pop()
    return [(rows[i].strip(), rows[i + 1]) for i in range(0, len(rows) - 1, 2)]


def _dxf_text(pairs) -> str:
    rows = []
    for c, v in pairs:
        rows.append(c.rjust(3))
        rows.append(v)
    return "\n".join(rows) + "\n"


def _bspline_point(degree: int, knots, ctrl, weights, t: float):
    """de Boor（含有理权重），用于取 SPLINE 中点。"""
    n = len(ctrl) - 1
    k = degree
    if n < k or len(knots) < n + k + 2:
        return ctrl[len(ctrl) // 2]
    span = k
    for i in range(k, n + 1):
        if knots[i] <= t < knots[i + 1]:
            span = i
            break
    else:
        span = n
    w = weights or [1.0] * len(ctrl)
    d = [(ctrl[j][0] * w[j], ctrl[j][1] * w[j], w[j]) for j in range(span - k, span + 1)]
    for r in range(1, k + 1):
        for j in range(k, r - 1, -1):
            i = j + span - k
            denom = knots[i + k - r + 1] - knots[i]
            a = 0.0 if denom == 0 else (t - knots[i]) / denom
            d[j] = tuple((1 - a) * d[j - 1][m] + a * d[j][m] for m in range(3))
    x, y, ww = d[k]
    return (x / ww, y / ww) if ww else (x, y)


def dxf_entity_samples(etype: str, groups):
    """DXF 图元上的采样点（页面坐标），用于判断是否隐藏线；不认识的类型返回 []。"""
    def vals(code):
        return [float(v) for c, v in groups if c == code and _is_float(v)]

    def first(code, default=0.0):
        v = vals(code)
        return v[0] if v else default

    if etype == "LINE":
        return [((first("10") + first("11")) / 2, (first("20") + first("21")) / 2)]
    if etype in ("CIRCLE", "ARC"):
        cx, cy, r = first("10"), first("20"), first("40")
        if etype == "CIRCLE":
            return [(cx + r * math.cos(a), cy + r * math.sin(a)) for a in (0.3, 2.4, 4.4)]
        a0, a1 = first("50"), first("51")
        span = (a1 - a0) % 360.0 or 360.0
        return [(cx + r * math.cos(math.radians(a0 + span * f)), cy + r * math.sin(math.radians(a0 + span * f)))
                for f in (0.25, 0.5, 0.75)]
    if etype == "ELLIPSE":
        cx, cy, mx, my, ratio = first("10"), first("20"), first("11"), first("21"), first("40", 1.0)
        t0, t1 = first("41", 0.0), first("42", 2 * math.pi)
        if t1 <= t0:
            t1 += 2 * math.pi
        pts = []
        for f in (0.25, 0.5, 0.75):
            t = t0 + (t1 - t0) * f
            pts.append((cx + mx * math.cos(t) - ratio * my * math.sin(t), cy + my * math.cos(t) + ratio * mx * math.sin(t)))
        return pts
    if etype == "SPLINE":
        xs, ys = vals("10"), vals("20")
        ctrl = list(zip(xs, ys))
        if len(ctrl) < 2:
            return []
        knots = vals("40")
        weights = vals("41") or None
        if weights and len(weights) != len(ctrl):
            weights = None
        degree = int(first("71", 3))
        if len(knots) >= len(ctrl) + degree + 1:
            lo, hi = knots[degree], knots[len(ctrl)]
            return [_bspline_point(degree, knots, ctrl, weights, lo + (hi - lo) * f) for f in (0.25, 0.5, 0.75)]
        return [ctrl[0], ctrl[-1]]
    if etype in ("LWPOLYLINE",):
        xs, ys = vals("10"), vals("20")
        if len(xs) >= 2:
            return [((xs[0] + xs[1]) / 2, (ys[0] + ys[1]) / 2)]
    return []


def _is_float(v) -> bool:
    try:
        float(v)
        return True
    except (TypeError, ValueError):
        return False


def make_hidden_classifier(hidden_polys, visible_polys, tol: float = 0.08):
    """采样点全部落在隐藏线上、且不全落在可见线上 → HIDDEN。"""
    if not hidden_polys:
        return lambda etype, groups: "OUTLINE"
    hid = SegmentIndex(hidden_polys)
    vis = SegmentIndex(visible_polys) if visible_polys else None

    def classify(etype, groups):
        pts = dxf_entity_samples(etype, groups)
        if not pts:
            return "OUTLINE"
        if all(hid.distance(p) < tol for p in pts) and not (vis and all(vis.distance(p) < tol for p in pts)):
            return "HIDDEN"
        return "OUTLINE"

    return classify


def dxf_postprocess(content: str, prims=(), frame_lines=(), frame_texts=(), classify=None) -> str:
    """
    TechDraw writeDXFPage 产物后处理：
      1) LTYPE 表补 CENTER/HIDDEN 线型，LAYER 表补 OUTLINE/HIDDEN/CENTER/DIM/HATCH/THREAD/NOTES/FRAME；
      2) 视图图元按 classify 分到 OUTLINE / HIDDEN，TechDraw 尺寸（DIMENSION、Dim* 图层）归 DIM；
      3) 追加图框/标题栏（FRAME）与孔标注图元（按 cls 分层）；更新 $HANDSEED。
    """
    pairs = _dxf_pairs(content)
    header_end = next((i for i, (c, v) in enumerate(pairs) if c == "0" and v.strip() == "ENDSEC"), -1)
    handles = [int(v.strip(), 16) for i, (c, v) in enumerate(pairs)
               if i > header_end and c == "5" and re.fullmatch(r"[0-9A-Fa-f]+", v.strip() or "x")]
    state = {"h": (max(handles) + 1) if handles else 0x100}

    def new_handle():
        h = state["h"]
        state["h"] += 1
        return f"{h:X}"

    # --- 表 ---
    def table_bounds(name):
        for i, (c, v) in enumerate(pairs):
            if c == "0" and v.strip() == "TABLE" and i + 1 < len(pairs) and pairs[i + 1][0] == "2" \
                    and pairs[i + 1][1].strip() == name:
                handle = next((v2.strip() for c2, v2 in pairs[i + 2:i + 6] if c2 == "5"), "0")
                end = next(j for j in range(i, len(pairs)) if pairs[j][0] == "0" and pairs[j][1].strip() == "ENDTAB")
                existing = set()
                for j in range(i + 2, end):
                    if pairs[j][0] == "2":
                        existing.add(pairs[j][1].strip().upper())
                return handle, end, existing
        return None, None, set()

    inserts = []  # (index, [pairs])
    lt_handle, lt_end, lt_existing = table_bounds("LTYPE")
    if lt_end is not None:
        rec = []
        for name, desc, pattern in DXF_LTYPES:
            if name in lt_existing:
                continue
            rec += [("0", "LTYPE"), ("5", new_handle()), ("330", lt_handle), ("100", "AcDbSymbolTableRecord"),
                    ("100", "AcDbLinetypeTableRecord"), ("2", name), ("70", "0"), ("3", desc), ("72", "65"),
                    ("73", str(len(pattern))), ("40", f"{sum(abs(x) for x in pattern):g}")]
            for seg in pattern:
                rec += [("49", f"{seg:g}"), ("74", "0")]
        inserts.append((lt_end, rec))
    la_handle, la_end, la_existing = table_bounds("LAYER")
    if la_end is not None:
        rec = []
        for name, color, ltype in DXF_LAYERS:
            if name in la_existing:
                continue
            rec += [("0", "LAYER"), ("5", new_handle()), ("330", la_handle), ("100", "AcDbSymbolTableRecord"),
                    ("100", "AcDbLayerTableRecord"), ("2", name), ("70", "0"), ("62", str(color)), ("6", ltype)]
        inserts.append((la_end, rec))
    for idx, rec in sorted(inserts, key=lambda item: -item[0]):
        pairs[idx:idx] = rec

    # --- 模型空间 owner 与 ENTITIES 段 ---
    owner = None
    for i, (c, v) in enumerate(pairs):
        if c == "0" and v.strip() == "BLOCK_RECORD":
            h, name = None, None
            for c2, v2 in pairs[i + 1:i + 12]:
                if c2 == "5":
                    h = v2.strip()
                if c2 == "2":
                    name = v2.strip()
                    break
            if name and name.lower() == "*model_space":
                owner = h
                break
    start = end = None
    for i, (c, v) in enumerate(pairs):
        if c == "2" and v.strip() == "ENTITIES" and i > 0 and pairs[i - 1][0] == "0" \
                and pairs[i - 1][1].strip() == "SECTION":
            start = i + 1
            continue
        if start is not None and c == "0" and v.strip() == "ENDSEC":
            end = i
            break
    if start is None or end is None:
        raise ValueError("DXF 缺少 ENTITIES 段")
    # 视图图元重新分层
    i = start
    while i < end:
        if pairs[i][0] != "0":
            i += 1
            continue
        j = i + 1
        while j < end and pairs[j][0] != "0":
            j += 1
        etype = pairs[i][1].strip()
        body = pairs[i + 1:j]
        lay_idx = next((k for k in range(i + 1, j) if pairs[k][0] == "8"), None)
        if lay_idx is not None:
            layer = pairs[lay_idx][1].strip()
            target = None
            if etype == "DIMENSION" or layer.lower().startswith("dim"):
                target = "DIM"
            elif layer not in ("0", "FRAME") and layer.upper() not in {n for n, _, _ in DXF_LAYERS}:
                target = classify(etype, body) if classify else "OUTLINE"
            if target:
                pairs[lay_idx] = (pairs[lay_idx][0], target)
        i = j

    added = []

    def emit(code, value):
        added.append((str(code), str(value)))

    def head(kind, layer, sub):
        emit(0, kind)
        emit(5, new_handle())
        if owner:
            emit(330, owner)
        emit(100, "AcDbEntity")
        emit(8, layer)
        emit(100, sub)

    def line(a, b, layer):
        head("LINE", layer, "AcDbLine")
        emit(10, f"{a[0]:.4f}"); emit(20, f"{a[1]:.4f}"); emit(30, "0")
        emit(11, f"{b[0]:.4f}"); emit(21, f"{b[1]:.4f}"); emit(31, "0")

    def text(at, txt, height, layer, anchor="start", rot=0):
        if txt is None or str(txt) == "":
            return
        head("TEXT", layer, "AcDbText")
        emit(10, f"{at[0]:.4f}"); emit(20, f"{at[1]:.4f}"); emit(30, "0"); emit(40, f"{height:g}")
        emit(1, dxf_text_escape(txt))
        if rot:
            emit(50, f"{rot:g}")
        just = {"start": 0, "middle": 1, "end": 2}.get(anchor, 0)
        if just:
            emit(72, str(just))
            emit(11, f"{at[0]:.4f}"); emit(21, f"{at[1]:.4f}"); emit(31, "0")
        emit(100, "AcDbText")

    for (x1, y1, x2, y2) in frame_lines:
        line((x1, y1), (x2, y2), "FRAME")
    for (x, y, txt, height) in frame_texts:
        text((x, y), txt, height, "FRAME")
    for p in prims:
        layer = CLS_LAYER.get(p.get("cls") or "dim", "DIM")
        t = p["t"]
        if t == "line":
            for a, b in zip(p["pts"], p["pts"][1:]):
                line(a, b, layer)
        elif t == "circle":
            head("CIRCLE", layer, "AcDbCircle")
            emit(10, f"{p['c'][0]:.4f}"); emit(20, f"{p['c'][1]:.4f}"); emit(30, "0"); emit(40, f"{p['r']:.4f}")
        elif t == "arc":
            head("ARC", layer, "AcDbCircle")
            emit(10, f"{p['c'][0]:.4f}"); emit(20, f"{p['c'][1]:.4f}"); emit(30, "0"); emit(40, f"{p['r']:.4f}")
            emit(100, "AcDbArc"); emit(50, f"{p['a0']:g}"); emit(51, f"{p['a1']:g}")
        elif t == "arrow":
            (x, y), (dx, dy) = p["tip"], p["dir"]
            bx, by = x + dx * 3.0, y + dy * 3.0
            nx, ny = -dy * 0.5, dx * 0.5
            head("SOLID", "DIM", "AcDbTrace")
            for k, (px, py) in enumerate(((x, y), (bx + nx, by + ny), (bx - nx, by - ny), (bx - nx, by - ny))):
                emit(10 + k, f"{px:.4f}"); emit(20 + k, f"{py:.4f}"); emit(30 + k, "0")
        elif t == "text":
            # SVG 的 text 锚点是基线；DXF TEXT 同为基线对齐，竖排文字旋转 90°
            text(p["at"], p["text"], p["size"], layer, p.get("anchor") or "middle", 90 if p.get("rot") == 90 else 0)
    pairs[end:end] = added
    for k, (c, v) in enumerate(pairs):
        if c == "9" and v.strip() == "$HANDSEED" and k + 1 < len(pairs):
            code, val = pairs[k + 1]
            try:
                current = int(val.strip(), 16)
            except ValueError:
                current = 0
            if current <= state["h"]:
                pairs[k + 1] = (code, f"{state['h'] + 1:X}")
            break
    return _dxf_text(pairs)


# ---------------------------------------------------------------------------
# 几何识别兜底、视图映射、轴线与剖视图元（recognize_geometry 需 FreeCAD 对象，其余为纯逻辑）
# ---------------------------------------------------------------------------

def recognize_geometry(App, Part, shape) -> dict:
    """
    圆柱面识别（导入 STEP 等无孔语义时兜底；有语义时用于核对）：
      - 孔：沿 Z 的内凹整圆柱面按轴线成组；最小半径为底孔，顶部更大的同轴圆柱为沉孔；下方无材料为通孔；
      - 腰形槽：两段等半径 180° 内凹圆柱面配对；
      - 回转轴：外凸整圆柱面（沿 X/Y/Z），用于画轴线/中心标记。
    返回 {"holes": [spec...], "axes": [...], "warnings": [...]}，spec 与 normalize_hole_specs 同形（source=geometry）。
    """
    bb = shape.BoundBox
    stacks, arcs, revolve, warnings = {}, [], {}, []

    def inside(x, y, z):
        try:
            return shape.isInside(App.Vector(x, y, z), 1e-7, True)
        except Exception:  # noqa: BLE001
            return False

    for face in shape.Faces:
        surf = face.Surface
        if type(surf).__name__ != "Cylinder":
            continue
        ax, c, r = surf.Axis, surf.Center, float(surf.Radius)
        u0, u1, v0, v1 = face.ParameterRange
        span = math.degrees(u1 - u0)
        pm = face.valueAt((u0 + u1) / 2, (v0 + v1) / 2)
        w = pm - c
        foot = c + ax * w.dot(ax)
        radial = pm - foot
        if radial.Length < 1e-9:
            continue
        radial.normalize()
        o, i_ = pm + radial * 0.05, pm - radial * 0.05
        o_in, i_in = inside(o.x, o.y, o.z), inside(i_.x, i_.y, i_.z)
        axis = "x" if abs(ax.x) > 0.999 else "y" if abs(ax.y) > 0.999 else "z" if abs(ax.z) > 0.999 else None
        fb = face.BoundBox
        if o_in and not i_in and axis == "z":
            key = (round(foot.x, 2), round(foot.y, 2))
            if span >= 359.0:
                stacks.setdefault(key, []).append([r, fb.ZMin, fb.ZMax, span])
            else:
                mid = math.atan2(pm.y - foot.y, pm.x - foot.x)
                arcs.append({"c": (foot.x, foot.y), "r": r, "z": (fb.ZMin, fb.ZMax), "span": span, "mid": mid, "key": key})
        elif i_in and not o_in and axis:
            if axis == "z":
                key = ("z", round(foot.x, 2), round(foot.y, 2))
                lo, hi = fb.ZMin, fb.ZMax
            elif axis == "x":
                key = ("x", round(foot.y, 2), round(foot.z, 2))
                lo, hi = fb.XMin, fb.XMax
            else:
                key = ("y", round(foot.x, 2), round(foot.z, 2))
                lo, hi = fb.YMin, fb.YMax
            e = revolve.setdefault(key, {"axis": axis, "coords": key[1:], "r": 0.0, "lo": lo, "hi": hi, "span": 0.0})
            e["r"] = max(e["r"], r)
            e["lo"], e["hi"] = min(e["lo"], lo), max(e["hi"], hi)
            e["span"] += span
    # 分成两半的整圆（缝合边）：同轴同半径同高度的半圆柱合并回整圆
    rest = []
    for a in arcs:
        twin = [b for b in arcs if b is not a and b["key"] == a["key"] and abs(b["r"] - a["r"]) < 1e-3
                and abs(b["z"][0] - a["z"][0]) < 1e-3 and abs(b["z"][1] - a["z"][1]) < 1e-3]
        if twin and abs(a["span"] + sum(b["span"] for b in twin) - 360.0) < 1.0:
            stacks.setdefault(a["key"], []).append([a["r"], a["z"][0], a["z"][1], a["span"]])
        else:
            rest.append(a)
    holes = []
    for (x, y), faces in stacks.items():
        merged = {}
        for r, z0, z1, _span in faces:
            k = round(r, 3)
            m = merged.setdefault(k, [r, z0, z1])
            m[1], m[2] = min(m[1], z0), max(m[2], z1)
        ent = sorted(merged.values())
        r0, z0, z1 = ent[0]
        top = max(e[2] for e in ent)
        spec = {"kind": "hole", "positions": [(x, y)], "diameter": round(2 * r0, 3), "source": "geometry", "featureId": ""}
        spec["through"] = not inside(x, y, z0 - 0.3)
        if not spec["through"]:
            spec["depth"] = round(top - z0, 3)
        if len(ent) >= 2:
            rb, b0, b1 = ent[-1]
            if abs(b1 - top) < 1e-3:
                spec["kind"] = "counterbore"
                spec["cbDiameter"] = round(2 * rb, 3)
                spec["cbDepth"] = round(b1 - b0, 3)
            if len(ent) > 2:
                warnings.append(f"孔 ({format_mm(x)}, {format_mm(y)}) 有 {len(ent)} 级台阶，只标注底孔与最大沉孔（几何识别）")
        holes.append(spec)
    used = set()
    for i, a in enumerate(rest):
        if i in used or abs(a["span"] - 180.0) > 2.0:
            continue
        for j in range(i + 1, len(rest)):
            b = rest[j]
            if j in used or abs(b["r"] - a["r"]) > 1e-3 or abs(b["span"] - 180.0) > 2.0:
                continue
            if abs(b["z"][0] - a["z"][0]) > 1e-3 or abs(b["z"][1] - a["z"][1]) > 1e-3:
                continue
            dist = math.hypot(b["c"][0] - a["c"][0], b["c"][1] - a["c"][1])
            if dist < 1e-3:
                continue
            used.update((i, j))
            cx, cy = (a["c"][0] + b["c"][0]) / 2, (a["c"][1] + b["c"][1]) / 2
            ang = math.degrees(math.atan2(b["c"][1] - a["c"][1], b["c"][0] - a["c"][0])) % 180.0
            spec = {"kind": "slot", "positions": [(round(cx, 4), round(cy, 4))], "length": round(dist + 2 * a["r"], 3),
                    "width": round(2 * a["r"], 3), "source": "geometry", "featureId": "",
                    "through": not inside(cx, cy, a["z"][0] - 0.3)}
            if not spec["through"]:
                spec["depth"] = round(a["z"][1] - a["z"][0], 3)
            if abs(ang) > 1e-3 and abs(ang - 180.0) > 1e-3:
                spec["angle"] = round(ang, 3)
            holes.append(spec)
            break
    axes = [e for e in revolve.values() if e["span"] >= 359.0]
    return {"holes": holes, "axes": axes, "warnings": warnings}


def reconcile_holes(declared, recognized):
    """特征树语义优先；几何里多出来的孔按「几何识别」补上，声明了但几何里找不到的给警告。"""
    warnings = []

    def same(g, d):
        if g["kind"] == "slot" or d["kind"] == "slot":
            return g["kind"] == d["kind"] and abs(g.get("length", 0) - d.get("length", 0)) < 0.05 \
                and abs(g.get("width", 0) - d.get("width", 0)) < 0.05
        return abs(g.get("diameter", 0) - d.get("diameter", 0)) < 0.05

    matched_decl = set()
    extra = []
    for g in recognized:
        p = g["positions"][0]
        hit = False
        for di, d in enumerate(declared):
            for qi, q in enumerate(d["positions"]):
                if abs(p[0] - q[0]) < 0.05 and abs(p[1] - q[1]) < 0.05 and same(g, d):
                    matched_decl.add((di, qi))
                    hit = True
        if not hit:
            extra.append(g)
    for di, d in enumerate(declared):
        miss = [q for qi, q in enumerate(d["positions"]) if (di, qi) not in matched_decl]
        if miss and recognized is not None:
            warnings.append(f"特征树中的孔（{d['kind']}，{len(miss)} 处）在实体几何中未识别到，仍按特征树标注")
    if extra:
        warnings.append(f"实体中有 {len(extra)} 处孔/槽未在特征树中声明，已按几何识别标注（几何识别）")
    return declared + extra, warnings


def view_mapper(kind: str, rect, bb, scale: float):
    """模型点 → 页面点（第一角：front 看 −Y 方向得 XZ；top 得 XY；left 的水平向为 −Y）。"""
    x0, y0 = rect[0], rect[1]
    if kind == "front" or kind == "section":
        return lambda x, y, z: (x0 + (x - bb[0]) * scale, y0 + (z - bb[2]) * scale)
    if kind == "top":
        return lambda x, y, z: (x0 + (x - bb[0]) * scale, y0 + (y - bb[1]) * scale)
    if kind == "left":
        return lambda x, y, z: (x0 + (bb[4] - y) * scale, y0 + (z - bb[2]) * scale)
    raise ValueError(kind)


def axis_prims(page_rects, bb, scale, groups, axes):
    """主/左视图中的孔轴线、各视图的回转体轴线与中心标记（细点画线，伸出轮廓 3 mm）。bb=(xmin,ymin,zmin,xmax,ymax,zmax)。"""
    prims = []
    ext = 3.0
    if "front" in page_rects:
        m = view_mapper("front", page_rects["front"], bb, scale)
        xs = []
        for g in groups:
            for (x, _y) in g["positions"]:
                if g["kind"] == "slot" and not g.get("angle"):
                    half = (g["length"] - g["width"]) / 2
                    xs.extend((x - half, x + half))
                else:
                    xs.append(x)
        xs = _unique(xs)
        for x in xs:
            (px, a), (_, b) = m(x, 0, bb[2]), m(x, 0, bb[5])
            prims.append(prim_line([(px, a - 2), (px, b + 2)], "center"))
    if "left" in page_rects:
        m = view_mapper("left", page_rects["left"], bb, scale)
        ys = _unique([p[1] for g in groups for p in g["positions"]])
        for y in ys:
            (px, a), (_, b) = m(0, y, bb[2]), m(0, y, bb[5])
            prims.append(prim_line([(px, a - 2), (px, b + 2)], "center"))
    for e in axes:
        for kind in ("front", "top", "left"):
            if kind not in page_rects:
                continue
            m = view_mapper(kind, page_rects[kind], bb, scale)
            if e["axis"] == "z":
                x, y = e["coords"]
                if kind == "top":
                    c = m(x, y, 0)
                    prims.extend(center_cross(c, e["r"] * scale + ext))
                else:
                    a, b = m(x, y, e["lo"]), m(x, y, e["hi"])
                    prims.append(prim_line([(a[0], a[1] - ext), (b[0], b[1] + ext)], "center"))
            elif e["axis"] == "x":
                y, z = e["coords"]
                if kind == "left":
                    prims.extend(center_cross(m(0, y, z), e["r"] * scale + ext))
                else:
                    a, b = m(e["lo"], y, z), m(e["hi"], y, z)
                    prims.append(prim_line([(a[0] - ext, a[1]), (b[0] + ext, b[1])], "center"))
            else:
                x, z = e["coords"]
                if kind == "front":
                    prims.extend(center_cross(m(x, 0, z), e["r"] * scale + ext))
                else:
                    a, b = m(x, e["lo"], z), m(x, e["hi"], z)
                    prims.append(prim_line([a, b], "center"))
    return prims


def section_prims(sec_rect, cut_bb, scale, slices, groups, y_cut, top_z):
    """剖视图 A-A：剖面线（45°，3 mm）、过孔中心的轴线、螺纹大径细实线与螺纹终止线、标签。"""
    x0, y0 = sec_rect[0], sec_rect[1]

    def M(x, z):
        return (x0 + (x - cut_bb[0]) * scale, y0 + (z - cut_bb[2]) * scale)

    polys = [[M(x, z) for x, z in poly] for poly in slices]
    prims = [prim_line(seg, "hatch") for seg in hatch_lines(polys, 3.0, 45.0)]
    for g in groups:
        for (x, y) in g["positions"]:
            if abs(y - y_cut) > HOLE_TOL or g["kind"] == "slot":
                continue
            a, b = M(x, cut_bb[2]), M(x, cut_bb[5])
            prims.append(prim_line([(a[0], a[1] - 2), (b[0], b[1] + 2)], "center"))
            major = _thread_major(g)
            if major:
                tdepth = g.get("threadDepth") or g.get("depth") or (top_z - cut_bb[2])
                for sx in (-1, 1):
                    p1, p2 = M(x + sx * major / 2, top_z), M(x + sx * major / 2, top_z - tdepth)
                    prims.append(prim_line([p1, p2], "thread"))
                q1, q2 = M(x - major / 2, top_z - tdepth), M(x + major / 2, top_z - tdepth)
                prims.append(prim_line([q1, q2], "thick"))
    prims.append(prim_text((sec_rect[0] + sec_rect[2]) / 2, sec_rect[3] + 2.5, "A-A", size=5.0))
    return prims


# ---------------------------------------------------------------------------
# FreeCAD 侧
# ---------------------------------------------------------------------------

def emit_event(payload: dict) -> None:
    try:
        sys.stdout.write(EVENT_PREFIX + json.dumps(payload, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    except Exception:  # noqa: BLE001
        pass


class Runtime:
    def __init__(self):
        if not os.environ.get("DISPLAY") and sys.platform.startswith("linux"):
            os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
        import FreeCAD  # noqa: F401
        import Part  # noqa: F401
        import TechDraw  # noqa: F401
        self.App = FreeCAD
        self.Part = Part
        self.TechDraw = TechDraw
        self.qt = None
        self.app = None
        try:
            from PySide import QtCore, QtGui  # FreeCAD 自带的 PySide 兼容层（Qt5/Qt6 皆可）
            self.qt = (QtCore, QtGui)
            inst = QtCore.QCoreApplication.instance()
            # TechDraw 的隐藏线计算在后台线程完成，需要 Qt 事件循环交付结果；
            # 用 QGuiApplication 以便后续 QSvgRenderer/QPdfWriter 渲染 PDF。
            self.app = inst or QtGui.QGuiApplication(["automationcad-freecad"])
        except Exception as exc:  # noqa: BLE001
            self.qt_error = str(exc)
        self.version = ".".join(str(x) for x in FreeCAD.Version()[:3])

    def process(self):
        if self.app is not None:
            self.app.processEvents()

    def wait_views(self, views, timeout_s: float) -> bool:
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            self.process()
            if all(len(v.getVisibleEdges()) > 0 for v in views):
                # 再让事件循环跑一下，确保隐藏线也已交付
                for _ in range(3):
                    self.process()
                    time.sleep(0.02)
                return True
            time.sleep(0.05)
        return False

    def pick_font(self) -> str:
        prefs = ["Microsoft YaHei", "SimSun", "SimHei", "Noto Sans CJK SC", "Noto Sans SC", "Source Han Sans SC",
                 "WenQuanYi Micro Hei", "PingFang SC", "Arial Unicode MS"]
        if not self.qt:
            return prefs[0]
        try:
            QtGui = self.qt[1]
            families = QtGui.QFontDatabase.families() if hasattr(QtGui.QFontDatabase, "families") else []
            if not families:
                families = QtGui.QFontDatabase().families()
            for name in prefs:
                if name in families:
                    return name
        except Exception:  # noqa: BLE001
            pass
        return prefs[0]

    def svg_to_pdf(self, svg: str, paper: str, path: str) -> str | None:
        """用 Qt 把 SVG 渲染成矢量 PDF；失败返回原因（主进程会用 Electron 兜底）。"""
        if not self.qt or self.app is None:
            return "Qt 不可用"
        try:
            QtCore, QtGui = self.qt
            from PySide import QtSvg
            p = PAPERS[paper]
            writer = QtGui.QPdfWriter(path)
            unit = getattr(QtGui.QPageSize, "Millimeter", None)
            if unit is None:
                unit = QtGui.QPageSize.Unit.Millimeter
            writer.setPageSize(QtGui.QPageSize(QtCore.QSizeF(p["w"], p["h"]), unit, paper))
            try:
                writer.setPageMargins(QtCore.QMarginsF(0, 0, 0, 0))
            except Exception:  # noqa: BLE001
                pass
            writer.setResolution(600)
            writer.setTitle(paper)
            renderer = QtSvg.QSvgRenderer(QtCore.QByteArray(svg.encode("utf-8")))
            if not renderer.isValid():
                return "SVG 解析失败"
            painter = QtGui.QPainter(writer)
            try:
                renderer.render(painter, QtCore.QRectF(0, 0, writer.width(), writer.height()))
            finally:
                painter.end()
            if not os.path.exists(path) or os.path.getsize(path) < 200:
                return "PDF 输出为空"
            return None
        except Exception as exc:  # noqa: BLE001
            return f"{type(exc).__name__}: {exc}"


def _polylines(edges, deflection: float = 0.05) -> list:
    out = []
    for edge in edges:
        try:
            pts = edge.discretize(Deflection=deflection)
        except Exception:  # noqa: BLE001
            try:
                pts = edge.discretize(24)
            except Exception:  # noqa: BLE001
                continue
        out.append([(round(p.x, 4), round(p.y, 4)) for p in pts])
    return out


def _bounds(polys):
    xs = [x for poly in polys for x, _ in poly]
    ys = [y for poly in polys for _, y in poly]
    if not xs:
        return (0.0, 0.0, 0.0, 0.0)
    return (min(xs), min(ys), max(xs), max(ys))


def run_part(rt: Runtime, job: dict, part: dict, index: int) -> dict:
    App, Part, TechDraw = rt.App, rt.Part, rt.TechDraw
    options = job.get("options") or {}
    formats = [f for f in (options.get("formats") or ["pdf", "dxf", "svg"]) if f in ("pdf", "dxf", "svg", "fcstd")]
    with_iso = options.get("iso", True) is not False
    hidden = options.get("hiddenLines", True) is not False
    hlr_timeout = float(options.get("hlrTimeoutSec") or 60)
    out_dir = job["outputDir"]
    stem = part["fileStem"]
    result = {"partId": part["partId"], "ok": False, "files": {}, "warnings": []}
    started = time.time()
    doc = App.newDocument(f"acad_{index}")
    try:
        shape = Part.Shape()
        shape.read(part["step"])
        if shape.isNull() or not shape.Solids and not shape.Faces:
            raise ValueError("STEP 中没有实体或面")
        try:
            bb = shape.optimalBoundingBox()
        except Exception:  # noqa: BLE001
            bb = shape.BoundBox
        size = (bb.XLength, bb.YLength, bb.ZLength)
        result["bbox"] = [round(v, 3) for v in size]
        result["solids"] = len(shape.Solids)
        obj = doc.addObject("Part::Feature", "Part")
        obj.Shape = shape
        obj.Label = str(part.get("name") or part["partId"])

        # ---- 孔语义：特征树优先，几何识别兜底/核对 ----
        bb6 = (bb.XMin, bb.YMin, bb.ZMin, bb.XMax, bb.YMax, bb.ZMax)
        declared, hole_warn = normalize_hole_specs(part.get("holes"))
        result["warnings"].extend(hole_warn)
        try:
            geo = recognize_geometry(App, Part, shape)
        except Exception as exc:  # noqa: BLE001
            geo = {"holes": [], "axes": [], "warnings": [f"圆柱面几何识别失败：{exc}"]}
        result["warnings"].extend(geo["warnings"])
        if declared is None:
            all_specs = geo["holes"]
            if all_specs:
                result["warnings"].append(f"作业未提供孔语义，{len(all_specs)} 处孔/槽按圆柱面几何识别标注（几何识别）")
        else:
            all_specs, rec_warn = reconcile_holes(declared, geo["holes"])
            result["warnings"].extend(rec_warn)
        groups = group_holes(all_specs) if all_specs else []
        sources = sorted({src for g in groups for src in g["sources"]})
        bbox2d = (bb.XMin, bb.YMin, bb.XMax, bb.YMax)
        pos_plan = plan_hole_positions(groups, bbox2d) if groups else None
        section_y = choose_section_line(groups) if groups else None
        hole_mode = "dims" if groups else "none"
        annot = annotation_needs(groups, pos_plan, "dims") if groups else {}
        if section_y is not None:
            annot["section"] = True
        paper_opt = part.get("paper") or options.get("paper") or "auto"
        scale_opt = part.get("scale") or options.get("scale")
        plan = choose_sheet(size, paper_opt, scale_opt, with_iso, annot)
        crowded = crowding_reason(groups, pos_plan, plan["scale"]) if groups else None
        if crowded:
            hole_mode = "table"
            annot = annotation_needs(groups, pos_plan, "table")
            if section_y is not None:
                annot["section"] = True
            plan = choose_sheet(size, paper_opt, scale_opt, with_iso, annot)
            result["warnings"].append(f"孔位标注过密（{crowded}），已改为孔位表")
            if "table" not in (plan.get("rects") or {}):
                result["warnings"].append("孔位表在图幅内放不下，已省略，请人工补充")
        paper, scale = plan["paper"], plan["scale"]
        plan["scaleLabel"] = scale_label(scale)
        result["warnings"].extend(plan.get("warnings") or [])
        result["paper"] = paper
        result["scale"] = plan["scaleLabel"]

        page = doc.addObject("TechDraw::DrawPage", "Page")
        tpl = doc.addObject("TechDraw::DrawSVGTemplate", "Template")
        tpl_path = os.path.join(App.getResourceDir(), "Mod", "TechDraw", "Templates", f"{paper}_Landscape_blank.svg")
        if os.path.exists(tpl_path):
            tpl.Template = tpl_path
        page.Template = tpl
        pg = doc.addObject("TechDraw::DrawProjGroup", "ProjGroup")
        page.addView(pg)
        pg.Source = [obj]
        pg.ProjectionType = "First Angle"
        # 关键顺序（FreeCAD 1.0 实测）：
        #  1) 比例要在 addProjection 之前设在投影组上；子视图保持 ScaleType=Page 由组统一缩放，
        #     事后改子视图 Scale 不会触发重新投影，会拿到旧比例的几何；
        #  2) HardHidden 等影响投影的属性要在第一次 recompute 之前设好，避免等到“旧”边线；
        #  3) 只有第一次 recompute 触发隐藏线计算，之后只改位置。
        pg.ScaleType = "Custom"
        pg.Scale = scale
        pg.AutoDistribute = False
        centers = plan.get("centers") or {}
        fc = centers.get("front", (PAPERS[paper]["w"] / 3, PAPERS[paper]["h"] * 2 / 3))
        pg.X, pg.Y = fc
        items = {}
        for name in ("Front", "Top", "Left"):
            item = pg.addProjection(name)
            if item is not None:
                item.HardHidden = hidden
                items[name] = item
        iso = None
        if plan.get("iso") and "iso" in centers:
            iso = doc.addObject("TechDraw::DrawViewPart", "Isometric")
            page.addView(iso)
            iso.Source = [obj]
            iso.Direction = App.Vector(*ISO_DIR)
            iso.XDirection = App.Vector(*ISO_XDIR)
            iso.ScaleType = "Custom"
            iso.Scale = plan["iso"]["scale"]
            iso.X, iso.Y = centers["iso"]
        sec_view, cut_shape = None, None
        if section_y is not None and "section" in centers:
            try:
                box = Part.makeBox(bb.XLength + 2, bb.YMax - section_y + 1, bb.ZLength + 2,
                                   App.Vector(bb.XMin - 1, section_y, bb.ZMin - 1))
                cut_shape = shape.common(box)
                sobj = doc.addObject("Part::Feature", "SectionSolidA")
                sobj.Shape = cut_shape
                sec_view = doc.addObject("TechDraw::DrawViewPart", "SectionA")
                page.addView(sec_view)
                sec_view.Source = [sobj]
                sec_view.Direction = App.Vector(0, -1, 0)
                sec_view.XDirection = App.Vector(1, 0, 0)
                sec_view.ScaleType = "Custom"
                sec_view.Scale = scale
                sec_view.X, sec_view.Y = centers["section"]
            except Exception as exc:  # noqa: BLE001
                sec_view = None
                result["warnings"].append(f"剖视图 A-A 生成失败：{exc}")
        elif section_y is not None:
            pass
        doc.recompute()
        items.update({v.Type: v for v in pg.Views})
        views = [items[t] for t in ("Front", "Top", "Left") if t in items] + ([iso] if iso else []) \
            + ([sec_view] if sec_view else [])
        if not rt.wait_views(views, hlr_timeout):
            raise TimeoutError(f"TechDraw 投影超时（{hlr_timeout:g} 秒）")
        for key, typ in (("top", "Top"), ("left", "Left")):
            if key in centers and typ in items:
                items[typ].X = centers[key][0] - fc[0]
                items[typ].Y = centers[key][1] - fc[1]
        doc.recompute()
        rt.process()
        for typ, view in items.items():
            got = float(view.getScale()) if hasattr(view, "getScale") else scale
            if abs(got - scale) > 1e-9:
                result["warnings"].append(f"{typ} 视图比例 {got:g} 与期望 {scale:g} 不一致")

        # 外形总尺寸：长（主视 X）、高（主视 Y）、宽（左视 X）——TechDraw 范围尺寸，进入 DXF/FCStd
        dim_objs = []
        try:
            dim_objs.append(TechDraw.makeExtentDim(items["Front"], [], 0))
            dim_objs.append(TechDraw.makeExtentDim(items["Front"], [], 1))
            dim_objs.append(TechDraw.makeExtentDim(items["Left"], [], 0))
            # 范围尺寸默认落在视图中心，挪到视图外侧（尺寸 X/Y 相对父视图中心，y 向上，页面毫米）
            L0, W0, H0 = size
            offsets = ((0.0, H0 * scale / 2 + 8), (-(L0 * scale / 2 + 8), 0.0), (0.0, H0 * scale / 2 + 8))
            for dim, (dx, dy) in zip(dim_objs, offsets):
                try:
                    dim.X, dim.Y = dx, dy
                except Exception:  # noqa: BLE001
                    pass
            doc.recompute()
            rt.process()
        except Exception as exc:  # noqa: BLE001
            result["warnings"].append(f"TechDraw 范围尺寸创建失败：{exc}")

        # 采样各视图几何，合成 SVG（视图局部坐标已按比例、y 向下）
        page_views = {}
        page_rects = {}
        for key, view in (("front", items.get("Front")), ("top", items.get("Top")), ("left", items.get("Left")),
                          ("iso", iso), ("section", sec_view)):
            if view is None:
                continue
            vis = _polylines(view.getVisibleEdges())
            hid = _polylines(view.getHiddenEdges()) if hidden and key not in ("iso", "section") else []
            pos = (centers[key][0], centers[key][1]) if key in centers else (float(view.X), float(view.Y))
            page_views[key] = {"visible": vis, "hidden": hid, "center": pos}
            bx0, by0, bx1, by1 = _bounds(vis)
            # 页面坐标（y 向上）：x = cx + px, y = cy - py
            page_rects[key] = (pos[0] + bx0, pos[1] - by1, pos[0] + bx1, pos[1] - by0)
        if "iso" in page_views:
            r = page_rects["iso"]
            page_views["iso"]["label"] = "轴测图" + ("" if abs(plan["iso"]["scale"] - scale) < 1e-12
                                                 else f" {scale_label(plan['iso']['scale'])}")
            page_views["iso"]["labelAt"] = ((r[0] + r[2]) / 2, r[3] + 4)
        L, W, H = size
        dims = []
        if "front" in page_rects:
            f = page_rects["front"]
            dims.append({"orient": "h", "p1": (f[0], f[3]), "p2": (f[2], f[3]), "at": f[3] + 8, "text": format_mm(L)})
            dims.append({"orient": "v", "p1": (f[0], f[1]), "p2": (f[0], f[3]), "at": f[0] - 8, "text": format_mm(H)})
        if "left" in page_rects:
            lr = page_rects["left"]
            dims.append({"orient": "h", "p1": (lr[0], lr[3]), "p2": (lr[2], lr[3]), "at": lr[3] + 8, "text": format_mm(W)})
        result["dimensions"] = {"length": round(L, 3), "width": round(W, 3), "height": round(H, 3)}

        # ---- 孔标注 / 孔位尺寸 / 中心线 / 剖视 图元（SVG、PDF、DXF 共用） ----
        prims = []
        hole_info = {"callouts": [], "mode": hole_mode}
        try:
            if groups and "top" in page_rects:
                hp, hole_info = layout_hole_annotations(groups, pos_plan, page_rects["top"], bbox2d, scale, hole_mode)
                prims.extend(hp)
                if hole_mode == "table" and "table" in (plan.get("rects") or {}):
                    t = plan["rects"]["table"]
                    prims.extend(hole_table_prims(groups, bbox2d, (t[0], t[1])))
            prims.extend(axis_prims(page_rects, bb6, scale, groups, geo["axes"]))
            if sec_view is not None and "section" in page_rects and cut_shape is not None:
                slices = []
                for wire in shape.slice(App.Vector(0, 1, 0), float(section_y)):
                    try:
                        pts = wire.discretize(Deflection=0.02)
                    except Exception:  # noqa: BLE001
                        pts = wire.discretize(64)
                    slices.append([(q.x, q.z) for q in pts])
                cbb = cut_shape.BoundBox
                prims.extend(section_prims(page_rects["section"], (cbb.XMin, cbb.YMin, cbb.ZMin, cbb.XMax, cbb.YMax, cbb.ZMax),
                                           scale, slices, groups, section_y, bb.ZMax))
                ty = page_rects["top"][1] + (section_y - bb.YMin) * scale
                prims.extend(cut_line_prims(page_rects["top"], ty, "A"))
        except Exception as exc:  # noqa: BLE001
            result["warnings"].append(f"孔标注生成失败（已出外形尺寸图）：{type(exc).__name__}: {exc}")
        result["holes"] = {"source": ("mixed" if len(sources) > 1 else sources[0]) if sources else "none",
                           "callouts": hole_info.get("callouts", []), "mode": hole_mode}
        if sec_view is not None and "section" in page_rects:
            result["holes"]["section"] = "A-A"

        meta = {
            "name": part.get("name") or part["partId"],
            "drawingNo": part.get("drawingNo") or "",
            "material": part.get("material") or "",
            "quantity": part.get("quantity") or 1,
            "designer": (job.get("titleBlock") or {}).get("designer") or "",
            "date": (job.get("titleBlock") or {}).get("date") or time.strftime("%Y-%m-%d"),
            "company": (job.get("titleBlock") or {}).get("company") or "",
        }
        # TechDraw 模板可编辑字段（仅对内置模板有效，失败不影响出图）
        try:
            texts = dict(tpl.EditableTexts)
            for k, v in (("DrawingNumber", meta["drawingNo"]), ("FC-Title", meta["name"]), ("FC-Scale", plan["scaleLabel"]),
                         ("AuthorName", meta["designer"]), ("CreationDate", meta["date"])):
                if k in texts:
                    texts[k] = str(v)
            tpl.EditableTexts = texts
        except Exception:  # noqa: BLE001
            pass

        font = rt.pick_font()
        svg = compose_svg(paper, plan, page_views, dims, meta, font, prims)
        files = {}
        svg_path = os.path.join(out_dir, f"{stem}.svg")
        with open(svg_path, "w", encoding="utf-8") as fh:
            fh.write(svg)
        if "svg" in formats or "pdf" in formats:
            files["svg"] = os.path.basename(svg_path)
        if "dxf" in formats:
            dxf_path = os.path.join(out_dir, f"{stem}.dxf")
            TechDraw.writeDXFPage(page, dxf_path)
            try:
                with open(dxf_path, "r", encoding="utf-8", errors="replace") as fh:
                    raw = fh.read()
                lines, texts = frame_and_title_dxf(paper, plan, meta)
                hid_page, vis_page = [], []
                for key, pv in page_views.items():
                    cx0, cy0 = pv["center"]
                    vis_page += [[(cx0 + x, cy0 - y) for x, y in poly] for poly in pv["visible"]]
                    hid_page += [[(cx0 + x, cy0 - y) for x, y in poly] for poly in pv.get("hidden") or []]
                with open(dxf_path, "w", encoding="utf-8") as fh:
                    fh.write(dxf_postprocess(raw, prims, lines, texts, make_hidden_classifier(hid_page, vis_page)))
            except Exception as exc:  # noqa: BLE001
                result["warnings"].append(f"DXF 图框/标题栏追加失败（视图与尺寸已导出）：{exc}")
            files["dxf"] = os.path.basename(dxf_path)
        if "pdf" in formats:
            pdf_path = os.path.join(out_dir, f"{stem}.pdf")
            err = rt.svg_to_pdf(svg, paper, pdf_path)
            if err:
                result["warnings"].append(f"FreeCAD 侧 PDF 渲染失败：{err}；将由主进程用 SVG 兜底生成")
                result["pdfFallback"] = True
            else:
                files["pdf"] = os.path.basename(pdf_path)
        if "fcstd" in formats:
            add_cosmetic_centerlines(App, items, groups, geo["axes"], bb6)
            fc_path = os.path.join(out_dir, f"{stem}.FCStd")
            doc.saveAs(fc_path)
            files["fcstd"] = os.path.basename(fc_path)
        result["files"] = files
        result["views"] = sorted(page_views.keys())
        result["ok"] = True
    except Exception as exc:  # noqa: BLE001
        result["error"] = f"{type(exc).__name__}: {exc}"
        result["trace"] = traceback.format_exc(limit=3)
    finally:
        result["elapsedMs"] = round((time.time() - started) * 1000)
        try:
            App.closeDocument(doc.Name)
        except Exception:  # noqa: BLE001
            pass
    return result


def add_cosmetic_centerlines(App, items, groups, axes, bb6) -> None:
    """FCStd 里补 TechDraw 原生中心线（CosmeticEdge，点画线）与圆心标记；DXF 已写出之后才加，避免重复图元。"""
    top, front = items.get("Top"), items.get("Front")
    for view in (top, front, items.get("Left")):
        for prop in ("ArcCenterMarks",):
            try:
                setattr(view, prop, True)
            except Exception:  # noqa: BLE001
                pass
    try:
        for g in groups:
            for (x, y) in g["positions"]:
                if g["kind"] == "slot":
                    continue
                r = max(g.get("cbDiameter") or 0, g.get("diameter") or 0) / 2 + 2
                z = bb6[5]
                if top is not None:
                    top.makeCosmeticLine3D(App.Vector(x - r, y, z), App.Vector(x + r, y, z), 4)
                    top.makeCosmeticLine3D(App.Vector(x, y - r, z), App.Vector(x, y + r, z), 4)
                if front is not None:
                    front.makeCosmeticLine3D(App.Vector(x, y, bb6[2] - 2), App.Vector(x, y, bb6[5] + 2), 4)
        for e in axes:
            if e["axis"] == "z" and front is not None:
                x, y = e["coords"]
                front.makeCosmeticLine3D(App.Vector(x, y, e["lo"] - 3), App.Vector(x, y, e["hi"] + 3), 4)
    except Exception:  # noqa: BLE001
        pass


def write_result(out_dir: str, payload: dict) -> None:
    path = os.path.join(out_dir, "result.json")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def job_path_from_env() -> str | None:
    path = os.environ.get("AUTOMATIONCAD_FREECAD_JOB")
    if path:
        return path
    argv = list(sys.argv)
    if "--pass" in argv:
        i = argv.index("--pass")
        if i + 1 < len(argv):
            return argv[i + 1]
    return None


def main() -> int:
    started = time.time()
    path = job_path_from_env()
    if not path:
        sys.stderr.write("缺少作业文件：请设置 AUTOMATIONCAD_FREECAD_JOB\n")
        return 2
    with open(path, "r", encoding="utf-8") as fh:
        job = json.load(fh)
    out_dir = job.get("outputDir") if isinstance(job, dict) else None
    errors = validate_job(job)
    base = {"protocol": RESULT_PROTOCOL, "jobId": job.get("jobId") if isinstance(job, dict) else None,
            "scriptVersion": SCRIPT_VERSION}
    if errors:
        payload = {**base, "ok": False, "error": "；".join(errors), "parts": []}
        if out_dir and os.path.isdir(out_dir):
            write_result(out_dir, payload)
        sys.stderr.write(payload["error"] + "\n")
        return 3
    os.makedirs(out_dir, exist_ok=True)
    try:
        rt = Runtime()
    except Exception as exc:  # noqa: BLE001
        payload = {**base, "ok": False, "error": f"FreeCAD 模块加载失败：{exc}", "parts": []}
        write_result(out_dir, payload)
        return 4
    parts = job["parts"]
    results = []
    for index, part in enumerate(parts):
        emit_event({"event": "part-start", "index": index, "total": len(parts), "partId": part["partId"]})
        res = run_part(rt, job, part, index)
        results.append(res)
        emit_event({"event": "part-done", "index": index, "total": len(parts), "partId": part["partId"],
                    "ok": res.get("ok", False)})
    payload = {**base, "ok": all(r.get("ok") for r in results), "freecadVersion": rt.version,
               "parts": results, "elapsedMs": round((time.time() - started) * 1000)}
    write_result(out_dir, payload)
    emit_event({"event": "done", "ok": payload["ok"]})
    return 0


def _adapter_specs():
    """自检样例：转接板 200×120（4×Ø6.6 沉孔、2×Ø8 通孔、腰形槽 60×12）。"""
    raw = [
        {"kind": "counterbore", "featureId": "f2", "positions": [[-85, -45], [85, -45], [-85, 45], [85, 45]],
         "diameter": 6.6, "through": True, "cbDiameter": 11, "cbDepth": 6.5},
        {"kind": "hole", "featureId": "f3", "positions": [[-40, 0], [40, 0]], "diameter": 8, "through": True},
        {"kind": "slot", "featureId": "f4", "positions": [[0, 0]], "through": True, "length": 60, "width": 12},
    ]
    specs, warn = normalize_hole_specs(raw)
    assert warn == [], warn
    return specs


def _flange_specs():
    """自检样例：法兰 Ø130（Ø40 中心通孔、6×Ø9 节圆 Ø90 均布、2×M6 底孔 Ø5 深 12 螺纹深 10）。"""
    pcd = [[round(45 * math.cos(math.radians(a)), 6), round(45 * math.sin(math.radians(a)), 6)] for a in range(0, 360, 60)]
    raw = [
        {"kind": "hole", "featureId": "c", "positions": [[0, 0]], "diameter": 40, "through": True},
        {"kind": "hole", "featureId": "p", "positions": pcd, "diameter": 9, "through": True},
        {"kind": "hole", "featureId": "t", "positions": [[0, 30], [0, -30]], "diameter": 5, "through": False,
         "depth": 12, "thread": "M6", "threadDepth": 10},
    ]
    specs, warn = normalize_hole_specs(raw)
    assert warn == [], warn
    return specs


def _self_test_holes() -> None:
    # 清洗：非法条目丢弃并给出警告；None = 未提供
    assert normalize_hole_specs(None) == (None, [])
    bad, warn = normalize_hole_specs([{"kind": "x"}, {"kind": "hole", "positions": []},
                                      {"kind": "hole", "positions": [[0, 0]], "through": False, "diameter": 5},
                                      {"kind": "hole", "positions": [[0, 0]], "diameter": 5, "thread": "6"}])
    assert len(bad) == 2 and len(warn) == 3, (bad, warn)
    assert bad[0]["through"] is True and "thread" not in bad[1], bad

    # 分组：跨特征同规格合并、去重孔位，字母顺序、阵列识别
    a = _adapter_specs()
    dup = a + [{**a[1], "featureId": "f9", "positions": [(40.0, 0.0), (0.0, 30.0)]}]
    g = group_holes(dup)
    assert [x["kind"] for x in g] == ["counterbore", "hole", "slot"], g
    assert len(g[1]["positions"]) == 3 and g[1]["featureIds"] == ["f3", "f9"], g[1]
    assert [x["letter"] for x in g] == ["A", "B", "C"]
    assert g[0]["pattern"]["type"] == "grid"
    f = group_holes(_flange_specs())
    assert f[1]["pattern"]["type"] == "circular" and f[1]["pattern"]["count"] == 6 and abs(f[1]["pattern"]["radius"] - 45) < 1e-3

    # 文字标注：沉孔/深度用中文文字（常见中文字体无 ⌴ ↧ 字形），Ø × 保留
    ga = group_holes(a)
    assert [x["callout"] for x in ga] == ["4×Ø6.6 沉孔Ø11深6.5", "2×Ø8 通孔", "腰形槽 60×12 通"], [x["callout"] for x in ga]
    assert [x["callout"] for x in f] == ["Ø40 通孔", "6×Ø9 通孔 均布", "2×M6-6H深10 孔深12"], [x["callout"] for x in f]
    for x in ga + f:
        assert "\u2334" not in x["callout"] and "\u21a7" not in x["callout"], x["callout"]
    blind = group_holes(normalize_hole_specs([
        {"kind": "hole", "positions": [[0, 0]], "diameter": 5, "through": False, "depth": 8},
        {"kind": "hole", "positions": [[10, 0]], "diameter": 5, "through": False, "depth": 8, "thread": "M6", "threadDepth": 8},
        {"kind": "counterbore", "positions": [[20, 0]], "diameter": 6.6, "through": False, "depth": 12, "cbDiameter": 11, "cbDepth": 6.5},
        {"kind": "hole", "positions": [[30, 0]], "diameter": 8.5, "through": True, "thread": "M10"},
    ])[0])
    assert [x["callout"] for x in blind] == ["Ø5深8", "M6-6H深8", "Ø6.6深12 沉孔Ø11深6.5", "M10-6H 通孔"], [x["callout"] for x in blind]
    assert single_callout(ga[0]) == "Ø6.6 沉孔Ø11深6.5"

    # 孔位尺寸方案：对称（孔距）/ 基准坐标（左下为 0）；圆周阵列只标节圆
    bbox = (-100.0, -60.0, 100.0, 60.0)
    pa = plan_hole_positions(ga, bbox)
    assert pa["x"]["mode"] == "sym" and [d["text"] for d in pa["x"]["dims"]] == ["80", "170"], pa["x"]
    assert pa["y"]["mode"] == "sym" and [d["text"] for d in pa["y"]["dims"]] == ["90"], pa["y"]
    asym = group_holes(normalize_hole_specs([{"kind": "hole", "positions": [[-80, 10], [30, 10], [50, -40]], "diameter": 6}])[0])
    po = plan_hole_positions(asym, bbox)
    assert po["x"]["mode"] == "ord" and [d["text"] for d in po["x"]["dims"]] == ["0", "20", "130", "150"], po["x"]
    assert po["y"]["mode"] == "ord" and [d["text"] for d in po["y"]["dims"]] == ["0", "20", "70"], po["y"]
    pf = plan_hole_positions(f, (-65.0, -65.0, 65.0, 65.0))
    assert pf["circles"] and pf["circles"][0]["text"] == "节圆Ø90", pf["circles"]
    assert [d["text"] for d in pf["y"]["dims"]] == ["60"] and pf["x"]["dims"] == [], pf

    # 一维避让：保序、间距、总位移最小
    got = spread([0.0, 1.0, 2.0, 20.0], 5.0)
    assert all(got[i + 1] - got[i] >= 5.0 - 1e-9 for i in range(3)) and abs(got[1] - 1.0) < 1e-9, got

    # 过密退化孔位表
    assert crowding_reason(ga, pa, 1.0) is None
    many = group_holes(normalize_hole_specs([{"kind": "hole", "positions": [[i * 1.0 - 50, 0]], "diameter": 1 + i * 0.1}
                                             for i in range(9)])[0])
    assert "超过" in (crowding_reason(many, plan_hole_positions(many, bbox), 1.0) or ""), "9 种规格应退孔位表"
    dense = group_holes(normalize_hole_specs([{"kind": "hole", "positions": [[-99 + i * 1.3, -59 + i * 0.7] for i in range(8)], "diameter": 1}])[0])
    assert crowding_reason(dense, plan_hole_positions(dense, bbox), 0.5), "孔心坐标过密应退孔位表"
    tbl = hole_table_prims(ga, bbox, (0.0, 0.0))
    texts = [p["text"] for p in tbl if p["t"] == "text"]
    assert "A1" in texts and "C1" in texts and "Ø6.6 沉孔Ø11深6.5" in texts, texts

    # 剖切线：过沉孔/盲孔孔心；全通孔不剖
    assert choose_section_line(ga) in (-45.0, 45.0)
    assert choose_section_line(f) in (30.0, -30.0)
    assert choose_section_line(group_holes(normalize_hole_specs([{"kind": "hole", "positions": [[0, 0]], "diameter": 5}])[0])) is None

    # DXF 分层：孔标注图元按 cls 进 DIM/CENTER/THREAD/NOTES 图层，图层表补齐
    rect = (50.0, 50.0, 250.0, 170.0)
    prims, info = layout_hole_annotations(f, pf, (100.0, 100.0, 230.0, 230.0), (-65.0, -65.0, 65.0, 65.0), 1.0)
    dxf = "\n".join([
        "  0", "SECTION", "  2", "HEADER", "  9", "$HANDSEED", "  5", "100", "  0", "ENDSEC",
        "  0", "SECTION", "  2", "TABLES", "  0", "TABLE", "  2", "LAYER", "  5", "2", "  0", "ENDTAB",
        "  0", "TABLE", "  2", "LTYPE", "  5", "5", "  0", "ENDTAB",
        "  0", "TABLE", "  2", "BLOCK_RECORD", "  0", "BLOCK_RECORD", "  5", "1F", "  2", "*Model_Space", "  0", "ENDTAB", "  0", "ENDSEC",
        "  0", "SECTION", "  2", "ENTITIES", "  0", "LINE", "  5", "A6", "  8", "Visible", "  10", "0", "  20", "0", "  11", "5", "  21", "0",
        "  0", "ENDSEC", "  0", "EOF", ""])
    out = dxf_postprocess(dxf, prims + cut_line_prims(rect, 60.0))
    pairs = _dxf_pairs(out)
    layers = {v.strip() for c, v in pairs if c == "8"}
    assert {"DIM", "CENTER", "THREAD", "OUTLINE"} <= layers, layers
    table_names = {next(v2.strip() for c2, v2 in pairs[i + 1:i + 10] if c2 == "2")
                   for i, (c, v) in enumerate(pairs) if c == "0" and v.strip() == "LAYER"}
    assert {n for n, _, _ in DXF_LAYERS} <= table_names, table_names
    assert any(c == "1" and "M6-6H" in v for c, v in pairs), "螺纹标注应写进 DXF TEXT"
    assert any(c == "6" and v.strip() == "CENTER" for c, v in pairs), "CENTER 图层应用点画线线型"
    assert info["callouts"] == ["Ø40 通孔", "6×Ø9 通孔 均布", "2×M6-6H深10 孔深12", "节圆Ø90"], info


def self_test() -> int:
    """纯逻辑自检：比例/图幅/布局/DXF 句柄追加。供 node --test 在有 python3 时调用。"""
    assert parse_scale("1:2") == 0.5 and parse_scale("2:1") == 2.0 and parse_scale("auto") is None
    assert scale_label(0.5) == "1:2" and scale_label(1.0) == "1:1"
    small = choose_sheet((60, 40, 10))
    assert small["paper"] == "A4" and small["scale"] >= 1.0, small
    plate = choose_sheet((200, 120, 15))
    assert plate["paper"] in ("A4", "A3") and plate["scale"] in (1.0, 0.5), plate
    big = choose_sheet((1200, 600, 400))
    assert big["scale"] < 0.5, big
    for plan in (small, plate, big):
        rects = plan["rects"]
        names = list(rects)
        for i, a in enumerate(names):
            assert not _overlap(rects[a], plan["title"]), (a, plan)
            for b in names[i + 1:]:
                assert not _overlap(rects[a], rects[b]), (a, b)
    fixed = choose_sheet((200, 120, 15), "A3", "1:5")
    assert fixed["paper"] == "A3" and fixed["scale"] == 0.2
    try:
        choose_sheet((1, 1, 1), "A0")
        raise AssertionError("A0 应被拒绝")
    except ValueError:
        pass
    assert format_mm(200.0) == "200" and format_mm(12.345) == "12.35" and format_mm(7.5) == "7.5"
    assert safe_file_stem("P-001/转接板") == "P-001"
    dxf = "\n".join([
        "  0", "SECTION", "  2", "HEADER", "  9", "$HANDSEED", "  5", "FFFF", "  0", "ENDSEC",
        "  0", "SECTION", "  2", "TABLES", "  0", "TABLE", "  2", "BLOCK_RECORD",
        "  0", "BLOCK_RECORD", "  5", "1F", "  2", "*Model_Space", "  0", "ENDTAB", "  0", "ENDSEC",
        "  0", "SECTION", "  2", "ENTITIES", "  0", "LINE", "  5", "A6A", "  8", "0", "  0", "ENDSEC",
        "  0", "EOF", ""])
    out = dxf_append_entities(dxf, [(0, 0, 10, 0)], [(1, 1, "图号A", 3.5)])
    assert "\\U+56FE\\U+53F7A" in out, out
    assert out.index("TEXT") < out.rindex("ENDSEC") and "A6B" in out and "\n1F\n" in out
    assert validate_job({"protocol": PROTOCOL, "kind": "techdraw", "outputDir": "/x",
                         "parts": [{"partId": "a", "step": "/a.step", "fileStem": "a"}]}) == []
    assert validate_job({"protocol": "x", "kind": "techdraw", "outputDir": "/x", "parts": []})
    svg = compose_svg("A3", {**plate, "scaleLabel": "1:1"}, {}, [], {"name": "转接板"}, "Noto Sans CJK SC")
    assert svg.startswith("<svg") and "转接板" in svg and "420mm" in svg
    _self_test_holes()
    sys.stdout.write("SELF_TEST_OK\n")
    return 0


if __name__ == "__main__" or os.environ.get("AUTOMATIONCAD_FREECAD_JOB"):
    # freecadcmd 执行脚本时 __name__ 不一定是 "__main__"，以环境变量为准
    if "--self-test" in sys.argv:
        _code = self_test()
    else:
        try:
            _code = main()
        except Exception as _exc:  # noqa: BLE001
            sys.stderr.write(f"作业异常：{_exc}\n{traceback.format_exc()}")
            _code = 1
    if __name__ == "__main__" and "FreeCAD" not in sys.modules:
        sys.exit(_code)
