"""build123d sidecar 原型（P9 选用内核）：HTTP + Bearer，声明式特征树 → 实体 → STEP/STL。

启动：python app.py --port 7412 --token <token>
"""
from __future__ import annotations

import argparse, json, os, secrets, tempfile, time, traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import build123d as bd

TOKEN = ""
VERSION = bd.__version__


def _num(value, name: str, minimum: float = 0.0) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} 必须是数字")
    if value <= minimum:
        raise ValueError(f"{name} 必须大于 {minimum}")
    return float(value)


def build(ops: list[dict]):
    if not isinstance(ops, list) or not ops:
        raise ValueError("ops 必须是非空数组")
    shape = None
    for index, op in enumerate(ops, 1):
        if not isinstance(op, dict):
            raise ValueError(f"第 {index} 个操作必须是对象")
        kind = op.get("op")
        if kind == "box":
            L, W, H = (_num(op.get(k), k) for k in ("length", "width", "height"))
            centered = bool(op.get("centered", True))
            z = 0.0 if centered else H / 2
            base = bd.Pos(0, 0, z) * bd.Box(L, W, H)
            shape = base if shape is None else shape + base
        elif kind == "cylinder":
            if shape is None:
                raise ValueError("cylinder 之前必须有实体")
            d = _num(op.get("diameter"), "diameter")
            h = _num(op.get("height"), "height")
            x, y, z = (op.get("at") or [0, 0, 0])[:3]
            shape = shape + (bd.Pos(float(x), float(y), float(z)) * bd.Cylinder(d / 2, h))
        elif kind == "holes":
            if shape is None:
                raise ValueError("holes 之前必须有实体")
            d = _num(op.get("diameter"), "diameter")
            positions = op.get("positions") or []
            if not positions:
                raise ValueError("holes.positions 不能为空")
            depth = op.get("depth")
            for x, y in positions:
                z0 = -1.0
                height = 1e3 if depth in (None, "through") else _num(depth, "depth") + 2
                shape = shape - (bd.Pos(float(x), float(y), z0) * bd.Cylinder(d / 2, height))
        elif kind == "slot":
            if shape is None:
                raise ValueError("slot 之前必须有实体")
            length = _num(op.get("length"), "length")
            width = _num(op.get("width"), "width")
            cut = bd.extrude(bd.SlotOverall(length, width), amount=1e3)
            shape = shape - (bd.Pos(0, 0, -1) * cut)
        elif kind == "fillet":
            if shape is None:
                raise ValueError("fillet 之前必须有实体")
            radius = _num(op.get("radius"), "radius")
            selector = str(op.get("edges") or "|Z")
            edges = shape.edges().filter_by(bd.Axis.Z) if selector == "|Z" else shape.edges()
            shape = bd.fillet(edges, radius)
        else:
            raise ValueError(f"第 {index} 个操作未知：{kind}")
    return shape


def describe(shape) -> dict:
    bb = shape.bounding_box()
    return {
        "volumeMm3": round(shape.volume, 1),
        "bbox": [round(bb.size.X, 2), round(bb.size.Y, 2), round(bb.size.Z, 2)],
        "faces": len(shape.faces()),
        "edges": len(shape.edges()),
        "solids": len(shape.solids()),
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "Build123dSidecar/0.1"

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        return self.headers.get("Authorization", "") == f"Bearer {TOKEN}"

    def log_message(self, fmt, *args):
        pass

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"ok": True, "kernel": "build123d", "version": VERSION, "pid": os.getpid()})
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
            shape = build(payload.get("ops") or [])
            built_ms = (time.perf_counter() - started) * 1000
            outdir = tempfile.mkdtemp(prefix="b123d-build-")
            files = {}
            for fmt in wants:
                path = os.path.join(outdir, f"part.{fmt}")
                t = time.perf_counter()
                if fmt == "step":
                    bd.export_step(shape, path)
                else:
                    bd.export_stl(shape, path, tolerance=0.1)
                files[fmt] = {"path": path, "bytes": os.path.getsize(path), "ms": round((time.perf_counter() - t) * 1000, 1)}
            self._send(200, {"ok": True, "kernel": "build123d", "stats": describe(shape), "buildMs": round(built_ms, 1), "files": files})
        except Exception as exc:  # noqa: BLE001
            self._send(400, {"ok": False, "error": str(exc), "trace": traceback.format_exc(limit=2)})


def main() -> None:
    global TOKEN
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=7412)
    ap.add_argument("--token", default="")
    args = ap.parse_args()
    TOKEN = args.token or secrets.token_urlsafe(24)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(json.dumps({"ok": True, "port": args.port, "token": TOKEN, "kernel": "build123d", "version": VERSION}), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
