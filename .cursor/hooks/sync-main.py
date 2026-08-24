#!/usr/bin/env python3
"""Cursor hook: commit dirty work, then sync origin/main.

afterFileEdit / afterTabFileEdit — checkpoint commit
stop / afterAgentResponse — commit leftover, pull, push main
"""
from __future__ import annotations

import json
import os
import subprocess
import sys

BUT = r"C:\Program Files\GitButler\but.exe"
ROOT = os.environ.get("CURSOR_PROJECT_DIR") or os.getcwd()


def run(argv: list[str], timeout: int = 90) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        argv,
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=timeout,
        encoding="utf-8",
        errors="replace",
    )


def dirty() -> bool:
    r = run(["git", "status", "--porcelain"])
    return bool(r.stdout.strip())


def commit(message: str) -> bool:
    if not dirty():
        return False
    run(["git", "add", "-A"])
    if not dirty():
        return False
    msg = " ".join(message.split()).strip()[:72] or "chore: cursor edit"
    r = run(["git", "commit", "-m", msg])
    if r.returncode != 0:
        sys.stderr.write(r.stderr or r.stdout or "commit failed\n")
        return False
    if os.path.isfile(BUT):
        # Best-effort GitButler commit if the repo is in workspace mode.
        run([BUT, "commit", "-b", "main", "-m", msg], timeout=30)
    return True


def sync_main() -> None:
    pull = run(["git", "pull", "--rebase", "--autostash", "origin", "main"], timeout=120)
    if pull.returncode != 0:
        sys.stderr.write(pull.stderr or pull.stdout or "pull failed\n")
    push = run(["git", "push", "origin", "HEAD:main"], timeout=120)
    if push.returncode != 0:
        sys.stderr.write(push.stderr or push.stdout or "push failed\n")
    if os.path.isfile(BUT):
        run([BUT, "pull"], timeout=60)
        run([BUT, "push", "main"], timeout=60)


def main() -> int:
    raw = sys.stdin.read()
    try:
        data = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        data = {}
    event = str(data.get("hook_event_name") or data.get("event") or "")
    if event in ("afterFileEdit", "afterTabFileEdit"):
        path = data.get("file_path") or "files"
        commit(f"chore: cursor edit {os.path.basename(str(path))}")
    else:
        prompt = str(data.get("prompt") or data.get("user_prompt") or data.get("text") or "")
        commit(prompt or "chore: cursor agent session")
        sync_main()
    sys.stdout.write("{}\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        sys.stderr.write(f"{exc}\n")
        sys.stdout.write("{}\n")
        raise SystemExit(0)
