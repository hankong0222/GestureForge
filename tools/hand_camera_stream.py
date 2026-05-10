"""Serve the existing GestureForge hand skeleton renderer as an MJPEG stream.

Run:
  python tools/hand_camera_stream.py --mirror

The frontend reads http://localhost:8791/video and displays the already-drawn
camera frame instead of running another MediaPipe instance in React.
"""

from __future__ import annotations

import argparse
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cv2


def draw_label(frame, text: str, origin: tuple[int, int], color: tuple[int, int, int]) -> None:
    x, y = origin
    cv2.putText(frame, text, (x + 2, y + 2), cv2.FONT_HERSHEY_SIMPLEX, 0.58, (0, 0, 0), 3, cv2.LINE_AA)
    cv2.putText(frame, text, (x, y), cv2.FONT_HERSHEY_SIMPLEX, 0.58, color, 2, cv2.LINE_AA)


class LazyHandTracker:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.ready = False
        self.error = ""
        self.hands = None
        self.finger_states = None
        self.draw_finger_states = None
        self.draw_hand = None
        self.draw_handedness = None
        self.handedness_label = None
        self.landmark_points = None
        self.lock = threading.Lock()
        self.loader = threading.Thread(target=self._load, daemon=True)
        self.loader.start()

    def status(self) -> str:
        with self.lock:
            if self.ready:
                return "ready"

            return self.error or "loading"

    def _load(self) -> None:
        try:
            import mediapipe as mp
            from hand_finger_states import finger_states
            from live_hand_skeleton import (
                draw_finger_states,
                draw_hand,
                draw_handedness,
                handedness_label,
                landmark_points,
            )

            hands = mp.solutions.hands.Hands(
                static_image_mode=False,
                max_num_hands=self.args.max_hands,
                model_complexity=1,
                min_detection_confidence=self.args.detect_conf,
                min_tracking_confidence=self.args.track_conf,
            )
            with self.lock:
                self.hands = hands
                self.finger_states = finger_states
                self.draw_finger_states = draw_finger_states
                self.draw_hand = draw_hand
                self.draw_handedness = draw_handedness
                self.handedness_label = handedness_label
                self.landmark_points = landmark_points
                self.ready = True
        except Exception as error:
            with self.lock:
                self.error = str(error)

    def close(self) -> None:
        with self.lock:
            hands = self.hands
            self.hands = None
            self.ready = False

        if hands is not None:
            hands.close()

    def analyze(self, frame) -> tuple[list[dict[str, object]], str]:
        with self.lock:
            ready = self.ready
            error = self.error
            hands = self.hands
            finger_states = self.finger_states
            draw_finger_states = self.draw_finger_states
            draw_hand = self.draw_hand
            draw_handedness = self.draw_handedness
            handedness_label = self.handedness_label
            landmark_points = self.landmark_points

        if not ready or hands is None:
            return [], error or "loading"

        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        rgb.flags.writeable = False
        results = hands.process(rgb)

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

        return hand_states, "ready"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Stream the live GestureForge hand skeleton overlay.")
    parser.add_argument("--host", default="127.0.0.1", help="HTTP host.")
    parser.add_argument("--port", type=int, default=8791, help="HTTP port.")
    parser.add_argument("--camera", type=int, default=-1, help="Webcam index. Use -1 to auto-detect.")
    parser.add_argument("--backend", choices=("dshow", "msmf", "any", "auto"), default="auto", help="OpenCV camera backend.")
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
        self.capture, self.camera_index = self.open_capture()
        self.tracker = LazyHandTracker(args)
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self.previous_time = time.perf_counter()
        self.fps = 0.0
        self.latest_frame: bytes | None = None
        self.latest_state: dict[str, object] = {
            "hands": 0,
            "trackerStatus": "loading",
            "indexExtended": False,
            "indexFolded": False,
            "updatedAt": 0.0,
        }
        self.worker = threading.Thread(target=self.capture_loop, daemon=True)
        self.worker.start()

    def open_capture(self):
        indices = [self.args.camera] if self.args.camera >= 0 else list(range(6))
        backend_map = {
            "dshow": [("DSHOW", cv2.CAP_DSHOW)],
            "msmf": [("MSMF", cv2.CAP_MSMF)],
            "any": [("ANY", cv2.CAP_ANY)],
            "auto": [
                ("DSHOW", cv2.CAP_DSHOW),
                ("MSMF", cv2.CAP_MSMF),
                ("ANY", cv2.CAP_ANY),
            ],
        }
        backends = backend_map[self.args.backend]
        errors: list[str] = []

        for index in indices:
            for backend_name, backend in backends:
                capture = cv2.VideoCapture(index, backend)
                capture.set(cv2.CAP_PROP_FRAME_WIDTH, self.args.width)
                capture.set(cv2.CAP_PROP_FRAME_HEIGHT, self.args.height)

                if capture.isOpened():
                    ok = False

                    for _ in range(12):
                        ok, _ = capture.read()

                        if ok:
                            break

                        time.sleep(0.08)

                    if ok:
                        print(f"Using camera index {index} via {backend_name}", flush=True)
                        return capture, index

                capture.release()
                errors.append(f"{index}/{backend_name}")

        hint = ", ".join(errors[:12])
        raise RuntimeError(f"Could not open a usable camera. Tried {hint}.")

    def close(self) -> None:
        self.stop_event.set()
        self.worker.join(timeout=1)
        self.tracker.close()
        self.capture.release()

    def state(self) -> dict[str, object]:
        with self.lock:
            return dict(self.latest_state)

    def frame(self) -> bytes | None:
        with self.lock:
            return self.latest_frame

    def capture_loop(self) -> None:
        while not self.stop_event.is_set():
            ok, frame = self.capture.read()

            if not ok:
                time.sleep(0.05)
                continue

            encoded = self.process_frame(frame)

            if encoded is not None:
                with self.lock:
                    self.latest_frame = encoded

            time.sleep(0.01)

    def process_frame(self, frame) -> bytes | None:
        if frame is None:
            return None


        if self.args.mirror:
            frame = cv2.flip(frame, 1)

        hand_states, tracker_status = self.tracker.analyze(frame)

        aggregate_states = {
            finger: any(bool(item["states"].get(finger)) for item in hand_states)
            for finger in ("thumb", "index", "middle", "ring", "pinky")
        }
        index_extended = aggregate_states["index"]
        latest_state = {
            "hands": len(hand_states),
            "trackerStatus": tracker_status,
            "fingers": aggregate_states,
            "indexExtended": index_extended,
            "indexFolded": bool(hand_states) and not index_extended,
            "handsDetail": hand_states,
            "updatedAt": time.time(),
        }
        with self.lock:
            self.latest_state = latest_state

        now = time.perf_counter()
        elapsed = now - self.previous_time
        self.previous_time = now
        self.fps = 0.9 * self.fps + 0.1 * (1 / elapsed) if self.fps else (1 / elapsed)

        draw_label(frame, f"FPS {self.fps:.1f}", (18, 34), (255, 214, 90))
        draw_label(frame, f"Hands {len(hand_states)}", (18, 64), (93, 230, 255))

        if tracker_status != "ready":
            draw_label(frame, f"MediaPipe {tracker_status}", (18, 94), (255, 95, 159))

        ok, encoded = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), self.args.jpeg_quality])
        return encoded.tobytes() if ok else None


def make_handler(camera: HandCamera, shutdown_server) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: object) -> None:
            return

        def send_payload(
            self,
            status: int,
            payload: bytes = b"",
            content_type: str = "application/json",
            cache_control: str | None = None,
        ) -> bool:
            try:
                self.send_response(status)
                if cache_control:
                    self.send_header("Cache-Control", cache_control)
                if content_type:
                    self.send_header("Content-Type", content_type)
                if payload:
                    self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                if payload:
                    self.wfile.write(payload)
                return True
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
                return False

        def do_POST(self) -> None:
            if self.path == "/shutdown":
                self.send_payload(200, b'{"status":"stopping"}')
                threading.Thread(target=shutdown_server, daemon=True).start()
                return

            self.send_payload(404, b'{"error":"not found"}')

        def do_GET(self) -> None:
            if self.path == "/health":
                self.send_payload(200, b'{"status":"ok"}')
                return

            if self.path == "/state":
                payload = json.dumps(camera.state()).encode("utf-8")
                self.send_payload(200, payload, cache_control="no-store")
                return

            if self.path == "/shutdown":
                self.send_payload(200, b'{"status":"stopping"}')
                threading.Thread(target=shutdown_server, daemon=True).start()
                return

            if self.path != "/video":
                self.send_payload(404, b'{"error":"not found"}')
                return

            self.send_response(200)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
            self.end_headers()

            while True:
                frame = camera.frame()

                if frame is None:
                    time.sleep(0.05)
                    continue

                try:
                    self.wfile.write(b"--frame\r\n")
                    self.wfile.write(b"Content-Type: image/jpeg\r\n")
                    self.wfile.write(f"Content-Length: {len(frame)}\r\n\r\n".encode("ascii"))
                    self.wfile.write(frame)
                    self.wfile.write(b"\r\n")
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
                    break

    return Handler


def main() -> None:
    args = parse_args()
    camera = HandCamera(args)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(camera, lambda: server.shutdown()))

    print(f"GestureForge hand camera stream running at http://{args.host}:{args.port}/video")
    try:
        server.serve_forever()
    finally:
        camera.close()
        server.server_close()


if __name__ == "__main__":
    main()
