# -*- coding: utf-8 -*-
"""实测：musicdl 引擎能否拿到 VIP 曲目的无损直链（只探测，不落盘）"""
import json, subprocess, sys, urllib.request

BRIDGE = ["engine/.venv/Scripts/python.exe", "-u", "engine/musicdl/bridge.py",
          "--work-dir", r"C:\Windows\Temp\aurora-musicdl", "--musicdl-path", "engine/vendor/musicdl"]

def request(proc, req):
    proc.stdin.write((json.dumps(req, ensure_ascii=False) + "\n").encode("utf-8"))
    proc.stdin.flush()
    while True:
        line = proc.stdout.readline()
        if not line:
            raise RuntimeError("bridge died")
        msg = json.loads(line.decode("utf-8"))
        if msg.get("id") == req["id"]:
            return msg

def head(url, headers=None):
    req = urllib.request.Request(url, method="HEAD", headers=headers or {})
    try:
        r = urllib.request.urlopen(req, timeout=15)
        size = r.headers.get("Content-Length") or r.headers.get("Content-Range") or "?"
        ctype = r.headers.get("Content-Type", "")
        return f"HTTP {r.status} type={ctype} size={size}"
    except Exception as e:
        return f"FAIL {e}"

proc = subprocess.Popen(BRIDGE, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
request(proc, {"id": 0, "cmd": "ping", "params": {}})

CASES = [
    ("孙燕姿", "我不难过"),   # QQ/网易均为 VIP
    ("周杰伦", "晴天"),       # 全网 VIP 常青树
]
for source in ["kugou", "migu", "qianqian"]:
    for artist, name in CASES:
        req = {"id": f"{source}-{name}", "cmd": "resolve",
               "params": {"source": source, "name": name, "artists": artist}}
        msg = request(proc, req)
        if "error" in msg:
            print(f"{source:9s} {artist}-{name}: ERROR {msg['error'].get('message','')[:60]}")
            continue
        d = msg["result"]
        probe = head(d["url"], d.get("headers") or None)
        print(f"{source:9s} {artist}-{name}: ext={d['ext']} bitrate={d['bitrate']} size={d['size']/1048576:.1f}MB | HEAD {probe}")
proc.terminate()
