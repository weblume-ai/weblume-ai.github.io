@echo off
rem One-time setup for the Jarvis listener (two claps / "Hey Jarvis"). Free libraries only: about 2 GB with Whisper (the ears, on the NVIDIA card).
cd /d "%~dp0"
where uv >nul 2>nul || (echo Install uv first: https://docs.astral.sh/uv/ & pause & exit /b 1)
uv venv --python 3.12 .venv
uv pip install --python .venv\Scripts\python.exe sounddevice numpy openwakeword onnxruntime edge-tts faster-whisper nvidia-cublas-cu12 "nvidia-cudnn-cu12==9.*"
.venv\Scripts\python.exe -c "from openwakeword.utils import download_models; download_models(['hey_jarvis'])"
echo.
echo Done. Start Phainora AI and clap twice or say "Hey Jarvis".
pause
