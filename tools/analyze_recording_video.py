"""Analyze a Cloudinary-hosted gameplay recording.

Pipeline:
  1. Download original video from Cloudinary secure URL.
  2. Extract audio with ffmpeg and transcribe with Whisper.
  3. Detect loud/scream/laughter-like audio moments with local heuristics.
  4. Sample frames and ask Backboard for funny highlight windows with memory.
"""

from __future__ import annotations

import argparse
import base64
import json
import math
import os
import re
import shutil
import subprocess
import sys
import uuid
import urllib.error
import urllib.request
import wave
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import numpy as np


DEFAULT_TRANSCRIBE_MODEL = "whisper-1"
DEFAULT_BACKBOARD_MODEL = "gpt-4o"
DEFAULT_BACKBOARD_PROVIDER = "openai"
BACKBOARD_API_BASE = "https://app.backboard.io/api"


@dataclass
class SampledFrame:
  time: float
  path: Path
  data_url: str


def parse_args() -> argparse.Namespace:
  parser = argparse.ArgumentParser(description="Analyze a gameplay recording from Cloudinary.")
  parser.add_argument("--video-url", required=True, help="HTTPS video URL from Cloudinary.")
  parser.add_argument("--public-id", required=True, help="Cloudinary public_id.")
  parser.add_argument("--work-dir", required=True, help="Directory for downloaded media and extracted assets.")
  parser.add_argument("--json-out", required=True, help="Path to write analysis JSON.")
  parser.add_argument("--feedback-json", help="Optional JSON file with user prompt and feedback.")
  parser.add_argument("--assistant-state", help="Optional JSON file used to persist the Backboard assistant id.")
  parser.add_argument("--max-frames", type=int, default=10, help="Maximum video frames to send to the vision model.")
  return parser.parse_args()


def load_dotenv(dotenv_path: Path) -> None:
  if not dotenv_path.exists():
    return

  for raw_line in dotenv_path.read_text(encoding="utf-8").splitlines():
    line = raw_line.strip()

    if not line or line.startswith("#") or "=" not in line:
      continue

    key, value = line.split("=", 1)
    key = key.strip()
    value = value.strip().strip('"').strip("'")

    if key and key not in os.environ:
      os.environ[key] = value


def safe_suffix(video_url: str) -> str:
  suffix = Path(urlparse(video_url).path).suffix.lower()
  return suffix if suffix in {".mp4", ".mov", ".webm", ".mkv", ".m4v"} else ".webm"


def run_command(args: list[str]) -> None:
  completed = subprocess.run(args, capture_output=True, text=True, check=False)

  if completed.returncode != 0:
    detail = completed.stderr.strip() or completed.stdout.strip()
    raise RuntimeError(detail or f"{args[0]} exited with {completed.returncode}")


def download_video(video_url: str, out_path: Path) -> None:
  parsed = urlparse(video_url)

  if parsed.scheme != "https":
    raise ValueError("video_url must use HTTPS.")

  request = urllib.request.Request(video_url, headers={"User-Agent": "GestureForge/1.0"})

  with urllib.request.urlopen(request, timeout=120) as response:
    out_path.write_bytes(response.read())


def ffmpeg_path() -> str | None:
  configured = os.environ.get("FFMPEG")

  if configured:
    return configured

  return shutil.which("ffmpeg")


def extract_audio(video_path: Path, wav_path: Path) -> bool:
  ffmpeg = ffmpeg_path()

  if not ffmpeg:
    return False

  run_command([
    ffmpeg,
    "-y",
    "-i",
    str(video_path),
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-sample_fmt",
    "s16",
    str(wav_path),
  ])
  return wav_path.exists() and wav_path.stat().st_size > 0


def response_to_dict(response: object) -> dict[str, object]:
  if hasattr(response, "model_dump"):
    return response.model_dump()

  if isinstance(response, dict):
    return response

  return json.loads(str(response))


def read_json_file(path: Path | None) -> dict[str, object]:
  if not path or not path.exists():
    return {}

  try:
    data = json.loads(path.read_text(encoding="utf-8"))
  except (OSError, json.JSONDecodeError):
    return {}

  return data if isinstance(data, dict) else {}


def read_feedback(path: str | None) -> dict[str, str]:
  data = read_json_file(Path(path).resolve() if path else None)
  return {
    "prompt": str(data.get("prompt", "")).strip(),
    "feedback": str(data.get("feedback", "")).strip(),
  }


def load_backboard_assistant_id(state_path: Path | None) -> str:
  configured = os.environ.get("BACKBOARD_ASSISTANT_ID", "").strip()

  if configured:
    return configured

  state = read_json_file(state_path)
  return str(state.get("assistant_id", "")).strip()


def save_backboard_assistant_id(state_path: Path | None, assistant_id: str) -> None:
  if not state_path or not assistant_id or os.environ.get("BACKBOARD_ASSISTANT_ID"):
    return

  state_path.parent.mkdir(parents=True, exist_ok=True)
  state_path.write_text(json.dumps({"assistant_id": assistant_id}, indent=2) + "\n", encoding="utf-8")


def backboard_config(state_path: Path | None) -> dict[str, object]:
  api_key = os.environ.get("BACKBOARD_API_KEY", "").strip()

  if not api_key:
    raise RuntimeError("BACKBOARD_API_KEY is required for Backboard funny moment analysis.")

  return {
    "api_key": api_key,
    "base_url": os.environ.get("BACKBOARD_API_BASE", BACKBOARD_API_BASE).rstrip("/"),
    "assistant_id": load_backboard_assistant_id(state_path),
    "llm_provider": os.environ.get("BACKBOARD_LLM_PROVIDER", DEFAULT_BACKBOARD_PROVIDER),
    "model_name": os.environ.get("BACKBOARD_MODEL_NAME", DEFAULT_BACKBOARD_MODEL),
    "memory_mode": os.environ.get("BACKBOARD_MEMORY_MODE", "Readonly"),
  }


def multipart_body(fields: dict[str, object], files: list[Path]) -> tuple[bytes, str]:
  boundary = f"----GestureForge{uuid.uuid4().hex}"
  chunks: list[bytes] = []

  for key, value in fields.items():
    if value is None or value == "":
      continue

    chunks.append(f"--{boundary}\r\n".encode("utf-8"))
    chunks.append(f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode("utf-8"))
    chunks.append(str(value).encode("utf-8"))
    chunks.append(b"\r\n")

  for path in files:
    chunks.append(f"--{boundary}\r\n".encode("utf-8"))
    chunks.append(
      (
        f'Content-Disposition: form-data; name="files"; filename="{path.name}"\r\n'
        "Content-Type: image/jpeg\r\n\r\n"
      ).encode("utf-8")
    )
    chunks.append(path.read_bytes())
    chunks.append(b"\r\n")

  chunks.append(f"--{boundary}--\r\n".encode("utf-8"))
  return b"".join(chunks), boundary


def backboard_send_message(
  content: str,
  *,
  state_path: Path | None,
  files: list[Path] | None = None,
  json_output: bool = False,
  memory: str | None = None,
  system_prompt: str | None = None,
) -> dict[str, object]:
  config = backboard_config(state_path)
  fields: dict[str, object] = {
    "content": content,
    "stream": False,
    "llm_provider": config["llm_provider"],
    "model_name": config["model_name"],
    "json_output": bool(json_output),
  }

  if config["assistant_id"]:
    fields["assistant_id"] = config["assistant_id"]

  if memory:
    fields["memory"] = memory

  if system_prompt:
    fields["system_prompt"] = system_prompt

  file_paths = files or []

  if file_paths:
    multipart_fields = {
      **fields,
      "stream": "false",
      "json_output": "true" if json_output else "false",
    }
    body, boundary = multipart_body(multipart_fields, file_paths)
    headers = {
      "X-API-Key": str(config["api_key"]),
      "Content-Type": f"multipart/form-data; boundary={boundary}",
    }
    request = urllib.request.Request(
      f"{config['base_url']}/threads/messages",
      data=body,
      headers=headers,
      method="POST",
    )
  else:
    headers = {
      "X-API-Key": str(config["api_key"]),
      "Content-Type": "application/json",
    }
    request = urllib.request.Request(
      f"{config['base_url']}/threads/messages",
      data=json.dumps(fields).encode("utf-8"),
      headers=headers,
      method="POST",
    )

  try:
    with urllib.request.urlopen(request, timeout=180) as response:
      payload = json.loads(response.read().decode("utf-8"))
  except urllib.error.HTTPError as error:
    detail = error.read().decode("utf-8", errors="ignore")
    raise RuntimeError(f"Backboard request failed with {error.code}: {detail}") from error

  assistant_id = str(payload.get("assistant_id", "")).strip()

  if assistant_id:
    save_backboard_assistant_id(state_path, assistant_id)

  return payload


def transcribe_audio(wav_path: Path) -> dict[str, object]:
  api_key = os.environ.get("OPENAI_API_KEY")

  if not api_key:
    raise RuntimeError("OPENAI_API_KEY is required for Whisper transcription.")

  from openai import OpenAI

  client = OpenAI(api_key=api_key)
  model = os.environ.get("OPENAI_TRANSCRIBE_MODEL", DEFAULT_TRANSCRIBE_MODEL)

  with wav_path.open("rb") as audio_file:
    response = client.audio.transcriptions.create(
      model=model,
      file=audio_file,
      response_format="verbose_json",
    )

  data = response_to_dict(response)
  segments = [
    {
      "start": float(segment.get("start", 0)),
      "end": float(segment.get("end", 0)),
      "text": str(segment.get("text", "")).strip(),
    }
    for segment in data.get("segments", []) or []
  ]

  return {
    "model": model,
    "text": str(data.get("text", "")).strip(),
    "segments": segments,
  }


def read_wav_mono(wav_path: Path) -> tuple[int, np.ndarray]:
  with wave.open(str(wav_path), "rb") as wav:
    sample_rate = wav.getframerate()
    channels = wav.getnchannels()
    sample_width = wav.getsampwidth()
    raw = wav.readframes(wav.getnframes())

  if sample_width != 2:
    raise RuntimeError("Only 16-bit PCM wav audio is supported for detection.")

  audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0

  if channels > 1:
    audio = audio.reshape(-1, channels).mean(axis=1)

  return sample_rate, audio


def dbfs(window: np.ndarray) -> float:
  rms = float(np.sqrt(np.mean(np.square(window))) + 1e-9)
  return 20 * math.log10(rms)


def zero_crossing_rate(window: np.ndarray) -> float:
  if len(window) < 2:
    return 0.0

  return float(np.mean(np.abs(np.diff(np.signbit(window)))))


def high_frequency_ratio(window: np.ndarray, sample_rate: int) -> float:
  if len(window) < 8:
    return 0.0

  spectrum = np.abs(np.fft.rfft(window * np.hanning(len(window))))
  freqs = np.fft.rfftfreq(len(window), d=1.0 / sample_rate)
  total = float(np.sum(spectrum) + 1e-9)
  high = float(np.sum(spectrum[freqs >= 2500]))
  return high / total


def merge_events(events: list[dict[str, object]], max_gap: float = 0.65) -> list[dict[str, object]]:
  if not events:
    return []

  events.sort(key=lambda event: (str(event["label"]), float(event["start"])))
  merged: list[dict[str, object]] = []

  for event in events:
    if (
      merged
      and merged[-1]["label"] == event["label"]
      and float(event["start"]) - float(merged[-1]["end"]) <= max_gap
    ):
      merged[-1]["end"] = max(float(merged[-1]["end"]), float(event["end"]))
      merged[-1]["score"] = max(float(merged[-1]["score"]), float(event["score"]))
      continue

    merged.append(dict(event))

  merged.sort(key=lambda event: float(event["start"]))
  return merged


def detect_audio_events(wav_path: Path) -> dict[str, object]:
  sample_rate, audio = read_wav_mono(wav_path)

  if audio.size == 0:
    return {"events": [], "summary": {"duration": 0, "peak_dbfs": None}}

  window_size = max(1, int(sample_rate * 0.5))
  hop_size = max(1, int(sample_rate * 0.25))
  windows: list[dict[str, float]] = []

  for start in range(0, max(1, len(audio) - window_size), hop_size):
    chunk = audio[start : start + window_size]

    if len(chunk) < window_size // 2:
      continue

    windows.append({
      "start": start / sample_rate,
      "end": min(len(audio), start + window_size) / sample_rate,
      "db": dbfs(chunk),
      "zcr": zero_crossing_rate(chunk),
      "high_ratio": high_frequency_ratio(chunk, sample_rate),
    })

  if not windows:
    return {"events": [], "summary": {"duration": len(audio) / sample_rate, "peak_dbfs": dbfs(audio)}}

  db_values = np.array([window["db"] for window in windows], dtype=np.float32)
  loud_threshold = max(-18.0, float(np.percentile(db_values, 88)))
  laugh_threshold = max(-30.0, float(np.percentile(db_values, 65)))
  events: list[dict[str, object]] = []

  for index, window in enumerate(windows):
    loud_score = min(1.0, max(0.0, (window["db"] - loud_threshold + 8) / 16))

    if window["db"] >= loud_threshold:
      events.append({
        "label": "high_volume",
        "start": round(window["start"], 2),
        "end": round(window["end"], 2),
        "score": round(loud_score, 2),
        "reason": f"Audio level {window['db']:.1f} dBFS exceeded loud threshold.",
      })

    if window["db"] > -24 and window["high_ratio"] > 0.26 and window["zcr"] > 0.08:
      events.append({
        "label": "scream_or_shriek",
        "start": round(window["start"], 2),
        "end": round(window["end"], 2),
        "score": round(min(1.0, 0.45 + window["high_ratio"] + window["zcr"]), 2),
        "reason": "Loud window with high-frequency energy and rapid zero crossings.",
      })

    recent = windows[max(0, index - 5) : index + 1]
    bursts = [item for item in recent if item["db"] > laugh_threshold and 0.02 <= item["zcr"] <= 0.18]

    if len(bursts) >= 3 and window["db"] > laugh_threshold:
      events.append({
        "label": "laughter_like_bursts",
        "start": round(recent[0]["start"], 2),
        "end": round(window["end"], 2),
        "score": round(min(1.0, 0.38 + len(bursts) * 0.1), 2),
        "reason": "Repeated short voiced bursts that resemble laughter cadence.",
      })

  return {
    "events": merge_events(events),
    "summary": {
      "duration": round(len(audio) / sample_rate, 2),
      "peak_dbfs": round(float(np.max(db_values)), 2),
      "loud_threshold_dbfs": round(loud_threshold, 2),
    },
  }


def video_duration(video_path: Path) -> float:
  import cv2

  capture = cv2.VideoCapture(str(video_path))

  try:
    fps = capture.get(cv2.CAP_PROP_FPS) or 0
    frames = capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0
    return float(frames / fps) if fps else 0.0
  finally:
    capture.release()


def frame_times(duration: float, audio_events: list[dict[str, object]], max_frames: int) -> list[float]:
  candidates = {0.5}

  if duration > 1:
    for index in range(max_frames):
      candidates.add((index + 0.5) * duration / max_frames)

  for event in audio_events[: max_frames]:
    start = float(event.get("start", 0))
    end = float(event.get("end", start))
    candidates.add(max(0.0, min(duration, (start + end) / 2)))

  return sorted(time for time in candidates if 0 <= time <= max(0.5, duration))[:max_frames]


def sample_video_frames(video_path: Path, work_dir: Path, audio_events: list[dict[str, object]], max_frames: int) -> list[SampledFrame]:
  import cv2

  duration = video_duration(video_path)
  times = frame_times(duration, audio_events, max_frames)
  capture = cv2.VideoCapture(str(video_path))
  frames_dir = work_dir / "frames"
  frames_dir.mkdir(parents=True, exist_ok=True)
  frames: list[SampledFrame] = []

  try:
    for index, time in enumerate(times):
      capture.set(cv2.CAP_PROP_POS_MSEC, time * 1000)
      ok, frame = capture.read()

      if not ok or frame is None:
        continue

      height, width = frame.shape[:2]

      if width > 720:
        scale = 720 / width
        frame = cv2.resize(frame, (720, int(height * scale)), interpolation=cv2.INTER_AREA)

      out_path = frames_dir / f"frame_{index:02d}_{time:.2f}s.jpg"
      cv2.imwrite(str(out_path), frame, [int(cv2.IMWRITE_JPEG_QUALITY), 82])
      encoded = base64.b64encode(out_path.read_bytes()).decode("ascii")
      frames.append(SampledFrame(time=round(time, 2), path=out_path, data_url=f"data:image/jpeg;base64,{encoded}"))
  finally:
    capture.release()

  return frames


def json_object_from_text(text: str) -> dict[str, object]:
  cleaned = text.strip()
  cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
  cleaned = re.sub(r"\s*```$", "", cleaned)
  start = cleaned.find("{")
  end = cleaned.rfind("}")

  if start == -1 or end == -1 or end < start:
    raise ValueError("Model did not return a JSON object.")

  return json.loads(cleaned[start : end + 1])


def multimodal_prompt(transcription: dict[str, object], audio: dict[str, object]) -> str:
  segments = transcription.get("segments", []) if isinstance(transcription, dict) else []
  compact_segments = [
    {
      "start": round(float(segment.get("start", 0)), 2),
      "end": round(float(segment.get("end", 0)), 2),
      "text": str(segment.get("text", ""))[:180],
    }
    for segment in segments[:80]
    if isinstance(segment, dict)
  ]

  return (
    "You are analyzing a gameplay recording for funny moments. "
    "Use the sampled frames, transcript, and audio event hints. "
    "Also respect saved Backboard memories about the user's humor and editing preferences. "
    "Return only compact JSON with this shape: "
    '{"funny_moments":[{"start":0,"end":3,"score":0.0,"title":"short label","reason":"why it is funny","signals":["visual","audio","transcript"],"asset_hints":{"meme":"meme_laugh","sound":"sound_wtf"}}],"summary":"one sentence"}. '
    "Prefer short highlight windows of 2-12 seconds. Do not invent moments that are not supported.\n\n"
    "Asset hints are optional, but if you choose them you may only use these exact ids: "
    "meme_laugh, meme_embarrassed, sound_laugh, sound_wtf. "
    "Never invent external meme or sound assets.\n\n"
    f"Transcript segments:\n{json.dumps(compact_segments, ensure_ascii=False)}\n\n"
    f"Audio events:\n{json.dumps(audio.get('events', []), ensure_ascii=False)}"
  )


def remember_feedback_with_backboard(feedback: dict[str, str], state_path: Path | None) -> dict[str, object] | None:
  prompt = feedback.get("prompt", "").strip()
  feedback_text = feedback.get("feedback", "").strip()

  if not prompt and not feedback_text:
    return None

  content = (
    "Remember these user preferences for future gameplay highlight analysis. "
    "Only store durable preferences about humor, pacing, clip selection, subtitles, tone, or editing style.\n\n"
    f"User prompt/preferences:\n{prompt or '(none)'}\n\n"
    f"Feedback on previous analysis:\n{feedback_text or '(none)'}"
  )
  return backboard_send_message(
    content,
    state_path=state_path,
    memory="Auto",
    system_prompt="You help remember concise user preferences for video highlight analysis.",
  )


def analyze_funny_moments_with_backboard(
  frames: list[SampledFrame],
  transcription: dict[str, object],
  audio: dict[str, object],
  feedback: dict[str, str],
  state_path: Path | None,
) -> dict[str, object]:
  if not frames:
    raise RuntimeError("No frames could be extracted for multimodal analysis.")

  memory_response = remember_feedback_with_backboard(feedback, state_path)
  user_prompt = feedback.get("prompt", "").strip()
  user_feedback = feedback.get("feedback", "").strip()
  frame_manifest = [{"filename": frame.path.name, "time": frame.time} for frame in frames]
  content = (
    f"{multimodal_prompt(transcription, audio)}\n\n"
    f"User-written analysis prompt:\n{user_prompt or '(none)'}\n\n"
    f"User feedback to apply:\n{user_feedback or '(none)'}\n\n"
    f"Attached frame manifest:\n{json.dumps(frame_manifest, ensure_ascii=False)}"
  )
  response = backboard_send_message(
    content,
    state_path=state_path,
    files=[frame.path for frame in frames],
    json_output=True,
    memory=os.environ.get("BACKBOARD_ANALYSIS_MEMORY_MODE", "Readonly"),
    system_prompt=(
      "You are GestureForge's video highlight analyst. "
      "Use attached gameplay frames, transcript, audio events, and remembered preferences. "
      "Return valid JSON only."
    ),
  )
  parsed = json_object_from_text(str(response.get("content", "{}")))

  funny_moments = parsed.get("funny_moments", [])

  if not isinstance(funny_moments, list):
    funny_moments = []

  return {
    "provider": "backboard",
    "model_provider": response.get("model_provider"),
    "model_name": response.get("model_name"),
    "assistant_id": response.get("assistant_id"),
    "thread_id": response.get("thread_id"),
    "memory_operation_id": response.get("memory_operation_id"),
    "preference_memory_operation_id": memory_response.get("memory_operation_id") if memory_response else None,
    "sampled_frames": [{"time": frame.time, "path": str(frame.path)} for frame in frames],
    "funny_moments": funny_moments,
    "summary": parsed.get("summary", ""),
  }


def build_highlights(multimodal: dict[str, object], audio: dict[str, object]) -> list[dict[str, object]]:
  highlights: list[dict[str, object]] = []

  for moment in multimodal.get("funny_moments", []) if isinstance(multimodal, dict) else []:
    if not isinstance(moment, dict):
      continue

    highlights.append({
      "start": float(moment.get("start", 0)),
      "end": float(moment.get("end", 0)),
      "score": float(moment.get("score", 0)),
      "title": str(moment.get("title", "Funny moment")),
      "reason": str(moment.get("reason", "")),
      "source": "multimodal",
      "signals": moment.get("signals", []),
    })

  for event in audio.get("events", []) if isinstance(audio, dict) else []:
    if not isinstance(event, dict) or str(event.get("label")) == "high_volume":
      continue

    highlights.append({
      "start": float(event.get("start", 0)),
      "end": float(event.get("end", 0)),
      "score": min(0.75, float(event.get("score", 0))),
      "title": str(event.get("label", "audio_event")).replace("_", " ").title(),
      "reason": str(event.get("reason", "")),
      "source": "audio",
      "signals": [str(event.get("label", "audio"))],
    })

  highlights.sort(key=lambda item: item["score"], reverse=True)
  return highlights[:8]


def write_json(path: Path, payload: dict[str, object]) -> None:
  path.parent.mkdir(parents=True, exist_ok=True)
  path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> None:
  args = parse_args()
  root_dir = Path(__file__).resolve().parents[1]
  load_dotenv(root_dir / ".env")

  work_dir = Path(args.work_dir).resolve()
  work_dir.mkdir(parents=True, exist_ok=True)
  video_path = work_dir / f"source{safe_suffix(args.video_url)}"
  wav_path = work_dir / "audio.wav"
  feedback = read_feedback(args.feedback_json)
  assistant_state = Path(args.assistant_state).resolve() if args.assistant_state else root_dir / "tmp" / "backboard-state.json"
  errors: list[str] = []

  result: dict[str, object] = {
    "status": "complete",
    "public_id": args.public_id,
    "video_url": args.video_url,
    "generated_at": datetime.now(timezone.utc).isoformat(),
    "transcription": {"text": "", "segments": []},
    "audio": {"events": [], "summary": {}},
    "multimodal": {"funny_moments": [], "sampled_frames": []},
    "feedback": feedback,
    "highlights": [],
    "errors": errors,
  }

  try:
    download_video(args.video_url, video_path)
    result["local_video_path"] = str(video_path)
  except Exception as exc:
    result["status"] = "failed"
    errors.append(f"download: {exc}")
    write_json(Path(args.json_out), result)
    return

  try:
    if extract_audio(video_path, wav_path):
      result["audio_path"] = str(wav_path)
    else:
      errors.append("audio: ffmpeg was not found; set FFMPEG or add ffmpeg to PATH.")
  except Exception as exc:
    errors.append(f"audio_extract: {exc}")

  if wav_path.exists():
    try:
      result["transcription"] = transcribe_audio(wav_path)
    except Exception as exc:
      errors.append(f"transcription: {exc}")

    try:
      result["audio"] = detect_audio_events(wav_path)
    except Exception as exc:
      errors.append(f"audio_detect: {exc}")

  try:
    audio_events = result.get("audio", {}).get("events", []) if isinstance(result.get("audio"), dict) else []
    frames = sample_video_frames(video_path, work_dir, audio_events, args.max_frames)
    result["multimodal"] = analyze_funny_moments_with_backboard(
      frames,
      result["transcription"],
      result["audio"],
      feedback,
      assistant_state,
    )
  except Exception as exc:
    errors.append(f"backboard_multimodal: {exc}")

  result["highlights"] = build_highlights(result["multimodal"], result["audio"])

  if errors:
    result["status"] = "partial" if result["highlights"] or result.get("audio", {}).get("events") else "failed"

  write_json(Path(args.json_out), result)


if __name__ == "__main__":
  try:
    main()
  except Exception as error:
    print(str(error), file=sys.stderr)
    raise
