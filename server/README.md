# Kaigi Local Server

Drop-in local replacement for the Gemini API used by the Kaigi Meeting Chrome extension. Runs Qwen3 + Whisper on Apple Silicon via MLX.

## Install (one-time)

```bash
brew install ffmpeg uv         # ffmpeg is needed for opus/webm decoding
cd server
uv sync                        # installs mlx-lm, mlx-whisper, fastapi, uvicorn
```

First request will download model weights (~6.5 GB total) into `~/.cache/huggingface/`.

## Run

```bash
./start.sh                     # http://127.0.0.1:8787
```

Override models via env:

```bash
KAIGI_QWEN_REPO=mlx-community/Qwen3-8B-Instruct-4bit ./start.sh
KAIGI_WHISPER_REPO=mlx-community/whisper-large-v3-turbo ./start.sh
```

Optional shared-secret protection:

```bash
LOCAL_API_KEY=hunter2 ./start.sh
```

The extension already appends `?key=...` to every call, so set `geminiApiKey` in the popup to the same value.

## Point the extension at it

Once the server is up, change the base URL in `src/content/core/api.js` from
`https://generativelanguage.googleapis.com` to `http://127.0.0.1:8787`, add the
local origin to `manifest.json` `host_permissions`, and rebuild. (Covered in the
follow-up client-side patch.)

## Smoke tests

```bash
# Text breakdown
curl -s 'http://127.0.0.1:8787/v1beta/models/qwen:generateContent?key=x' \
  -H 'Content-Type: application/json' \
  -d '{"contents":[{"parts":[{"text":"Return ONLY JSON {\"original\":\"...\",\"translation\":\"...\",\"words\":[]}. Text: 今日は良い天気ですね"}]}],"generationConfig":{"temperature":0.1,"maxOutputTokens":2048,"responseMimeType":"application/json"}}'

# Translation
curl -s 'http://127.0.0.1:8787/v1beta/models/qwen:generateContent?key=x' \
  -H 'Content-Type: application/json' \
  -d '{"contents":[{"parts":[{"text":"Translate to English. Only output the translation.\n\nText: お疲れ様でした"}]}],"generationConfig":{"maxOutputTokens":256}}'

# Audio transcription
B64=$(base64 < sample-ja.webm)
curl -s 'http://127.0.0.1:8787/v1beta/models/whisper:generateContent?key=x' \
  -H 'Content-Type: application/json' \
  -d "{\"contents\":[{\"parts\":[{\"inlineData\":{\"mimeType\":\"audio/webm;codecs=opus\",\"data\":\"$B64\"}},{\"text\":\"Transcribe Japanese audio.\"}]}],\"generationConfig\":{\"maxOutputTokens\":2048}}"
```
