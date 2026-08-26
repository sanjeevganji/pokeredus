#!/usr/bin/env python3
"""PokeRedus / PokeLink terminal launcher.

No-args opens an arrow-key menu. Named subcommands are one-liners for
setup, the web UI, live battles (battle id), training, quantum, and settings.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
SETTINGS_PATH = Path(__file__).resolve().parent / "launch-settings.json"
CLI_TS = ROOT / "packages" / "cli" / "src" / "cli.ts"
PACK_MINI = ROOT / "pokeredus" / "data" / "knowledge-pack" / "knowledge-pack-mini.json"
POOL_OUT = ROOT / "packages" / "engine" / "data" / "gen9randombattle.json"
REPLAY = ROOT / "packages" / "cli" / "tests" / "fixtures" / "transcript.txt"
LIVE_STATE = ROOT / "live-state.json"

DEFAULTS: dict[str, Any] = {
    "policy": "quantum",
    "dry_run": True,
    "user": "",
    "pass": "",
    "url": "",
    "decision_log": "decisions.jsonl",
    "seed": None,
    "shots": None,
}

USAGE = """\
PokeRedus / PokeLink launcher

  python tools/pr.py                         arrow-key menu
  python tools/pr.py setup                   Node + Python KG + quantum-policy
  python tools/pr.py web                     PokeRedus web UI (detect games there)
  python tools/pr.py pokelink <battle-id>    web UI + PokeLink live
  python tools/pr.py live <battle-id>        same as pokelink
  python tools/pr.py quantum <battle-id>     live with QAOA policy
  python tools/pr.py softmax <battle-id>     live with softmax benchmark
  python tools/pr.py score [transcript]      replay a Showdown transcript
  python tools/pr.py pack [--mini]           export knowledge pack
  python tools/pr.py graph                   rebuild Python matchup graph
  python tools/pr.py train                   pack + graph
  python tools/pr.py quantum-test            unittest quantum-policy
  python tools/pr.py test                    npm test + pytest + quantum tests
  python tools/pr.py settings [k=v ...]      print or set launcher options
  python tools/pr.py list                    print menu catalog

Battle id is a Showdown room (gen9randombattle-... or battle-gen9randombattle-...).
Or detect and attach from the web UI Games page (python tools/pr.py web).
Add --send to actually send moves (default is dry-run). Extra CLI flags pass through.
"""


# ── settings ──────────────────────────────────────────────────────────

def load_settings() -> dict[str, Any]:
    data = dict(DEFAULTS)
    if SETTINGS_PATH.exists():
        try:
            data.update(json.loads(SETTINGS_PATH.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError):
            pass
    for key, env in (
        ("user", "POKELINK_USER"),
        ("pass", "POKELINK_PASS"),
        ("url", "POKELINK_URL"),
        ("policy", "POKEREDUS_POLICY"),
    ):
        val = os.environ.get(env)
        if val:
            data[key] = val
    if data.get("policy") not in ("quantum", "softmax"):
        data["policy"] = "quantum"
    return data


def save_settings(data: dict[str, Any]) -> None:
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    blob = {k: data.get(k, DEFAULTS[k]) for k in DEFAULTS}
    SETTINGS_PATH.write_text(json.dumps(blob, indent=2) + "\n", encoding="utf-8")


def apply_kv(data: dict[str, Any], token: str) -> None:
    if "=" not in token:
        raise ValueError(f"expected key=value, got {token!r}")
    key, raw = token.split("=", 1)
    if key not in DEFAULTS:
        raise ValueError(f"unknown setting {key!r}")
    if key in ("dry_run",):
        data[key] = raw.lower() in ("1", "true", "on", "yes")
    elif key in ("seed", "shots"):
        data[key] = None if raw in ("", "none", "null") else int(raw)
    else:
        data[key] = raw


# ── process helpers ───────────────────────────────────────────────────

def which_cmd(name: str) -> str:
    found = shutil.which(name)
    if found:
        return found
    if os.name == "nt":
        for extra in (f"{name}.cmd", f"{name}.exe", f"{name}.bat"):
            found = shutil.which(extra)
            if found:
                return found
    return name


def child_env(*, relax_tls: bool = False) -> dict[str, str]:
    env = os.environ.copy()
    env.setdefault("POKEREDUS_PYTHON", sys.executable)
    env.setdefault("POKELINK_STATE", str(LIVE_STATE))
    if relax_tls:
        # ponytail: intercepted TLS on some Windows boxes breaks undici/ws verify. Set NODE_EXTRA_CA_CERTS to drop this.
        env.setdefault("NODE_TLS_REJECT_UNAUTHORIZED", "0")
    return env


def prepare_argv(argv: list[str]) -> list[str]:
    """Run .cmd shims through cmd.exe so shell=True is never needed."""
    if os.name != "nt" or not argv:
        return argv
    first = argv[0]
    suffix = Path(first).suffix.lower()
    name = Path(first).name.lower()
    if suffix in (".cmd", ".bat") or name in ("npm", "npx", "npm.cmd", "npx.cmd"):
        # `/c call` so a quoted path under Program Files is not stripped by cmd.
        return [os.environ.get("COMSPEC", "cmd.exe"), "/c", "call", *argv]
    return argv


def fmt_cmd(argv: list[str]) -> str:
    if os.name == "nt":
        return subprocess.list2cmdline(argv)
    import shlex
    return shlex.join(argv)


def run_cmd(argv: list[str], *, cwd: Path = ROOT, pause: bool = False, env: dict[str, str] | None = None) -> int:
    print(f"$ {fmt_cmd(argv)}")
    try:
        proc = subprocess.run(prepare_argv(argv), cwd=str(cwd), env=env or child_env())
        code = proc.returncode
    except OSError as exc:
        print(exc)
        code = 127
    if pause:
        try:
            input("\nPress Enter to return to the menu...")
        except EOFError:
            pass
    return code


def spawn_detached(argv: list[str], *, cwd: Path = ROOT, env: dict[str, str] | None = None) -> subprocess.Popen:
    kwargs: dict[str, Any] = {"cwd": str(cwd), "env": env or child_env()}
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.CREATE_NEW_CONSOLE
    else:
        kwargs["start_new_session"] = True
    print(f"$ {fmt_cmd(argv)}   (detached)")
    return subprocess.Popen(prepare_argv(argv), **kwargs)


def npm(*args: str) -> list[str]:
    return [which_cmd("npm"), *args]


def npx(*args: str) -> list[str]:
    return [which_cmd("npx"), *args]


def cli(*args: str) -> list[str]:
    return npx("tsx", str(CLI_TS), *args)


# ── live / pokelink argv ──────────────────────────────────────────────

def live_argv(
    battle: str,
    *,
    policy: str | None = None,
    dry_run: bool | None = None,
    extra: list[str] | None = None,
) -> list[str]:
    s = load_settings()
    mode = policy or s["policy"]
    argv = cli("live", "--battle", battle, "--policy", mode)
    send = extra is not None and "--send" in extra
    rest = [a for a in (extra or []) if a != "--send"]
    use_dry = False if send else (s["dry_run"] if dry_run is None else dry_run)
    if use_dry:
        argv.append("--dry-run")
    if s.get("user"):
        argv.extend(["--user", str(s["user"])])
        if s.get("pass"):
            argv.extend(["--pass", str(s["pass"])])
    if s.get("url"):
        argv.extend(["--url", str(s["url"])])
    if s.get("decision_log"):
        argv.extend(["--decision-log", str(s["decision_log"])])
    argv.extend(["--live-state", str(LIVE_STATE)])
    if s.get("seed") is not None and s["seed"] != "":
        argv.extend(["--seed", str(s["seed"])])
    if s.get("shots") is not None and s["shots"] != "":
        argv.extend(["--shots", str(s["shots"])])
    argv.extend(rest)
    return argv


def need_battle(args: list[str], name: str) -> str | None:
    if not args or args[0].startswith("-"):
        print(f"usage: python tools/pr.py {name} <battle-id> [--send] [cli flags...]")
        return None
    return args[0]


# ── command catalog (also drives the TUI) ─────────────────────────────

def action_setup_node() -> list[tuple[list[str], Path]]:
    return [(npm("install"), ROOT)]


def action_setup_python() -> list[tuple[list[str], Path]]:
    return [([sys.executable, "-m", "pip", "install", "-e", "./pokeredus[dev]"], ROOT)]


def action_setup_quantum() -> list[tuple[list[str], Path]]:
    return [([sys.executable, "-m", "pip", "install", "-e", "./quantum-policy"], ROOT)]


def action_setup_all() -> list[tuple[list[str], Path]]:
    return action_setup_node() + action_setup_python() + action_setup_quantum()


def action_web() -> list[tuple[list[str], Path]]:
    return [(npm("run", "dev", "-w", "@pokeredus/web"), ROOT)]


def action_graph() -> list[tuple[list[str], Path]]:
    return [([sys.executable, "scripts/build_graph.py"], ROOT / "pokeredus")]


def action_pack_py(mini: bool = False) -> list[tuple[list[str], Path]]:
    argv = [sys.executable, "scripts/export_knowledge_pack.py"]
    if mini:
        argv.append("--mini")
    return [(argv, ROOT / "pokeredus")]


def action_fetch() -> list[tuple[list[str], Path]]:
    cwd = ROOT / "pokeredus"
    return [
        ([sys.executable, "scripts/fetch_moves.py"], cwd),
        ([sys.executable, "scripts/fetch_base_stats.py"], cwd),
    ]


def action_sprites() -> list[tuple[list[str], Path]]:
    cwd = ROOT / "pokeredus"
    return [
        ([sys.executable, "scripts/download_sprites.py"], cwd),
        ([sys.executable, "scripts/download_item_sprites.py"], cwd),
    ]


def action_pytest() -> list[tuple[list[str], Path]]:
    return [([sys.executable, "-m", "pytest", "tests/test_matchup_graph_8attr.py",
              "tests/test_matchup_graph_view.py", "tests/test_attribute_engine.py",
              "tests/test_phase5.py", "tests/test_game_state.py"], ROOT / "pokeredus")]


def action_pool() -> list[tuple[list[str], Path]]:
    return [(cli("generate-pool", "--samples", "200", "--seed", "1", "--out", str(POOL_OUT)), ROOT)]


def action_pack_ts(mini: bool = False) -> list[tuple[list[str], Path]]:
    argv = cli("export-pack")
    if mini:
        argv.append("--mini")
    return [(argv, ROOT)]


def action_render() -> list[tuple[list[str], Path]]:
    return [(cli("render-pack", "--pack", str(PACK_MINI)), ROOT)]


def action_score(transcript: str | None = None) -> list[tuple[list[str], Path]]:
    s = load_settings()
    path = transcript or str(REPLAY)
    argv = cli("score", "--replay", path, "--pool", str(POOL_OUT), "--policy", s["policy"], "--dry-run")
    if s.get("decision_log"):
        argv.extend(["--decision-log", str(s["decision_log"])])
    return [(argv, ROOT)]


def action_quantum_test() -> list[tuple[list[str], Path]]:
    return [([sys.executable, "-m", "unittest", "discover", "-s", "quantum-policy/tests"], ROOT)]


def action_npm_test() -> list[tuple[list[str], Path]]:
    return [(npm("test"), ROOT)]


def action_typecheck() -> list[tuple[list[str], Path]]:
    return [(npm("run", "typecheck"), ROOT)]


def action_build() -> list[tuple[list[str], Path]]:
    return [(npm("run", "build"), ROOT)]


def action_verify() -> list[tuple[list[str], Path]]:
    return action_npm_test() + action_typecheck() + action_build() + action_quantum_test() + action_pytest()


def action_train() -> list[tuple[list[str], Path]]:
    return action_pool() + action_pack_ts() + action_graph()


def run_jobs(jobs: list[tuple[list[str], Path]], *, pause: bool = False) -> int:
    code = 0
    for argv, cwd in jobs:
        code = run_cmd(argv, cwd=cwd, pause=False)
        if code:
            break
    if pause:
        try:
            input("\nPress Enter to return to the menu...")
        except EOFError:
            pass
    return code


# ── TUI catalog ───────────────────────────────────────────────────────
# kind: submenu | run | live | setting-cycle | setting-text | setting-int | back

MENUS: dict[str, list[dict[str, Any]]] = {
    "main": [
        {"label": "Setup", "kind": "submenu", "to": "setup",
         "help": "Install Node workspaces, Python KG, and quantum-policy"},
        {"label": "PokeRedus", "kind": "submenu", "to": "pokeredus",
         "help": "Web UI, graph and pack exporters"},
        {"label": "PokeLink", "kind": "submenu", "to": "pokelink",
         "help": "Replay score and pack tools; live battles attach from the web UI"},
        {"label": "Train / update models", "kind": "submenu", "to": "train",
         "help": "Pool, knowledge pack, matchup graph, Showdown data"},
        {"label": "Quantum", "kind": "submenu", "to": "quantum",
         "help": "PennyLane QAOA install, tests, live quantum vs softmax"},
        {"label": "Maintain", "kind": "submenu", "to": "maintain",
         "help": "Tests, typecheck, build"},
        {"label": "Settings", "kind": "submenu", "to": "settings",
         "help": "Policy, dry-run, Showdown account, decision log, QAOA"},
        {"label": "Quit", "kind": "quit"},
    ],
    "setup": [
        {"label": "Install Node workspaces", "kind": "run", "jobs": "setup_node"},
        {"label": "Install Python KG (pokeredus[dev])", "kind": "run", "jobs": "setup_python"},
        {"label": "Install quantum-policy (PennyLane)", "kind": "run", "jobs": "setup_quantum"},
        {"label": "Install everything", "kind": "run", "jobs": "setup_all"},
        {"label": "Back", "kind": "back"},
    ],
    "pokeredus": [
        {"label": "Launch web UI", "kind": "run", "jobs": "web"},
        {"label": "Build matchup graph", "kind": "run", "jobs": "graph"},
        {"label": "Export knowledge pack (Python)", "kind": "run", "jobs": "pack_py"},
        {"label": "Export mini knowledge pack (Python)", "kind": "run", "jobs": "pack_py_mini"},
        {"label": "Fetch moves + base stats", "kind": "run", "jobs": "fetch"},
        {"label": "Download sprites", "kind": "run", "jobs": "sprites"},
        {"label": "Python tests", "kind": "run", "jobs": "pytest"},
        {"label": "Back", "kind": "back"},
    ],
    "pokelink": [
        {"label": "Score replay transcript", "kind": "run", "jobs": "score"},
        {"label": "Render knowledge pack", "kind": "run", "jobs": "render"},
        {"label": "Generate Random Battle pool", "kind": "run", "jobs": "pool"},
        {"label": "Export knowledge pack (TS)", "kind": "run", "jobs": "pack_ts"},
        {"label": "CLI tests", "kind": "run", "jobs": "cli_test"},
        {"label": "Back", "kind": "back"},
    ],
    "train": [
        {"label": "Generate Random Battle pool", "kind": "run", "jobs": "pool"},
        {"label": "Export knowledge pack (TS)", "kind": "run", "jobs": "pack_ts"},
        {"label": "Export knowledge pack (Python KG)", "kind": "run", "jobs": "pack_py"},
        {"label": "Rebuild matchup graph", "kind": "run", "jobs": "graph"},
        {"label": "Fetch Showdown moves + stats", "kind": "run", "jobs": "fetch"},
        {"label": "Score replay -> decision log", "kind": "run", "jobs": "score"},
        {"label": "Run all of the above (pool + pack + graph)", "kind": "run", "jobs": "train"},
        {"label": "Back", "kind": "back"},
    ],
    "quantum": [
        {"label": "Install quantum-policy", "kind": "run", "jobs": "setup_quantum"},
        {"label": "Run quantum-policy tests", "kind": "run", "jobs": "quantum_test"},
        {"label": "Live battle - quantum", "kind": "live", "policy": "quantum", "dry_run": True},
        {"label": "Live battle - quantum (send moves)", "kind": "live", "policy": "quantum", "dry_run": False},
        {"label": "Live battle - softmax benchmark", "kind": "live", "policy": "softmax", "dry_run": True},
        {"label": "Back", "kind": "back"},
    ],
    "maintain": [
        {"label": "npm test", "kind": "run", "jobs": "npm_test"},
        {"label": "npm typecheck", "kind": "run", "jobs": "typecheck"},
        {"label": "npm build", "kind": "run", "jobs": "build"},
        {"label": "Python tests", "kind": "run", "jobs": "pytest"},
        {"label": "Quantum tests", "kind": "run", "jobs": "quantum_test"},
        {"label": "Full verify (test + typecheck + build + pytest + quantum)", "kind": "run", "jobs": "verify"},
        {"label": "Back", "kind": "back"},
    ],
}

JOBS = {
    "setup_node": action_setup_node,
    "setup_python": action_setup_python,
    "setup_quantum": action_setup_quantum,
    "setup_all": action_setup_all,
    "web": action_web,
    "graph": action_graph,
    "pack_py": action_pack_py,
    "pack_py_mini": lambda: action_pack_py(True),
    "fetch": action_fetch,
    "sprites": action_sprites,
    "pytest": action_pytest,
    "pool": action_pool,
    "pack_ts": action_pack_ts,
    "pack_ts_mini": lambda: action_pack_ts(True),
    "render": action_render,
    "score": action_score,
    "quantum_test": action_quantum_test,
    "npm_test": action_npm_test,
    "typecheck": action_typecheck,
    "build": action_build,
    "verify": action_verify,
    "train": action_train,
    "cli_test": lambda: [(npm("test", "-w", "@pokeredus/cli"), ROOT)],
}

SETTING_ROWS = [
    {"key": "policy", "label": "Policy", "kind": "cycle", "values": ["quantum", "softmax"]},
    {"key": "dry_run", "label": "Dry-run (log, do not send)", "kind": "cycle", "values": [True, False]},
    {"key": "user", "label": "Showdown user (empty = guest)", "kind": "text"},
    {"key": "pass", "label": "Showdown password", "kind": "secret"},
    {"key": "url", "label": "Showdown websocket URL", "kind": "text"},
    {"key": "decision_log", "label": "Decision log JSONL", "kind": "text"},
    {"key": "seed", "label": "Policy / pool seed (empty = none)", "kind": "int"},
    {"key": "shots", "label": "QAOA shots (empty = exact)", "kind": "int"},
]


# ── keys ──────────────────────────────────────────────────────────────

def enable_vt() -> None:
    if os.name != "nt":
        return
    try:
        import ctypes
        handle = ctypes.windll.kernel32.GetStdHandle(-11)
        mode = ctypes.c_uint()
        if ctypes.windll.kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
            ctypes.windll.kernel32.SetConsoleMode(handle, mode.value | 0x0004)
    except Exception:
        pass


def read_key() -> str:
    """Return up/down/left/right/enter/esc/back/quit/other."""
    if os.name == "nt":
        import msvcrt
        ch = msvcrt.getch()
        if ch in (b"\x00", b"\xe0"):
            ch2 = msvcrt.getch()
            return {b"H": "up", b"P": "down", b"K": "left", b"M": "right"}.get(ch2, "other")
        if ch in (b"\r", b"\n"):
            return "enter"
        if ch == b"\x1b":
            return "esc"
        if ch == b"\x08":
            return "back"
        if ch in (b"q", b"Q"):
            return "quit"
        return "other"
    import termios
    import tty
    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    try:
        tty.setraw(fd)
        ch = sys.stdin.read(1)
        if ch == "\x1b":
            nxt = sys.stdin.read(1)
            if nxt == "[":
                arrow = sys.stdin.read(1)
                return {"A": "up", "B": "down", "C": "right", "D": "left"}.get(arrow, "esc")
            return "esc"
        if ch in ("\r", "\n"):
            return "enter"
        if ch in ("\x7f", "\b"):
            return "back"
        if ch in ("q", "Q"):
            return "quit"
        if ch == "\x03":
            raise KeyboardInterrupt
        return "other"
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)


def clear() -> None:
    os.system("cls" if os.name == "nt" else "clear")


def show_cursor(on: bool) -> None:
    sys.stdout.write("\033[?25h" if on else "\033[?25l")
    sys.stdout.flush()


def prompt(msg: str, *, secret: bool = False) -> str:
    show_cursor(True)
    try:
        if secret:
            import getpass
            return getpass.getpass(msg)
        return input(msg)
    except EOFError:
        return ""
    finally:
        show_cursor(False)


def fmt_setting(key: str, value: Any) -> str:
    if key == "pass":
        return "(set)" if value else "(empty)"
    if value is None or value == "":
        return "(empty)"
    if isinstance(value, bool):
        return "on" if value else "off"
    return str(value)


# ── TUI ───────────────────────────────────────────────────────────────

def banner() -> str:
    s = load_settings()
    user = s.get("user") or "guest"
    dry = "on" if s.get("dry_run") else "off"
    return (
        "  PokeRedus / PokeLink launcher\n"
        f"  policy={s.get('policy')}  dry-run={dry}  user={user}\n"
        "  arrows move   enter select   esc/back back   q quit\n"
    )


def draw(title: str, labels: list[str], idx: int, help_text: str = "") -> None:
    clear()
    print(banner())
    print(f"  {title}")
    print("  " + "-" * max(24, len(title)))
    for i, label in enumerate(labels):
        mark = ">" if i == idx else " "
        if i == idx and sys.stdout.isatty():
            print(f"  {mark} \033[7m {label} \033[0m")
        else:
            print(f"  {mark}  {label}")
    if help_text:
        print()
        print(f"  {help_text}")


def pick_menu(name: str) -> dict[str, Any] | None:
    items = MENUS[name]
    idx = 0
    title = {
        "main": "Main",
        "setup": "Setup",
        "pokeredus": "PokeRedus",
        "pokelink": "PokeLink",
        "train": "Train / update models",
        "quantum": "Quantum",
        "maintain": "Maintain",
    }[name]
    while True:
        labels = [it["label"] for it in items]
        help_text = items[idx].get("help", "")
        draw(title, labels, idx, help_text)
        key = read_key()
        if key == "up":
            idx = (idx - 1) % len(items)
        elif key == "down":
            idx = (idx + 1) % len(items)
        elif key in ("esc", "back") and name != "main":
            return None
        elif key == "quit" or (key in ("esc", "back") and name == "main"):
            return {"kind": "quit"}
        elif key == "enter":
            return items[idx]


def settings_menu() -> None:
    data = load_settings()
    idx = 0
    rows = SETTING_ROWS + [{"key": "_back", "label": "Save & back", "kind": "back"}]
    while True:
        labels = []
        for row in rows:
            if row["kind"] == "back":
                labels.append(row["label"])
            else:
                labels.append(f"{row['label']}: {fmt_setting(row['key'], data.get(row['key']))}")
        draw("Settings  (enter edit / left-right cycle)", labels, idx)
        key = read_key()
        row = rows[idx]
        if key == "up":
            idx = (idx - 1) % len(rows)
        elif key == "down":
            idx = (idx + 1) % len(rows)
        elif key in ("esc", "back", "quit"):
            save_settings(data)
            return
        elif key in ("left", "right", "enter") and row["kind"] == "cycle":
            vals = row["values"]
            cur = data.get(row["key"], vals[0])
            step = 1 if key != "left" else -1
            data[row["key"]] = vals[(vals.index(cur) + step) % len(vals)] if cur in vals else vals[0]
            save_settings(data)
        elif key == "enter" and row["kind"] == "back":
            save_settings(data)
            return
        elif key == "enter" and row["kind"] in ("text", "secret", "int"):
            raw = prompt(f"  {row['label']}: ", secret=row["kind"] == "secret")
            if row["kind"] == "int":
                data[row["key"]] = None if raw.strip() == "" else int(raw.strip())
            else:
                data[row["key"]] = raw
            save_settings(data)


def ask_battle() -> str | None:
    show_cursor(True)
    clear()
    print(banner())
    print("  Enter Showdown battle id")
    print("  (gen9randombattle-...  or  battle-gen9randombattle-...)")
    print()
    try:
        raw = input("  battle id: ").strip()
    except EOFError:
        raw = ""
    show_cursor(False)
    return raw or None


def do_integrated(
    battle: str,
    *,
    policy: str | None = None,
    dry_run: bool | None = None,
    extra: list[str] | None = None,
    pause: bool = True,
) -> int:
    """Start the web UI plus PokeLink live."""
    env = child_env(relax_tls=True)
    spawn_detached(action_web()[0][0], env=env)
    print(f"PokeLink HUD snapshot: {LIVE_STATE}")
    print("Detect and manage games from the web UI Games page.")
    return run_cmd(live_argv(battle, policy=policy, dry_run=dry_run, extra=extra), pause=pause, env=env)


def do_live(*, policy: str | None = None, dry_run: bool | None = None, pause: bool = True) -> int:
    battle = ask_battle()
    if not battle:
        return 0
    return do_integrated(battle, policy=policy, dry_run=dry_run, pause=pause)


def tui() -> int:
    enable_vt()
    show_cursor(False)
    stack = ["main"]
    try:
        while stack:
            name = stack[-1]
            if name == "settings":
                settings_menu()
                stack.pop()
                continue
            item = pick_menu(name)
            if item is None or item.get("kind") == "back":
                stack.pop()
                continue
            kind = item["kind"]
            if kind == "quit":
                return 0
            if kind == "submenu":
                stack.append(item["to"])
                continue
            if kind == "run":
                show_cursor(True)
                clear()
                jobs = JOBS[item["jobs"]]()
                run_jobs(jobs, pause=True)
                show_cursor(False)
                continue
            if kind == "live":
                show_cursor(True)
                do_live(policy=item.get("policy"), dry_run=item.get("dry_run"), pause=True)
                show_cursor(False)
                continue
        return 0
    finally:
        show_cursor(True)
        clear()


# ── CLI dispatch ──────────────────────────────────────────────────────

def cmd_settings(args: list[str]) -> int:
    data = load_settings()
    for token in args:
        try:
            apply_kv(data, token)
        except ValueError as exc:
            print(exc)
            return 2
    if args:
        save_settings(data)
        print(f"saved {SETTINGS_PATH}")
    for key in DEFAULTS:
        print(f"{key}={fmt_setting(key, data.get(key))}")
    return 0


def cmd_list() -> int:
    print("Menus:")
    for name, items in MENUS.items():
        print(f"  [{name}]")
        for it in items:
            extra = it.get("jobs") or it.get("to") or it.get("kind")
            print(f"    - {it['label']}  ({extra})")
    print("\nSettings:")
    for row in SETTING_ROWS:
        print(f"    {row['key']}: {row['label']}")
    return 0


def self_check() -> int:
    argv = live_argv("gen9randombattle-1", policy="quantum", dry_run=True)
    assert "--battle" in argv and "gen9randombattle-1" in argv
    assert "--dry-run" in argv
    assert "--live-state" in argv
    assert argv[argv.index("--policy") + 1] == "quantum"
    send = live_argv("x", dry_run=False, extra=["--send"])
    assert "--dry-run" not in send
    soft = live_argv("x", policy="softmax", dry_run=True)
    assert "softmax" in soft
    data = dict(DEFAULTS)
    apply_kv(data, "dry_run=false")
    apply_kv(data, "shots=128")
    apply_kv(data, "seed=")
    assert data["dry_run"] is False
    assert data["shots"] == 128
    assert data["seed"] is None
    for jobs in JOBS:
        JOBS[jobs]()  # builders must not raise
    assert "pokelink" in MENUS and "quantum" in MENUS and "setup" in MENUS
    assert "combined" not in MENUS
    assert all(it.get("jobs") != "gui" for items in MENUS.values() for it in items)
    assert any(it.get("jobs") == "web" for it in MENUS["pokeredus"])
    assert all(it.get("kind") != "live" for it in MENUS["pokelink"])
    pip = action_setup_python()[0][0]
    assert pip[-1] == "./pokeredus[dev]"
    if os.name == "nt":
        assert prepare_argv(pip) == pip
        wrapped = prepare_argv(npm("install"))
        assert wrapped[0].lower().endswith("cmd.exe") and wrapped[1].lower() == "/c"
    print("self-check ok")
    return 0


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(errors="replace")
        except Exception:
            pass
    args = list(sys.argv[1:] if argv is None else argv)
    if not args or args[0] in ("menu", "tui"):
        if not sys.stdin.isatty() or not sys.stdout.isatty():
            print(USAGE)
            return 2
        return tui()
    cmd = args[0]
    rest = args[1:]
    if cmd in ("-h", "--help", "help"):
        print(USAGE)
        return 0
    if cmd == "--self-check":
        return self_check()
    if cmd == "list":
        return cmd_list()
    if cmd == "settings":
        return cmd_settings(rest)
    if cmd == "setup":
        jobs = action_setup_all() if (not rest or rest == ["--all"]) else (
            action_setup_node() if rest == ["node"] else
            action_setup_python() if rest == ["python"] else
            action_setup_quantum() if rest == ["quantum"] else None
        )
        if jobs is None:
            print("usage: python tools/pr.py setup [node|python|quantum|--all]")
            return 2
        return run_jobs(jobs)
    if cmd in ("gui", "combined"):
        print("The web UI is the only UI. Use: python tools/pr.py web")
        print("Detect and manage Showdown games from the Games page.")
        return 2
    if cmd == "web":
        return run_jobs(action_web())
    if cmd in ("pokelink", "live", "quantum", "softmax"):
        battle = need_battle(rest, cmd)
        if not battle:
            return 2
        extra = rest[1:]
        policy = "softmax" if cmd == "softmax" else ("quantum" if cmd == "quantum" else None)
        return do_integrated(battle, policy=policy, extra=extra, pause=False)
    if cmd == "score":
        transcript = rest[0] if rest and not rest[0].startswith("-") else None
        return run_jobs(action_score(transcript))
    if cmd == "pool":
        return run_jobs(action_pool())
    if cmd == "pack":
        return run_jobs(action_pack_ts("--mini" in rest))
    if cmd == "graph":
        return run_jobs(action_graph())
    if cmd == "train":
        return run_jobs(action_train())
    if cmd == "quantum-test":
        return run_jobs(action_quantum_test())
    if cmd == "test":
        return run_jobs(action_verify())
    print(USAGE)
    return 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        show_cursor(True)
        print("\n[pr] interrupted")
        raise SystemExit(130)
