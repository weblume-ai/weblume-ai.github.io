"""Jarvis wake listener: two claps or "Hey Jarvis" opens Jarvis.
The microphone audio is analysed on this laptop only; nothing is recorded or sent anywhere.
Runs from Windows startup (Jarvis only, light): the app's small server starts only when Jarvis is called,
without the company server or the full Phainora AI window.
  python jarvis_listener.py --test   prints the live levels, to tune CLAP_PEAK for your mic"""
import json, os, socket, subprocess, sys, time, urllib.request
from pathlib import Path
import numpy as np
import sounddevice as sd
from openwakeword.model import Model

URL = "http://127.0.0.1:8787"
RATE, CHUNK = 16000, 1280             # 80 ms blocks, what openWakeWord expects
WAKE_SCORE = float(os.environ.get("JARVIS_WAKE", 0.5))
CLAP_PEAK = float(os.environ.get("JARVIS_CLAP", 0.35))  # peak level of a clap (0..1)
CLAP_OVER_ROOM = 8                    # and this many times louder than the room
COOLDOWN = 5
TEST = "--test" in sys.argv


def server_up():
    try:
        urllib.request.urlopen(URL + "/api/health", timeout=2)
        return True
    except Exception:
        return False


def start_server():
    """The app's own small Node server, hidden, with no browser and no company server."""
    root = Path(__file__).resolve().parent.parent
    subprocess.Popen(["node", str(root / "server" / "proxy.js")], cwd=root, creationflags=subprocess.CREATE_NO_WINDOW,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(30):
        time.sleep(0.5)
        if server_up():
            return True
    return False


def open_jarvis(why):
    print("open:", why, flush=True)
    if not server_up() and not start_server():
        return
    try:  # an open Phainora AI window shows Jarvis itself
        req = urllib.request.Request(URL + "/api/jarvis", data=b"{}", headers={"Content-Type": "application/json"})
        if json.load(urllib.request.urlopen(req, timeout=3)).get("page"):
            return
    except Exception:
        pass
    u = URL + "/?jarvis"
    if subprocess.call(f'start "" chrome --app="{u}" --window-size=1280,860', shell=True):
        subprocess.call(f'start "" msedge --app="{u}" --window-size=1280,860', shell=True)


def is_double_clap(times, now):
    """Two claps 0.15-0.9 s apart; the second one is now."""
    return len(times) >= 2 and 0.15 <= now - times[-2] <= 0.9


def main():
    if "--open" in sys.argv:  # the desktop Jarvis shortcut: open it now, no listening
        return open_jarvis("shortcut")
    lock = socket.socket()
    try:
        lock.bind(("127.0.0.1", 8789))  # one listener only, even if start.bat runs twice
    except OSError:
        return
    model = Model(wakeword_models=["hey_jarvis"], inference_framework="onnx")
    room, claps, last = 0.02, [], 0.0
    with sd.InputStream(samplerate=RATE, channels=1, dtype="int16", blocksize=CHUNK) as mic:
        while True:
            block, _ = mic.read(CHUNK)
            pcm = block[:, 0]
            x = pcm.astype(np.float32) / 32768
            peak, rms = float(np.abs(x).max()), float(np.sqrt((x * x).mean()))
            now = time.time()
            score = model.predict(pcm).get("hey_jarvis", 0)
            clap = peak > CLAP_PEAK and peak > CLAP_OVER_ROOM * room
            if not clap:
                room = 0.98 * room + 0.02 * rms  # slow average of the room's level
            if TEST:
                print(f"peak {peak:.2f}  room {room:.3f}  jarvis {score:.2f}" + ("  CLAP" if clap else ""), flush=True)
            if clap and (not claps or now - claps[-1] > 0.15):
                claps = (claps + [now])[-3:]
                if is_double_clap(claps, now) and now - last > COOLDOWN:
                    last, claps = now, []
                    open_jarvis("two claps")
            if score > WAKE_SCORE and now - last > COOLDOWN:
                last = now
                model.reset()
                open_jarvis(f"hey jarvis {score:.2f}")


assert is_double_clap([1.0, 1.4], 1.4) and not is_double_clap([1.0, 2.5], 2.5) and not is_double_clap([1.4], 1.4)
if __name__ == "__main__":
    main()
