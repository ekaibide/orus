// Transcribe un trozo de audio (≤10 min, opus) con Groq y descuenta el uso del plan gratuito.
//   GET  → { used, limit, remaining }   (segundos del mes en curso)
//   POST multipart "file" → { duration, language, segments: [{start,end,text}], remaining }
// No guarda audio ni texto: solo los segundos consumidos.
import { createClient } from "npm:@supabase/supabase-js@2";
import { oggOpusSeconds } from "./ogg.ts";

const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY") ?? "";
const GROQ_URL = Deno.env.get("TRANSCRIBE_URL") ?? "https://api.groq.com/openai/v1/audio/transcriptions";
const MODEL = Deno.env.get("TRANSCRIBE_MODEL") ?? "whisper-large-v3-turbo";
const MONTHLY_FREE_SECONDS = Number(Deno.env.get("MONTHLY_FREE_SECONDS") ?? 60 * 60);       // 60 min/mes
// 30 h/día × 0,04 $/h ≈ 1,2 $/día: peor caso ≈ 33 €/mes, por debajo del umbral de 50 €/mes.
const DAILY_GLOBAL_SECONDS = Number(Deno.env.get("DAILY_GLOBAL_SECONDS") ?? 30 * 60 * 60);
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const MAX_CHUNK_BYTES = 4 * 1024 * 1024; // 10 min a 32 kbps ≈ 2,4 MB
const MAX_CHUNK_SECONDS = 11 * 60;       // la web corta en trozos de 10 min


const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0] ?? "";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(req), "Content-Type": "application/json" },
  });
}

async function quota(userId: string) {
  const { data, error } = await admin.rpc("quota_status", { p_user: userId }).single();
  if (error) throw error;
  const row = data as { used_month: number; used_today_global: number };
  return { used: row.used_month, global: Number(row.used_today_global) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors(req) });

  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: auth } = await admin.auth.getUser(jwt);
  const user = auth?.user;
  // Modo prueba: vale la sesión anónima siempre que lleve el email que pidió la web.
  const email = user?.email || (user?.user_metadata?.email as string | undefined);
  if (!user || !email) return json(req, 401, { error: "Inicia sesión para continuar." });

  let q;
  try {
    q = await quota(user.id);
  } catch (e) {
    console.error("quota_status", e);
    return json(req, 500, { error: "Error interno. Inténtalo de nuevo." });
  }
  const remaining = Math.max(0, MONTHLY_FREE_SECONDS - q.used);

  if (req.method === "GET") return json(req, 200, { used: q.used, limit: MONTHLY_FREE_SECONDS, remaining });
  if (req.method !== "POST") return json(req, 405, { error: "Método no permitido." });

  if (remaining <= 0) {
    return json(req, 402, { error: "Has agotado tus minutos gratis de este mes.", remaining: 0 });
  }
  if (q.global >= DAILY_GLOBAL_SECONDS) {
    return json(req, 503, { error: "El servicio ha llegado a su límite de hoy. Vuelve a intentarlo mañana." });
  }

  let file: File;
  try {
    const form = await req.formData();
    const f = form.get("file");
    if (!(f instanceof File)) throw new Error("sin archivo");
    file = f;
  } catch {
    return json(req, 400, { error: "Falta el audio." });
  }
  if (file.size === 0 || file.size > MAX_CHUNK_BYTES) {
    return json(req, 413, { error: "Trozo de audio vacío o demasiado grande." });
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const seconds = oggOpusSeconds(bytes);
  if (seconds == null) return json(req, 400, { error: "Formato de audio no válido." });
  if (seconds > MAX_CHUNK_SECONDS) return json(req, 413, { error: "Trozo de audio demasiado largo." });
  if (seconds > remaining + 30) {
    return json(req, 402, { error: "No te quedan minutos gratis suficientes este mes.", remaining });
  }

  const fd = new FormData();
  fd.append("file", new Blob([bytes], { type: "audio/ogg" }), "audio.ogg");
  fd.append("model", MODEL);
  fd.append("response_format", "verbose_json");
  fd.append("temperature", "0");
  const lang = new URL(req.url).searchParams.get("language");
  if (lang && /^[a-z]{2}$/.test(lang)) fd.append("language", lang);

  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
    body: fd,
  });
  if (!res.ok) {
    // No reenviamos el detalle del proveedor al cliente.
    console.error("transcribe provider", res.status, (await res.text()).slice(0, 500));
    const status = res.status === 429 ? 503 : 502;
    return json(req, status, { error: "El servicio de transcripción no está disponible ahora. Reintenta en unos minutos." });
  }
  const out = await res.json() as {
    duration?: number;
    language?: string;
    segments?: { start: number; end: number; text: string }[];
    text?: string;
  };
  const duration = Math.max(Number(out.duration ?? 0), seconds);

  const { error: usageErr } = await admin.rpc("record_usage", {
    p_user: user.id,
    p_seconds: Math.max(1, Math.ceil(duration)),
  });
  if (usageErr) console.error("record_usage", usageErr);

  const segments = (out.segments ?? []).map((s) => ({ start: s.start, end: s.end, text: s.text }));
  if (!segments.length && out.text?.trim()) segments.push({ start: 0, end: duration, text: out.text });

  return json(req, 200, {
    duration,
    language: out.language ?? null,
    segments,
    remaining: Math.max(0, remaining - Math.ceil(duration)),
  });
});
