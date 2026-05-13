"""Lazy loaders for the MLX models. Each is loaded on first use and cached."""

from __future__ import annotations

import os
import threading
from typing import Any

import mlx_whisper
from mlx_lm import generate, load
from mlx_lm.sample_utils import make_sampler

QWEN_REPO = os.environ.get(
    "KAIGI_QWEN_REPO",
    "mlx-community/Qwen3.5-4B-4bit",
)
QWEN_FALLBACK_REPO = "mlx-community/Llama-3.1-Swallow-8B-Instruct-v0.2-4bit"

WHISPER_REPO = os.environ.get(
    "KAIGI_WHISPER_REPO",
    "mlx-community/whisper-large-v3-turbo",
)

_qwen_lock = threading.Lock()
_qwen: tuple[Any, Any] | None = None  # (model, tokenizer)


def get_qwen() -> tuple[Any, Any]:
    global _qwen
    if _qwen is not None:
        return _qwen
    with _qwen_lock:
        if _qwen is not None:
            return _qwen
        try:
            _qwen = load(QWEN_REPO)
        except Exception as e:
            print(f"[models] {QWEN_REPO} failed ({e}); falling back to {QWEN_FALLBACK_REPO}")
            _qwen = load(QWEN_FALLBACK_REPO)
    return _qwen


def qwen_generate(prompt: str, *, max_tokens: int = 2048, temperature: float = 0.1) -> str:
    model, tokenizer = get_qwen()
    messages = [{"role": "user", "content": prompt}]
    if hasattr(tokenizer, "apply_chat_template"):
        # enable_thinking=False suppresses Qwen3/3.5 reasoning traces. Models that
        # don't accept the kwarg (older tokenizers) fall back gracefully.
        try:
            formatted = tokenizer.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=True,
                enable_thinking=False,
            )
        except TypeError:
            formatted = tokenizer.apply_chat_template(
                messages, tokenize=False, add_generation_prompt=True
            )
    else:
        formatted = prompt

    sampler = make_sampler(temp=temperature)
    text = generate(
        model,
        tokenizer,
        prompt=formatted,
        max_tokens=max_tokens,
        sampler=sampler,
        verbose=False,
    )
    return text


def whisper_transcribe(audio_path: str, *, language: str = "ja") -> str:
    result = mlx_whisper.transcribe(
        audio_path,
        path_or_hf_repo=WHISPER_REPO,
        language=language,
    )
    return (result.get("text") or "").strip()


def preload() -> None:
    """Force both models to load now so first request isn't penalised."""
    print(f"[models] preloading Qwen ({QWEN_REPO})...")
    get_qwen()
    print(f"[models] preloading Whisper ({WHISPER_REPO})...")
    mlx_whisper.load_models.load_model(WHISPER_REPO)
    print("[models] preload complete")
