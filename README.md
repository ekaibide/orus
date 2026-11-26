# Orus

Sube un vídeo (.mkv, .mp4, .mov…) y descarga la transcripción completa en .docx. Gratis hasta 60 min al mes por cuenta.

## Cómo funciona

```
Navegador                                   Supabase                       Groq
─────────                                   ────────                       ────
ffmpeg.wasm extrae el audio (el vídeo no
se sube), detecta silencios y lo corta
en trozos de 10 min (opus, ~2,4 MB)
   │  login: solo email (modo prueba, sesión anónima de Supabase)
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

## Modo prueba (login sin verificar)

Ahora mismo se entra solo con el email, sin comprobarlo: sesión anónima de Supabase con el email en `user_metadata`. Consecuencias: el cupo de 60 min/mes es por navegador, no por persona, y el gasto solo lo acota `DAILY_GLOBAL_SECONDS`. Supabase limita a 30 cuentas nuevas por hora e IP.

Para volver al código de 6 dígitos: configurar un remitente SMTP en Supabase, restaurar el formulario de código (commit «Login con código de 6 dígitos…»), desactivar `enable_anonymous_sign_ins` y volver a exigir `!user.is_anonymous` en la función.

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
4. Auth: `supabase config push` (ver «Modo prueba»). Con remitente SMTP: `SMTP_USER=… SMTP_PASS=… supabase config push`; plantilla en `supabase/templates/codigo.html`.
5. Rellenar `web/config.js` (URL y clave publishable) y publicar `web/` (GitHub Pages).

## Regenerar las librerías de `web/vendor/`

```bash
cd build && npm install && npx esbuild entry.js --bundle --format=esm --minify --platform=browser --outfile=../web/vendor/libs.js
```

ffmpeg: copiar `node_modules/@ffmpeg/ffmpeg/dist/esm/*.js` a `web/vendor/ffmpeg/` y `node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.*` a `web/vendor/core/`.
