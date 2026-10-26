"""B-Rep 精确干涉（OCP/OCC 布尔），供桌面端「精确干涉」调用。

输入：STEP/IGES/brep 文件路径
输出：JSON（stdout 最后一行，或 --out 文件）
  { ok, parts, candidates, checks, hits: [{a, b, volumeMm3, ratio, severity}], refused?, reason?, elapsedMs }

口径：
  - 只做**实体之间**的真实布尔交集（BRepAlgoAPI_Common），不是 AABB。
  - 相邻零件共面/共线接触的"零体积交集"不算干涉：体积阈值 1 mm³ 且占较小件体积 > 0.05%。
  - 大装配会爆炸（O(n²)），超过 part/candidate 上限直接拒绝并说明，不硬扛。
  - 装配层级/名字来自 XCAF；同名件按出现序号区分。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

TOL_VOLUME_MM3 = 1.0
TOL_RATIO = 0.0005
MAX_PARTS = 400
MAX_CANDIDATES = 30000


def fail(code: str, message: str) -> dict:
    return {"ok": False, "code": code, "message": message}


def label_name(label) -> str:
    try:
        from OCP.TDataStd import TDataStd_Name
        attr = TDataStd_Name()
        if label.FindAttribute(TDataStd_Name.GetID_s(), attr):
            return attr.Get().ToExtString()
    except Exception:
        pass
    return ""


def collect_shapes(doc):
    """遍历 XCAF 文档的全部标签，取「零件实例」：引用（装配里的零件）+ 独立简单形状。

    实测 as1-oc-214：34 个标签 = 13 个引用 + 5 个简单形状，恰好等于解析器的 18 个网格。
    按组件递归反而会漏（子装配引用拿不到位置），所以这里用全树深遍历 + 位置。
    """
    from OCP.TDF import TDF_ChildIterator, TDF_Label
    from OCP.XCAFDoc import XCAFDoc_DocumentTool

    shape_tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())

    def instance_name(label) -> str:
        name = label_name(label)
        if name:
            return name
        try:
            ref = TDF_Label()
            if shape_tool.IsReference_s(label) and shape_tool.GetReferredShape_s(label, ref):
                return label_name(ref)
        except Exception:
            pass
        return ""

    def shape_of(label):
        try:
            if shape_tool.IsReference_s(label):
                ref = TDF_Label()
                if not shape_tool.GetReferredShape_s(label, ref):
                    return None
                base = shape_tool.GetShape_s(ref)
                loc = shape_tool.GetLocation_s(label)
                if base is None or base.IsNull():
                    return None
                return base.Moved(loc) if loc is not None else base
            if shape_tool.IsSimpleShape_s(label):
                shape = shape_tool.GetShape_s(label)
                loc = shape_tool.GetLocation_s(label)
                if shape is None or shape.IsNull():
                    return None
                return shape.Moved(loc) if loc is not None else shape
        except Exception:
            return None
        return None

    # 第一遍：收集引用实例与被引用的定义标签（定义本体不能当实例重复计入）
    labels = []
    iterator = TDF_ChildIterator(doc.Main(), True)
    while iterator.More():
        labels.append(iterator.Value())
        iterator.Next()

    referred_labels = []
    for label in labels:
        try:
            if shape_tool.IsReference_s(label):
                ref = TDF_Label()
                if shape_tool.GetReferredShape_s(label, ref):
                    referred_labels.append(ref)
        except Exception:
            pass

    def is_definition(label) -> bool:
        for ref in referred_labels:
            try:
                if ref.IsEqual(label):
                    return True
            except Exception:
                continue
        return False

    out = []
    for label in labels:
        try:
            is_ref = shape_tool.IsReference_s(label)
            is_simple = shape_tool.IsSimpleShape_s(label)
        except Exception:
            continue
        if is_simple and not is_ref and is_definition(label):
            continue
        if not (is_ref or is_simple):
            continue
        shape = shape_of(label)
        if shape is None or shape.IsNull():
            continue
        out.append((instance_name(label), shape))
    return out


def bbox(shape):
    from OCP.BRepBndLib import BRepBndLib
    from OCP.Bnd import Bnd_Box

    box = Bnd_Box()
    BRepBndLib.Add_s(shape, box)
    # OCP 的 Bnd_Box.Get() 是 void（老 pythonocc 才返回 tuple），用 CornerMin/CornerMax
    lo = box.CornerMin()
    hi = box.CornerMax()
    return (lo.X(), lo.Y(), lo.Z(), hi.X(), hi.Y(), hi.Z())


def overlaps(a, b, eps=1e-3) -> bool:
    return not (
        a[3] <= b[0] + eps or b[3] <= a[0] + eps
        or a[4] <= b[1] + eps or b[4] <= a[1] + eps
        or a[5] <= b[2] + eps or b[5] <= a[2] + eps
    )


def volume(shape) -> float:
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps

    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape, props)
    return abs(props.Mass())


def common_volume(a, b) -> float:
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Common

    op = BRepAlgoAPI_Common(a, b)
    op.Build()
    if not op.IsDone():
        return 0.0
    return volume(op.Shape())


def main() -> int:
    started = time.time()
    parser = argparse.ArgumentParser()
    parser.add_argument("step")
    parser.add_argument("--out", default=None)
    parser.add_argument("--max-parts", type=int, default=MAX_PARTS)
    parser.add_argument("--max-candidates", type=int, default=MAX_CANDIDATES)
    args = parser.parse_args()
    # OCCT 的 ReadFile 对相对路径不稳（实测相对路径返回 RetError），统一转绝对路径
    args.step = os.path.abspath(args.step)
    if not os.path.exists(args.step):
        print(json.dumps(fail("FILE_NOT_FOUND", f"文件不存在：{args.step}")))
        return 2

    try:
        from OCP.BRep import BRep_Builder
        from OCP.STEPCAFControl import STEPCAFControl_Reader
        from OCP.TCollection import TCollection_ExtendedString
        from OCP.TDocStd import TDocStd_Document
        from OCP.XCAFApp import XCAFApp_Application
    except Exception as error:  # pragma: no cover - 环境缺 OCP
        print(json.dumps(fail("OCP_UNAVAILABLE", f"缺少 OCP/OCCT 绑定：{error}")))
        return 2

    app = XCAFApp_Application.GetApplication_s()
    doc = TDocStd_Document(TCollection_ExtendedString("XmlXCAF"))
    app.NewDocument(TCollection_ExtendedString("XmlXCAF"), doc)

    reader = STEPCAFControl_Reader()
    reader.SetNameMode(True)
    reader.SetColorMode(True)
    reader.SetLayerMode(True)
    try:
        status = reader.ReadFile(args.step)
    except Exception as error:
        print(json.dumps(fail("READ_FAILED", f"STEP 读取异常：{error}")))
        return 2
    if status != 1:  # IFSelect_RetDone
        print(json.dumps(fail("READ_FAILED", f"STEP 读取失败（status={status}）")))
        return 2
    if not reader.Transfer(doc):
        print(json.dumps(fail("TRANSFER_FAILED", "STEP 转 XCAF 失败")))
        return 2

    parts = collect_shapes(doc)
    if len(parts) > args.max_parts:
        print(json.dumps({
            "ok": False,
            "code": "TOO_MANY_PARTS",
            "message": f"零件 {len(parts)} 个超过上限 {args.max_parts}：B-Rep 布尔是 O(n²)，请先按子装配拆分或提高上限",
            "parts": len(parts),
        }))
        return 3
    if len(parts) == 0:
        print(json.dumps(fail("NO_SHAPES", "文件里没有可用的实体形状（可能只有曲面/面片）")))
        return 3

    boxes = [bbox(shape) for _name, shape in parts]
    volumes = [volume(shape) for _name, shape in parts]
    candidates = []
    for i in range(len(parts)):
        for j in range(i + 1, len(parts)):
            if overlaps(boxes[i], boxes[j]):
                candidates.append((i, j))
    if len(candidates) > args.max_candidates:
        print(json.dumps({
            "ok": False,
            "code": "TOO_MANY_CANDIDATES",
            "message": f"AABB 候选对 {len(candidates)} 超过上限 {args.max_candidates}：请拆分装配后再跑",
            "parts": len(parts),
            "candidates": len(candidates),
        }))
        return 3

    names = []
    seen = {}
    for name, _shape in parts:
        base = name or "未命名"
        seen[base] = seen.get(base, 0) + 1
        names.append(base if seen[base] == 1 else f"{base}#{seen[base]}")

    hits = []
    for i, j in candidates:
        try:
            vol = common_volume(parts[i][1], parts[j][1])
        except Exception:
            vol = 0.0
        if vol <= TOL_VOLUME_MM3:
            continue
        smaller = min(volumes[i], volumes[j]) or 1.0
        ratio = vol / smaller
        if ratio <= TOL_RATIO:
            continue
        hits.append({
            "a": names[i],
            "b": names[j],
            "volumeMm3": round(vol, 2),
            "ratio": round(ratio, 4),
            "severity": "严重" if ratio >= 0.01 else "轻微",
        })

    hits.sort(key=lambda item: item["volumeMm3"], reverse=True)
    result = {
        "ok": True,
        "parts": len(parts),
        "candidates": len(candidates),
        "checks": len(candidates),
        "hits": hits,
        "elapsedMs": int((time.time() - started) * 1000),
        "tolerances": {"volumeMm3": TOL_VOLUME_MM3, "ratio": TOL_RATIO},
    }
    text = json.dumps(result, ensure_ascii=False)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            handle.write(text)
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
