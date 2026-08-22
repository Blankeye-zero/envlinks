"""
Typing trainer: practice on a new keyboard, track WPM, and find out
exactly which keys you keep misclicking.

Run:  python typing_trainer.py
"""

import ctypes
import json
import os
import random
import sys
import time
from pathlib import Path

STATS_FILE = Path.home() / ".typing_trainer_stats.json"

WORDS = [
    "the", "quick", "brown", "fox", "jumps", "over", "lazy", "dog", "time",
    "people", "water", "world", "life", "hand", "part", "child", "eye",
    "woman", "place", "work", "week", "case", "point", "government",
    "company", "number", "group", "problem", "fact", "money", "story",
    "example", "state", "family", "student", "country", "issue", "side",
    "kind", "head", "house", "service", "friend", "power", "hour", "game",
    "line", "end", "member", "law", "car", "city", "community", "name",
    "president", "team", "minute", "idea", "body", "information", "back",
    "parent", "face", "others", "level", "office", "door", "health",
    "person", "art", "war", "history", "party", "result", "change",
    "morning", "reason", "research", "girl", "guy", "moment", "air",
    "teacher", "force", "education", "quiz", "jazz", "zebra", "wizard",
    "puzzle", "fizzy", "buzzer", "sizzle", "dizzy", "gaze", "graze",
    "amaze", "size", "prize", "excite", "exam", "exit", "exile", "index",
    "extra", "expert", "exact", "vex", "vixen", "vivid", "avoid", "value",
    "voice", "volume", "vacuum", "quiet", "quote", "queen", "quest",
    "square", "equal", "quick", "acquire", "opaque", "juice", "jump",
    "joke", "job", "join", "judge", "juggle", "major", "enjoy", "eject",
    "object", "subject", "reject", "gadget", "budget", "widget",
    "yellow", "yesterday", "yield", "yoga", "young", "royal", "loyal",
    "keyboard", "keys", "typing", "practice", "click", "clack", "tabs",
    "shift", "control", "escape", "delete", "insert", "return", "space",
    "left", "right", "middle", "bottom", "top", "corner", "edge", "row",
    "column", "layout", "switch", "mechanical", "wireless", "battery",
    "cable", "wrist", "finger", "thumb", "pinky", "reach", "stretch",
    "posture", "comfort", "speed", "accuracy", "rhythm", "flow", "focus",
]

BACKSPACE_KEYS = ("\x08", "\x7f")
QUIT_KEYS = ("\x1b",)


# ---------- terminal setup ----------

def enable_ansi() -> None:
    if os.name != "nt":
        return
    try:
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.GetStdHandle(-11)
        mode = ctypes.c_uint32()
        kernel32.GetConsoleMode(handle, ctypes.byref(mode))
        kernel32.SetConsoleMode(handle, mode.value | 0x0004)
    except Exception:
        pass


def getch() -> str:
    if os.name == "nt":
        import msvcrt
        ch = msvcrt.getwch()
        if ch in ("\x00", "\xe0"):
            msvcrt.getwch()  # swallow extended-key second byte (arrows, F-keys, etc.)
            return ""
        return ch
    import termios
    import tty
    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    try:
        tty.setraw(fd)
        return sys.stdin.read(1)
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)


def clear_screen() -> None:
    print("\x1b[H\x1b[2J", end="")


# ---------- stats persistence ----------

def load_stats() -> dict:
    if STATS_FILE.exists():
        try:
            return json.loads(STATS_FILE.read_text())
        except Exception:
            pass
    return {"key_errors": {}, "sessions": []}


def save_stats(stats: dict) -> None:
    STATS_FILE.write_text(json.dumps(stats, indent=2))


# ---------- typing test ----------

def build_target(word_count: int, stats: dict, weak_mode: bool = False) -> str:
    key_errors = stats.get("key_errors", {})
    pool = WORDS
    if weak_mode and key_errors:
        weak_chars = sorted(
            (k for k in key_errors if k.isalpha()),
            key=lambda k: key_errors[k],
            reverse=True,
        )[:6]
        filtered = [w for w in WORDS if any(c in w for c in weak_chars)]
        if len(filtered) >= 10:
            pool = filtered
    return " ".join(random.choice(pool) for _ in range(word_count))


def colorize(target: str, states: list) -> str:
    out = []
    for i, c in enumerate(target):
        if i < len(states):
            if states[i] == "correct":
                out.append(f"\x1b[92m{c}\x1b[0m")
            else:
                shown = c if c != " " else "_"
                out.append(f"\x1b[91m\x1b[4m{shown}\x1b[0m")
        elif i == len(states):
            out.append(f"\x1b[7m{c}\x1b[0m")
        else:
            out.append(f"\x1b[2m{c}\x1b[0m")
    return "".join(out)


def run_test(target: str, stats: dict):
    states = []
    key_errors = stats.setdefault("key_errors", {})
    start_time = None
    misclicks = 0

    while len(states) < len(target):
        clear_screen()
        print("Type the text below.  Backspace to fix.  Esc to abandon this round.\n")
        print(colorize(target, states))
        if start_time is not None:
            elapsed = time.time() - start_time
            correct = sum(1 for s in states if s == "correct")
            wpm = (correct / 5) / (elapsed / 60) if elapsed > 0 else 0.0
            print(f"\n\nWPM: {wpm:5.1f}    Misclicks: {misclicks}")
        else:
            print("\n\nWPM:   0.0    Misclicks: 0")

        ch = getch()
        if ch in QUIT_KEYS:
            return None
        if ch == "\x03":
            raise KeyboardInterrupt
        if ch == "":
            continue
        if ch in ("\r", "\n"):
            continue
        if ch in BACKSPACE_KEYS:
            if states:
                states.pop()
            continue

        if start_time is None:
            start_time = time.time()

        idx = len(states)
        expected = target[idx]
        if ch == expected:
            states.append("correct")
        else:
            states.append("wrong")
            misclicks += 1
            key_errors[expected] = key_errors.get(expected, 0) + 1

    elapsed = max(time.time() - start_time, 0.001)
    correct = sum(1 for s in states if s == "correct")
    wpm = (correct / 5) / (elapsed / 60)
    accuracy = 100 * correct / len(target)
    return {
        "wpm": wpm,
        "accuracy": accuracy,
        "misclicks": misclicks,
        "elapsed": elapsed,
        "chars": len(target),
    }


# ---------- reporting ----------

KEYBOARD_ROWS = [
    "1234567890-=",
    "qwertyuiop[]",
    "asdfghjkl;'",
    "zxcvbnm,./",
]


def print_keyboard_heatmap(stats: dict) -> None:
    key_errors = stats.get("key_errors", {})
    if not key_errors:
        print("No misclick data yet -- run a few rounds first.")
        return
    max_err = max(key_errors.values())
    print("Misclick heatmap (darker/redder = more mistakes on that key):\n")
    for row in KEYBOARD_ROWS:
        line = []
        for c in row:
            n = key_errors.get(c, 0)
            if n == 0:
                line.append(f"\x1b[2m[{c}]\x1b[0m")
            else:
                ratio = n / max_err
                if ratio > 0.66:
                    color = "\x1b[91m"  # red
                elif ratio > 0.33:
                    color = "\x1b[93m"  # yellow
                else:
                    color = "\x1b[92m"  # green (minor)
                line.append(f"{color}[{c}]\x1b[0m")
        print("  " + " ".join(line))
    print()
    worst = sorted(key_errors.items(), key=lambda kv: kv[1], reverse=True)[:5]
    print("Top problem keys: " + ", ".join(f"'{k}' ({n})" for k, n in worst))


def print_stats_summary(stats: dict) -> None:
    sessions = stats.get("sessions", [])
    if not sessions:
        print("No sessions recorded yet.")
        return
    recent = sessions[-10:]
    avg_wpm = sum(s["wpm"] for s in recent) / len(recent)
    avg_acc = sum(s["accuracy"] for s in recent) / len(recent)
    print(f"Sessions recorded: {len(sessions)}")
    print(f"Last {len(recent)} rounds -- avg WPM: {avg_wpm:.1f}, avg accuracy: {avg_acc:.1f}%\n")
    print_keyboard_heatmap(stats)


# ---------- main menu ----------

def prompt_word_count(default: int = 20) -> int:
    raw = input(f"How many words? [{default}]: ").strip()
    if not raw:
        return default
    try:
        return max(5, int(raw))
    except ValueError:
        return default


def main() -> None:
    enable_ansi()
    stats = load_stats()

    while True:
        clear_screen()
        print("=== Typing Trainer ===\n")
        print("1) Quick test (random words)")
        print("2) Weak-key drill (targets keys you misclick most)")
        print("3) View stats & keyboard heatmap")
        print("4) Quit\n")
        choice = input("Choose: ").strip()

        if choice == "1" or choice == "2":
            weak_mode = choice == "2"
            count = prompt_word_count()
            target = build_target(count, stats, weak_mode=weak_mode)
            result = run_test(target, stats)
            if result is not None:
                stats.setdefault("sessions", []).append(result)
                save_stats(stats)
                clear_screen()
                print("=== Round complete ===\n")
                print(f"WPM:      {result['wpm']:.1f}")
                print(f"Accuracy: {result['accuracy']:.1f}%")
                print(f"Misclicks: {result['misclicks']}")
                print()
                input("Press Enter to continue...")
            else:
                save_stats(stats)
        elif choice == "3":
            clear_screen()
            print_stats_summary(stats)
            print()
            input("Press Enter to continue...")
        elif choice == "4":
            break
        else:
            continue


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nBye.")
