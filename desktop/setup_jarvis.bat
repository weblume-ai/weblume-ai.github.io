@echo off
rem One-time setup for the Jarvis listener (two claps / "Hey Jarvis"). Free libraries only, about 100 MB.
cd /d "%~dp0"
where uv >nul 2>nul || (echo Install uv first: https://docs.astral.sh/uv/ & pause & exit /b 1)
uv venv --python 3.12 .venv
uv pip install --python .venv\Scripts\python.exe sounddevice numpy openwakeword onnxruntime
.venv\Scripts\python.exe -c "from openwakeword.utils import download_models; download_models(['hey_jarvis'])"
echo.
echo Done. Start Phainora AI and clap twice or say "Hey Jarvis".
pause
