#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一键重拉 musicdl 源码，覆盖随包 vendor 目录（引擎自愈）。

背景：musicdl 上游音源经常变动，随包分发的源码可能失效。
本脚本从 PyPI 重新拉取官方 wheel，做完整性体检后覆盖目标目录。

用法：
    python repair_vendor.py --target <vendor根目录>   # 目录下应含 musicdl/ 包

输出协议：stdout 只打一行 JSON
    成功 {"ok": true, "files": 96}
    失败 {"ok": false, "message": "原因"}
诊断信息全部走 stderr，主进程只解析那一行 JSON。
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
import urllib.request
import zipfile

VERSION = "2.14.2"
PYPI_API = f"https://pypi.org/pypi/musicdl/{VERSION}/json"


def emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False))
    sys.stdout.flush()


def is_broken(data: bytes) -> bool:
    """与 scripts/vendor_engine.py 同标准：NUL 字节或非 UTF-8 都算坏"""
    if b"\x00" in data:
        return True
    try:
        data.decode("utf-8")
    except UnicodeDecodeError:
        return True
    return False


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", required=True, help="vendor 根目录（含 musicdl/ 包）")
    args = parser.parse_args()
    target_pkg = os.path.join(args.target, "musicdl")

    try:
        with urllib.request.urlopen(PYPI_API, timeout=30) as resp:
            meta = json.load(resp)
        wheel = next(u for u in meta.get("urls", []) if u.get("filename", "").endswith(".whl"))
    except Exception as error:  # noqa: BLE001
        emit({"ok": False, "message": f"获取 PyPI 元数据失败：{type(error).__name__}: {error}"})
        return 1

    try:
        with tempfile.TemporaryDirectory(prefix="aurora-repair-") as tmp:
            whl_path = os.path.join(tmp, wheel["filename"])
            print(f"[repair] 下载 {wheel['filename']} ...", file=sys.stderr)
            urllib.request.urlretrieve(wheel["url"], whl_path)

            extract_dir = os.path.join(tmp, "unpacked")
            with zipfile.ZipFile(whl_path) as zf:
                zf.extractall(extract_dir)

            src_pkg = os.path.join(extract_dir, "musicdl")
            if not os.path.isdir(src_pkg):
                emit({"ok": False, "message": "wheel 里找不到 musicdl 包"})
                return 1

            py_files: list[str] = []
            for base, _dirs, names in os.walk(src_pkg):
                py_files.extend(os.path.join(base, n) for n in names if n.endswith(".py"))
            # musicdl 2.x 有 90+ 个源文件，太少说明下载/解包不完整
            if len(py_files) < 20:
                emit({"ok": False, "message": f"源文件过少（{len(py_files)} 个），疑似不完整"})
                return 1
            broken = [p for p in py_files if is_broken(open(p, "rb").read())]
            if broken:
                emit({"ok": False, "message": f"{len(broken)} 个文件损坏，放弃覆盖"})
                return 1

            if os.path.isdir(target_pkg):
                shutil.rmtree(target_pkg)
            shutil.copytree(src_pkg, target_pkg)
        emit({"ok": True, "files": len(py_files)})
        return 0
    except Exception as error:  # noqa: BLE001
        emit({"ok": False, "message": f"{type(error).__name__}: {error}"})
        return 1


if __name__ == "__main__":
    sys.exit(main())
