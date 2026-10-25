#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Aurora Music · musicdl 引擎桥

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
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import tempfile
import threading
import time
import traceback
import uuid
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

WORK_DIR = os.path.abspath(args.work_dir or os.path.join(tempfile.gettempdir(), "aurora-musicdl"))
os.makedirs(WORK_DIR, exist_ok=True)

try:
    import musicdl as _musicdl_pkg
    from musicdl.modules import BuildMusicClient, SongInfo
except Exception as err:  # pragma: no cover - 环境缺失时给出可读错误
    _emit(
        {
            "event": "fatal",
            "code": "engine_import",
            "message": f"无法导入 musicdl：{err}",
            "hint": "该 Python 缺少 musicdl 依赖。请 pip install musicdl，或在设置页指定另一个解释器",
        }
    )
    sys.exit(2)


# ---------------------------------------------------------------------------
# 音源清单：只暴露「无需登录 / 无 DRM」的源。
# netease / qq / kuwo 由 Aurora 原生适配器负责（支持榜单与逐字歌词），
# 这里刻意不重复注册，避免同一个平台出现两套行为。
# ---------------------------------------------------------------------------
SOURCES: dict[str, dict[str, Any]] = {
    # pageSize 是「每页条数」，决定了分页并行的粒度：
    # musicdl 在同一页内串行解析地址、页与页之间才并发，
    # 所以这个值越小并发越高。但太小的页会被部分平台风控拦下来
    # （咪咕每页 2 条会从 6s 退化到 50s+），因此按音源分别标定。
    "kugou": {"client": "KugouMusicClient", "label": "酷狗音乐", "pageSize": 2},
    "migu": {"client": "MiguMusicClient", "label": "咪咕音乐", "pageSize": 3},
    "qianqian": {"client": "QianqianMusicClient", "label": "千千音乐", "pageSize": 3},
    "fivesing": {"client": "FiveSingMusicClient", "label": "5sing 原创", "pageSize": 3},
    "bodian": {"client": "BodianMusicClient", "label": "波点音乐", "pageSize": 3},
    "streetvoice": {"client": "StreetVoiceMusicClient", "label": "街声"},
    "bilibili": {"client": "BilibiliMusicClient", "label": "哔哩哔哩"},
    "jiosaavn": {"client": "JioSaavnMusicClient", "label": "JioSaavn"},
    "jamendo": {"client": "JamendoMusicClient", "label": "Jamendo"},
    "ccmixter": {"client": "CCMixterMusicClient", "label": "ccMixter"},
    "opengameart": {"client": "OpenGameArtMusicClient", "label": "OpenGameArt"},
    "wikimedia": {"client": "WikimediaCommonsMusicClient", "label": "维基共享"},
    "audius": {"client": "AudiusMusicClient", "label": "Audius"},
    "fma": {"client": "FMAMusicClient", "label": "Free Music Archive"},
    "soundcloud": {"client": "SoundCloudMusicClient", "label": "SoundCloud"},
}

_client_lock = threading.Lock()
_clients: dict[tuple[str, int], Any] = {}


def get_client(source: str, size: int) -> Any:
    """按 (源, 召回条数) 缓存客户端。musicdl 的召回条数在构造期就固化进搜索 URL 了。"""
    if source not in SOURCES:
        raise EngineError("unsupported", f"未知音源：{source}")
    size = max(1, min(int(size or args.search_size), 50))
    key = (source, size)
    with _client_lock:
        client = _clients.get(key)
        if client is not None:
            return client
        cfg = {
            "search_size_per_source": size,
            # 每页条数直接决定并行度：musicdl 对「同一页」内的结果串行解析播放地址，
            # 页与页之间才走线程池。一页塞 10 条 = 10 次串行往返（咪咕实测 17s），
            # 拆成 3 条一页后 4 页并发，同样的 10 条只要 6~7s。
            # 酷狗更极端，2 条一页（5 页并发）能从 19s 压到 9s。
            "search_size_per_page": min(size, SOURCES[source].get("pageSize", 3)),
            "strict_limit_search_size_per_page": True,
            "work_dir": os.path.join(WORK_DIR, source),
            "disable_print": True,
            "max_retries": 2,
            "maintain_session": False,
            "auto_set_proxies": False,
            "random_update_ua": False,
        }
        client = BuildMusicClient(module_cfg=dict(cfg, type=SOURCES[source]["client"]))
        _clients[key] = client
        return client


class EngineError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


# ---------------------------------------------------------------------------
# 流式搜索：musicdl 的 search() 要等所有页都解析完才返回，
# 但页与页之间本来就是并发的，谁先完成谁就能先出结果。
# 这里在 _search 外面套一层，把「这一页解析完了」这件事告诉调用方。
# ---------------------------------------------------------------------------
class _PageProgress:
    """顶替 rich.Progress 传进 musicdl 的 progress 参数。

    musicdl 只用到 add_task / update / advance / tasks[...].{total,completed}，
    真正的目的不是画进度条，而是让 _search 能顺着 progress 找到 on_page 回调。
    """

    class _Task:
        def __init__(self, total: int = 0) -> None:
            self.total = total
            self.completed = 0

    def __init__(self, on_items: Any) -> None:
        self.on_items = on_items
        self.tasks: dict[int, Any] = {}
        self._next = 0

    def add_task(self, *_args: Any, total: int = 0, **_kw: Any) -> int:
        self._next += 1
        self.tasks[self._next] = self._Task(total or 0)
        return self._next

    def update(self, task_id: int = 0, **kwargs: Any) -> None:
        task = self.tasks.get(task_id)
        if task is not None and kwargs.get("total") is not None:
            task.total = int(kwargs["total"])

    def advance(self, task_id: int = 0, advance: int = 0) -> None:
        task = self.tasks.get(task_id)
        if task is not None:
            task.completed += int(advance)

    def __enter__(self) -> "_PageProgress":
        return self

    def __exit__(self, *_exc: Any) -> bool:
        return False


_page_hooked: set[Any] = set()


def install_page_hook() -> None:
    """给各音源客户端的 _search 挂上「逐首回调」。

    为什么不是「一页回调」：musicdl 的分页是并发的，各页耗时接近，
    按页推等于最后一起到，用户还是要干等。真正的颗粒度在页内——
    `_search` 每解析出一首就往 song_infos 里 append 一次。
    这里用一个轻量观察线程盯着列表长度，有新元素就立刻推给前端。

    只在类上包一次；回调通过 progress.on_items 传递，所以同一个客户端
    被不同关键词并发使用时不会串味。
    """
    try:
        from musicdl.modules import sources as sources_module
    except Exception:
        return

    for meta in SOURCES.values():
        cls = getattr(sources_module, meta["client"], None)
        if cls is None or cls in _page_hooked:
            continue
        _page_hooked.add(cls)
        original = cls._search

        def make(inner: Any) -> Any:
            def patched(self: Any, *args: Any, **kwargs: Any) -> Any:
                progress = args[4] if len(args) > 4 else kwargs.get("progress")
                bucket = args[3] if len(args) > 3 else kwargs.get("song_infos")
                notify = getattr(progress, "on_items", None)
                if notify is None or bucket is None:
                    return inner(self, *args, **kwargs)

                stop = threading.Event()
                cursor = {"at": 0}

                def drain() -> None:
                    try:
                        size = len(bucket)
                    except Exception:
                        return
                    if size <= cursor["at"]:
                        return
                    chunk = list(bucket[cursor["at"] : size])
                    cursor["at"] = size
                    if chunk:
                        try:
                            notify(chunk)
                        except Exception:
                            pass

                def watch() -> None:
                    while not stop.wait(0.12):
                        drain()

                watcher = threading.Thread(target=watch, daemon=True)
                watcher.start()
                try:
                    return inner(self, *args, **kwargs)
                finally:
                    stop.set()
                    drain()

            return patched

        cls._search = make(original)


# ---------------------------------------------------------------------------
# SongInfo 缓存
# ---------------------------------------------------------------------------
_token_lock = threading.Lock()
_tokens: dict[str, SongInfo] = {}
_token_by_id: dict[str, str] = {}


def stable_id(source: str, song_info: SongInfo) -> str:
    """稳定 id：跨引擎重启不变，用于本地库去重与歌单引用。

    注意 identifier 在不同音源里可能是 int（数字歌曲 id），不能直接 .strip()。
    """
    identifier = _clean(song_info.identifier)
    if identifier:
        return f"{source}:{identifier}"
    raw = f"{song_info.song_name or ''}|{song_info.singers or ''}|{song_info.album or ''}"
    return f"{source}:{hashlib.md5(raw.encode('utf-8')).hexdigest()[:16]}"


def _as_int(value: Any, default: int = 0) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


_NULLISH = {"null", "none", "nil", "undefined", "n/a", "na"}


def _clean(value: Any) -> str:
    """musicdl 各源在缺字段时有的返回 None，有的返回字符串 "NULL"，统一成空串。"""
    if value is None:
        return ""
    text = str(value).strip()
    return "" if text.lower() in _NULLISH else text


def remember(source: str, song_info: SongInfo) -> str:
    sid = stable_id(source, song_info)
    with _token_lock:
        token = _token_by_id.get(sid) or uuid.uuid4().hex
        _tokens[token] = song_info
        _token_by_id[sid] = token
    return token


def song_payload(source: str, song_info: SongInfo) -> dict[str, Any]:
    duration_s = _as_int(song_info.duration_s)
    return {
        "id": stable_id(source, song_info).split(":", 1)[1],
        "token": remember(source, song_info),
        "name": _clean(song_info.song_name),
        "singers": _clean(song_info.singers),
        "album": _clean(song_info.album),
        "ext": _clean(song_info.ext or "mp3").lstrip("."),
        "durationMs": duration_s * 1000,
        "sizeBytes": _as_int(song_info.file_size_bytes),
        "bitrate": _as_int(song_info.bitrate),
        "codec": _clean(song_info.codec),
        "coverUrl": _clean(song_info.cover_url),
        "hasUrl": bool(song_info.with_valid_download_url),
        "protocol": _clean(song_info.protocol or "HTTP").upper(),
    }


# ---------------------------------------------------------------------------
# 模糊匹配：引擎重启后 token 丢失，按元信息重新定位同一首歌
# ---------------------------------------------------------------------------
def _norm(text: str) -> str:
    return "".join(ch for ch in (text or "").lower() if ch.isalnum() or "\u4e00" <= ch <= "\u9fff")


def pick_best(target: dict[str, Any], items: list[SongInfo]) -> SongInfo | None:
    name = _norm(target.get("name", ""))
    artists = [_norm(a) for a in str(target.get("artists", "")).replace("/", ",").split(",") if a.strip()]
    duration = int(target.get("durationMs") or 0)
    best, best_score = None, 0.0
    for item in items:
        item_name = _norm(item.song_name or "")
        if not item_name:
            continue
        score = 0.0
        if item_name == name:
            score += 60
        elif name and (name in item_name or item_name in name):
            score += 35
        else:
            continue
        item_singers = _norm(item.singers or "")
        if artists and any(a and (a in item_singers or item_singers in a) for a in artists):
            score += 30
        if duration and item.duration_s:
            diff = abs(int(item.duration_s * 1000) - duration)
            if diff < 5000:
                score += 10
            elif diff > 30000:
                score -= 15
        if score > best_score:
            best, best_score = item, score
    return best if best_score >= 60 else None


def resolve_song_info(params: dict[str, Any]) -> tuple[str, SongInfo]:
    source = params.get("source") or ""
    token = params.get("token") or ""
    if token:
        with _token_lock:
            cached = _tokens.get(token)
        if cached is not None:
            return source, cached

    keyword = params.get("keyword") or ""
    if not keyword:
        name = (params.get("name") or "").strip()
        artist = (params.get("artists") or "").strip()
        keyword = f"{name} {artist}".strip()
    if not keyword:
        raise EngineError("invalid", "缺少歌曲信息，无法定位资源")

    client = get_client(source, int(params.get("size") or 12))
    items = client.search(keyword=keyword, num_threadings=4, request_overrides={})
    matched = pick_best(params, items)
    if matched is None:
        raise EngineError("notfound", f"{SOURCES[source]['label']} 未找到匹配曲目")
    return source, matched


# ---------------------------------------------------------------------------
# 命令实现
# ---------------------------------------------------------------------------
def cmd_ping(_params: dict[str, Any]) -> dict[str, Any]:
    return {
        "version": getattr(_musicdl_pkg, "__version__", "unknown"),
        "python": sys.version.split()[0],
        "executable": sys.executable,
        "workDir": WORK_DIR,
        "sources": [{"key": key, "label": meta["label"]} for key, meta in SOURCES.items()],
    }


def cmd_search(params: dict[str, Any]) -> dict[str, Any]:
    source = params.get("source") or ""
    keyword = (params.get("keyword") or "").strip()
    page = max(1, int(params.get("page") or 1))
    # 引擎音源的搜索成本很高（每个结果都要解析出真实地址），
    # 一页 10 条在分页并行后仍需 6~10 秒；再往上加只会让用户盯着骨架屏。
    limit = max(1, min(int(params.get("limit") or ENGINE_PAGE_SIZE), ENGINE_PAGE_SIZE))
    if not keyword:
        return {"items": [], "total": 0, "page": page, "hasMore": False}

    cache_key = (source, keyword, page, limit)
    request_id = params.get("_requestId")
    cached = _search_cache.get(cache_key)
    if cached and time.time() - cached[0] < SEARCH_CACHE_TTL:
        return cached[1]

    # 同一个关键词并发进来时只打一次平台接口，后到的等前一个的结果。
    with _search_lock(cache_key):
        cached = _search_cache.get(cache_key)
        if cached and time.time() - cached[0] < SEARCH_CACHE_TTL:
            return cached[1]
        return _run_search(source, keyword, page, limit, cache_key, request_id)


def _run_search(
    source: str,
    keyword: str,
    page: int,
    limit: int,
    cache_key: tuple[str, str, int, int],
    request_id: int | None = None,
) -> dict[str, Any]:
    # musicdl 的召回条数在构造期固化，翻页只能「多召回再切片」。
    # 最多翻到第 2 页（20 条），再往后召回成本不值得。
    want = min(limit * min(page, 2), ENGINE_MAX_RESULTS)
    client = get_client(source, want)
    started = time.time()

    # 流式：每解析完一页就把这一页推给前端，先看到的先用。
    # 页内重复（同一首歌在多个页出现）在这里顺手去掉。
    progress = None
    seen: set[str] = set()
    if request_id is not None:

        def on_items(bucket: list[Any]) -> None:
            fresh: list[dict[str, Any]] = []
            for song_info in bucket:
                try:
                    payload = song_payload(source, song_info)
                except Exception:
                    continue
                if payload["id"] in seen:
                    continue
                seen.add(payload["id"])
                fresh.append(payload)
            if fresh:
                _emit({"event": "partial", "id": request_id, "items": fresh})

        progress = _PageProgress(on_items)

    # 单源搜索可能因为平台重试而拖到一两分钟，UI 不能无限等：
    # 超时就返回空结果 + timeout 错误码，让播放器走「换源」而不是卡住。
    # 线程数与分页数对齐（10 条 / 每页 2~3 条 = 4~5 页），多出来的线程没有页可跑。
    submit_kwargs: dict[str, Any] = {
        "keyword": keyword,
        "num_threadings": 6,
        "request_overrides": {},
    }
    if progress is not None:
        submit_kwargs["main_process_context"] = progress
    future = SEARCH_POOL.submit(client.search, **submit_kwargs)
    try:
        items = future.result(timeout=SEARCH_TIMEOUT)
    except FuturesTimeout:
        raise EngineError("timeout", f"{SOURCES[source]['label']} 搜索超时（>{SEARCH_TIMEOUT}s）")

    payload = [song_payload(source, item) for item in items if item.song_name]
    total = len(payload)
    start = (page - 1) * limit
    result = {
        "items": payload[start : start + limit],
        "total": total,
        "page": page,
        "hasMore": page < 2 and start + limit < total,
        "cost": int((time.time() - started) * 1000),
    }
    _search_cache[cache_key] = (time.time(), result)
    if len(_search_cache) > 200:
        oldest = min(_search_cache.items(), key=lambda kv: kv[1][0])[0]
        _search_cache.pop(oldest, None)
        # 顺带回收锁；正在被持有的锁不能删，否则会破坏互斥
        stale = _search_locks.get(oldest)
        if stale is not None and not stale.locked():
            with _search_locks_guard:
                if not stale.locked():
                    _search_locks.pop(oldest, None)
    return result


def cmd_resolve(params: dict[str, Any]) -> dict[str, Any]:
    source, song_info = resolve_song_info(params)
    if not song_info.with_valid_download_url:
        raise EngineError("blocked", f"{SOURCES[source]['label']} 未返回可用播放地址")
    url = song_info.download_url
    if not isinstance(url, str) or not url.startswith("http"):
        raise EngineError("unsupported", "该音源返回的是加密流，当前引擎无法直连")
    return {
        "url": url,
        "headers": dict(song_info.default_download_headers or {}),
        "cookies": dict(song_info.default_download_cookies or {}),
        "ext": (song_info.ext or "mp3").lstrip("."),
        "size": int(song_info.file_size_bytes or 0),
        "bitrate": int(song_info.bitrate or 0),
        "codec": song_info.codec or "",
        "protocol": (song_info.protocol or "HTTP").upper(),
        "token": remember(source, song_info),
        "lyric": song_info.lyric or "",
        "coverUrl": song_info.cover_url or "",
    }


def cmd_lyric(params: dict[str, Any]) -> dict[str, Any]:
    """歌词：musicdl 在解析播放地址时顺带回填 SongInfo.lyric，这里直接取。

    拿不到就返回空串，播放器侧会走 LRCLIB 兜底（catalog.lyric 已实现）。
    """
    source, song_info = resolve_song_info(params)
    return {"lyric": song_info.lyric or "", "source": SOURCES[source]["label"]}


def cmd_download(params: dict[str, Any]) -> dict[str, Any]:
    """引擎侧下载：目前只给 HLS（m3u8）用。

    HTTP 直链由主进程的 DownloadManager 自己流式下载——那样才能复用断点续传、
    取消语义和统一的进度模型；HLS 需要合并分片，交给 musicdl 的 HLSDownloader。
    """
    source, song_info = resolve_song_info(params)
    target = params.get("path") or ""
    task_id = params.get("taskId") or uuid.uuid4().hex
    if not target:
        raise EngineError("invalid", "缺少目标路径")
    if not song_info.with_valid_download_url:
        raise EngineError("blocked", "没有可用的下载地址")

    from musicdl.modules.utils.hls import HLSDownloader

    os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
    last = {"at": 0.0}

    class _Progress:
        """把 HLSDownloader 的 rich Progress 调用翻译成协议事件。"""

        def __init__(self) -> None:
            self.tasks: dict[int, Any] = {}

        def add_task(self, *_a: Any, **_kw: Any) -> int:
            return 1

        def update(self, _task_id: int = 0, **kwargs: Any) -> None:
            total = kwargs.get("total")
            completed = kwargs.get("completed")
            if total:
                last["total"] = int(total)
            if completed is not None:
                last["received"] = int(completed)
            self._flush()

        def advance(self, _task_id: int = 0, advance: int = 0) -> None:
            last["received"] = int(last.get("received", 0)) + int(advance)
            self._flush()

        def _flush(self) -> None:
            now = time.time()
            if now - last["at"] < 0.3:
                return
            last["at"] = now
            _emit(
                {
                    "event": "progress",
                    "taskId": task_id,
                    "received": int(last.get("received", 0)),
                    "total": int(last.get("total", 0)),
                }
            )

    progress = _Progress()
    downloader = HLSDownloader(
        output_dir=os.path.dirname(target) or ".",
        headers=dict(song_info.default_download_headers or {}),
        cookies=dict(song_info.default_download_cookies or {}),
        disable_print=True,
    )
    downloader.download(song_info.download_url, target, quality="best", keep_temp=False, remux=True, progress=progress, progress_id=1)
    size = os.path.getsize(target) if os.path.exists(target) else 0
    _emit({"event": "progress", "taskId": task_id, "received": size, "total": size, "done": True})
    return {"path": target, "size": size}


def cmd_tag(params: dict[str, Any]) -> dict[str, Any]:
    """写入音频标签（ID3v2 / MP4 / Vorbis / APE）。

    复用 musicdl 依赖里的 mutagen，避免为了打标签再引入一个 npm 包；
    失败不抛错——标签是锦上添花，不能让一次成功的下载变成失败。
    """
    path = params.get("path") or ""
    if not path or not os.path.exists(path):
        raise EngineError("notfound", "文件不存在")
    title = params.get("title") or ""
    artists = params.get("artists") or ""
    album = params.get("album") or ""
    lyric = params.get("lyric") or ""
    track = params.get("track")
    ext = os.path.splitext(path)[1].lower()

    try:
        if ext == ".mp3":
            from mutagen.id3 import ID3, TIT2, TPE1, TALB, USLT, TRCK
            from mutagen.mp3 import MP3

            audio = MP3(path)
            if audio.tags is None:
                audio.add_tags()
            tags = audio.tags
            tags.delall("TIT2")
            tags.add(TIT2(encoding=3, text=title))
            tags.delall("TPE1")
            tags.add(TPE1(encoding=3, text=artists))
            tags.delall("TALB")
            tags.add(TALB(encoding=3, text=album))
            if track:
                tags.delall("TRCK")
                tags.add(TRCK(encoding=3, text=str(track)))
            if lyric:
                tags.delall("USLT")
                tags.add(USLT(encoding=3, lang="chi", desc="", text=lyric))
            audio.save()
        elif ext in {".m4a", ".mp4", ".aac"}:
            from mutagen.mp4 import MP4

            audio = MP4(path)
            audio["\xa9nam"] = [title]
            audio["\xa9ART"] = [artists]
            audio["\xa9alb"] = [album]
            if lyric:
                audio["\xa9lyr"] = [lyric]
            audio.save()
        elif ext == ".flac":
            from mutagen.flac import FLAC

            audio = FLAC(path)
            audio["title"] = title
            audio["artist"] = artists
            audio["album"] = album
            if lyric:
                audio["lyrics"] = lyric
            audio.save()
        elif ext in {".ogg", ".opus"}:
            from mutagen import File as MutagenFile

            audio = MutagenFile(path)
            if audio is not None:
                audio["title"] = title
                audio["artist"] = artists
                audio["album"] = album
                if lyric:
                    audio["lyrics"] = lyric
                audio.save()
        elif ext in {".wav"}:
            # WAV 的标签支持依赖 RIFF INFO 块，收益低、兼容性差，跳过
            return {"ok": True, "skipped": "wav"}
        else:
            return {"ok": True, "skipped": ext or "unknown"}
        return {"ok": True}
    except Exception as err:
        return {"ok": False, "error": str(err)}


COMMANDS = {
    "ping": cmd_ping,
    "search": cmd_search,
    "resolve": cmd_resolve,
    "lyric": cmd_lyric,
    "download": cmd_download,
    "tag": cmd_tag,
    "sources": lambda _p: {"sources": [{"key": k, "label": v["label"]} for k, v in SOURCES.items()]},
    "shutdown": lambda _p: {"ok": True},
}


# ---------------------------------------------------------------------------
# 主循环
# ---------------------------------------------------------------------------
POOL = ThreadPoolExecutor(max_workers=4, thread_name_prefix="engine")
# 搜索单独一个池：超时后调用方不再等待，但底层线程要能继续跑完并释放
SEARCH_POOL = ThreadPoolExecutor(max_workers=8, thread_name_prefix="search")
SEARCH_TIMEOUT = 45
SEARCH_CACHE_TTL = 180
ENGINE_PAGE_SIZE = 10
ENGINE_MAX_RESULTS = 20
_search_cache: dict[tuple[str, str, int, int], tuple[float, dict[str, Any]]] = {}
# 同一个关键词可能被多个入口同时请求（搜索页 + 自动换源），
# 让后到的那个等前一个跑完即可，不必再打一遍平台接口。
_search_locks: dict[tuple[str, str, int, int], threading.Lock] = {}
_search_locks_guard = threading.Lock()


def _search_lock(key: tuple[str, str, int, int]) -> threading.Lock:
    with _search_locks_guard:
        lock = _search_locks.get(key)
        if lock is None:
            lock = threading.Lock()
            _search_locks[key] = lock
        return lock
FuturesTimeout = TimeoutError


def handle(request: dict[str, Any]) -> None:
    req_id = request.get("id")
    cmd = request.get("cmd") or ""
    params = request.get("params") or {}
    handler = COMMANDS.get(cmd)
    if handler is None:
        _emit({"id": req_id, "ok": False, "error": {"code": "unsupported", "message": f"未知命令：{cmd}"}})
        return
    try:
        # 搜索支持边解析边推结果，回调要带上请求 id 才知道推给谁
        result = handler({**params, "_requestId": req_id} if cmd == "search" else params)
        _emit({"id": req_id, "ok": True, "result": result})
    except EngineError as err:
        _emit({"id": req_id, "ok": False, "error": {"code": err.code, "message": err.message}})
    except Exception as err:  # noqa: BLE001 - 引擎内部异常必须回传而不是崩进程
        _emit(
            {
                "id": req_id,
                "ok": False,
                "error": {"code": "internal", "message": str(err), "trace": traceback.format_exc(limit=3)},
            }
        )
    if cmd == "shutdown":
        os._exit(0)


def main() -> None:
    install_page_hook()
    _emit(
        {
            "event": "ready",
            "pid": os.getpid(),
            "version": getattr(_musicdl_pkg, "__version__", "unknown"),
            "python": sys.version.split()[0],
            "sources": len(SOURCES),
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
            handle(request)
            return
        POOL.submit(handle, request)
    # stdin 关闭（父进程退出或管道断开）：把在跑的任务做完再退出。
    # 不等待的话解释器会先关掉线程池，正在搜索的请求会抛
    # "cannot schedule new futures after interpreter shutdown"。
    POOL.shutdown(wait=True)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
