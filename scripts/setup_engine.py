#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一键准备 musicdl 引擎运行环境。

做三件事：
1. 在 `engine/.venv` 建一个独立虚拟环境（不污染系统 Python）；
2. 安装 musicdl 及其依赖（优先用仓库里的 musicdl/requirements.txt，保持一致）；
3. 体检 musicdl 源码，发现损坏文件就从已安装的同版本包里还原。

用法：
    npm run engine:setup
    python scripts/setup_engine.py --python "C:/Python312/python.exe"
    python scripts/setup_engine.py --skip-deps      # 只体检/修复源码
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VENV_DIR = os.path.join(ROOT, "engine", ".venv")


def venv_python(venv: str) -> str:
    return os.path.join(venv, "Scripts", "python.exe") if os.name == "nt" else os.path.join(venv, "bin", "python3")


def run(cmd: list[str], quiet: bool = False) -> int:
    print("  $ " + " ".join(cmd))
    result = subprocess.run(cmd, stdout=subprocess.PIPE if quiet else None, stderr=subprocess.STDOUT if quiet else None, text=True)
    if quiet and result.returncode != 0 and result.stdout:
        print(result.stdout[-2000:])
    return result.returncode


def find_musicdl_root() -> str:
    for candidate in (
        os.path.join(ROOT, "..", "musicdl"),
        os.path.join(ROOT, "engine", "vendor", "musicdl"),
    ):
        if os.path.isfile(os.path.join(candidate, "musicdl", "__init__.py")):
            return os.path.abspath(candidate)
    return ""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--python", default=sys.executable, help="用于创建虚拟环境的 Python")
    parser.add_argument("--skip-deps", action="store_true", help="跳过依赖安装")
    args = parser.parse_args()

    print("[setup] Aurora musicdl 引擎环境")
    print(f"[setup] 基础解释器：{args.python}")

    if not os.path.exists(venv_python(VENV_DIR)):
        print(f"[setup] 创建虚拟环境：{VENV_DIR}")
        code = run([args.python, "-m", "venv", VENV_DIR])
        if code != 0:
            print("[setup] 虚拟环境创建失败")
            return code
    else:
        print(f"[setup] 复用已有虚拟环境：{VENV_DIR}")

    python = venv_python(VENV_DIR)
    if not os.path.exists(python):
        print(f"[setup] 找不到虚拟环境解释器：{python}")
        return 2

    if not args.skip_deps:
        print("[setup] 升级 pip")
        run([python, "-m", "pip", "install", "--disable-pip-version-check", "-q", "--upgrade", "pip"], quiet=True)

        musicdl_root = find_musicdl_root()
        requirements = os.path.join(musicdl_root, "requirements.txt") if musicdl_root else ""
        if requirements and os.path.isfile(requirements):
            print(f"[setup] 安装依赖（来源：{requirements}）")
            code = run([python, "-m", "pip", "install", "--disable-pip-version-check", "-q", "-r", requirements], quiet=True)
            if code != 0:
                print("[setup] 依赖安装失败，请检查网络或代理设置")
                return code
        else:
            print("[setup] 未找到 requirements.txt，改为安装 PyPI 上的 musicdl")
            code = run([python, "-m", "pip", "install", "--disable-pip-version-check", "-q", "musicdl"], quiet=True)
            if code != 0:
                return code

        # 源码目录存在时，确保同版本的 musicdl 也在环境里，用于修复损坏文件
        if musicdl_root:
            run([python, "-m", "pip", "install", "--disable-pip-version-check", "-q", "musicdl"], quiet=True)

    musicdl_root = find_musicdl_root()
    if musicdl_root:
        print("[setup] 体检 musicdl 源码")
        run([python, os.path.join(ROOT, "scripts", "repair_musicdl.py"), "--target", musicdl_root])

    print("[setup] 验证引擎能否启动")
    bridge = os.path.join(ROOT, "engine", "musicdl", "bridge.py")
    cmd = [python, "-u", bridge]
    if musicdl_root:
        cmd += ["--musicdl-path", musicdl_root]
    result = subprocess.run(cmd, input='{"id":1,"cmd":"ping"}\n', text=True, capture_output=True, timeout=120)
    ok = '"ok": true' in (result.stdout or "")
    print("[setup] 引擎自检：" + ("通过" if ok else "失败"))
    if not ok:
        print((result.stdout or "")[-1000:])
        print((result.stderr or "")[-2000:])
        return 4

    print("\n[setup] 完成。启动应用即可在音源列表里看到引擎音源。")
    print(f"[setup] 如需指定解释器：设置环境变量 AURORA_PYTHON={python}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
