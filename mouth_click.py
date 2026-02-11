"""
mouth_click_server.py
─────────────────────
Face-controlled mouth-click, broadcast over WebSocket.
Uses the NEW MediaPipe Tasks API (mediapipe >= 0.10).

⚠️  PYTHON VERSION: mediapipe only supports Python 3.9 – 3.12.
    You are on Python 3.14 which is NOT supported.
    Please install Python 3.12 from https://python.org and run this
    script with that version:
        py -3.12 mouth_click_server.py

Install dependencies (in a Python 3.12 environment):
    pip install opencv-python mediapipe websockets

The model file (face_landmarker.task, ~3 MB) is downloaded automatically
on first run into the same folder as this script.

Every frame sends a JSON message to all connected browser clients:
  { "type": "move",  "x": 0.52, "y": 0.48 }   ← normalised 0-1 coords
  { "type": "click", "x": 0.52, "y": 0.48 }   ← fires when mouth OPENS
                                                   (triggers bird flap)
"""

import asyncio
import json
import math
import os
import sys
import time
import urllib.request

import cv2
import websockets

# ── Python version guard ───────────────────────────────────────────────────────
if sys.version_info >= (3, 13):
    print("=" * 65)
    print("ERROR: mediapipe does not support Python 3.13 or higher.")
    print(f"       You are running Python {sys.version_info.major}.{sys.version_info.minor}.")
    print()
    print("Fix: Install Python 3.12 from https://python.org/downloads/")
    print("     then run:  py -3.12 mouth_click_server.py")
    print("=" * 65)
    sys.exit(1)

import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision as mp_vision

# ── WebSocket config ──────────────────────────────────────────────────────────
WS_HOST = "localhost"
WS_PORT = 8765

# ── Camera ────────────────────────────────────────────────────────────────────
CAM_W, CAM_H, CAM_FPS = 640, 360, 30

# ── Model ─────────────────────────────────────────────────────────────────────
MODEL_URL  = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"
MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "face_landmarker.task")

# ── Tracking tuning ───────────────────────────────────────────────────────────
SMOOTHING_ALPHA      = 0.75
GAIN_X               = 2.8
GAIN_Y               = 3.2
DEADZONE             = 0.010
CENTER_ALPHA         = 0.02
CENTER_STABLE_THRESH = 0.02

# ── Mouth-open → flap tuning ──────────────────────────────────────────────────
OPEN_THRESH           = 0.26   # mouth ratio above this → fires a flap
MOUTH_FRAMES_REQUIRED = 2      # debounce: frames mouth must stay open
CLICK_COOLDOWN        = 0.35   # seconds between flap triggers

# ── State ─────────────────────────────────────────────────────────────────────
connected_clients: set = set()


# ── Helpers ───────────────────────────────────────────────────────────────────
def _clamp(v, lo, hi): return max(lo, min(hi, v))
def _ema(prev, new, a): return new if prev is None else prev + a * (new - prev)
def _dist(a, b):        return math.hypot(a.x - b.x, a.y - b.y)


def _soft_deadzone(v, dz):
    a = abs(v)
    if a < dz:
        return v * (a / dz) if dz > 1e-9 else 0.0
    return v


def _mouth_ratio(lm):
    """Vertical mouth opening / horizontal mouth width (normalised)."""
    v = _dist(lm[13], lm[14])
    h = _dist(lm[78], lm[308]) + 1e-6
    return v / h


def download_model():
    """Download the FaceLandmarker model if not already present."""
    if os.path.exists(MODEL_PATH):
        return
    print(f"[Model] Downloading face_landmarker.task (~3 MB) …")
    try:
        urllib.request.urlretrieve(MODEL_URL, MODEL_PATH)
        print(f"[Model] Saved to {MODEL_PATH}")
    except Exception as e:
        print(f"[Model] Download failed: {e}")
        print(f"        Please download manually from:\n        {MODEL_URL}")
        print(f"        and place it next to this script as 'face_landmarker.task'")
        sys.exit(1)


# ── WebSocket helpers ─────────────────────────────────────────────────────────
async def broadcast(msg: dict):
    if not connected_clients:
        return
    data = json.dumps(msg)
    await asyncio.gather(
        *[ws.send(data) for ws in list(connected_clients)],
        return_exceptions=True,
    )


async def ws_handler(websocket):
    print(f"[WS] Client connected: {websocket.remote_address}")
    connected_clients.add(websocket)
    try:
        await websocket.wait_closed()
    finally:
        connected_clients.discard(websocket)
        print(f"[WS] Client disconnected: {websocket.remote_address}")


# ── Main tracking loop ────────────────────────────────────────────────────────
async def face_tracking_loop():
    loop = asyncio.get_running_loop()

    # ── Camera ────────────────────────────────────────────────────────────────
    cam = cv2.VideoCapture(0, cv2.CAP_DSHOW)
    cam.set(cv2.CAP_PROP_FRAME_WIDTH,  CAM_W)
    cam.set(cv2.CAP_PROP_FRAME_HEIGHT, CAM_H)
    cam.set(cv2.CAP_PROP_FPS,          CAM_FPS)

    # ── MediaPipe Tasks FaceLandmarker (new API) ───────────────────────────────
    base_options = mp_python.BaseOptions(model_asset_path=MODEL_PATH)
    options = mp_vision.FaceLandmarkerOptions(
        base_options=base_options,
        running_mode=mp_vision.RunningMode.VIDEO,
        num_faces=1,
        min_face_detection_confidence=0.5,
        min_face_presence_confidence=0.5,
        min_tracking_confidence=0.5,
    )
    detector = mp_vision.FaceLandmarker.create_from_options(options)

    # ── Tracking state ────────────────────────────────────────────────────────
    prev_x = prev_y = None
    center_fx = center_fy = None
    mouth_open_frames = 0
    mouth_armed = False
    last_click = 0.0
    last_nx = last_ny = None
    frame_idx = 0

    print("[Face] Tracking started — open your mouth to flap!  Press 'q' to quit.")

    while True:
        ret, frame = await loop.run_in_executor(None, cam.read)
        if not ret or frame is None:
            await asyncio.sleep(0.01)
            continue

        frame = cv2.flip(frame, 1)
        fh, fw = frame.shape[:2]

        # Convert to MediaPipe Image (RGB)
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)

        # detect_for_video needs a monotonically increasing timestamp in ms
        timestamp_ms = int(frame_idx * (1000 / CAM_FPS))
        frame_idx += 1

        result = detector.detect_for_video(mp_image, timestamp_ms)

        if result.face_landmarks:
            lm = result.face_landmarks[0]   # list of NormalizedLandmark

            # ── Nose tip → cursor position ────────────────────────────────────
            nose = lm[1]
            fx, fy = nose.x, nose.y

            if center_fx is None:
                center_fx, center_fy = fx, fy
            else:
                ex, ey = fx - center_fx, fy - center_fy
                if abs(ex) < CENTER_STABLE_THRESH and abs(ey) < CENTER_STABLE_THRESH:
                    center_fx += CENTER_ALPHA * ex
                    center_fy += CENTER_ALPHA * ey

            dx = _soft_deadzone(fx - center_fx, DEADZONE) * GAIN_X
            dy = _soft_deadzone(fy - center_fy, DEADZONE) * GAIN_Y

            raw_x = _clamp(0.5 + dx, 0.0, 1.0)
            raw_y = _clamp(0.5 + dy, 0.0, 1.0)

            prev_x = _ema(prev_x, raw_x, SMOOTHING_ALPHA)
            prev_y = _ema(prev_y, raw_y, SMOOTHING_ALPHA)

            nx = round(prev_x, 4)
            ny = round(prev_y, 4)

            if last_nx != nx or last_ny != ny:
                await broadcast({"type": "move", "x": nx, "y": ny})
                last_nx, last_ny = nx, ny

            # ── Mouth open → flap ─────────────────────────────────────────────
            mr = _mouth_ratio(lm)

            if mr > OPEN_THRESH:
                mouth_open_frames += 1
                if mouth_open_frames >= MOUTH_FRAMES_REQUIRED and not mouth_armed:
                    now = time.time()
                    if (now - last_click) > CLICK_COOLDOWN:
                        await broadcast({"type": "click", "x": nx, "y": ny})
                        last_click = now
                        print(f"[Flap!] mouth={mr:.3f}  x={nx:.3f} y={ny:.3f}")
                    mouth_armed = True
            else:
                mouth_open_frames = 0
                mouth_armed = False

            # ── Debug overlay ─────────────────────────────────────────────────
            cv2.circle(frame, (int(nose.x * fw), int(nose.y * fh)), 5, (0, 255, 0), -1)
            for idx in [13, 14, 78, 308]:
                p = lm[idx]
                cv2.circle(frame, (int(p.x * fw), int(p.y * fh)), 3, (0, 255, 255), -1)

            hint = "FLAP!" if mouth_armed else ""
            cv2.putText(frame,
                        f"Mouth={mr:.3f}  armed={int(mouth_armed)}  clients={len(connected_clients)}  {hint}",
                        (12, 32), cv2.FONT_HERSHEY_SIMPLEX, 0.60, (255, 220, 0), 2)
            cv2.putText(frame,
                        f"WS ws://{WS_HOST}:{WS_PORT}  |  open mouth = flap  |  'q' quit",
                        (12, 60), cv2.FONT_HERSHEY_SIMPLEX, 0.50, (180, 180, 255), 1)

        cv2.imshow("FlappyBird – Face Controller", frame)
        if cv2.waitKey(1) & 0xFF == ord('q'):
            break

        await asyncio.sleep(0)

    cam.release()
    cv2.destroyAllWindows()
    detector.close()
    print("[Face] Tracking loop stopped.")


async def main():
    download_model()
    print(f"[WS] Starting WebSocket server on ws://{WS_HOST}:{WS_PORT}")
    async with websockets.serve(ws_handler, WS_HOST, WS_PORT):
        await face_tracking_loop()


if __name__ == "__main__":
    asyncio.run(main())