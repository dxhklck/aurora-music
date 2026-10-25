#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""修复 musicdl 源码目录中被损坏的 .py 文件。

背景
----
仓库里 `musicdl/musicdl/` 下有 8 个文件不是合法源码（二进制乱码，含 NUL 字节），
其中 `modules/utils/cookies.py` 被几乎所有音源 import，导致 `import musicdl.modules`
直接抛 `SyntaxError: source code string cannot contain null bytes`，
整个下载引擎不可用。

本脚本从已安装的同版本 musicdl 包（pip 安装，内容与官方发布一致）把这些文件还原回去，
只覆盖「无法解码 / 含 NUL 字节」的文件，其余文件不动。

用法：
    python scripts/repair_musicdl.py                     # 自动探测 ../musicdl 与已安装包
    python scripts/repair_musicdl.py --target D:/musicdl # 指定源码目录
    python scripts/repair_musicdl.py --check             # 只体检，不写入
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import shutil
import sys


def installed_package_dir() -> str:
    spec = importlib.util.find_spec("musicdl")
    if not spec or not spec.submodule_search_locations:
        return ""
    return list(spec.submodule_search_locations)[0]


def is_broken(path: str) -> bool:
    with open(path, "rb") as handle:
        data = handle.read()
    if b"\x00" in data:
        return True
    try:
        data.decode("utf-8")
    except UnicodeDecodeError:
        return True
    return False


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", default="", help="musicdl 源码目录（包含 musicdl/ 子目录）")
    parser.add_argument("--check", action="store_true", help="只检查不修复")
    args = parser.parse_args()

    target = args.target
    if not target:
        here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        for candidate in (os.path.join(here, "..", "musicdl"), os.path.join(here, "engine", "vendor", "musicdl")):
            if os.path.isdir(os.path.join(candidate, "musicdl")):
                target = os.path.abspath(candidate)
                break
    if not target or not os.path.isdir(os.path.join(target, "musicdl")):
        print(f"[repair] 找不到 musicdl 源码目录：{target or '(未指定)'}")
        return 2

    source_root = installed_package_dir()
    if not source_root:
        print("[repair] 当前解释器里没有安装 musicdl，无法取得修复来源。")
        print("         先执行：pip install musicdl")
        return 3

    broken: list[str] = []
    for root, _dirs, files in os.walk(os.path.join(target, "musicdl")):
        for name in files:
            if not name.endswith(".py"):
                continue
            path = os.path.join(root, name)
            if is_broken(path):
                broken.append(path)

    print(f"[repair] 源码目录：{target}")
    print(f"[repair] 修复来源：{source_root}")
    if not broken:
        print("[repair] 没有发现损坏文件，无需修复。")
        return 0

    print(f"[repair] 发现 {len(broken)} 个损坏文件：")
    for path in broken:
        rel = os.path.relpath(path, os.path.join(target, "musicdl"))
        print(f"  - {rel}")
        if args.check:
            continue
        replacement = os.path.join(source_root, rel)
        if not os.path.exists(replacement):
            print(f"    跳过：安装包里没有对应文件 {rel}")
            continue
        shutil.copyfile(replacement, path)
        print("    已还原")

    if args.check:
        print("[repair] --check 模式，未写入任何文件。")
        return 1

    print("[repair] 完成。建议再跑一次：python -c \"import sys; sys.path.insert(0,'%s'); import musicdl.modules\"" % target)
    return 0


if __name__ == "__main__":
    sys.exit(main())
