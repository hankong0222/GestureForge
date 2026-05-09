"""Serve the existing GestureForge hand skeleton renderer as an MJPEG stream.

Run:
  python tools/hand_camera_stream.py --mirror

The frontend reads http://localhost:8791/video and displays the already-drawn
camera frame instead of running another MediaPipe instance in React.
"""

from __future__ import annotations

import argparse
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cv2
import mediapipe as mp

from hand_finger_states import finger_states
from live_hand_skeleton import (
    draw_finger_states,
    draw_hand,
    draw_handedness,
    draw_label,
    handedness_label,
    landmark_points,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Stream the live GestureForge hand skeleton overlay.")
    parser.add_argument("--host", default="127.0.0.1", help="HTTP host.")
    parser.add_argument("--port", type=int, default=8791, help="HTTP port.")
    parser.add_argument("--camera", type=int, default=0, help="Webcam index.")
    parser.add_argument("--width", type=int, default=640, help="Requested camera width.")
    parser.add_argument("--height", type=int, default=480, help="Requested camera height.")
    parser.add_argument("--mirror", action="store_true", help="Mirror the webcam image.")
    parser.add_argument("--max-hands", type=int, default=2, help="Maximum number of hands to track.")
    parser.add_argument("--detect-conf", type=float, default=0.55, help="Minimum hand detection confidence.")
    parser.add_argument("--track-conf", type=float, default=0.55, help="Minimum hand tracking confidence.")
    parser.add_argument("--jpeg-quality", type=int, default=82, help="JPEG quality for the MJPEG stream.")
    return parser.parse_args()


class HandCamera:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.capture = cv2.VideoCapture(args.camera, cv2.CAP_DSHOW)
        self.capture.set(cv2.CAP_PROP_FRAME_WIDTH, args.width)
        self.capture.set(cv2.CAP_PROP_FRAME_HEIGHT, args.height)

        if not self.capture.isOpened():
            raise RuntimeError(f"Could not open camera index {args.camera}")

        self.hands = mp.solutions.hands.Hands(
            static_image_mode=False,
            max_num_hands=args.max_hands,
            model_complexity=1,
            min_detection_confidence=args.detect_conf,
            min_tracking_confidence=args.track_conf,
        )
        self.previous_time = time.perf_counter()
        self.fps = 0.0
        self.latest_state: dict[str, object] = {
            "hands": 0,
            "indexExtended": False,
            "indexFolded": False,
            "updatedAt": 0.0,
        }

    def close(self) -> None:
        self.hands.close()
        self.capture.release()

    def frame(self) -> bytes | None:
        ok, frame = self.capture.read()

        if not ok:
            return None

        if self.args.mirror:
            frame = cv2.flip(frame, 1)

        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        rgb.flags.writeable = False
        results = self.hands.process(rgb)

        height, width = frame.shape[:2]
        landmarks = results.multi_hand_landmarks or []
        handedness = results.multi_handedness or []
        hand_states: list[dict[str, object]] = []

        for index, hand_landmarks in enumerate(landmarks):
            current_handedness = handedness[index] if index < len(handedness) else None
            points = landmark_points(hand_landmarks, width, height)
            states = finger_states(hand_landmarks, handedness_label(current_handedness))
            draw_hand(frame, points)
            draw_handedness(frame, points, current_handedness)
            draw_finger_states(frame, points, states)
            hand_states.append(
                {
                    "handedness": handedness_label(current_handedness),
                    "states": states,
                }
            )

        aggregate_states = {
            finger: any(bool(item["states"].get(finger)) for item in hand_states)
            for finger in ("thumb", "index", "middle", "ring", "pinky")
        }
        index_extended = aggregate_states["index"]
        self.latest_state = {
            "hands": len(hand_states),
            "fingers": aggregate_states,
            "indexExtended": index_extended,
            "indexFolded": bool(hand_states) and not index_extended,
            "handsDetail": hand_states,
            "updatedAt": time.time(),
        }

        now = time.perf_counter()
        elapsed = now - self.previous_time
        self.previous_time = now
        self.fps = 0.9 * self.fps + 0.1 * (1 / elapsed) if self.fps else (1 / elapsed)

        draw_label(frame, f"FPS {self.fps:.1f}", (18, 34), (255, 214, 90))
        draw_label(frame, f"Hands {len(landmarks)}", (18, 64), (93, 230, 255))

        ok, encoded = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), self.args.jpeg_quality])
        return encoded.tobytes() if ok else None


def make_handler(camera: HandCamera) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: object) -> None:
            return

        def do_GET(self) -> None:
            if self.path == "/health":
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"status":"ok"}')
                return

            if self.path == "/state":
                payload = json.dumps(camera.latest_state).encode("utf-8")
                self.send_response(200)
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return

            if self.path != "/video":
                self.send_response(404)
                self.end_headers()
                return

            self.send_response(200)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
            self.end_headers()

            while True:
                frame = camera.frame()

                if frame is None:
                    break

                try:
                    self.wfile.write(b"--frame\r\n")
                    self.wfile.write(b"Content-Type: image/jpeg\r\n")
                    self.wfile.write(f"Content-Length: {len(frame)}\r\n\r\n".encode("ascii"))
                    self.wfile.write(frame)
                    self.wfile.write(b"\r\n")
                except (BrokenPipeError, ConnectionResetError):
                    break

    return Handler


def main() -> None:
    args = parse_args()
    camera = HandCamera(args)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(camera))

    print(f"GestureForge hand camera stream running at http://{args.host}:{args.port}/video")
    try:
        server.serve_forever()
    finally:
        camera.close()
        server.server_close()


if __name__ == "__main__":
    main()
