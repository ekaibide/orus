# /// script
# requires-python = ">=3.11,<3.13"
# dependencies = ["fastapi>=0.110", "uvicorn>=0.29", "python-multipart>=0.0.9", "mlx-whisper>=0.4"]
# ///
"""Imita la Edge Function `transcribe` (mismo contrato) con Whisper local, para probar la web sin cuentas.

    uv run dev/mock_api.py                       # API en :8020
    python3 -m http.server 8030 -d web           # web en :8030
    abrir http://127.0.0.1:8030/?mock=http://127.0.0.1:8020
"""
import os
import subprocess
import tempfile
import threading

from fastapi import FastAPI, UploadFile
from fastapi.middleware.cors import CORSMiddleware

LIMIT = int(os.environ.get("MOCK_LIMIT_SECONDS", 3600))
used = 0
lock = threading.Lock()

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.get("/transcribe")
def quota():
    return {"used": used, "limit": LIMIT, "remaining": max(0, LIMIT - used)}


@app.post("/transcribe")
def transcribe(file: UploadFile, language: str | None = None):
    global used
    import mlx_whisper

    with tempfile.NamedTemporaryFile(suffix=".ogg") as tmp:
        tmp.write(file.file.read())
        tmp.flush()
        duration = float(subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", tmp.name],
            capture_output=True, text=True, check=True).stdout.strip())
        with lock:  # Whisper local: uno a la vez
            r = mlx_whisper.transcribe(tmp.name, path_or_hf_repo="mlx-community/whisper-large-v3-turbo",
                                       condition_on_previous_text=False, language=language)
    used += int(duration) + 1
    return {
        "duration": duration,
        "language": r.get("language"),
        "segments": [{"start": s["start"], "end": s["end"], "text": s["text"]} for s in r["segments"]],
        "remaining": max(0, LIMIT - used),
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8020)
