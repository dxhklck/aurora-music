#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Aurora Music · musicdl 引擎桥（stdio 协议层）

进程模型
--------
Electron 主进程 spawn 本脚本，双方用 NDJSON（一行一个 JSON）通信：

    请求   {"id": 1, "cmd": "search", "params": {...}}
    响应   {"id": 1, "ok": true,  "result": {...}}
           {"id": 1, "ok": false, "error": {"code": "...", "message": "..."}}
    事件   {"event": "progress", "taskId": "...", "received": 0, "total": 0}

为什么用 stdio 而不是本地 HTTP：
1. 不占端口、不会被防火墙拦、不会和别的进程抢端口；
2. 生命周期跟着父进程，父进程退出即回收，不会留下孤儿进程；
3. 天然单客户端，不需要额外做鉴权。

约定
----
- **stdout 只允许出现协议帧**。musicdl 内部大量 print / rich 进度条会污染通道，
  所以启动时立刻把 sys.stdout 指向 stderr，协议帧写到保存下来的原始句柄。
- 请求并发执行（搜索一个源可能要 10 秒，不能阻塞其它请求），但写 stdout 加锁。
- SongInfo 对象缓存在内存里，用 token 引用；token 失效时按「歌名 + 歌手 + 时长」
  重新搜索匹配，因此引擎重启后旧的 Song 仍然可用。

分层说明
--------
引擎逻辑全部在 engine_core.py（命令实现、缓存、匹配），本文件只负责
stdio 传输：Android 端（Chaquopy）不走这里，直接 import engine_core。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any

# ---------------------------------------------------------------------------
# 协议通道：必须在 import musicdl 之前接管 stdout
# ---------------------------------------------------------------------------
_PROTOCOL_OUT = sys.stdout
sys.stdout = sys.stderr


def _emit(payload: dict[str, Any]) -> None:
    line = json.dumps(payload, ensure_ascii=False, default=str)
    with _WRITE_LOCK:
        _PROTOCOL_OUT.write(line + "\n")
        _PROTOCOL_OUT.flush()


_WRITE_LOCK = threading.Lock()

# ---------------------------------------------------------------------------
# 参数
# ---------------------------------------------------------------------------
parser = argparse.ArgumentParser(description="Aurora musicdl engine bridge")
parser.add_argument("--musicdl-path", default="", help="musicdl 源码根目录（含 musicdl/ 包）")
parser.add_argument("--work-dir", default="", help="引擎临时工作目录")
parser.add_argument("--search-size", type=int, default=10, help="每个源默认召回条数")
args, _unknown = parser.parse_known_args()

if args.musicdl_path:
    sys.path.insert(0, os.path.abspath(args.musicdl_path))

# 内嵌 Python（python312._pth 模式）不会自动加脚本目录，这里显式补上，
# 保证 engine_core 可被 import
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

# ---------------------------------------------------------------------------
# 装载核心层
# ---------------------------------------------------------------------------
try:
    import engine_core

    engine_core.init(work_dir=args.work_dir, search_size=args.search_size)
    engine_core.set_emitter(_emit)
except ImportError as err:
    _emit(
        {
            "event": "fatal",
            "code": "engine_import",
            "message": str(err),
            "hint": "该 Python 缺少 musicdl 依赖。请 pip install musicdl，或在设置页指定另一个解释器",
        }
    )
    sys.exit(2)

from concurrent.futures import ThreadPoolExecutor  # noqa: E402

_POOL = ThreadPoolExecutor(max_workers=4, thread_name_prefix="bridge")


def _handle(request: dict[str, Any]) -> None:
    """执行一条请求并回写响应帧；shutdown 收尾退出。"""
    response = engine_core.dispatch(request)
    _emit({"id": request.get("id"), **response})
    if request.get("cmd") == "shutdown":
        os._exit(0)


def main() -> None:
    import musicdl as _musicdl_pkg

    _emit(
        {
            "event": "ready",
            "pid": os.getpid(),
            "version": getattr(_musicdl_pkg, "__version__", "unknown"),
            "python": sys.version.split()[0],
            "sources": len(engine_core.SOURCES),
        }
    )
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except Exception:
            _emit({"event": "error", "message": "协议帧不是合法 JSON"})
            continue
        if request.get("cmd") == "shutdown":
            _handle(request)
            return
        _POOL.submit(_handle, request)
    # stdin 关闭（父进程退出或管道断开）：把在跑的任务做完再退出。
    # 不等待的话解释器会先关掉线程池，正在搜索的请求会抛
    # "cannot schedule new futures after interpreter shutdown"。
    _POOL.shutdown(wait=True)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
