"""Gemini-compatible local shim.

Mimics POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
so the Chrome extension only needs to swap its base URL.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import tempfile
import time
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from starlette.middleware.base import BaseHTTPMiddleware

from models import qwen_generate, whisper_transcribe

app = FastAPI(title="Kaigi Local Gemini Shim")

# In-memory request metrics surfaced via GET /stats for the popup indicator.
_stats: dict[str, Any] = {
    "requests_received": 0,
    "requests_completed": 0,
    "requests_in_flight": 0,
    "queue_depth": 0,            # requests waiting on the inference lock
    "last_received_at": None,    # epoch seconds
    "last_responded_at": None,   # epoch seconds
    "last_duration_ms": None,
    "total_duration_ms": 0,
    "avg_duration_ms": None,
    "started_at": time.time(),
}

# Serialize all heavy generation. MLX models are not thread-safe enough to share
# across concurrent inference calls, and on the M-series even if they were the
# GPU would just thrash. One at a time, FIFO via asyncio.Semaphore.
_inference_lock = asyncio.Semaphore(1)


async def _run_locked(fn, /, *args, **kwargs):
    """Acquire the inference semaphore, then run a sync fn in a worker thread.
    Tracks queue_depth for the popup indicator."""
    _stats["queue_depth"] += 1
    acquired = False
    try:
        async with _inference_lock:
            _stats["queue_depth"] -= 1
            acquired = True
            return await asyncio.to_thread(fn, *args, **kwargs)
    finally:
        if not acquired:
            _stats["queue_depth"] = max(0, _stats["queue_depth"] - 1)

_ALLOWED_ORIGIN_RE = re.compile(
    r"^(chrome-extension://.*|https://meet\.google\.com|https://chat\.google\.com|https://mail\.google\.com)$"
)


def _cors_headers(origin: str | None) -> dict[str, str]:
    """CORS + Private Network Access headers. PNA is required by Chrome when
    an https page fetches a private-network address (127.0.0.1).
    See chromestatus.com/feature/5436853517811712."""
    h = {
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Private-Network": "true",
        "Access-Control-Max-Age": "600",
        "Vary": "Origin",
    }
    if origin and _ALLOWED_ORIGIN_RE.match(origin):
        h["Access-Control-Allow-Origin"] = origin
    return h


class CORSAndPNAMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        origin = request.headers.get("origin")
        if request.method == "OPTIONS":
            return Response(status_code=200, headers=_cors_headers(origin))
        response = await call_next(request)
        for k, v in _cors_headers(origin).items():
            response.headers[k] = v
        return response


app.add_middleware(CORSAndPNAMiddleware)

REQUIRED_KEY = os.environ.get("LOCAL_API_KEY")  # optional shared secret


def _approx_tokens(*texts: str) -> int:
    return sum(max(1, len(t) // 3) for t in texts if t)


def _envelope(text: str, *, finish_reason: str, prompt_text: str = "") -> dict[str, Any]:
    return {
        "candidates": [
            {
                "content": {"parts": [{"text": text}]},
                "finishReason": finish_reason,
            }
        ],
        "usageMetadata": {"totalTokenCount": _approx_tokens(prompt_text, text)},
    }


_JSON_OBJECT_RE = re.compile(r"\{.*\}", re.DOTALL)


def _coerce_json(raw: str) -> str:
    """Best-effort cleanup: strip code fences, isolate outermost JSON object."""
    s = raw.strip()
    if s.startswith("```"):
        s = re.sub(r"^```(?:json)?\s*", "", s)
        s = re.sub(r"\s*```$", "", s)
    m = _JSON_OBJECT_RE.search(s)
    if m:
        candidate = m.group(0)
        try:
            json.loads(candidate)
            return candidate
        except json.JSONDecodeError:
            pass
    return s


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/stats")
def stats() -> dict[str, Any]:
    return _stats


@app.post("/v1beta/models/{model}:generateContent")
async def generate_content(model: str, request: Request) -> JSONResponse:
    if REQUIRED_KEY:
        key = request.query_params.get("key")
        if key != REQUIRED_KEY:
            raise HTTPException(status_code=401, detail="bad key")

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="invalid JSON body")

    try:
        parts = body["contents"][0]["parts"]
    except (KeyError, IndexError, TypeError):
        raise HTTPException(status_code=400, detail="missing contents[0].parts")

    gen_cfg = body.get("generationConfig", {}) or {}
    wants_json = gen_cfg.get("responseMimeType") == "application/json"
    max_tokens = int(gen_cfg.get("maxOutputTokens") or 2048)
    temperature = float(gen_cfg.get("temperature", 0.1))

    audio_part = next((p for p in parts if isinstance(p, dict) and "inlineData" in p), None)
    text_part = next((p for p in parts if isinstance(p, dict) and "text" in p), None)
    text_prompt = (text_part or {}).get("text", "")

    started = time.time()
    _stats["requests_received"] += 1
    _stats["requests_in_flight"] += 1
    _stats["last_received_at"] = started

    try:
        return await _generate(parts, audio_part, text_part, text_prompt, gen_cfg, wants_json, max_tokens, temperature, started)
    finally:
        ended = time.time()
        _stats["requests_in_flight"] = max(0, _stats["requests_in_flight"] - 1)
        _stats["last_responded_at"] = ended
        dur_ms = int((ended - started) * 1000)
        _stats["last_duration_ms"] = dur_ms
        _stats["total_duration_ms"] += dur_ms
        _stats["requests_completed"] += 1
        _stats["avg_duration_ms"] = int(_stats["total_duration_ms"] / _stats["requests_completed"])


async def _generate(parts, audio_part, text_part, text_prompt, gen_cfg, wants_json, max_tokens, temperature, started) -> JSONResponse:
    if audio_part:
        inline = audio_part["inlineData"]
        mime: str = inline.get("mimeType", "audio/webm")
        b64: str = inline["data"]
        suffix = ".webm" if "webm" in mime else ".wav" if "wav" in mime else ".m4a" if "m4a" in mime or "mp4" in mime else ".bin"

        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(base64.b64decode(b64))
            tmp_path = tmp.name

        try:
            transcription = await _run_locked(whisper_transcribe, tmp_path)
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

        if not wants_json:
            # transcribe-only call
            return JSONResponse(_envelope(transcription, finish_reason="STOP", prompt_text=text_prompt))

        # audio + JSON: feed transcription into the breakdown prompt the extension sent.
        # The original audio-breakdown prompt does NOT carry the JA text (Gemini transcribed it
        # implicitly). We append "Text: {transcription}" so Qwen sees what to break down.
        breakdown_prompt = f"{text_prompt}\n\nText: {transcription}" if text_prompt else f"Analyze this Japanese text and return ONLY valid JSON breakdown.\n\nText: {transcription}"

        raw = await _run_locked(qwen_generate, breakdown_prompt, max_tokens=max_tokens, temperature=temperature)
        out = _coerce_json(raw) if wants_json else raw
        finish = "STOP"
        elapsed = time.time() - started
        print(f"[audio+json] {elapsed:.1f}s transcription={transcription[:40]!r} out_len={len(out)}")
        return JSONResponse(_envelope(out, finish_reason=finish, prompt_text=breakdown_prompt))

    # Text-only path: covers breakdown, JA→EN, EN→JA, delta translation.
    if not text_prompt:
        raise HTTPException(status_code=400, detail="no text or audio part")

    raw = await _run_locked(qwen_generate, text_prompt, max_tokens=max_tokens, temperature=temperature)
    out = _coerce_json(raw) if wants_json else raw
    elapsed = time.time() - started
    print(f"[text{' +json' if wants_json else ''}] {elapsed:.1f}s in={len(text_prompt)} out={len(out)}")
    return JSONResponse(_envelope(out, finish_reason="STOP", prompt_text=text_prompt))
