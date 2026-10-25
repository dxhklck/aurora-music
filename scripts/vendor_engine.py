#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 musicdl 引擎源码收进 engine/vendor，随安装包分发。

用法
----
    python scripts/vendor_engine.py            # 本地已有且完好的 vendor 直接跳过
    python scripts/vendor_engine.py --force    # 忽略现有 vendor，重新拉取

行为
----
1. engine/vendor/musicdl/musicdl 已存在且无坏文件 → 直接跳过（本地日常构建走这条）。
2. 不存在/损坏时，按顺序尝试获取官方 musicdl 源码：
     a) pip download musicdl==2.14.2 --no-deps 的 wheel 解包
     b) 当前 Python 环境已安装的 musicdl 包
3. 拷贝后做完整性体检（UTF-8 可解码、无 NUL 字节），发现坏文件立即失败——
   宁可 CI 红也不打包坏引擎。
4. 无网络等极端情况下：只写占位说明文件并成功退出，保证打包流程不被卡死
   （装出来的包不带引擎音源，但应用本体可用）。
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile

MUSICDL_VERSION = "2.14.2"
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VENDOR_ROOT = os.path.join(HERE, "engine", "vendor", "musicdl")
PKG_DIR = os.path.join(VENDOR_ROOT, "musicdl")


def is_broken_file(data: bytes) -> bool:
    if b"\x00" in data:
        return True
    try:
        data.decode("utf-8")
    except UnicodeDecodeError:
        return True
    return False


def vendor_is_valid() -> bool:
    """vendor 里的 musicdl 包存在且所有 .py 完好才算有效"""
    if not os.path.isdir(PKG_DIR):
        return False
    py_files = []
    for base, _dirs, names in os.walk(PKG_DIR):
        py_files.extend(os.path.join(base, n) for n in names if n.endswith(".py"))
    if len(py_files) < 20:  # musicdl 2.x 有 90+ 个源文件，太少说明拷贝不完整
        return False
    return all(not is_broken_file(open(p, "rb").read()) for p in py_files)


def installed_package_dir() -> str:
    try:
        spec = importlib.util.find_spec("musicdl")
    except (ImportError, ValueError):
        return ""
    if spec and spec.submodule_search_locations:
        return list(spec.submodule_search_locations)[0]
    return ""


def fetch_wheel() -> str:
    """pip download 一个 wheel 回来，返回解出的 musicdl 包目录"""
    tmp = tempfile.mkdtemp(prefix="aurora-vendor-")
    subprocess.run(
        [sys.executable, "-m", "pip", "download", f"musicdl=={MUSICDL_VERSION}",
         "--no-deps", "--no-cache-dir", "-d", tmp],
        check=True, capture_output=True, timeout=300,
    )
    wheels = [n for n in os.listdir(tmp) if n.endswith(".whl")]
    if not wheels:
        raise RuntimeError(f"pip download 未产出 wheel：{os.listdir(tmp)}")
    pkg_root = os.path.join(tmp, "unpacked")
    with zipfile.ZipFile(os.path.join(tmp, wheels[0])) as zf:
        zf.extractall(pkg_root)
    src = os.path.join(pkg_root, "musicdl")
    if not os.path.isdir(src):
        raise RuntimeError("wheel 里没有 musicdl 包目录")
    return src


def copy_package(src: str) -> None:
    if os.path.isdir(VENDOR_ROOT):
        shutil.rmtree(VENDOR_ROOT)
    os.makedirs(VENDOR_ROOT)
    shutil.copytree(src, PKG_DIR)


def write_placeholder(reason: str) -> None:
    os.makedirs(VENDOR_ROOT, exist_ok=True)
    with open(os.path.join(VENDOR_ROOT, "README.txt"), "w", encoding="utf-8") as h:
        h.write(
            "musicdl 引擎源码未随包分发。\n"
            f"原因：{reason}\n"
            "在已装 Python 的机器上执行 `pip install musicdl=={v}` 后重跑 "
            "`python scripts/vendor_engine.py --force` 可补齐。\n".format(v=MUSICDL_VERSION)
        )


def main() -> int:
    # Windows CI 控制台默认 cp1252，中文输出会直接 UnicodeEncodeError
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true", help="忽略现有 vendor 重新拉取")
    args = parser.parse_args()

    if not args.force and vendor_is_valid():
        print(f"[vendor] engine/vendor/musicdl 已存在且完好，跳过（--force 可强制重建）")
        return 0

    errors: list[str] = []
    # 尝试 1：pip download 官方 wheel
    try:
        copy_package(fetch_wheel())
    except Exception as exc:  # noqa: BLE001 - 网络失败要兜底，不能让 CI 直接炸
        errors.append(f"pip download: {exc}")
        # 尝试 2：当前环境已安装的包
        installed = installed_package_dir()
        if installed and os.path.isdir(installed):
            try:
                copy_package(installed)
            except Exception as exc2:  # noqa: BLE001
                errors.append(f"installed package: {exc2}")

    if vendor_is_valid():
        count = sum(len(fs) for _b, _d, fs in os.walk(PKG_DIR))
        print(f"[vendor] musicdl {MUSICDL_VERSION} 源码已收进 engine/vendor（{count} 个文件）")
        return 0

    reason = "；".join(errors) or "未知原因"
    write_placeholder(reason)
    print(f"[vendor] 警告：引擎源码获取失败，已写占位（{reason}）", file=sys.stderr)
    return 0  # 占位模式：打包继续，只是包里没有引擎音源


if __name__ == "__main__":
    sys.exit(main())
