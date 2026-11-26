import { createClient, Document, Packer, Paragraph, TextRun, HeadingLevel, Header, Footer, ImageRun, PageNumber, Tab,
  AlignmentType, TabStopType, BorderStyle, Table, TableRow, TableCell, WidthType, TableLayoutType } from "./vendor/libs.js";
import { FFmpeg } from "./vendor/ffmpeg/index.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY, MOCK_API } from "./config.js";

// Trozos de ~3 min: con 10 min Whisper perdía la puntuación y se saltaba turnos cortos
// (comprobado con una declaración de 16 min). Se envían en orden, cada uno con el final
// del anterior como contexto.
const CHUNK_SEC = 180;
const PROMPT_WORDS = 40;
const $ = (id) => document.getElementById(id);
const CONFIGURED = Boolean(MOCK_API) || !SUPABASE_URL.includes("TU-PROYECTO");
const sb = MOCK_API || !CONFIGURED ? null : createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const API = MOCK_API ? `${MOCK_API}/transcribe` : `${SUPABASE_URL}/functions/v1/transcribe`;

let remaining = null; // segundos gratis que quedan este mes
let busy = false;

// ---------- utilidades ----------
const fmt = (s) => {
  s = Math.floor(s);
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, "0")).join(":");
};
const mins = (s) => Math.max(0, Math.floor(s / 60));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- interfaz ----------
// #app[data-view] decide qué se ve: "upload" (subida y errores), "working" (fases) o "done" (descarga).
const STEPS = ["audio", "idioma", "texto", "word"];
let downloadUrl = null;

function view(name) {
  $("app").dataset.view = name;
}
// #state es la única región aria-live del flujo: solo se reescribe cuando cambia el texto,
// así el lector de pantalla anuncia cada fase una vez y no cada porcentaje.
function setState(text, isError = false) {
  const el = $("state");
  el.className = isError ? "err" : "";
  el.setAttribute("role", isError ? "alert" : "status");
  if (el.textContent !== text) el.textContent = text;
}
// Marca la fase en curso (las anteriores quedan hechas) y su detalle: porcentaje o «n de N».
function step(id, text, detail = "") {
  const at = STEPS.indexOf(id);
  for (const li of $("steps").children) {
    const i = STEPS.indexOf(li.dataset.step);
    li.dataset.state = i < at ? "done" : i === at ? "active" : "todo";
    if (i === at) li.setAttribute("aria-current", "step");
    else li.removeAttribute("aria-current");
    li.querySelector(".detail").textContent = i === at ? detail : "";
  }
  setState(text);
}
function progress(frac) {
  const bar = $("bar");
  bar.hidden = frac == null;
  if (frac == null) return bar.removeAttribute("aria-valuenow");
  const pct = Math.round(Math.min(1, frac) * 100);
  $("fill").style.width = `${pct}%`;
  bar.setAttribute("aria-valuenow", pct);
}
function showWorking(file) {
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = null;
  $("fname").textContent = file.name;
  $("app").setAttribute("aria-busy", "true");
  view("working");
}
function showError(e) {
  const m = e?.message || String(e);
  progress(null);
  view("upload");
  setState(/failed to fetch|load failed|networkerror/i.test(m)
    ? "No hay conexión con el servicio. Comprueba la red y vuelve a intentarlo."
    : m, true);
}

async function token() {
  if (MOCK_API) return "mock";
  const { data } = await sb.auth.getSession();
  return data.session?.access_token;
}

async function api(method, body, query = "") {
  const headers = { Authorization: `Bearer ${await token()}` };
  if (!MOCK_API) headers.apikey = SUPABASE_ANON_KEY;
  const r = await fetch(API + query, { method, body, headers });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j.error || `Error ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return j;
}

// ---------- sesión ----------
function showQuota() {
  $("quota").textContent = remaining == null ? "" : `Te quedan ${mins(remaining)} min gratis este mes`;
}
async function refreshQuota() {
  try {
    const q = await api("GET");
    remaining = q.remaining;
  } catch { remaining = null; }
  showQuota();
}
function render(session) {
  const logged = Boolean(MOCK_API || session);
  $("login").hidden = logged;
  $("app").hidden = !logged;
  if (logged) refreshQuota();
}
// Vuelta de un enlace de email caducado o ya usado: avisar y limpiar la URL.
const hashParams = new URLSearchParams(location.hash.slice(1));
if (hashParams.get("error")) {
  queueMicrotask(() => loginMsg(hashParams.get("error_code") === "otp_expired"
    ? "El enlace ha caducado o ya se usó. Pide un código nuevo."
    : "No se pudo iniciar sesión. Pide un código nuevo.", true));
  history.replaceState(null, "", location.pathname + location.search);
}

if (!CONFIGURED) $("soon").hidden = false;
else if (MOCK_API) render(null);
else sb.auth.onAuthStateChange((_event, session) => render(session));

// Login sin contraseña: email → código de 6 dígitos (Supabase Auth OTP).
function loginMsg(text, isError = false) {
  $("loginMsg").textContent = text;
  $("loginMsg").className = isError ? "err" : "";
}
function authError(e) {
  const m = String(e?.message || e);
  if (/rate|seconds|too many/i.test(m)) return "Demasiados intentos. Espera un minuto y vuelve a probar.";
  if (/expired|invalid|token/i.test(m)) return "Código incorrecto o caducado.";
  if (/email/i.test(m)) return "Revisa el email.";
  return "No se pudo completar. Inténtalo de nuevo.";
}
async function busyForm(form, fn) {
  const btn = form.querySelector("button[type=submit]");
  btn.disabled = true;
  try { await fn(); } finally { btn.disabled = false; }
}
// Modo prueba: se entra solo con el email, sin verificarlo (sesión anónima de Supabase
// con el email guardado en el usuario). Para volver al código de 6 dígitos hace falta
// un remitente SMTP; ver el historial de git ("Login con código de 6 dígitos…").
$("emailForm").addEventListener("submit", (ev) => {
  ev.preventDefault();
  busyForm(ev.target, async () => {
    const email = $("email").value.trim().toLowerCase();
    loginMsg("");
    const { error } = await sb.auth.signInAnonymously({ options: { data: { email } } });
    if (error) return loginMsg(authError(error), true);
    // onAuthStateChange muestra la app
  });
});
$("logout").onclick = async () => { if (sb) await sb.auth.signOut(); };

// ---------- subida ----------
const drop = $("drop");
["dragenter", "dragover"].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (ev) => ev.dataTransfer.files[0] && run(ev.dataTransfer.files[0]));
$("f").addEventListener("change", (ev) => { const f = ev.target.files[0]; ev.target.value = ""; if (f) run(f); });
$("again").addEventListener("click", () => { setState(""); view("upload"); $("f").focus(); });
window.addEventListener("beforeunload", (ev) => { if (busy) ev.preventDefault(); });

async function run(file) {
  if (busy) return;
  busy = true;
  drop.classList.add("busy");
  showWorking(file);
  try {
    const audio = await extractAudio(file);
    const language = await detectLanguage(audio);
    const results = await transcribeAll(audio, language);
    const blob = await buildDocx(file, audio, results, language);
    offerDownload(file, blob);
  } catch (e) {
    showError(e);
  } finally {
    busy = false;
    drop.classList.remove("busy");
    $("app").removeAttribute("aria-busy");
    showQuota();
  }
}

// ---------- 1. audio en el navegador (el vídeo nunca se sube) ----------
async function extractAudio(file) {
  step("audio", "Preparando…");
  progress(0);
  const ff = new FFmpeg();
  let duration = 0, lastTime = 0, hasAudio = false, phase = "probe";
  const silences = []; // [inicio, fin] en segundos del vídeo
  ff.on("log", ({ message }) => {
    const d = message.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (d && !duration) duration = +d[1] * 3600 + +d[2] * 60 + +d[3];
    if (/Stream #\d+:\d+.*Audio:/.test(message)) hasAudio = true;
    const ss = message.match(/silence_start: (-?[\d.]+)/);
    if (ss && phase === "extract") silences.push([Math.max(0, +ss[1]), null]);
    const se = message.match(/silence_end: ([\d.]+)/);
    if (se && phase === "extract" && silences.length) silences.at(-1)[1] = +se[1];
    const t = message.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (t && phase === "extract") lastTime = +t[1] * 3600 + +t[2] * 60 + +t[3];
    if (t && phase === "extract" && duration) {
      const frac = lastTime / duration;
      progress(frac * 0.3);
      step("audio", "Extrayendo audio…", `${Math.min(100, Math.round(frac * 100))} %`);
    }
  });
  try {
    const core = new URL("./vendor/core/", import.meta.url).href;
    await ff.load({ coreURL: core + "ffmpeg-core.js", wasmURL: core + "ffmpeg-core.wasm" });
    await ff.createDir("/in");
    await ff.mount("WORKERFS", { files: [file] }, "/in");
    const src = "/in/" + file.name;

    step("audio", "Leyendo el vídeo…");
    await ff.exec(["-hide_banner", "-i", src]); // falla a propósito: solo queremos la cabecera
    if (!hasAudio) throw new Error("Este archivo no tiene pista de audio.");
    if (remaining != null && duration > remaining + 30) {
      throw new Error(`Este vídeo dura ${mins(duration)} min y te quedan ${mins(remaining)} min gratis este mes.`);
    }

    // Pasada 1: todo el audio (mono 16 kHz, opus) + todas las pausas de ≥0,4 s.
    phase = "extract";
    step("audio", "Extrayendo audio…", "0 %");
    const rc = await ff.exec([
      "-i", src, "-vn", "-map", "0:a:0", "-af", "silencedetect=noise=-40dB:d=0.4",
      "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "32k", "full.ogg",
    ]);
    if (rc !== 0) throw new Error("No se pudo leer el audio de este archivo.");
    for (const s of silences) if (s[1] == null) s[1] = duration || Infinity;
    // Silencios largos: no se envían y lo que Whisper escriba dentro se descarta (frases inventadas).
    const longSilences = silences.filter(([s, e]) => e - s >= 2);

    // Pasada 2: cortar (sin recodificar) en las pausas más cercanas a cada CHUNK_SEC.
    // Trozos largos hacen que Whisper pierda la puntuación y se salte turnos cortos.
    phase = "split";
    step("audio", "Preparando el audio…");
    const cuts = chooseCuts(silences, duration || lastTime);
    const rc2 = await ff.exec([
      "-i", "full.ogg", "-c", "copy", "-f", "segment",
      ...(cuts.length ? ["-segment_times", cuts.join(",")] : ["-segment_time", "999999"]),
      "-reset_timestamps", "1", "-segment_list", "chunks.csv", "-segment_list_type", "csv", "chunk%03d.ogg",
    ]);
    if (rc2 !== 0) throw new Error("No se pudo preparar el audio.");

    // chunks.csv: "chunk000.ogg,0.000000,181.230000"
    const csv = new TextDecoder().decode(await ff.readFile("chunks.csv"));
    const chunks = [];
    for (const line of csv.trim().split("\n")) {
      const [name, start, end] = line.split(",");
      if (!name) continue;
      const c = { start: +start, end: +end, bytes: null };
      c.hasSpeech = speechIn(longSilences, c.start, c.end) > 0.5;
      if (c.hasSpeech) c.bytes = await ff.readFile(name);
      chunks.push(c);
    }
    if (!chunks.length) throw new Error("No se pudo leer el audio de este archivo.");
    const total = chunks.at(-1).end;

    // Muestra de 30 s desde el primer tramo con voz, para fijar el idioma.
    let probe = null;
    const firstSpeech = firstSpeechAt(longSilences, total);
    if (firstSpeech != null) {
      phase = "lang";
      await ff.exec(["-ss", String(firstSpeech), "-t", "30", "-i", "full.ogg", "-c", "copy", "probe.ogg"]);
      probe = await ff.readFile("probe.ogg").catch(() => null);
    }
    return { chunks, silences: longSilences, total, probe };
  } finally {
    ff.terminate();
  }
}

// Puntos de corte cada ~CHUNK_SEC, movidos a la pausa más cercana (preferiblemente larga)
// para no partir frases. Sin pausa cerca, se corta en el punto exacto.
function chooseCuts(silences, total) {
  const cuts = [];
  let last = 0;
  while (total - last > CHUNK_SEC + 30) {
    const target = last + CHUNK_SEC;
    let best = null;
    for (const [s, e] of silences) {
      const mid = (s + e) / 2;
      if (!isFinite(mid) || mid < target - 45 || mid > target + 30 || mid < last + 60) continue;
      const score = Math.abs(mid - target) - 10 * Math.min(e - s, 3);
      if (!best || score < best.score) best = { mid, score };
    }
    const cut = best ? best.mid : target;
    cuts.push(+cut.toFixed(2));
    last = cut;
  }
  return cuts;
}

// ---------- silencios ----------
// Segundos con sonido dentro de [a, b], descontando los silencios detectados.
function speechIn(silences, a, b) {
  let silent = 0;
  for (const [s, e] of silences) silent += Math.max(0, Math.min(b, e) - Math.max(a, s));
  return Math.max(0, b - a - silent);
}
// Primer instante con sonido dentro de [a, b].
function speechStart(silences, a, b) {
  let t = a;
  for (const [s, e] of [...silences].sort((x, y) => x[0] - y[0])) {
    if (s <= t && e > t) t = e;
  }
  return Math.min(t, b);
}
function firstSpeechAt(silences, total) {
  let t = 0;
  for (const [s, e] of [...silences].sort((x, y) => x[0] - y[0])) {
    if (s > t + 0.5) break; // hay sonido antes de este silencio
    t = Math.max(t, e);
  }
  return t < total - 0.5 ? t : null;
}

// ---------- 2. idioma ----------
// Whisper deduce el idioma de los primeros 30 s de cada trozo; si el vídeo empieza con
// silencio o música se equivoca y traduce. Lo fijamos una vez con una muestra con voz.
const LANG_CODES = { spanish: "es", english: "en", french: "fr", german: "de", italian: "it", portuguese: "pt",
  catalan: "ca", basque: "eu", galician: "gl", dutch: "nl", polish: "pl", russian: "ru", ukrainian: "uk",
  chinese: "zh", japanese: "ja", korean: "ko", arabic: "ar", turkish: "tr", swedish: "sv", danish: "da",
  norwegian: "no", finnish: "fi", greek: "el", czech: "cs", romanian: "ro", hungarian: "hu", hindi: "hi" };
const LANG_NAMES = { es: "español", en: "inglés", fr: "francés", de: "alemán", it: "italiano", pt: "portugués",
  ca: "catalán", eu: "euskera", gl: "gallego", nl: "neerlandés" };
const toCode = (l) => {
  if (!l) return null;
  l = String(l).toLowerCase();
  return /^[a-z]{2}$/.test(l) ? l : LANG_CODES[l] ?? null;
};

async function detectLanguage(audio) {
  if (!audio.probe) return null;
  step("idioma", "Detectando idioma…");
  const r = await transcribeOne(audio.probe, "probe", null);
  return toCode(r.language);
}

// ---------- 3. transcripción por trozos ----------
async function transcribeOne(bytes, label, language, prompt = "") {
  for (let attempt = 0; ; attempt++) {
    try {
      const fd = new FormData();
      fd.append("file", new Blob([bytes], { type: "audio/ogg" }), `${label}.ogg`);
      if (prompt) fd.append("prompt", prompt);
      const r = await api("POST", fd, language ? `?language=${language}` : "");
      if (r.remaining != null) remaining = Math.min(remaining ?? Infinity, r.remaining);
      return r;
    } catch (e) {
      const retriable = !e.status || e.status >= 500;
      if (!retriable || attempt >= 2) throw e;
      await sleep(2000 * (attempt + 1));
    }
  }
}

async function transcribeAll(audio, language) {
  const todo = audio.chunks.map((c, i) => i).filter((i) => audio.chunks[i].hasSpeech);
  const results = new Array(audio.chunks.length).fill(null);
  // En orden: cada trozo recibe como contexto el final del anterior (mantiene puntuación e hilo).
  let prompt = "";
  for (let n = 0; n < todo.length; n++) {
    progress(0.3 + 0.7 * (n / todo.length));
    step("texto", "Transcribiendo…", todo.length > 1 ? `parte ${n + 1} de ${todo.length}` : "");
    const i = todo[n];
    results[i] = await transcribeOne(audio.chunks[i].bytes, `chunk${i}`, language, prompt);
    const words = results[i].segments.map((s) => s.text.trim()).join(" ").split(/\s+/).filter(Boolean);
    if (words.length) prompt = words.slice(-PROMPT_WORDS).join(" ");
  }
  return results;
}

// ---------- 4. Word ----------
function paragraphs(audio, results) {
  // Junta segmentos en párrafos: corta tras pausas > 2 s o cuando el párrafo pasa de ~60 s.
  // Descarta lo que cae casi entero en silencio (frases inventadas por Whisper).
  const paras = [];
  let cur = null, lastEnd = 0;
  audio.chunks.forEach((chunk, i) => {
    const r = results[i];
    if (!r) return;
    for (const s of r.segments) {
      const text = s.text.trim();
      if (!text) continue;
      const end = Math.min(chunk.end, chunk.start + Math.max(s.end, s.start + 0.1));
      const rawStart = Math.min(chunk.start + s.start, end);
      if (speechIn(audio.silences, rawStart, end) < 0.4) continue; // sin sonido real: inventado
      const start = speechStart(audio.silences, rawStart, end);    // Whisper suele adelantar el inicio
      if (!cur || start - lastEnd > 2 || start - cur.start > 60) {
        cur = { start, parts: [] };
        paras.push(cur);
      }
      cur.parts.push(text);
      lastEnd = end;
    }
  });
  return paras.map((p) => ({ start: p.start, text: p.parts.join(" ") }));
}

// Formato de escrito procesal: A4, márgenes de 2,5 cm, Times New Roman 12 a interlineado 1,5 y
// páginas numeradas. Medidas en twips (1 cm = 567); tamaños de letra en medios puntos.
const PAGE_W = 11906, PAGE_H = 16838, MARGIN = 1417;
const TEXT_W = PAGE_W - 2 * MARGIN;
const TIME_COL = 992; // 1,75 cm: columna de la marca de tiempo
const SERIF = "Times New Roman", SANS = "Arial", GREY = "5F6661";
const RULE = { style: BorderStyle.SINGLE, size: 4, color: "C4C9C3" };
const NO_RULE = { style: BorderStyle.NONE, size: 0, color: "auto" };
const NOTICE = "Transcripción automática; revisar frente al audio antes de usarla en un procedimiento.";
const LOGO_PX = { width: 83, height: 24 }; // 2,2 × 0,64 cm; el PNG es 717 × 208

const small = (text, extra = {}) => new TextRun({ text, font: SANS, size: 16, color: GREY, ...extra });
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

async function logoPng() {
  try {
    const r = await fetch(new URL("./assets/orus-logo-word.png", import.meta.url));
    return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
  } catch { return null; } // sin logo, la cabecera lleva el nombre en texto
}

async function buildDocx(file, audio, results, language) {
  step("word", "Generando el Word…");
  const paras = paragraphs(audio, results);
  const stem = file.name.replace(/\.[^.]+$/, "");
  const lang = language ?? toCode(results.find((r) => r?.language)?.language);
  const logo = await logoPng();

  // Cabecera y pie de todas las páginas.
  const header = new Header({ children: [new Paragraph({
    spacing: { line: 240, after: 0 },
    tabStops: [{ type: TabStopType.RIGHT, position: TEXT_W }],
    border: { bottom: { ...RULE, space: 6 } },
    children: [
      logo
        ? new ImageRun({ type: "png", data: logo, transformation: LOGO_PX,
            altText: { name: "Orus", title: "Orus", description: "Logo de Orus" } })
        : new TextRun({ text: "Orus", bold: true, size: 26 }),
      new TextRun({ font: SANS, size: 16, color: GREY, children: [new Tab(), clip(stem, 70)] }),
    ],
  })] });
  const footer = new Footer({ children: [new Paragraph({
    spacing: { line: 240, after: 0 },
    tabStops: [{ type: TabStopType.RIGHT, position: TEXT_W }],
    border: { top: { ...RULE, space: 6 } },
    children: [
      small(NOTICE, { size: 15, italics: true }),
      new TextRun({ font: SANS, size: 16, color: GREY,
        children: [new Tab(), "Página ", PageNumber.CURRENT, " de ", PageNumber.TOTAL_PAGES] }),
    ],
  })] });

  // Título y bloque de metadatos (tabla sin bordes verticales, con filete arriba y abajo).
  const meta = [["Archivo", file.name], ["Duración", fmt(audio.total)]];
  if (lang) meta.push(["Idioma", LANG_NAMES[lang] ?? lang]);
  meta.push(["Fecha de transcripción",
    new Date().toLocaleDateString("es-ES", { day: "numeric", month: "long", year: "numeric" })]);
  const LABEL_W = 2600;
  const metaCell = (width, run) => new TableCell({
    width: { size: width, type: WidthType.DXA },
    margins: { top: 60, bottom: 60, left: 0, right: 120 },
    children: [new Paragraph({ spacing: { line: 276, after: 0 }, children: [run] })],
  });
  const metaTable = new Table({
    width: { size: TEXT_W, type: WidthType.DXA },
    columnWidths: [LABEL_W, TEXT_W - LABEL_W],
    layout: TableLayoutType.FIXED,
    borders: { top: RULE, bottom: RULE, left: NO_RULE, right: NO_RULE, insideHorizontal: NO_RULE, insideVertical: NO_RULE },
    rows: meta.map(([label, value]) => new TableRow({ cantSplit: true, children: [
      metaCell(LABEL_W, small(label, { size: 17 })),
      metaCell(TEXT_W - LABEL_W, new TextRun({ text: value, size: 22 })),
    ] })),
  });

  // Cuerpo: un párrafo por intervención, con su marca de tiempo discreta en el margen.
  const body = paras.length
    ? paras.map((p, i) => new Paragraph({
        alignment: AlignmentType.JUSTIFIED,
        indent: { left: TIME_COL, hanging: TIME_COL },
        tabStops: [{ type: TabStopType.LEFT, position: TIME_COL }],
        spacing: { before: i ? 0 : 400, after: 160, line: 360 },
        children: [
          new TextRun({ text: fmt(p.start), font: SANS, size: 15, color: GREY }),
          new TextRun({ children: [new Tab()] }),
          new TextRun(p.text),
        ] }))
    : [new Paragraph({ spacing: { before: 400 },
        children: [new TextRun({ text: "No se detectó voz en el archivo.", italics: true })] })];

  const doc = new Document({
    creator: "Orus",
    title: `Transcripción de ${stem}`,
    description: NOTICE,
    styles: { default: {
      document: { run: { font: SERIF, size: 24 } },
      title: { run: { font: SERIF, size: 52 }, paragraph: { spacing: { before: 240, after: 60, line: 240 } } },
    } },
    sections: [{
      properties: { page: {
        size: { width: PAGE_W, height: PAGE_H },
        margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN, header: 567, footer: 680 },
      } },
      headers: { default: header },
      footers: { default: footer },
      children: [
        new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun("Transcripción")] }),
        new Paragraph({ spacing: { after: 320, line: 276 }, children: [new TextRun({ text: stem, size: 26, color: GREY })] }),
        metaTable,
        ...body,
      ],
    }],
  });
  return Packer.toBlob(doc);
}

function offerDownload(file, blob) {
  progress(null);
  const name = file.name.replace(/\.[^.]+$/, "") + "_transcripcion.docx";
  downloadUrl = URL.createObjectURL(blob);
  const a = $("dl");
  a.href = downloadUrl;
  a.download = name;
  $("fname").textContent = name;
  view("done");
  setState("Transcripción lista");
  a.click();
  a.focus();
}
