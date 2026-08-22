"""Nudge the mouse 1 pixel every INTERVAL seconds to keep Teams status 'Available'.

Uses the Windows SendInput API via ctypes — no third-party packages needed.
Quit with Ctrl+Alt+Q (works globally, even when run with pythonw) or Ctrl+C.
"""

import ctypes
import time
from ctypes import wintypes

INTERVAL = 60  # seconds between nudges (Teams goes Away after ~5 min idle)

INPUT_MOUSE = 0
MOUSEEVENTF_MOVE = 0x0001

MOD_ALT = 0x0001
MOD_CONTROL = 0x0002
WM_HOTKEY = 0x0312
PM_REMOVE = 0x0001
HOTKEY_ID = 1

ULONG_PTR = ctypes.POINTER(ctypes.c_ulong)


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", wintypes.LONG),
        ("dy", wintypes.LONG),
        ("mouseData", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


class INPUT(ctypes.Structure):
    class _I(ctypes.Union):
        _fields_ = [("mi", MOUSEINPUT)]

    _anonymous_ = ("i",)
    _fields_ = [("type", wintypes.DWORD), ("i", _I)]


def move_relative(dx: int, dy: int) -> None:
    inp = INPUT(type=INPUT_MOUSE, mi=MOUSEINPUT(dx=dx, dy=dy, dwFlags=MOUSEEVENTF_MOVE))
    ctypes.windll.user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT))


def quit_hotkey_pressed() -> bool:
    """Drain pending messages; return True if the quit hotkey was hit."""
    msg = wintypes.MSG()
    while ctypes.windll.user32.PeekMessageW(ctypes.byref(msg), None, 0, 0, PM_REMOVE):
        if msg.message == WM_HOTKEY and msg.wParam == HOTKEY_ID:
            return True
    return False


def main() -> None:
    if not ctypes.windll.user32.RegisterHotKey(None, HOTKEY_ID, MOD_CONTROL | MOD_ALT, ord("Q")):
        print("Warning: could not register Ctrl+Alt+Q (already in use?). Ctrl+C still works.")
    print(f"Keepalive running — nudging cursor every {INTERVAL}s. Quit with Ctrl+Alt+Q or Ctrl+C.")

    next_nudge = time.monotonic()
    try:
        while True:
            if quit_hotkey_pressed():
                print("Ctrl+Alt+Q pressed — stopping.")
                break
            if time.monotonic() >= next_nudge:
                move_relative(1, 0)
                time.sleep(0.1)
                move_relative(-1, 0)
                next_nudge = time.monotonic() + INTERVAL
            time.sleep(0.25)
    except KeyboardInterrupt:
        print("Stopped.")
    finally:
        ctypes.windll.user32.UnregisterHotKey(None, HOTKEY_ID)


if __name__ == "__main__":
    main()
