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
SCRIPT_VERSION = "1.0.0"
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


def plan_layout(size, paper: str, scale: float, with_iso: bool = True):
    """
    第一角投影（GB）：主视图左上，左视图在主视图右侧，俯视图在主视图下方；标题栏右下。
    坐标为页面毫米，原点左下（与 TechDraw 页面一致）。返回各视图中心与占位矩形；放不下返回 None。
    """
    L, W, H = (max(float(v), 1e-6) for v in size)
    area = drawing_area(paper)
    title = (area["x1"] - TITLE_W, area["y0"], area["x1"], area["y0"] + TITLE_H)
    fw, fh = L * scale, H * scale        # 主视图（XZ）
    lw, lh = W * scale, H * scale        # 左视图（YZ）
    tw, th = L * scale, W * scale        # 俯视图（XY）
    # 主视图左上角从绘图区左上角留出 GAP（上方放长度尺寸，左方放高度尺寸）
    fx0 = area["x0"] + GAP
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
                if any(_overlap(grown, other) for other in rects.values()):
                    continue
                iso = r
                iso_scale = s
                break
            if iso:
                break
    centers = {k: ((r[0] + r[2]) / 2, (r[1] + r[3]) / 2) for k, r in rects.items()}
    out = {"paper": paper, "scale": scale, "rects": dict(rects), "centers": centers, "title": title,
           "iso": None}
    if iso:
        out["rects"]["iso"] = iso
        out["centers"]["iso"] = ((iso[0] + iso[2]) / 2, (iso[1] + iso[3]) / 2)
        out["iso"] = {"scale": iso_scale}
    return out


def choose_sheet(size, paper_opt: str = "auto", scale_opt=None, with_iso: bool = True):
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
            plan = plan_layout(size, p, s, with_iso)
            if plan:
                best[p] = plan
                break
    warnings = []
    if not best:
        # 实在放不下：最大图幅 + 最小比例，给出警告但仍出图
        p = papers[-1]
        s = fixed or SCALES[-1][0]
        plan = plan_layout(size, p, s, False) or {
            "paper": p, "scale": s, "rects": {}, "centers": {}, "title": None, "iso": None
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


def compose_svg(paper: str, plan: dict, views: dict, dims: list, meta: dict, font_family: str) -> str:
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

        plan = choose_sheet(size, part.get("paper") or options.get("paper") or "auto",
                            part.get("scale") or options.get("scale"), with_iso)
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
        doc.recompute()
        items.update({v.Type: v for v in pg.Views})
        views = [items[t] for t in ("Front", "Top", "Left") if t in items] + ([iso] if iso else [])
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
                          ("iso", iso)):
            if view is None:
                continue
            vis = _polylines(view.getVisibleEdges())
            hid = _polylines(view.getHiddenEdges()) if hidden and key != "iso" else []
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
        svg = compose_svg(paper, plan, page_views, dims, meta, font)
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
                with open(dxf_path, "w", encoding="utf-8") as fh:
                    fh.write(dxf_append_entities(raw, lines, texts))
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
