"""Jarvis wake listener and ears: two claps or "Hey Jarvis" opens Jarvis, then what you say is turned into text
with Whisper on the GPU (faster-whisper, large-v3-turbo) and handed to Jarvis.
The microphone audio stays on this laptop: it's kept in memory only while you talk, never saved or sent anywhere.
Runs from Windows startup (Jarvis only, light): the app's small server starts only when Jarvis is called,
without the company server or the full Phainora AI window.
  python jarvis_listener.py --test   prints the live levels, to tune CLAP_PEAK for your mic"""
import json, os, socket, subprocess, sys, threading, time, urllib.request
from pathlib import Path
import numpy as np
import sounddevice as sd
from openwakeword.model import Model

URL = "http://127.0.0.1:8787"
RATE, CHUNK = 16000, 1280             # 80 ms blocks, what openWakeWord expects
WAKE_SCORE = float(os.environ.get("JARVIS_WAKE", 0.5))
CLAP_PEAK = float(os.environ.get("JARVIS_CLAP", 0.35))  # peak level of a clap (0..1)
CLAP_OVER_ROOM = 8                    # and this many times louder than the room
GAIN = int(os.environ.get("JARVIS_GAIN", 4))         # voice boost before the wake-word model
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


LOG = Path(__file__).with_name("jarvis_listener.log")


def log(line):
    """Near misses and triggers, so a call that did nothing can be tuned (last ~500 lines kept)."""
    try:
        lines = LOG.read_text(encoding="utf-8").splitlines()[-500:] if LOG.exists() else []
        LOG.write_text("\n".join(lines + [time.strftime("%H:%M:%S ") + line]) + "\n", encoding="utf-8")
    except OSError:
        pass


def open_jarvis(why):
    print("open:", why, flush=True)
    log("OPEN " + why)
    if not server_up() and not start_server():
        return
    try:  # an open Phainora AI window shows Jarvis itself
        req = urllib.request.Request(URL + "/api/jarvis", data=b"{}", headers={"Content-Type": "application/json"})
        if json.load(urllib.request.urlopen(req, timeout=3)).get("page"):
            return
    except Exception:
        pass
    u = URL + "/?jarvis"  # Edge first: it has the natural Microsoft voices (Shakir); the keys come from the server's settings
    if subprocess.call(f'start "" msedge --app="{u}" --window-size=1280,860', shell=True):
        subprocess.call(f'start "" chrome --app="{u}" --window-size=1280,860', shell=True)


SPEECH = 0.03       # boosted loudness that counts as talking
END_QUIET, NO_SPEECH, MAX_TALK = 0.9, 6.0, 15.0   # seconds: pause that ends a request, wait for a first word, longest request
JUNK = {"", "اشتركوا في القناة", "ترجمة نانسي قنقر", "شكرا للمشاهدة", "Thank you."}  # what Whisper invents from silence


class Ears:
    """Whisper on the GPU. Loads in the background, so a missing GPU or library only means: no ears (the page then uses the browser's)."""
    def __init__(self):
        self.model = None

    def load(self):
        try:
            for d in (Path(sys.prefix) / "Lib" / "site-packages" / "nvidia").glob("*/bin"):
                os.add_dll_directory(str(d))  # cuBLAS / cuDNN from the pip wheels; CTranslate2 also looks on PATH
                os.environ["PATH"] = str(d) + os.pathsep + os.environ.get("PATH", "")
            from faster_whisper import WhisperModel
            self.model = WhisperModel("large-v3-turbo", device="cuda", compute_type="int8_float16")
            log("whisper ready")
        except Exception as e:
            log(f"whisper not loaded: {e}")

    def text(self, frames):
        audio = np.concatenate(frames).astype(np.float32) / 32768
        segs, _ = self.model.transcribe(audio, language="ar", beam_size=1, vad_filter=True, initial_prompt="يا جارفيس،")
        t = " ".join(s.text.strip() for s in segs).strip()
        return "" if t.strip(" .،") in JUNK else t


def post_text(text):
    try:
        req = urllib.request.Request(URL + "/api/jarvis", data=json.dumps({"text": text}).encode(), headers={"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=3)
    except Exception as e:
        log(f"post failed: {e}")


def page_waits():
    try:
        return json.load(urllib.request.urlopen(URL + "/api/jarvis/hear", timeout=0.3)).get("listen", False)
    except Exception:
        return False


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
    if not server_up():  # the small server (~50 MB) waits ready, so the words right after "Hey Jarvis" aren't lost while it starts
        threading.Thread(target=start_server, daemon=True).start()
    model = Model(wakeword_models=["hey_jarvis"], inference_framework="onnx")
    ears = Ears()
    threading.Thread(target=ears.load, daemon=True).start()
    room, claps, last, n = 0.02, [], 0.0, 0
    talk = None  # while recording a request: {"frames", "t0", "spoke", "quiet", "wake"}
    with sd.InputStream(samplerate=RATE, channels=1, dtype="int16", blocksize=CHUNK) as mic:
        while True:
            block, _ = mic.read(CHUNK)
            pcm = block[:, 0]
            x = pcm.astype(np.float32) / 32768
            peak, rms = float(np.abs(x).max()), float(np.sqrt((x * x).mean()))
            now, n = time.time(), n + 1
            # NVIDIA Broadcast hands over a quiet voice (peaks under 0.15), too quiet for the models: boost it first
            loud = np.clip(pcm.astype(np.int32) * GAIN, -32768, 32767).astype(np.int16)
            if talk is not None:  # recording what you say to Jarvis
                talk["frames"].append(loud)
                if rms * GAIN > max(SPEECH, 3 * GAIN * room):
                    talk["spoke"], talk["quiet"] = talk["spoke"] or now, now
                age = now - talk["t0"]
                if (talk["spoke"] and now - talk["quiet"] > END_QUIET) or age > MAX_TALK or (not talk["spoke"] and age > NO_SPEECH):
                    heard = ears.text(talk["frames"]) if talk["spoke"] else ""
                    log(f"heard: {heard!r}")
                    if heard or talk["wake"]:
                        post_text(heard)  # only its name: the page answers "Yes, sir?" and waits
                    talk, last = None, time.time()
                continue
            if ears.model and n % 7 == 0 and page_waits():  # Jarvis answered and waits for your reply
                talk = {"frames": [], "t0": now, "spoke": None, "quiet": now, "wake": False}
                continue
            score = model.predict(loud).get("hey_jarvis", 0)
            clap = peak > CLAP_PEAK and peak > CLAP_OVER_ROOM * room
            if not clap:
                room = 0.98 * room + 0.02 * rms  # slow average of the room's level
            if TEST:
                print(f"peak {peak:.2f}  room {room:.3f}  jarvis {score:.2f}" + ("  CLAP" if clap else ""), flush=True)
            if score > 0.05 or peak > 0.05:
                log(f"peak {peak:.2f} room {room:.3f} jarvis {score:.2f}" + (" CLAP" if clap else ""))
            if clap and (not claps or now - claps[-1] > 0.15):
                claps = (claps + [now])[-3:]
                if is_double_clap(claps, now) and now - last > COOLDOWN:
                    last, claps = now, []
                    open_jarvis("two claps")
                    if ears.model:
                        talk = {"frames": [], "t0": time.time(), "spoke": None, "quiet": time.time(), "wake": True}
            if score > WAKE_SCORE and now - last > COOLDOWN:
                last = now
                model.reset()
                open_jarvis(f"hey jarvis {score:.2f}")
                if ears.model:  # "Hey Jarvis, what's the weather": the request right after the name
                    talk = {"frames": [], "t0": time.time(), "spoke": None, "quiet": time.time(), "wake": True}


assert is_double_clap([1.0, 1.4], 1.4) and not is_double_clap([1.0, 2.5], 2.5) and not is_double_clap([1.4], 1.4)
if __name__ == "__main__":
    main()
