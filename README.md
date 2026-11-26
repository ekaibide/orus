# Vídeo a Word

Sube un vídeo (.mkv, .mp4, .mov…) y descarga la transcripción completa en .docx. Gratis hasta 60 min al mes por cuenta.

## Cómo funciona

```
Navegador                                   Supabase                       Groq
─────────                                   ────────                       ────
ffmpeg.wasm extrae el audio (el vídeo no
se sube), detecta silencios y lo corta
en trozos de 10 min (opus, ~2,4 MB)
   │  login: email + código de 6 dígitos (Supabase Auth)
   ├─ muestra de 30 s con voz ─────────────▶ functions/transcribe ─────────▶ Whisper large-v3-turbo
   │                                         · valida sesión               (0,04 $/hora de audio)
   ├─ trozos con voz (3 en paralelo) ──────▶ · lee la duración real del Ogg
   │                                         · cupo mensual + tope diario
   ◀─ segmentos con tiempos ───────────────  · suma segundos (no guarda audio ni texto)
filtra frases inventadas en silencios,
monta los párrafos y genera el .docx
```

- **`web/`**: web estática; las librerías van incluidas en `web/vendor/` (sin CDNs).
- **`supabase/functions/transcribe/`**: única función de servidor.
- **`supabase/migrations/`**: tablas de consumo con RLS (sin acceso `anon`; cada usuario solo lee lo suyo; escribe solo la función).
- **`dev/mock_api.py`**: imita la función con Whisper local para probar sin cuentas.
- **`local/app.py`**: versión 100 % local (Mac con Apple Silicon), sin login.

## Límites (variables de entorno de la función)

| Variable | Por defecto | Para qué |
|---|---|---|
| `MONTHLY_FREE_SECONDS` | 3600 | Minutos gratis por cuenta y mes |
| `DAILY_GLOBAL_SECONDS` | 108000 (30 h) | Tope de gasto total por día (≈1,2 $/día) |
| `ALLOWED_ORIGINS` | — | Origen de la web (CORS), p. ej. `https://usuario.github.io` |
| `GROQ_API_KEY` | — | **Secreto**: `supabase secrets set GROQ_API_KEY="$(security find-generic-password -s groq-video-a-word -w)"`, nunca en el repo |

## Probar en local (sin cuentas)

```bash
uv run dev/mock_api.py
```

```bash
python3 -m http.server 8030 -d web
```

Abrir `http://127.0.0.1:8030/?mock=http://127.0.0.1:8020`.

## Desplegar

1. `supabase link --project-ref <ref>` y `supabase db push`
2. `supabase secrets set GROQ_API_KEY=… ALLOWED_ORIGINS=https://…`
3. `supabase functions deploy transcribe`
4. Auth (código por email, remitente Gmail con contraseña de aplicación): `SMTP_USER=… SMTP_PASS=… supabase config push`. La configuración y la plantilla están en `supabase/config.toml` y `supabase/templates/codigo.html`.
5. Rellenar `web/config.js` (URL y clave publishable) y publicar `web/` (GitHub Pages).

## Regenerar las librerías de `web/vendor/`

```bash
cd build && npm install && npx esbuild entry.js --bundle --format=esm --minify --platform=browser --outfile=../web/vendor/libs.js
```

ffmpeg: copiar `node_modules/@ffmpeg/ffmpeg/dist/esm/*.js` a `web/vendor/ffmpeg/` y `node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.*` a `web/vendor/core/`.
