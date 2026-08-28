#!/usr/bin/env python3
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time

DATA = os.path.expanduser("~/Library/Application Support/komorebi")
SOCK_NAME = "sketchybar"
SOCK_PATH = os.path.join(DATA, SOCK_NAME)
PIDFILE = "/tmp/sketchybar-komorebi-events.pid"
CACHE = "/tmp/sketchybar-komorebi.json"
ICON_MAP = os.path.expanduser("~/.config/sketchybar/icon_map.sh")
ALIASES = {
    "Outlook": "Microsoft Outlook",
    "Teams": "Microsoft Teams",
    "ghostty": "Ghostty",
}
ICON_CACHE = {}
ANIM_CURVE = "tanh"
ANIM_DURATION = "16"
LAYOUTS = {
    "Bsp": "BSP",
    "Columns": "Columns",
    "Rows": "Rows",
    "VerticalStack": "V-Stack",
    "HorizontalStack": "H-Stack",
    "UltrawideVerticalStack": "Ultrawide",
    "Grid": "Grid",
    "RightMainVerticalStack": "R-Stack",
    "Scrolling": "Scroll",
}


def layout_label(w):
    if w.get("monocle_container"):
        return "Monocle"
    layout = w.get("layout") or {}
    name = layout.get("Default")
    if name:
        return LAYOUTS.get(name, name)
    if "Custom" in layout:
        return "Custom"
    return "—"


def snapshot(state):
    mon = state["monitors"]["elements"][state["monitors"]["focused"]]
    fi = mon["workspaces"]["focused"]
    rows = []
    layouts = []
    for i, w in enumerate(mon["workspaces"]["elements"]):
        seen = []
        seen_set = set()
        for c in w["containers"]["elements"]:
            for win in c["windows"]["elements"]:
                exe = (win.get("details") or {}).get("exe") or ""
                if exe and exe not in seen_set:
                    seen_set.add(exe)
                    seen.append(exe)
        for win in w.get("floating_windows", {}).get("elements", []):
            exe = (win.get("details") or {}).get("exe") or ""
            if exe and exe not in seen_set:
                seen_set.add(exe)
                seen.append(exe)
        rows.append((i, i == fi, seen))
        layouts.append(layout_label(w))
    return rows, layouts


def sig_of(rows, layouts):
    return tuple(
        (i, f, tuple(a), layouts[i] if i < len(layouts) else "")
        for i, f, a in rows
    )


def map_icons(apps):
    if not apps:
        return ""
    missing = []
    for app in apps:
        key = ALIASES.get(app, app)
        if key not in ICON_CACHE:
            missing.append(key)
    if missing:
        out = subprocess.check_output(["bash", ICON_MAP, *missing], text=True).split()
        for name, icon in zip(missing, out):
            ICON_CACHE[name] = icon
    return " ".join(ICON_CACHE[ALIASES.get(a, a)] for a in apps)


def load_cache():
    try:
        with open(CACHE) as f:
            data = json.load(f)
        rows = [(int(i), bool(f), list(a)) for i, f, a in data["rows"]]
        layouts = list(data.get("layouts") or [])
        if len(layouts) != len(rows):
            layouts = [""] * len(rows)
        return rows, layouts
    except Exception:
        return None, None


def save_cache(rows, layouts):
    with open(CACHE, "w") as f:
        json.dump(
            {
                "rows": [[i, f, a] for i, f, a in rows],
                "layouts": layouts,
            },
            f,
        )


def focused_layout(rows, layouts):
    for i, focused, _ in rows:
        if focused and i < len(layouts):
            return layouts[i]
    return layouts[0] if layouts else "—"


def apply_rows(rows, layouts, animate):
    cmd = ["sketchybar"]
    if animate:
        cmd += ["--animate", ANIM_CURVE, ANIM_DURATION]
    for idx, focused, apps in rows:
        icons = map_icons(apps)
        show = bool(icons) and not focused
        cmd += [
            "--set",
            f"space.{idx + 1}",
            f"icon.highlight={'on' if focused else 'off'}",
            f"label.highlight={'on' if focused else 'off'}",
            f"label={icons}",
            f"label.width={'dynamic' if show else '0'}",
            f"label.padding_left={'10' if show else '0'}",
            f"label.padding_right={'10' if show else '0'}",
            f"label.background.drawing={'on' if icons else 'off'}",
            "label.background.height=28",
            "drawing=on",
        ]
    cmd += [
        "--set",
        "ws_layout",
        f"label={focused_layout(rows, layouts)}",
        "drawing=on",
    ]
    subprocess.run(cmd, check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    save_cache(rows, layouts)


def komorebi_state():
    try:
        return json.loads(
            subprocess.check_output(
                ["komorebic", "state"],
                text=True,
                stderr=subprocess.DEVNULL,
            )
        )
    except Exception:
        return None


def apply_once(animate=False):
    state = komorebi_state()
    if not state:
        return
    rows, layouts = snapshot(state)
    apply_rows(rows, layouts, animate)


def select_workspace(idx):
    rows, layouts = load_cache()
    if rows is None:
        state = komorebi_state()
        if not state:
            return
        rows, layouts = snapshot(state)
    new_rows = [(i, i == idx, apps) for i, _, apps in rows]
    if sig_of(new_rows, layouts) == sig_of(rows, layouts) and load_cache()[0] is not None:
        return
    apply_rows(new_rows, layouts, animate=True)


def subscribe():
    subprocess.run(
        ["komorebic", "subscribe-socket", SOCK_NAME],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def singleton():
    if os.path.exists(PIDFILE):
        try:
            old = int(open(PIDFILE).read().strip())
            if old != os.getpid():
                os.kill(old, signal.SIGTERM)
                time.sleep(0.15)
        except (OSError, ValueError):
            pass
    with open(PIDFILE, "w") as f:
        f.write(str(os.getpid()))


def process_line(line):
    line = line.strip()
    if not line:
        return
    try:
        notification = json.loads(line)
    except json.JSONDecodeError:
        return
    state = notification.get("state")
    if not state:
        return
    try:
        rows, layouts = snapshot(state)
    except Exception:
        return
    cached_rows, cached_layouts = load_cache()
    if (
        cached_rows is not None
        and sig_of(cached_rows, cached_layouts) == sig_of(rows, layouts)
    ):
        return
    apply_rows(rows, layouts, animate=True)


def handle_conn(conn):
    buf = b""
    while True:
        chunk = conn.recv(65536)
        if not chunk:
            break
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            process_line(line.decode("utf-8", "replace"))
    if buf.strip():
        process_line(buf.decode("utf-8", "replace"))


def listen():
    singleton()
    os.makedirs(DATA, exist_ok=True)
    if os.path.exists(SOCK_PATH):
        os.unlink(SOCK_PATH)
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(SOCK_PATH)
    srv.listen(8)
    srv.settimeout(10)
    subscribe()
    t = threading.Timer(0.4, lambda: apply_once(False))
    t.daemon = True
    t.start()
    while True:
        try:
            conn, _ = srv.accept()
        except socket.timeout:
            subscribe()
            continue
        try:
            handle_conn(conn)
        except OSError:
            pass
        finally:
            conn.close()


if __name__ == "__main__":
    if "--once" in sys.argv:
        apply_once(animate=False)
    elif "--select" in sys.argv:
        i = sys.argv.index("--select")
        select_workspace(int(sys.argv[i + 1]))
    else:
        listen()
