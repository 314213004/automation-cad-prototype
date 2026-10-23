#!/usr/bin/env python3
"""把 README.md 转成单文件 HTML（图片以 base64 内嵌），用于群里直接发文件查看。

用法：
    python3 scripts/build-readme-html.py [输出路径]
默认输出 docs/report/AutomationCAD-项目说明-单文件.html
"""
from __future__ import annotations

import base64
import io
import re
import sys
from pathlib import Path

import markdown
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "README.md"
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "docs/report/AutomationCAD-项目说明-单文件.html"
MAX_WIDTH = 1200
QUALITY = 82

CSS = """
:root{--bg:#0f1216;--card:#171c22;--line:#2a323c;--fg:#e6edf3;--dim:#9aa7b4;--acc:#4c9aff;}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.75 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:1080px;margin:0 auto;padding:48px 28px 80px}
h1{font-size:34px;line-height:1.3;margin:0 0 8px;border-bottom:2px solid var(--acc);padding-bottom:14px}
h2{font-size:24px;margin:44px 0 14px;padding-left:12px;border-left:4px solid var(--acc)}
h3{font-size:19px;margin:30px 0 10px;color:#cbd8e6}
p,li{color:var(--fg)}
a{color:var(--acc);text-decoration:none}
img{max-width:100%;height:auto;display:block;margin:18px auto;border:1px solid var(--line);border-radius:10px;background:#0b0e12}
code{background:#1e252d;padding:2px 6px;border-radius:5px;font-size:13.5px;color:#9fd2ff}
pre{background:#0b0e12;border:1px solid var(--line);border-radius:10px;padding:16px;overflow:auto}
pre code{background:none;padding:0;color:#cfe6ff}
table{width:100%;border-collapse:collapse;margin:18px 0;font-size:14.5px;display:block;overflow-x:auto}
th,td{border:1px solid var(--line);padding:9px 12px;text-align:left;vertical-align:top}
th{background:#1b222b;color:#cfe6ff;white-space:nowrap}
tr:nth-child(even) td{background:#141a20}
blockquote{margin:18px 0;padding:12px 18px;background:#161d25;border-left:3px solid var(--acc);color:var(--dim);border-radius:0 8px 8px 0}
hr{border:0;border-top:1px solid var(--line);margin:36px 0}
.meta{color:var(--dim);font-size:13.5px;margin-bottom:8px}
.toc{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 22px;margin:26px 0}
.toc ul{margin:6px 0 0;padding-left:20px}
.toc a{color:#b9cde0}
footer{margin-top:56px;padding-top:18px;border-top:1px solid var(--line);color:var(--dim);font-size:13px}
"""


def data_uri(path: Path) -> str:
    img = Image.open(path).convert("RGB")
    if img.width > MAX_WIDTH:
        height = round(img.height * MAX_WIDTH / img.width)
        img = img.resize((MAX_WIDTH, height), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=QUALITY, optimize=True, progressive=True)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def main() -> int:
    if not SRC.exists():
        print(f"找不到 {SRC}")
        return 1
    text = SRC.read_text(encoding="utf-8")
    # 去掉 README 里的相对链接图片语法干扰，先记录引用清单
    refs = re.findall(r"!\[[^\]]*\]\(([^)\s]+)", text)
    inlined = 0
    for ref in dict.fromkeys(refs):
        if ref.startswith(("http://", "https://", "data:")):
            continue
        p = (ROOT / ref).resolve()
        if not p.exists():
            print(f"跳过缺失图片：{ref}")
            continue
        uri = data_uri(p)
        text = text.replace(f"]({ref})", f"]({uri})")
        inlined += 1

    body = markdown.markdown(
        text,
        extensions=["tables", "fenced_code", "toc", "sane_lists", "attr_list"],
    )
    html = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AutomationCAD 桌面版 · 项目说明</title>
<style>{CSS}</style></head>
<body><div class="wrap">
<div class="meta">AutomationCAD 桌面版 · 项目说明（由 README.md 生成，图片已内嵌，可离线查看）</div>
{body}
<footer>本文件为单文件 HTML，包含 {inlined} 张内嵌截图，无外部依赖。</footer>
</div></body></html>
"""
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(html, encoding="utf-8")
    print(f"HTML_BUILD_OK images={inlined} bytes={OUT.stat().st_size} out={OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
