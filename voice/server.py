#!/usr/bin/env python
"""Lyra voice sidecar: KittenTTS text-to-speech and faster-whisper speech-to-text.
Protocol: one JSON object per line on stdin, one JSON reply per line on stdout.
  {"id": 1, "cmd": "tts", "text": "...", "voice": "Rosie", "model": "KittenML/kitten-tts-nano-0.1", "out": "/path/out.wav"}
  {"id": 2, "cmd": "stt", "path": "/path/in.webm", "model": "small"}
  {"id": 3, "cmd": "voices", "model": "..."}
"""
import json
import os
import re
import sys
import traceback

OUT = sys.stdout
sys.stdout = sys.stderr  # libraries may print; keep the protocol channel clean

# Friendly names -> KittenTTS voice ids. Edit freely; unknown names fall through as raw ids.
VOICE_MAP = {
    "Rosie": "expr-voice-2-f",
    "Bella": "expr-voice-3-f",
    "Jasmine": "expr-voice-4-f",
    "Luna": "expr-voice-5-f",
    "Jasper": "expr-voice-2-m",
    "Leo": "expr-voice-3-m",
    "Ben": "expr-voice-4-m",
    "Axel": "expr-voice-5-m",
}
DEFAULT_MODEL = "KittenML/kitten-tts-nano-0.1"
_tts = {}
_stt = {}


def get_tts(model_id):
    """Default: the KittenTTS package downloads kitten-tts-nano-0.1 from Hugging Face on first use.
    Anything else must be a path to a .onnx file with voices.npz next to it."""
    model_id = model_id or DEFAULT_MODEL
    if model_id not in _tts:
        from kittentts import KittenTTS
        if model_id.endswith(".onnx"):
            _tts[model_id] = KittenTTS(model_id, os.path.join(os.path.dirname(model_id), "voices.npz"))
        else:
            _tts[model_id] = KittenTTS()
    return _tts[model_id]


def get_stt(size):
    size = size or "small"
    if size not in _stt:
        from faster_whisper import WhisperModel
        _stt[size] = WhisperModel(size, device="cpu", compute_type="int8")
    return _stt[size]


# KittenTTS runs one forward pass over the whole phoneme sequence and fails past
# roughly 450 characters ("Expand node" INVALID_ARGUMENT), so long replies are cut
# into sentence-sized chunks, synthesised separately and joined with a short pause.
MAX_CHARS = 320
GAP_SECONDS = 0.18
SAMPLE_RATE = 24000


def split_text(text, limit=MAX_CHARS):
    """Split on sentence ends, then clauses, then words; never return a chunk over the limit."""
    parts, buf = [], ""
    for sentence in re.split(r"(?<=[.!?;:])\s+|\n+", text):
        sentence = sentence.strip()
        if not sentence:
            continue
        if len(sentence) > limit:
            if buf:
                parts.append(buf); buf = ""
            piece = ""
            for word in sentence.split(" "):
                if len(piece) + len(word) + 1 > limit:
                    if piece:
                        parts.append(piece)
                    piece = word[:limit] if len(word) > limit else word
                else:
                    piece = f"{piece} {word}".strip()
            if piece:
                buf = piece
            continue
        if len(buf) + len(sentence) + 1 > limit:
            parts.append(buf); buf = sentence
        else:
            buf = f"{buf} {sentence}".strip()
    if buf:
        parts.append(buf)
    return parts or [text[:limit]]


def synth(model, text, voice, speed, depth=0):
    """Generate one chunk; halve it and retry if the model rejects the length."""
    try:
        return model.generate(text, voice=voice, speed=speed)
    except Exception:
        if depth >= 3 or len(text) < 40:
            raise
        cut = text.rfind(" ", 0, len(text) // 2 + 20) or len(text) // 2
        left, right = text[:cut].strip(), text[cut:].strip()
        if not left or not right:
            raise
        import numpy as np
        return np.concatenate([synth(model, left, voice, speed, depth + 1), synth(model, right, voice, speed, depth + 1)])


def cmd_tts(req):
    import numpy as np
    import soundfile as sf
    m = get_tts(req.get("model"))
    voice = VOICE_MAP.get(req.get("voice"), req.get("voice") or "expr-voice-2-f")
    text = (req.get("text") or "").strip()
    if not text:
        raise ValueError("empty text")
    speed = float(req.get("speed") or 1.0)
    chunks = split_text(text, int(req.get("max_chars") or MAX_CHARS))
    gap = np.zeros(int(SAMPLE_RATE * GAP_SECONDS), dtype=np.float32)
    pieces = []
    for i, chunk in enumerate(chunks):
        if i:
            pieces.append(gap)
        pieces.append(np.asarray(synth(m, chunk, voice, speed), dtype=np.float32))
    audio = np.concatenate(pieces) if len(pieces) > 1 else pieces[0]
    sf.write(req["out"], audio, SAMPLE_RATE)
    return {"path": req["out"], "voice": voice, "chunks": len(chunks), "chars": len(text), "seconds": round(len(audio) / SAMPLE_RATE, 2)}


def cmd_warmup(req):
    """Load the models so the first spoken reply is not slow."""
    loaded = []
    if req.get("tts", True):
        get_tts(req.get("model")); loaded.append("tts")
    if req.get("stt"):
        get_stt(req.get("stt_model")); loaded.append("stt")
    return {"loaded": loaded}


def cmd_stt(req):
    model = get_stt(req.get("model"))
    segments, info = model.transcribe(req["path"], vad_filter=True, beam_size=3)
    text = " ".join(s.text.strip() for s in segments).strip()
    return {"text": text, "language": info.language}


def cmd_voices(req):
    ids = []
    try:
        ids = list(getattr(get_tts(req.get("model")), "available_voices", []))
    except Exception:
        pass
    names = [n for n, v in VOICE_MAP.items() if not ids or v in ids] or list(VOICE_MAP)
    return {"voices": names, "ids": ids, "map": VOICE_MAP}


def cmd_ping(req):
    return {"pong": True}


HANDLERS = {"tts": cmd_tts, "stt": cmd_stt, "voices": cmd_voices, "ping": cmd_ping, "warmup": cmd_warmup}


def reply(obj):
    OUT.write(json.dumps(obj) + "\n")
    OUT.flush()


reply({"ready": True, "pid": os.getpid()})
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
        res = HANDLERS[req["cmd"]](req)
        reply({"id": req.get("id"), "ok": True, **res})
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        reply({"id": (req.get("id") if isinstance(req, dict) else None), "ok": False, "error": f"{type(e).__name__}: {e}"})
