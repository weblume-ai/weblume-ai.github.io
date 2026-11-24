"""Jarvis wake listener and ears: two claps or "Hey Jarvis" opens Jarvis, then what you say is turned into text
with Whisper on the GPU (faster-whisper, large-v3-turbo) and handed to Jarvis.
The microphone audio stays on this laptop: it's kept in memory only while you talk, never saved or sent anywhere.
Runs from Windows startup (Jarvis only, light): the app's small server starts only when Jarvis is called,
without the company server or the full Phainora AI window.
  python jarvis_listener.py --test   prints the live levels, to tune CLAP_PEAK for your mic"""
import ctypes, json, os, re, secrets, socket, subprocess, sys, threading, time, urllib.parse, urllib.request
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


SPEECH = 0.002      # raw loudness that counts as talking: NVIDIA Broadcast mutes the room (~0.00002) and keeps the voice quiet (~0.005)
END_QUIET, NO_SPEECH, MAX_TALK = 0.6, 6.0, 15.0   # seconds: pause that ends a request, wait for a first word, longest request
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
            # large-v3, not turbo: turbo's cut-down decoder mishears Egyptian Arabic more ("شغل اوني"); ~1 s on the RTX 4060
            self.model = WhisperModel("large-v3", device="cuda", compute_type="int8_float16")
            log("whisper ready")
        except Exception as e:
            log(f"whisper not loaded: {e}")

    def text(self, frames):
        audio = np.concatenate(frames).astype(np.float32) / 32768
        audio *= 0.9 / max(float(np.abs(audio).max()), 1e-4)  # even out a quiet mic without clipping (a fixed boost distorted Arabic)
        segs, _ = self.model.transcribe(audio, language="ar", beam_size=5, vad_filter=True,
                                        initial_prompt="يا جارفيس، سامعني؟ افتح جوجل. Jarvis, what's the weather?")
        t = " ".join(s.text.strip() for s in segs).strip()
        return "" if t.strip(" .،") in JUNK else t


# ---- hands: what Jarvis may do on this PC. Only opening and media keys: nothing that deletes, sends, buys or types for you.
TOKEN = secrets.token_hex(16)  # the app's server reads it from .jarvis-token; a web page can't, so no site can drive these
APPS = {"chrome": "chrome", "edge": "msedge", "notepad": "notepad", "calculator": "calc", "paint": "mspaint",
        "explorer": "explorer", "file explorer": "explorer", "settings": "ms-settings:", "task manager": "taskmgr",
        "spotify": "spotify:", "whatsapp": "whatsapp:", "discord": "discord:", "camera": "microsoft.windows.camera:"}
SITES = {"youtube": "https://www.youtube.com", "google": "https://www.google.com", "gmail": "https://mail.google.com",
         "facebook": "https://www.facebook.com", "instagram": "https://www.instagram.com", "tiktok": "https://www.tiktok.com",
         "chatgpt": "https://chatgpt.com", "github": "https://github.com", "netflix": "https://www.netflix.com"}
FOLDERS = {"downloads": "Downloads", "desktop": "Desktop", "documents": "Documents", "pictures": "Pictures",
           "videos": "Videos", "music": "Music", "projects": r"Downloads\Projects"}
KEYS = {"play_pause": 0xB3, "next": 0xB0, "previous": 0xB1, "volume_up": 0xAF, "volume_down": 0xAE, "mute": 0xAD}


CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
CLOSE = {"google": "chrome", "google chrome": "chrome", "edge": "msedge", "microsoft edge": "msedge", "calculator": "calculatorapp",
         "file explorer": "explorer", "word": "winword", "excel": "excel", "vscode": "code", "visual studio code": "code"}
KEEP = {"explorer", "python", "pythonw", "node", "powershell", "cmd", "system", "svchost", "winlogon", "csrss", "dwm"}  # never closed by voice


VK = {"ctrl": 0x11, "control": 0x11, "alt": 0x12, "shift": 0x10, "win": 0x5B, "windows": 0x5B, "enter": 0x0D, "return": 0x0D,
      "tab": 0x09, "esc": 0x1B, "escape": 0x1B, "backspace": 0x08, "space": 0x20, "up": 0x26, "down": 0x28, "left": 0x25,
      "right": 0x27, "pageup": 0x21, "pagedown": 0x22, "home": 0x24, "end": 0x23, "f5": 0x74, "f11": 0x7A, "printscreen": 0x2C}
VK.update({c: ord(c.upper()) for c in "abcdefghijklmnopqrstuvwxyz0123456789"})  # no "delete": Jarvis never deletes
MESSAGING = re.compile(r"whatsapp|discord|telegram|messenger|gmail|outlook|instagram|slack|teams|signal|mail", re.I)
SECRETS = re.compile(r"password|passwd|باسورد|كلمة (السر|المرور)|\b(?:\d[ -]?){13,19}\b|cvv", re.I)


def foreground_title():
    u = ctypes.windll.user32
    buf = ctypes.create_unicode_buffer(300)
    u.GetWindowTextW(u.GetForegroundWindow(), buf, 300)
    return buf.value


def keys(combo):
    """Press a shortcut like "ctrl+t", "alt+tab" or "enter"."""
    parts = [VK.get(k.strip().lower()) for k in combo.replace(" ", "").split("+")]
    if not parts or None in parts:
        return False
    k = ctypes.windll.user32.keybd_event
    for vk in parts:
        k(vk, 0, 0, 0)
    for vk in reversed(parts):
        k(vk, 0, 2, 0)
    return True


def type_text(text):
    """Types by pasting, so Arabic works in any app (it replaces what's on the clipboard)."""
    subprocess.run(["powershell", "-NoProfile", "-Command", "Set-Clipboard -Value $env:JV_TXT"], env={**os.environ, "JV_TXT": text},
                   timeout=10, creationflags=subprocess.CREATE_NO_WINDOW)
    time.sleep(0.1)
    keys("ctrl+v")


def first_video(query):
    """The first YouTube result's id, read from the public results page (no key needed)."""
    req = urllib.request.Request("https://www.youtube.com/results?search_query=" + urllib.parse.quote(query),
                                 headers={"User-Agent": "Mozilla/5.0", "Accept-Language": "en"})
    m = re.search(r'"videoId":"([\w-]{11})"', urllib.request.urlopen(req, timeout=10).read().decode("utf-8", "ignore"))
    return m.group(1) if m else None


def browse(url):
    """Websites open in Chrome (his browser), not the Windows default (Edge)."""
    if CHROME.exists():
        subprocess.Popen([str(CHROME), url])
    else:
        os.startfile(url)


def screenshot():
    """The whole screen as a JPEG, 1280 wide (enough for the vision model to find a button)."""
    import io
    from PIL import ImageGrab
    im = ImageGrab.grab(all_screens=False).convert("RGB")
    im.thumbnail((1280, 1280))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=80)
    return buf.getvalue()


def click(fx, fy):
    """Left click at a point given as fractions (0..1) of the screen."""
    u = ctypes.windll.user32
    w, h = u.GetSystemMetrics(0), u.GetSystemMetrics(1)
    u.SetCursorPos(int(fx * w), int(fy * h))
    time.sleep(0.05)
    u.mouse_event(2, 0, 0, 0, 0)  # left down
    u.mouse_event(4, 0, 0, 0, 0)  # left up


def find_app(name):
    """The Start menu shortcut whose name best matches (installed programs only)."""
    name = name.lower().strip()
    roots = [Path(os.environ.get("APPDATA", "")) / r"Microsoft\Windows\Start Menu\Programs",
             Path(os.environ.get("PROGRAMDATA", "")) / r"Microsoft\Windows\Start Menu\Programs",
             Path.home() / "Desktop", Path.home() / r"OneDrive\Documentos\Desktop"]
    best = None
    for root in roots:
        for lnk in root.rglob("*.lnk") if root.exists() else []:
            stem = lnk.stem.lower()
            if "uninstall" in stem:
                continue
            score = 3 if stem == name else 2 if stem.startswith(name) else 1 if name in stem else 0
            if score and (best is None or score > best[0] or (score == best[0] and len(stem) < len(best[1].stem))):
                best = (score, lnk)
    return best[1] if best else None


def act(action, arg, confirmed=False):
    """Run one Jarvis action; returns what happened, for Jarvis to say,
    or ("CONFIRM", label) when it waits for his click on yes (sending in a chat, shutting down)."""
    arg = str(arg or "").strip()[:500]
    if action == "play_youtube":
        vid = first_video(arg)
        if not vid:
            return f"I couldn't find {arg} on YouTube."
        browse(f"https://www.youtube.com/watch?v={vid}")
        return f"Playing {arg} on YouTube."
    if action == "type_text":
        if SECRETS.search(arg):
            return "I don't type passwords or card numbers, sir. Please type those yourself."
        type_text(arg)
        return "Typed it."
    if action == "press_keys":
        combo = arg.lower().replace(" ", "")
        if "enter" in combo.split("+") and MESSAGING.search(foreground_title()) and not confirmed:
            return ("CONFIRM", f"Press Enter (send) in {foreground_title()[:60]}")
        return "Done." if keys(combo) else f"I don't know the key {arg}."
    if action == "window":
        combo = {"minimize": "win+down", "maximize": "win+up", "switch": "alt+tab", "show_desktop": "win+d",
                 "close": "alt+f4", "new_tab": "ctrl+t", "close_tab": "ctrl+w", "scroll_down": "pagedown", "scroll_up": "pageup",
                 "back": "alt+left", "refresh": "f5", "fullscreen": "f11"}.get(arg.lower())
        if not combo:
            return "Unknown window action."
        if combo == "alt+f4":  # same as the X: unsaved work still asks
            VK["f4"] = 0x73
        keys(combo)
        return "Done."
    if action == "system":
        what = arg.lower()
        if what == "lock":
            ctypes.windll.user32.LockWorkStation()
            return "Locked."
        cmd = {"sleep": ["rundll32.exe", "powrprof.dll,SetSuspendState", "0,1,0"], "restart": ["shutdown", "/r", "/t", "5"],
               "shutdown": ["shutdown", "/s", "/t", "5"]}.get(what)
        if not cmd:
            return "Unknown system action."
        if not confirmed:
            return ("CONFIRM", what.capitalize() + " the PC")
        subprocess.Popen(cmd, creationflags=subprocess.CREATE_NO_WINDOW)
        return f"{what.capitalize()} in a few seconds, sir."
    if action == "open_app":
        key = arg.lower()
        if key in SITES:
            return act("open_website", SITES[key])
        lnk = find_app(arg)
        target = str(lnk) if lnk else APPS.get(key)
        if not target:
            return f"I couldn't find an app called {arg}."
        os.startfile(target)
        return f"Opened {lnk.stem if lnk else arg}."
    if action == "open_website":
        url = SITES.get(arg.lower(), arg)
        if not url.startswith(("http://", "https://")):
            url = "https://" + url
        if not re.match(r"^https?://[\w.-]+\.[a-z]{2,}(/\S*)?$", url, re.I):
            return "That doesn't look like a website address."
        browse(url)
        return f"Opened {url} in Chrome."
    if action in ("search_google", "search_youtube"):
        base = "https://www.google.com/search?q=" if action == "search_google" else "https://www.youtube.com/results?search_query="
        browse(base + urllib.parse.quote(arg))
        return f"Searching for {arg}."
    if action == "close_app":
        name = re.sub(r"[^a-z0-9 ]", "", arg.lower()).strip()
        proc = CLOSE.get(name, name)
        if not proc or proc in KEEP:
            return f"I won't close {arg}."
        # CloseMainWindow is the same as clicking X: an app with unsaved work still asks to save
        r = subprocess.run(["powershell", "-NoProfile", "-Command",
                            "$n=$env:JV_APP; $p=Get-Process | ? { $_.ProcessName -like \"*$n*\" -and $_.MainWindowHandle -ne 0 }; "
                            "$p | % { [void]$_.CloseMainWindow() }; $p.Count"],
                           capture_output=True, text=True, timeout=15, env={**os.environ, "JV_APP": proc},
                           creationflags=subprocess.CREATE_NO_WINDOW)
        n = (r.stdout.strip().splitlines() or ["0"])[-1]
        return f"Closed {arg}." if n not in ("", "0") else f"{arg} isn't open."
    if action == "open_folder":
        sub = FOLDERS.get(arg.lower())
        if not sub:
            return f"I only open these folders: {', '.join(FOLDERS)}."
        p = Path.home() / sub
        if not p.exists() and sub in ("Desktop", "Documents"):
            p = Path.home() / "OneDrive" / ("Documentos" if sub == "Documents" else r"Documentos\Desktop")
        os.startfile(str(p))
        return f"Opened {arg}."
    if action == "click_at":  # "x,y" as fractions of the screen; the server found the spot and asked first when it was risky
        fx, fy = (float(v) for v in arg.split(","))
        if not (0 <= fx <= 1 and 0 <= fy <= 1):
            return "That point is off the screen."
        click(fx, fy)
        return "Clicked."
    if action == "media":
        vk = KEYS.get(arg.lower())
        if vk is None:
            return "Unknown media key."
        for _ in range(5 if arg.startswith("volume") else 1):
            ctypes.windll.user32.keybd_event(vk, 0, 0, 0)
            ctypes.windll.user32.keybd_event(vk, 0, 2, 0)
        return "Done."
    return "I can't do that yet."


def voice_server():
    """Ryan's voice kept warm on 127.0.0.1:8788 (edge-tts already loaded), so a reply starts ~2 s sooner than starting edge-tts each time."""
    import asyncio
    import edge_tts
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    class Voice(BaseHTTPRequestHandler):
        def do_POST(self):
            n = int(self.headers.get("Content-Length") or 0)
            if self.path not in ("/tts", "/do") or not 0 < n <= 20000:
                return self.send_error(400)
            body = json.loads(self.rfile.read(n))
            if self.path == "/do":  # only the app's server has the token
                if not secrets.compare_digest(self.headers.get("X-Jarvis-Token", ""), TOKEN):
                    return self.send_error(403)
                try:  # "confirmed" only arrives after his click on yes (the page adds it; the model can't)
                    msg = act(str(body.get("action", "")), body.get("arg"), confirmed=body.get("confirmed") is True)
                except Exception as e:
                    msg = f"That didn't work: {e}"
                log(f"do {body.get('action')} {body.get('arg')!r}: {msg}")
                if isinstance(msg, tuple):
                    out = json.dumps({"result": "Waiting for his yes on the screen.",
                                      "confirm": {"action": body.get("action"), "arg": body.get("arg"), "label": msg[1]}}).encode()
                else:
                    out = json.dumps({"result": msg}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                return self.wfile.write(out)
            text = str(body.get("text", ""))[:1500]

            async def speak():
                out = b""
                async for c in edge_tts.Communicate(text, "en-GB-RyanNeural", pitch="-6Hz").stream():
                    if c["type"] == "audio":
                        out += c["data"]
                return out
            try:
                audio = asyncio.run(speak())
            except Exception:
                return self.send_error(502)
            self.send_response(200)
            self.send_header("Content-Type", "audio/mpeg")
            self.end_headers()
            self.wfile.write(audio)

        def do_GET(self):
            u = urllib.parse.urlparse(self.path)
            if u.path == "/tts":  # streamed: the first words play while the rest is still being made
                text = urllib.parse.parse_qs(u.query).get("text", [""])[0][:1500]
                if not text.strip():
                    return self.send_error(400)
                self.send_response(200)
                self.send_header("Content-Type", "audio/mpeg")
                self.end_headers()

                async def stream():
                    async for c in edge_tts.Communicate(text, "en-GB-RyanNeural", pitch="-6Hz").stream():
                        if c["type"] == "audio":
                            self.wfile.write(c["data"])
                            self.wfile.flush()
                try:
                    asyncio.run(stream())
                except Exception:
                    pass
                return
            if u.path == "/shot":  # the screen, for Jarvis's eyes (token only)
                if not secrets.compare_digest(self.headers.get("X-Jarvis-Token", ""), TOKEN):
                    return self.send_error(403)
                png = screenshot()
                self.send_response(200)
                self.send_header("Content-Type", "image/jpeg")
                self.end_headers()
                return self.wfile.write(png)
            self.send_error(404)

        def log_message(self, *a):
            pass
    try:
        ThreadingHTTPServer(("127.0.0.1", 8788), Voice).serve_forever()
    except OSError as e:
        log(f"voice server: {e}")


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
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # screenshots and clicks both in real pixels on a scaled display
    except Exception:
        pass
    Path(__file__).with_name(".jarvis-token").write_text(TOKEN)
    threading.Thread(target=voice_server, daemon=True).start()
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
                talk["frames"].append(pcm.copy())  # the untouched sound for Whisper; it's evened out once at the end
                if rms > max(SPEECH, 2.5 * room):
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
