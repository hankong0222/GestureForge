"""Finger extension checks for MediaPipe Hands landmarks.

The checks use a palm-local coordinate system:
  - y axis: wrist -> middle finger MCP, the direction fingers extend.
  - x axis: pinky MCP -> index MCP, the thumb-side direction.

MediaPipe landmarks can be passed as a hand_landmarks object, a list of
landmark-like objects with x/y attributes, or a list of (x, y) / (x, y, z)
tuples. Coordinates may be normalized or pixel coordinates.
"""

from __future__ import annotations

from dataclasses import dataclass
from math import hypot
from typing import Mapping, Sequence


WRIST = 0
THUMB_CMC = 1
THUMB_MCP = 2
THUMB_IP = 3
THUMB_TIP = 4
INDEX_MCP = 5
INDEX_PIP = 6
INDEX_DIP = 7
INDEX_TIP = 8
MIDDLE_MCP = 9
MIDDLE_PIP = 10
MIDDLE_DIP = 11
MIDDLE_TIP = 12
RING_MCP = 13
RING_PIP = 14
RING_DIP = 15
RING_TIP = 16
PINKY_MCP = 17
PINKY_PIP = 18
PINKY_DIP = 19
PINKY_TIP = 20

FINGER_JOINTS = {
    "index": (INDEX_MCP, INDEX_PIP, INDEX_DIP, INDEX_TIP),
    "middle": (MIDDLE_MCP, MIDDLE_PIP, MIDDLE_DIP, MIDDLE_TIP),
    "ring": (RING_MCP, RING_PIP, RING_DIP, RING_TIP),
    "pinky": (PINKY_MCP, PINKY_PIP, PINKY_DIP, PINKY_TIP),
}


@dataclass(frozen=True)
class Point:
    x: float
    y: float


@dataclass(frozen=True)
class PalmFrame:
    origin: Point
    x_axis: Point
    y_axis: Point
    scale: float


def _point(raw_point: object) -> Point:
    if hasattr(raw_point, "x") and hasattr(raw_point, "y"):
        return Point(float(raw_point.x), float(raw_point.y))

    if isinstance(raw_point, Sequence) and len(raw_point) >= 2:
        return Point(float(raw_point[0]), float(raw_point[1]))

    raise TypeError(f"Unsupported landmark point: {raw_point!r}")


def _points(landmarks: object) -> list[Point]:
    raw_landmarks = getattr(landmarks, "landmark", landmarks)
    points = [_point(point) for point in raw_landmarks]

    if len(points) < 21:
        raise ValueError(f"MediaPipe Hands requires 21 landmarks, got {len(points)}")

    return points


def _subtract(a: Point, b: Point) -> Point:
    return Point(a.x - b.x, a.y - b.y)


def _dot(a: Point, b: Point) -> float:
    return a.x * b.x + a.y * b.y


def _length(vector: Point) -> float:
    return hypot(vector.x, vector.y)


def _normalize(vector: Point, fallback: Point) -> Point:
    length = _length(vector)

    if length < 1e-9:
        return fallback

    return Point(vector.x / length, vector.y / length)


def build_palm_frame(landmarks: object) -> tuple[list[Point], PalmFrame]:
    points = _points(landmarks)
    wrist = points[WRIST]
    middle_mcp = points[MIDDLE_MCP]
    index_mcp = points[INDEX_MCP]
    pinky_mcp = points[PINKY_MCP]

    y_axis = _normalize(_subtract(middle_mcp, wrist), Point(0.0, -1.0))
    thumb_side = _normalize(_subtract(index_mcp, pinky_mcp), Point(1.0, 0.0))
    scale = max(_length(_subtract(middle_mcp, wrist)), _length(_subtract(index_mcp, pinky_mcp)), 1e-6)

    return points, PalmFrame(origin=wrist, x_axis=thumb_side, y_axis=y_axis, scale=scale)


def palm_coordinates(point: Point, frame: PalmFrame) -> Point:
    relative = _subtract(point, frame.origin)
    return Point(_dot(relative, frame.x_axis) / frame.scale, _dot(relative, frame.y_axis) / frame.scale)


def _finger_is_extended(
    landmarks: object,
    finger: str,
    *,
    min_tip_forward: float = 0.32,
    min_tip_pip_gap: float = 0.16,
) -> bool:
    points, frame = build_palm_frame(landmarks)
    mcp_index, pip_index, dip_index, tip_index = FINGER_JOINTS[finger]
    mcp = palm_coordinates(points[mcp_index], frame)
    pip = palm_coordinates(points[pip_index], frame)
    dip = palm_coordinates(points[dip_index], frame)
    tip = palm_coordinates(points[tip_index], frame)

    points_forward = tip.y > mcp.y + min_tip_forward and tip.y > pip.y + min_tip_pip_gap
    joints_progress_outward = tip.y >= dip.y - 0.08 and dip.y >= pip.y - 0.08

    return points_forward and joints_progress_outward


def _thumb_is_extended(
    landmarks: object,
    *,
    min_tip_side_gap: float = 0.16,
    min_ip_side_gap: float = 0.05,
    max_fold_back: float = 0.14,
) -> bool:
    points, frame = build_palm_frame(landmarks)
    cmc = palm_coordinates(points[THUMB_CMC], frame)
    mcp = palm_coordinates(points[THUMB_MCP], frame)
    ip = palm_coordinates(points[THUMB_IP], frame)
    tip = palm_coordinates(points[THUMB_TIP], frame)

    opens_to_thumb_side = tip.x > mcp.x + min_tip_side_gap and tip.x > ip.x + min_ip_side_gap
    joint_chain_does_not_fold_back = ip.x >= cmc.x - max_fold_back and tip.x >= ip.x - max_fold_back

    return opens_to_thumb_side and joint_chain_does_not_fold_back


def is_left_thumb_extended(landmarks: object) -> bool:
    return _thumb_is_extended(landmarks)


def is_left_index_extended(landmarks: object) -> bool:
    return _finger_is_extended(landmarks, "index")


def is_left_middle_extended(landmarks: object) -> bool:
    return _finger_is_extended(landmarks, "middle")


def is_left_ring_extended(landmarks: object) -> bool:
    return _finger_is_extended(landmarks, "ring")


def is_left_pinky_extended(landmarks: object) -> bool:
    return _finger_is_extended(landmarks, "pinky")


def is_right_thumb_extended(landmarks: object) -> bool:
    return _thumb_is_extended(landmarks)


def is_right_index_extended(landmarks: object) -> bool:
    return _finger_is_extended(landmarks, "index")


def is_right_middle_extended(landmarks: object) -> bool:
    return _finger_is_extended(landmarks, "middle")


def is_right_ring_extended(landmarks: object) -> bool:
    return _finger_is_extended(landmarks, "ring")


def is_right_pinky_extended(landmarks: object) -> bool:
    return _finger_is_extended(landmarks, "pinky")


LEFT_HAND_EXTENDED_CHECKS = {
    "thumb": is_left_thumb_extended,
    "index": is_left_index_extended,
    "middle": is_left_middle_extended,
    "ring": is_left_ring_extended,
    "pinky": is_left_pinky_extended,
}

RIGHT_HAND_EXTENDED_CHECKS = {
    "thumb": is_right_thumb_extended,
    "index": is_right_index_extended,
    "middle": is_right_middle_extended,
    "ring": is_right_ring_extended,
    "pinky": is_right_pinky_extended,
}


def left_finger_states(landmarks: object) -> dict[str, bool]:
    return {finger: check(landmarks) for finger, check in LEFT_HAND_EXTENDED_CHECKS.items()}


def right_finger_states(landmarks: object) -> dict[str, bool]:
    return {finger: check(landmarks) for finger, check in RIGHT_HAND_EXTENDED_CHECKS.items()}


def finger_states(landmarks: object, handedness_label: str | None) -> dict[str, bool]:
    label = (handedness_label or "").strip().lower()

    if label == "left":
        return left_finger_states(landmarks)

    if label == "right":
        return right_finger_states(landmarks)

    return right_finger_states(landmarks)


def finger_pose_values(states: Mapping[str, bool]) -> dict[str, int]:
    return {finger: 100 if is_extended else 0 for finger, is_extended in states.items()}
