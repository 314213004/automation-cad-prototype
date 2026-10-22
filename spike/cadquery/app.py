"""CadQuery sidecar 原型：HTTP + Bearer，声明式特征树 → 参数化实体 → STEP/STL。

仅用标准库 + cadquery，验证「桌面端 → 本地建模服务」这条链路。
启动：python app.py --port 7411 --token <token>
"""
from __future__ import annotations

import argparse, json, os, secrets, tempfile, time, traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cadquery as cq

TOKEN = ""
VERSION = cq.__version__


def _num(value, name: str, minimum: float = 0.0) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} 必须是数字")
    if value <= minimum:
        raise ValueError(f"{name} 必须大于 {minimum}")
    return float(value)


def build(ops: list[dict]) -> cq.Workplane:
    if not isinstance(ops, list) or not ops:
        raise ValueError("ops 必须是非空数组")
    wp: cq.Workplane | None = None
    for index, op in enumerate(ops, 1):
        if not isinstance(op, dict):
            raise ValueError(f"第 {index} 个操作必须是对象")
        kind = op.get("op")
        if kind == "box":
            L, W, H = (_num(op.get(k), k) for k in ("length", "width", "height"))
            centered = bool(op.get("centered", True))
            z = 0.0 if centered else H / 2
            base = cq.Workplane("XY").box(L, W, H, centered=(centered, centered, True)).translate((0, 0, z))
            wp = base if wp is None else wp.union(base)
        elif kind == "holes":
            if wp is None:
                raise ValueError("holes 之前必须有实体")
            d = _num(op.get("diameter"), "diameter")
            positions = op.get("positions") or []
            if not positions:
                raise ValueError("holes.positions 不能为空")
            pts = [(float(x), float(y)) for x, y in positions]
            wp = wp.faces(">Z").workplane().pushPoints(pts).hole(d)
        elif kind == "slot":
            if wp is None:
                raise ValueError("slot 之前必须有实体")
            length = _num(op.get("length"), "length")
            width = _num(op.get("width"), "width")
            wp = wp.faces(">Z").workplane().slot2D(length, width).cutThruAll()
        elif kind == "fillet":
            if wp is None:
                raise ValueError("fillet 之前必须有实体")
            radius = _num(op.get("radius"), "radius")
            selector = str(op.get("edges") or "|Z")
            wp = wp.edges(selector).fillet(radius)
        else:
            raise ValueError(f"第 {index} 个操作未知：{kind}")
    assert wp is not None
    return wp


def describe(wp: cq.Workplane) -> dict:
    solid = wp.val()
    bb = solid.BoundingBox()
    return {
        "volumeMm3": round(solid.Volume(), 1),
        "bbox": [round(bb.xlen, 2), round(bb.ylen, 2), round(bb.zlen, 2)],
        "faces": len(solid.Faces()),
        "edges": len(solid.Edges()),
        "solids": len(wp.solids().vals()),
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "CadQuerySidecar/0.1"

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        header = self.headers.get("Authorization", "")
        return header == f"Bearer {TOKEN}"

    def log_message(self, fmt, *args):  # 静默，避免污染 stdout
        pass

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"ok": True, "cadquery": VERSION, "pid": os.getpid()})
        else:
            self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if not self._authorized():
            self._send(401, {"ok": False, "error": "unauthorized"})
            return
        if self.path != "/build":
            self._send(404, {"ok": False, "error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > 1_000_000:
                raise ValueError("请求体为空或超过 1 MB")
            payload = json.loads(self.rfile.read(length))
            wants = payload.get("exports") or ["step"]
            for item in wants:
                if item not in ("step", "stl"):
                    raise ValueError(f"不支持的导出格式：{item}")
            started = time.perf_counter()
            wp = build(payload.get("ops") or [])
            built_ms = (time.perf_counter() - started) * 1000
            outdir = tempfile.mkdtemp(prefix="cq-build-")
            files = {}
            for fmt in wants:
                path = os.path.join(outdir, f"part.{fmt}")
                t = time.perf_counter()
                cq.exporters.export(wp, path, tolerance=0.1) if fmt == "stl" else cq.exporters.export(wp, path)
                files[fmt] = {"path": path, "bytes": os.path.getsize(path), "ms": round((time.perf_counter() - t) * 1000, 1)}
            self._send(200, {"ok": True, "stats": describe(wp), "buildMs": round(built_ms, 1), "files": files})
        except Exception as exc:  # noqa: BLE001 - 统一转成 JSON 错误
            self._send(400, {"ok": False, "error": str(exc), "trace": traceback.format_exc(limit=2)})


def main() -> None:
    global TOKEN
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=7411)
    ap.add_argument("--token", default="")
    args = ap.parse_args()
    TOKEN = args.token or secrets.token_urlsafe(24)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(json.dumps({"ok": True, "port": args.port, "token": TOKEN, "cadquery": VERSION}), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
