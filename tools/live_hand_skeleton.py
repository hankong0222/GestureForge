"""Open a webcam and draw MediaPipe hand skeletons in real time.

Run:
  python tools/live_hand_skeleton.py --mirror

Controls:
  q or Esc  close the camera window
  s         save a screenshot into runs/hand_skeleton
"""

from __future__ import annotations

import argparse
import time
from pathlib import Path

import cv2
import mediapipe as mp
import numpy as np


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = ROOT / "runs" / "hand_skeleton"

FINGER_COLORS = {
    "thumb": (255, 95, 159),
    "index": (93, 230, 255),
    "middle": (146, 255, 115),
    "ring": (255, 214, 90),
    "pinky": (190, 145, 255),
    "palm": (246, 241, 223),
}

CONNECTION_COLORS = {
    (0, 1): "palm",
    (1, 2): "thumb",
    (2, 3): "thumb",
    (3, 4): "thumb",
    (0, 5): "palm",
    (5, 6): "index",
    (6, 7): "index",
    (7, 8): "index",
    (0, 9): "palm",
    (9, 10): "middle",
    (10, 11): "middle",
    (11, 12): "middle",
    (0, 13): "palm",
    (13, 14): "ring",
    (14, 15): "ring",
    (15, 16): "ring",
    (0, 17): "palm",
    (17, 18): "pinky",
    (18, 19): "pinky",
    (19, 20): "pinky",
    (5, 9): "palm",
    (9, 13): "palm",
    (13, 17): "palm",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Draw live hand skeletons with MediaPipe Hands.")
    parser.add_argument("--camera", type=int, default=0, help="Webcam index.")
    parser.add_argument("--width", type=int, default=1280, help="Requested camera width.")
    parser.add_argument("--height", type=int, default=720, help="Requested camera height.")
    parser.add_argument("--mirror", action="store_true", help="Mirror the webcam image.")
    parser.add_argument("--max-hands", type=int, default=2, help="Maximum number of hands to track.")
    parser.add_argument("--detect-conf", type=float, default=0.55, help="Minimum hand detection confidence.")
    parser.add_argument("--track-conf", type=float, default=0.55, help="Minimum hand tracking confidence.")
    return parser.parse_args()


def draw_label(frame: np.ndarray, text: str, origin: tuple[int, int], color: tuple[int, int, int]) -> None:
    x, y = origin
    cv2.putText(frame, text, (x + 2, y + 2), cv2.FONT_HERSHEY_SIMPLEX, 0.58, (0, 0, 0), 3, cv2.LINE_AA)
    cv2.putText(frame, text, (x, y), cv2.FONT_HERSHEY_SIMPLEX, 0.58, color, 2, cv2.LINE_AA)


def landmark_points(hand_landmarks: object, width: int, height: int) -> list[tuple[int, int]]:
    points: list[tuple[int, int]] = []

    for landmark in hand_landmarks.landmark:
        x = min(max(int(landmark.x * width), 0), width - 1)
        y = min(max(int(landmark.y * height), 0), height - 1)
        points.append((x, y))

    return points


def draw_hand(frame: np.ndarray, points: list[tuple[int, int]]) -> None:
    for start, end in CONNECTION_COLORS:
        color_name = CONNECTION_COLORS[(start, end)]
        color = FINGER_COLORS[color_name]
        cv2.line(frame, points[start], points[end], color, 3, cv2.LINE_AA)

    for index, point in enumerate(points):
        color = (255, 255, 255) if index == 0 else (93, 230, 255)
        cv2.circle(frame, point, 6, (0, 0, 0), -1, cv2.LINE_AA)
        cv2.circle(frame, point, 4, color, -1, cv2.LINE_AA)


def draw_handedness(
    frame: np.ndarray,
    points: list[tuple[int, int]],
    handedness: object | None,
) -> None:
    if handedness is None:
        return

    classification = handedness.classification[0]
    label = classification.label
    score = classification.score
    x = min(point[0] for point in points)
    y = max(24, min(point[1] for point in points) - 10)
    draw_label(frame, f"{label} {score:.2f}", (x, y), (146, 255, 115))


def main() -> None:
    args = parse_args()
    cap = cv2.VideoCapture(args.camera, cv2.CAP_DSHOW)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, args.width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, args.height)

    if not cap.isOpened():
        raise RuntimeError(f"Could not open camera index {args.camera}")

    hands_detector = mp.solutions.hands.Hands(
        static_image_mode=False,
        max_num_hands=args.max_hands,
        model_complexity=1,
        min_detection_confidence=args.detect_conf,
        min_tracking_confidence=args.track_conf,
    )

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    prev_time = time.perf_counter()
    fps = 0.0
    screenshot_count = 0

    print("MediaPipe camera running. Press q or Esc to quit. Press s to save a screenshot.")

    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break

            if args.mirror:
                frame = cv2.flip(frame, 1)

            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            rgb.flags.writeable = False
            results = hands_detector.process(rgb)

            hands_count = 0
            height, width = frame.shape[:2]
            landmarks = results.multi_hand_landmarks or []
            handedness = results.multi_handedness or []

            for index, hand_landmarks in enumerate(landmarks):
                points = landmark_points(hand_landmarks, width, height)
                draw_hand(frame, points)
                draw_handedness(frame, points, handedness[index] if index < len(handedness) else None)
                hands_count += 1

            now = time.perf_counter()
            elapsed = now - prev_time
            prev_time = now
            fps = 0.9 * fps + 0.1 * (1 / elapsed) if fps else (1 / elapsed)

            draw_label(frame, f"FPS {fps:.1f}", (18, 34), (255, 214, 90))
            draw_label(frame, f"Hands {hands_count}", (18, 64), (93, 230, 255))
            draw_label(frame, "MediaPipe Hands | q/Esc quit | s save", (18, frame.shape[0] - 22), (246, 241, 223))

            cv2.imshow("GestureForge MediaPipe Hand Skeleton", frame)
            key = cv2.waitKey(1) & 0xFF

            if key in (27, ord("q")):
                break

            if key == ord("s"):
                screenshot_count += 1
                output_path = OUTPUT_DIR / f"mediapipe_hand_{screenshot_count:03d}.png"
                cv2.imwrite(str(output_path), frame)
                print(f"Saved {output_path}")
    finally:
        hands_detector.close()
        cap.release()
        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
