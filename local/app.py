# /// script
# requires-python = ">=3.11,<3.13"
# dependencies = [
#   "fastapi>=0.110",
#   "uvicorn>=0.29",
#   "python-multipart>=0.0.9",
#   "mlx-whisper>=0.4",
#   "python-docx>=1.1",
# ]
# ///
"""Mini SaaS: sube un .mkv y descarga la transcripción completa en Word.

Ejecutar:  uv run app.py   →  http://127.0.0.1:8000
Transcribe en local (Whisper large-v3-turbo sobre MLX, Apple Silicon): sin coste por minuto
y sin que el audio salga del equipo.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import threading
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from docx import Document
from docx.shared import Pt, RGBColor
from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse

MODEL = os.environ.get("WHISPER_MODEL", "mlx-community/whisper-large-v3-turbo")
WORKDIR = Path(tempfile.gettempdir()) / "mkv2docx"
WORKDIR.mkdir(exist_ok=True)
ALLOWED = {".mkv", ".mp4", ".mov", ".webm", ".mp3", ".wav", ".m4a"}

app = FastAPI(title="MKV → Word")


@dataclass
class Job:
    id: str
    filename: str
    status: str = "en cola"  # en cola | extrayendo audio | transcribiendo | listo | error
    error: str | None = None
    docx: Path | None = None
    duration: float | None = None
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False)


JOBS: dict[str, Job] = {}
# Un único worker: Whisper usa toda la GPU; en paralelo solo se pisarían.
GPU_LOCK = threading.Lock()


def fmt_ts(seconds: float) -> str:
    s = int(seconds)
    return f"{s // 3600:02d}:{s % 3600 // 60:02d}:{s % 60:02d}"


def probe_duration(path: Path) -> float | None:
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
        return float(out)
    except Exception:
        return None


def build_docx(job: Job, result: dict, out: Path) -> None:
    doc = Document()
    style = doc.styles["Normal"]
    style.font.name = "Calibri"
    style.font.size = Pt(11)

    doc.add_heading(f"Transcripción — {Path(job.filename).stem}", level=1)
    meta = doc.add_paragraph()
    meta.add_run(f"Archivo: {job.filename}").italic = True
    if job.duration:
        meta.add_run(f"\nDuración: {fmt_ts(job.duration)}").italic = True
    if result.get("language"):
        meta.add_run(f"\nIdioma detectado: {result['language']}").italic = True

    # Agrupa segmentos en párrafos: corta cuando hay pausa > 2 s o el párrafo pasa de ~60 s.
    para_start, buf, last_end = None, [], 0.0
    def flush():
        if not buf:
            return
        p = doc.add_paragraph()
        ts = p.add_run(f"[{fmt_ts(para_start)}] ")
        ts.bold = True
        ts.font.color.rgb = RGBColor(0x66, 0x66, 0x66)
        p.add_run(" ".join(buf))

    for seg in result.get("segments", []):
        text = seg["text"].strip()
        if not text:
            continue
        if para_start is None:
            para_start = seg["start"]
        elif seg["start"] - last_end > 2.0 or seg["start"] - para_start > 60:
            flush()
            buf, para_start = [], seg["start"]
        buf.append(text)
        last_end = seg["end"]
    flush()

    if not result.get("segments"):
        doc.add_paragraph("(No se detectó voz en el archivo.)")
    doc.save(out)


def process(job: Job, src: Path) -> None:
    jobdir = src.parent
    try:
        with GPU_LOCK:
            job.status = "extrayendo audio"
            job.duration = probe_duration(src)
            wav = jobdir / "audio.wav"
            subprocess.run(
                ["ffmpeg", "-nostdin", "-y", "-i", str(src), "-vn", "-ac", "1", "-ar", "16000", str(wav)],
                capture_output=True, check=True,
            )
            src.unlink(missing_ok=True)  # el vídeo ya no hace falta

            job.status = "transcribiendo"
            import mlx_whisper  # import diferido: arranque del servidor rápido
            result = mlx_whisper.transcribe(str(wav), path_or_hf_repo=MODEL, condition_on_previous_text=False)
            wav.unlink(missing_ok=True)

        out = jobdir / f"{Path(job.filename).stem}_transcripcion.docx"
        build_docx(job, result, out)
        job.docx = out
        job.status = "listo"
    except subprocess.CalledProcessError as e:
        job.status, job.error = "error", "ffmpeg no pudo leer el archivo: " + e.stderr.decode(errors="ignore")[-300:]
    except Exception as e:  # noqa: BLE001 — se muestra al usuario
        job.status, job.error = "error", f"{type(e).__name__}: {e}"


@app.post("/api/jobs")
async def create_job(file: UploadFile):
    name = Path(file.filename or "archivo.mkv").name
    if Path(name).suffix.lower() not in ALLOWED:
        raise HTTPException(400, f"Formato no admitido. Usa: {', '.join(sorted(ALLOWED))}")
    job = Job(id=uuid.uuid4().hex, filename=name)
    jobdir = WORKDIR / job.id
    jobdir.mkdir()
    src = jobdir / f"input{Path(name).suffix.lower()}"
    with src.open("wb") as f:
        shutil.copyfileobj(file.file, f, length=8 * 1024 * 1024)
    JOBS[job.id] = job
    threading.Thread(target=process, args=(job, src), daemon=True).start()
    return {"id": job.id}


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "Trabajo no encontrado")
    return {"status": job.status, "error": job.error, "filename": job.filename,
            "duration": job.duration, "ready": job.docx is not None}


@app.get("/api/jobs/{job_id}/docx")
def download(job_id: str):
    job = JOBS.get(job_id)
    if not job or not job.docx:
        raise HTTPException(404, "Aún no está listo")
    return FileResponse(job.docx, filename=job.docx.name,
                        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document")


@app.get("/", response_class=HTMLResponse)
def index():
    return PAGE


PAGE = """<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MKV → Word</title>
<style>
:root{--bg:#f6f5f2;--card:#fff;--ink:#1c1c1c;--mute:#6b6b6b;--line:#e3e1dc;--acc:#2f5bea}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--card:#1e1e1e;--ink:#eee;--mute:#999;--line:#333;--acc:#7b9bff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,sans-serif;
display:grid;place-items:center;min-height:100vh;padding:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:32px;width:100%;max-width:480px}
h1{font-size:22px;margin:0 0 4px}p{margin:0;color:var(--mute);font-size:14px}
#drop{display:block;margin-top:24px;border:2px dashed var(--line);border-radius:12px;padding:36px 16px;text-align:center;cursor:pointer;transition:.15s}
#drop.over{border-color:var(--acc);background:color-mix(in srgb,var(--acc) 8%,transparent)}
#drop strong{color:var(--acc)}input{display:none}
#state{margin-top:20px;font-size:15px;min-height:24px}
.bar{height:6px;background:var(--line);border-radius:3px;overflow:hidden;margin-top:10px;display:none}
.bar i{display:block;height:100%;width:0;background:var(--acc);transition:width .2s}
.bar.indet i{width:35%;animation:slide 1.2s infinite ease-in-out}
@keyframes slide{0%{margin-left:-35%}100%{margin-left:100%}}
a.btn{display:inline-block;margin-top:14px;background:var(--acc);color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600}
.err{color:#d33}
</style></head><body>
<div class="card">
  <h1>Transcribir vídeo a Word</h1>
  <p>Sube un .mkv (o mp4, mov, mp3…) y descarga la transcripción completa en .docx.</p>
  <label id="drop"><input id="f" type="file" accept=".mkv,.mp4,.mov,.webm,.mp3,.wav,.m4a">
    Arrastra el archivo aquí o <strong>elige uno</strong></label>
  <div id="state"></div>
  <div class="bar" id="bar"><i id="fill"></i></div>
  <div id="out"></div>
</div>
<script>
const $=id=>document.getElementById(id), drop=$('drop');
['dragenter','dragover'].forEach(e=>drop.addEventListener(e,ev=>{ev.preventDefault();drop.classList.add('over')}));
['dragleave','drop'].forEach(e=>drop.addEventListener(e,ev=>{ev.preventDefault();drop.classList.remove('over')}));
drop.addEventListener('drop',ev=>ev.dataTransfer.files[0]&&upload(ev.dataTransfer.files[0]));
$('f').addEventListener('change',ev=>ev.target.files[0]&&upload(ev.target.files[0]));
function setState(t,cls=''){$('state').className=cls;$('state').textContent=t}
function upload(file){
  $('out').innerHTML='';const bar=$('bar');bar.style.display='block';bar.classList.remove('indet');
  const fd=new FormData();fd.append('file',file);const x=new XMLHttpRequest();
  x.upload.onprogress=e=>{if(e.lengthComputable){const p=Math.round(e.loaded/e.total*100);$('fill').style.width=p+'%';setState('Subiendo… '+p+'%')}};
  x.onload=()=>{if(x.status!==200){bar.style.display='none';return setState(JSON.parse(x.responseText).detail||'Error al subir','err')}
    bar.classList.add('indet');poll(JSON.parse(x.responseText).id,Date.now())};
  x.onerror=()=>setState('Error de red','err');x.open('POST','/api/jobs');x.send(fd);
}
async function poll(id,t0){
  const r=await fetch('/api/jobs/'+id).then(r=>r.json());
  const secs=Math.round((Date.now()-t0)/1000);
  if(r.status==='listo'){$('bar').style.display='none';setState('Listo en '+secs+' s ✓');
    $('out').innerHTML='<a class="btn" href="/api/jobs/'+id+'/docx">Descargar Word</a>';return}
  if(r.status==='error'){$('bar').style.display='none';return setState(r.error,'err')}
  const dur=r.duration?' · vídeo de '+Math.round(r.duration/60)+' min':'';
  setState(r.status.charAt(0).toUpperCase()+r.status.slice(1)+'… ('+secs+' s'+dur+')');
  setTimeout(()=>poll(id,t0),1500);
}
</script></body></html>"""

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("PORT", 8000)))
