"""Apply a GestureForge mapping to a session game source tree.

This patcher is intentionally conservative. It copies the original game into a
patched directory, injects a small JS runtime for browser games, then replaces
only high-confidence JavaScript keyboard/action usage checks from analysis.json
and mapping.json.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import stat
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any


SUPPORTED_PATCH_EXTENSIONS = {".js", ".jsx", ".ts", ".tsx", ".html", ".htm"}
HTML_EXTENSIONS = {".html", ".htm"}


@dataclass
class PatchResult:
    control_id: str
    action: str
    gesture: str
    status: str
    file: str | None = None
    line: int | None = None
    before: str | None = None
    after: str | None = None
    reason: str | None = None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Patch game keyboard controls with GestureForge gesture functions.")
    parser.add_argument("--source", required=True, help="Original game source directory.")
    parser.add_argument("--analysis", required=True, help="analysis.json path.")
    parser.add_argument("--mapping", required=True, help="mapping.json path.")
    parser.add_argument("--plan", help="Optional patch-plan.json path. When present, apply only this reviewed plan.")
    parser.add_argument("--out", required=True, help="Patched output directory.")
    parser.add_argument("--report-out", help="Optional JSON report path.")
    return parser.parse_args()


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def safe_relative(path_text: str) -> Path:
    relative = Path(path_text)

    if relative.is_absolute() or any(part == ".." for part in relative.parts):
        raise ValueError(f"Unsafe relative path: {path_text}")

    return relative


def clean_output_dir(source: Path, out: Path) -> None:
    source = source.resolve()
    out = out.resolve()

    if out == source or source in out.parents:
        raise ValueError("Output directory must not be inside the source directory.")

    def make_writable_and_retry(function: Any, path: str, exc_info: Any) -> None:
        try:
            os.chmod(path, stat.S_IWRITE)
            function(path)
        except Exception:
            raise exc_info[1]

    if out.exists():
        shutil.rmtree(out, onerror=make_writable_and_retry)

    shutil.copytree(source, out, ignore=shutil.ignore_patterns(".git", "node_modules", ".venv", "venv"))


def js_identifier(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9_$]+", "_", value.strip()).strip("_")

    if not cleaned:
        return "control"

    if re.match(r"^[0-9]", cleaned):
        cleaned = f"control_{cleaned}"

    return cleaned[:1].lower() + cleaned[1:]


def function_name(control: dict[str, Any]) -> str:
    suggested = str(control.get("suggested_function") or "")
    match = re.search(r"gestureForge\.controls\.([A-Za-z_$][\w$]*)\s*\(", suggested)

    if match:
        return match.group(1)

    return js_identifier(str(control.get("action") or control.get("control_id") or "control"))


def gesture_fingers(control: dict[str, Any]) -> list[str]:
    fingers = control.get("gesture_fingers")

    if isinstance(fingers, list):
        return [
            str(finger)
            for finger in fingers
            if str(finger) in {"thumb", "index", "middle", "ring", "pinky"}
        ]

    gesture = str(control.get("gesture") or "")

    if gesture == "index_extend":
        return ["index"]

    return []


def is_edge_triggered(control: dict[str, Any]) -> bool:
    texts = [
        str((control.get("binding_target") or {}).get("text") or ""),
        str(control.get("event") or ""),
        str(control.get("source_kind") or ""),
    ]
    joined = " ".join(texts)

    return (
        "keydown" in joined.lower()
        or "KEYDOWN" in joined
        or bool(re.search(r"bindKey\s*\([^)]*,\s*[^)]*,\s*true\s*\)", joined, re.IGNORECASE))
    )


def needs_key_synthesis(control: dict[str, Any]) -> bool:
    usage_targets = control.get("usage_targets") or []

    if not isinstance(usage_targets, list) or not usage_targets:
        return True

    for target in usage_targets:
        if not isinstance(target, dict):
            continue

        text = str(target.get("text") or "")

        if re.search(r"\baction\s*={2,3}\s*['\"][^'\"]+['\"]", text):
            return True

        if re.search(r"['\"][^'\"]+['\"]\s*={2,3}\s*action\b", text):
            return True

        if re.search(r"addEventListener|KEYDOWN|KEYUP|keydown|keyup|keypress", text, re.IGNORECASE):
            return True

    return False


def key_event_fields(control: dict[str, Any]) -> dict[str, Any]:
    key = str(control.get("key") or "")
    code = str(control.get("code") or key)
    normalized = code or key
    key_code_by_name = {
        "Backspace": 8,
        "Tab": 9,
        "Enter": 13,
        "ShiftLeft": 16,
        "ShiftRight": 16,
        "ControlLeft": 17,
        "ControlRight": 17,
        "AltLeft": 18,
        "AltRight": 18,
        "Escape": 27,
        "Space": 32,
        "ArrowLeft": 37,
        "ArrowUp": 38,
        "ArrowRight": 39,
        "ArrowDown": 40,
    }

    if normalized == "Space" or key == "Space":
        return {"key": " ", "code": "Space", "keyCode": 32}

    if re.fullmatch(r"Key[A-Z]", normalized):
        letter = normalized[-1]
        return {"key": letter.lower(), "code": normalized, "keyCode": ord(letter)}

    if re.fullmatch(r"Digit[0-9]", normalized):
        digit = normalized[-1]
        return {"key": digit, "code": normalized, "keyCode": ord(digit)}

    if normalized in key_code_by_name:
        return {"key": key if key and key != "Space" else normalized, "code": normalized, "keyCode": key_code_by_name[normalized]}

    if len(key) == 1:
        upper = key.upper()
        return {"key": key, "code": code or f"Key{upper}", "keyCode": ord(upper)}

    return {"key": key or normalized, "code": code or normalized, "keyCode": 0}


def mapping_controls(mapping: dict[str, Any]) -> list[dict[str, Any]]:
    controls = mapping.get("controls", [])

    if not isinstance(controls, list):
        return []

    return [control for control in controls if isinstance(control, dict)]


def runtime_source(mapping: dict[str, Any]) -> str:
    entries = []
    key_entries = []

    for control in mapping_controls(mapping):
        function = function_name(control)
        fingers = gesture_fingers(control)
        entries.append(
            f"    {json.dumps(function)}: "
            f"{{ fingers: {json.dumps(fingers)}, edge: {str(is_edge_triggered(control)).lower()} }}"
        )

        if needs_key_synthesis(control):
            key_entries.append(f"    {json.dumps(function)}: {json.dumps(key_event_fields(control))}")

    controls_object = ",\n".join(entries)
    keys_object = ",\n".join(key_entries)

    return f"""(function () {{
  var root = window.gestureForge = window.gestureForge || {{}};
  var state = root.state = root.state || {{
    indexExtended: false,
    indexFolded: true,
    fingers: {{
      thumb: false,
      index: false,
      middle: false,
      ring: false,
      pinky: false
    }},
    hands: 0
  }};
  var controlMap = {{
{controls_object}
  }};
  var keyMap = {{
{keys_object}
  }};
  var extraPredicates = root.extraPredicates = root.extraPredicates || {{}};
  var activeKeyboardActions = root.activeKeyboardActions = root.activeKeyboardActions || {{}};
  var previousGestureActions = root.previousGestureActions = root.previousGestureActions || {{}};
  var edgePulseActions = root.edgePulseActions = root.edgePulseActions || {{}};

  root.setState = function setState(nextState) {{
    Object.assign(state, nextState || {{}});
    state.fingers = Object.assign({{
      thumb: false,
      index: !!state.indexExtended,
      middle: false,
      ring: false,
      pinky: false
    }}, state.fingers || {{}}, nextState && nextState.fingers ? nextState.fingers : {{}});
    state.indexExtended = !!state.fingers.index;
    state.indexFolded = !!state.hands && !state.indexExtended;
    Object.keys(controlMap).forEach(function updateEdgePulse(action) {{
      var active = rawGestureActive(action);
      var wasActive = !!previousGestureActions[action];
      var config = controlConfig(action);

      if (config.edge && active && !wasActive) {{
        edgePulseActions[action] = true;
      }}

      previousGestureActions[action] = active;
    }});
    syncKeyboardEvents();
  }};

  root.gestures = root.gestures || {{
    indexExtended: function indexExtended() {{ return !!state.indexExtended; }},
    indexFolded: function indexFolded() {{ return !!state.indexFolded; }}
  }};

  root.controls = root.controls || {{}};
  root.input = root.input || {{}};

  function asPredicateList(predicates) {{
    if (!predicates) return [];
    return Array.isArray(predicates) ? predicates : [predicates];
  }}

  function runPredicate(predicate) {{
    try {{
      return typeof predicate === "function" && !!predicate();
    }} catch (error) {{
      return false;
    }}
  }}

  function controlConfig(action) {{
    var config = controlMap[action];
    return config || {{ fingers: [], edge: false }};
  }}

  function rawGestureActive(action) {{
    var fingers = controlConfig(action).fingers || [];
    var fingerState = state.fingers || {{}};

    if (!state.hands) return false;

    return ["thumb", "index", "middle", "ring", "pinky"].every(function comboMatches(finger) {{
      var shouldExtend = fingers.indexOf(finger) !== -1;
      return !!fingerState[finger] === shouldExtend;
    }});
  }}

  function gestureActive(action) {{
    var config = controlConfig(action);

    if (config.edge) {{
      if (edgePulseActions[action]) {{
        edgePulseActions[action] = false;
        return true;
      }}

      return false;
    }}

    return rawGestureActive(action);
  }}

  root.bind = function bind(action, predicate) {{
    if (!extraPredicates[action]) extraPredicates[action] = [];
    extraPredicates[action].push(predicate);
  }};

  root.input.check = function check(action, predicates) {{
    var checks = []
      .concat(asPredicateList(predicates))
      .concat(function gestureForgeMappedGesturePredicate() {{ return gestureActive(action); }})
      .concat(extraPredicates[action] || []);

    return checks.some(runPredicate);
  }};

  Object.keys(controlMap).forEach(function registerControl(name) {{
    root.controls[name] = function mappedGestureControl() {{
      return root.input.check(name);
    }};
  }});

  function keyEventFor(action, type) {{
    var config = keyMap[action] || {{}};
    var keyCode = Number(config.keyCode || 0);
    var eventInit = {{
      key: config.key || "",
      code: config.code || "",
      keyCode: keyCode,
      which: keyCode,
      bubbles: true,
      cancelable: true
    }};

    try {{
      return new KeyboardEvent(type, eventInit);
    }} catch (error) {{
      var fallback = document.createEvent("KeyboardEvent");
      fallback.initKeyboardEvent(type, true, true, window, eventInit.key, 0, "", false, "");
      return fallback;
    }}
  }}

  function dispatchKeyboardEvent(action, type) {{
    if (!keyMap[action]) return;
    var event = keyEventFor(action, type);
    var target = document.activeElement || document.body || document;

    try {{ target.dispatchEvent(event); }} catch (error) {{}}
    try {{ document.dispatchEvent(event); }} catch (error) {{}}
    try {{ window.dispatchEvent(event); }} catch (error) {{}}
  }}

  function syncKeyboardEvents() {{
    Object.keys(controlMap).forEach(function syncAction(action) {{
      var active = rawGestureActive(action);

      if (active && !activeKeyboardActions[action]) {{
        activeKeyboardActions[action] = true;
        dispatchKeyboardEvent(action, "keydown");
      }} else if (!active && activeKeyboardActions[action]) {{
        activeKeyboardActions[action] = false;
        dispatchKeyboardEvent(action, "keyup");
      }}
    }});
  }}

  function applyCameraState(cameraState) {{
    var nextFingers = cameraState.fingers || {{}};

    if (!cameraState.fingers && Array.isArray(cameraState.handsDetail)) {{
      nextFingers = {{ thumb: false, index: false, middle: false, ring: false, pinky: false }};
      cameraState.handsDetail.forEach(function mergeHand(hand) {{
        var states = hand.states || {{}};
        Object.keys(nextFingers).forEach(function mergeFinger(finger) {{
          nextFingers[finger] = nextFingers[finger] || !!states[finger];
        }});
      }});
    }}

    root.setState({{
      hands: Number(cameraState.hands || 0),
      fingers: nextFingers,
      indexExtended: !!cameraState.indexExtended,
      indexFolded: !!cameraState.indexFolded
    }});
  }}

  function startCameraStatePolling() {{
    if (root.__cameraStatePolling) return;
    root.__cameraStatePolling = true;

    function pollCameraState() {{
      if (typeof fetch !== "function") return;

      fetch("/api/camera/state", {{ cache: "no-store" }})
        .then(function parseResponse(response) {{ return response.json(); }})
        .then(applyCameraState)
        .catch(function ignoreCameraStateError() {{}})
        .finally(function scheduleNextPoll() {{
          window.setTimeout(pollCameraState, 80);
        }});
    }}

    pollCameraState();
  }}

  function installMelonInputPatch() {{
    return true;
  }}

  if (!installMelonInputPatch()) {{
    var tries = 0;
    var timer = window.setInterval(function retryMelonInputPatch() {{
      tries += 1;
      if (installMelonInputPatch() || tries > 120) {{
        window.clearInterval(timer);
      }}
    }}, 100);
  }}

  window.setInterval(syncKeyboardEvents, 80);
  startCameraStatePolling();
}})();
"""


def inject_runtime(out_dir: Path, mapping: dict[str, Any]) -> list[PatchResult]:
    runtime_path = out_dir / "gestureforge-runtime.js"
    runtime_path.write_text(runtime_source(mapping), encoding="utf-8")

    results = [
        PatchResult(
            control_id="runtime",
            action="runtime",
            gesture="runtime",
            status="created",
            file="gestureforge-runtime.js",
        )
    ]

    html_files = sorted(path for path in out_dir.rglob("*") if path.suffix.lower() in HTML_EXTENSIONS)

    for html_path in html_files:
        text = html_path.read_text(encoding="utf-8", errors="ignore")

        if "gestureforge-runtime.js" in text:
            continue

        script_tag = '<script src="gestureforge-runtime.js"></script>'

        if re.search(r"</head\s*>", text, re.IGNORECASE):
            patched = re.sub(r"</head\s*>", f"  {script_tag}\n</head>", text, count=1, flags=re.IGNORECASE)
        elif re.search(r"</body\s*>", text, re.IGNORECASE):
            patched = re.sub(r"</body\s*>", f"  {script_tag}\n</body>", text, count=1, flags=re.IGNORECASE)
        else:
            patched = f"{script_tag}\n{text}"

        html_path.write_text(patched, encoding="utf-8")
        results.append(
            PatchResult(
                control_id="runtime",
                action="runtime",
                gesture="runtime",
                status="injected",
                file=str(html_path.relative_to(out_dir)),
            )
        )

    if not html_files:
        results.append(
            PatchResult(
                control_id="runtime",
                action="runtime",
                gesture="runtime",
                status="manual_review",
                reason="No HTML file found for runtime injection.",
            )
        )

    return results


def apply_runtime_injections_from_plan(out_dir: Path, plan: dict[str, Any], mapping: dict[str, Any]) -> list[PatchResult]:
    runtime_path = out_dir / "gestureforge-runtime.js"
    runtime_path.write_text(runtime_source(mapping), encoding="utf-8")
    results = [
        PatchResult(
            control_id="runtime",
            action="runtime",
            gesture="runtime",
            status="created",
            file="gestureforge-runtime.js",
        )
    ]
    injections = plan.get("runtime_injections", [])

    if not isinstance(injections, list) or not injections:
        results.append(
            PatchResult(
                control_id="runtime",
                action="runtime",
                gesture="runtime",
                status="manual_review",
                reason="No reviewed runtime injection found in patch plan.",
            )
        )
        return results

    for injection in injections:
        if not isinstance(injection, dict):
            continue

        file_text = str(injection.get("file") or "")
        insert_before = str(injection.get("insert_before") or "")
        content = str(injection.get("content") or "")
        confidence = float(injection.get("confidence") or 0)

        if injection.get("approved") is False:
            results.append(PatchResult("runtime", "runtime", "runtime", "skipped", file=file_text, reason="Runtime injection was not approved."))
            continue

        if confidence < 0.8:
            results.append(PatchResult("runtime", "runtime", "runtime", "manual_review", file=file_text, reason="Runtime injection confidence is below 0.8."))
            continue

        try:
            relative = safe_relative(file_text)
        except ValueError as exc:
            results.append(PatchResult("runtime", "runtime", "runtime", "manual_review", file=file_text, reason=str(exc)))
            continue

        file_path = out_dir / relative

        if not file_path.exists():
            results.append(PatchResult("runtime", "runtime", "runtime", "manual_review", file=file_text, reason="Runtime injection file not found."))
            continue

        text = file_path.read_text(encoding="utf-8", errors="ignore")

        if "gestureforge-runtime.js" in text:
            results.append(PatchResult("runtime", "runtime", "runtime", "already_present", file=file_text))
            continue

        index = text.lower().find(insert_before.lower())

        if index == -1:
            results.append(PatchResult("runtime", "runtime", "runtime", "manual_review", file=file_text, reason="insert_before marker not found."))
            continue

        patched = text[:index] + f"  {content}\n" + text[index:]
        file_path.write_text(patched, encoding="utf-8")
        results.append(PatchResult("runtime", "runtime", "runtime", "injected", file=file_text))

    return results


def composed_check_expression(action_token: str, original_expression: str) -> str:
    return (
        f"gestureForge.input.check({json.dumps(action_token)}, "
        f"function gestureForgeOriginalPredicate() {{ return {original_expression}; }})"
    )


def replace_usage_expression(line: str, action_token: str) -> tuple[str, bool]:
    escaped = re.escape(action_token)
    patterns = [
        re.compile(rf"me\.input\.isKeyPressed\s*\(\s*(['\"]){escaped}\1\s*\)", re.IGNORECASE),
    ]

    patched = line
    changed = False

    for pattern in patterns:
        match = pattern.search(patched)

        if match:
            expression = match.group(0)
            patched = patched[: match.start()] + composed_check_expression(action_token, expression) + patched[match.end() :]
            changed = True
            break

    return patched, changed


def replace_any_supported_usage_expression(line: str, fallback_action: str) -> tuple[str, bool]:
    patterns = [
        re.compile(r"me\.input\.isKeyPressed\s*\(\s*(['\"])([^'\"]+)\1\s*\)", re.IGNORECASE),
    ]

    for pattern in patterns:
        match = pattern.search(line)

        if match:
            action_token = match.group(2) or fallback_action
            expression = match.group(0)
            patched = line[: match.start()] + composed_check_expression(action_token, expression) + line[match.end() :]
            return patched, True

    return line, False


def patch_control(out_dir: Path, control: dict[str, Any]) -> list[PatchResult]:
    control_id = str(control.get("control_id") or control.get("id") or "")
    action = str(control.get("action") or "")
    gesture = str(control.get("gesture") or "")
    usage_targets = control.get("usage_targets") or []
    results: list[PatchResult] = []

    if not isinstance(usage_targets, list) or not usage_targets:
        return [
            PatchResult(
                control_id=control_id,
                action=action,
                gesture=gesture,
                status="manual_review",
                reason="No usage_targets available. Binding-only replacement is not safe yet.",
            )
        ]

    for target in usage_targets:
        if not isinstance(target, dict):
            continue

        file_text = str(target.get("file") or "")
        target_line = int(target.get("line") or 0)
        target_text = str(target.get("text") or "").strip()

        try:
            relative = safe_relative(file_text)
        except ValueError as exc:
            results.append(
                PatchResult(control_id, action, gesture, "manual_review", reason=str(exc))
            )
            continue

        file_path = out_dir / relative

        if file_path.suffix.lower() not in SUPPORTED_PATCH_EXTENSIONS:
            results.append(
                PatchResult(
                    control_id,
                    action,
                    gesture,
                    "manual_review",
                    file=file_text,
                    line=target_line,
                    reason=f"Unsupported patch file type: {file_path.suffix}",
                )
            )
            continue

        if not file_path.exists():
            results.append(
                PatchResult(control_id, action, gesture, "manual_review", file=file_text, line=target_line, reason="File not found.")
            )
            continue

        lines = file_path.read_text(encoding="utf-8", errors="ignore").splitlines(keepends=True)

        if target_line < 1 or target_line > len(lines):
            results.append(
                PatchResult(control_id, action, gesture, "manual_review", file=file_text, line=target_line, reason="Line out of range.")
            )
            continue

        original_line = lines[target_line - 1]

        if target_text and target_text not in original_line.strip():
            results.append(
                PatchResult(
                    control_id,
                    action,
                    gesture,
                    "manual_review",
                    file=file_text,
                    line=target_line,
                    before=original_line.rstrip("\r\n"),
                    reason="Target text does not match current line.",
                )
            )
            continue

        patched_line, changed = replace_usage_expression(original_line, action[:1].lower() + action[1:])

        if not changed:
            patched_line, changed = replace_usage_expression(original_line, action)

        if not changed:
            patched_line, changed = replace_any_supported_usage_expression(original_line, action)

        if not changed:
            results.append(
                PatchResult(
                    control_id,
                    action,
                    gesture,
                    "manual_review",
                    file=file_text,
                    line=target_line,
                    before=original_line.rstrip("\r\n"),
                    reason="No supported keyboard usage expression found on target line.",
                )
            )
            continue

        lines[target_line - 1] = patched_line
        file_path.write_text("".join(lines), encoding="utf-8")
        results.append(
            PatchResult(
                control_id,
                action,
                gesture,
                "patched",
                file=file_text,
                line=target_line,
                before=original_line.rstrip("\r\n"),
                after=patched_line.rstrip("\r\n"),
            )
        )

    return results


def apply_plan_patches(out_dir: Path, plan: dict[str, Any]) -> list[PatchResult]:
    results: list[PatchResult] = []
    patches = plan.get("patches", [])

    if not isinstance(patches, list):
        return [
            PatchResult(
                control_id="plan",
                action="plan",
                gesture="plan",
                status="manual_review",
                reason="patch-plan.json does not contain a patches list.",
            )
        ]

    for patch in patches:
        if not isinstance(patch, dict):
            continue

        control_id = str(patch.get("control_id") or "")
        action = str(patch.get("action") or "")
        gesture = str(patch.get("gesture") or "")
        file_text = str(patch.get("file") or "")
        target_line = int(patch.get("line") or 0)
        before = str(patch.get("before") or "")
        after = str(patch.get("after") or "")
        before_contains = str(patch.get("before_contains") or "")
        after_contains = str(patch.get("after_contains") or "")
        replace_all = bool(patch.get("replace_all"))
        confidence = float(patch.get("confidence") or 0)

        if patch.get("approved") is False:
            results.append(PatchResult(control_id, action, gesture, "skipped", file=file_text, line=target_line, reason="Patch was not approved."))
            continue

        if confidence < 0.8:
            results.append(PatchResult(control_id, action, gesture, "manual_review", file=file_text, line=target_line, reason="Patch confidence is below 0.8."))
            continue

        try:
            relative = safe_relative(file_text)
        except ValueError as exc:
            results.append(PatchResult(control_id, action, gesture, "manual_review", file=file_text, line=target_line, reason=str(exc)))
            continue

        file_path = out_dir / relative

        if file_path.suffix.lower() not in SUPPORTED_PATCH_EXTENSIONS:
            results.append(PatchResult(control_id, action, gesture, "manual_review", file=file_text, line=target_line, reason=f"Unsupported patch file type: {file_path.suffix}"))
            continue

        if not file_path.exists():
            results.append(PatchResult(control_id, action, gesture, "manual_review", file=file_text, line=target_line, reason="File not found."))
            continue

        lines = file_path.read_text(encoding="utf-8", errors="ignore").splitlines(keepends=True)

        if target_line < 1 or target_line > len(lines):
            results.append(PatchResult(control_id, action, gesture, "manual_review", file=file_text, line=target_line, reason="Line out of range."))
            continue

        current = lines[target_line - 1]
        newline = "\r\n" if current.endswith("\r\n") else "\n" if current.endswith("\n") else ""
        current_without_newline = current.rstrip("\r\n")

        if before_contains and after_contains:
            if replace_all:
                text = "".join(lines)

                if before_contains not in text:
                    if after_contains in text:
                        results.append(
                            PatchResult(
                                control_id,
                                action,
                                gesture,
                                "already_present",
                                file=file_text,
                                line=target_line,
                                before=before_contains,
                                after=after_contains,
                            )
                        )
                        continue

                    results.append(
                        PatchResult(
                            control_id,
                            action,
                            gesture,
                            "manual_review",
                            file=file_text,
                            line=target_line,
                            before=before_contains,
                            after=after_contains,
                            reason="Reviewed before_contains text does not exist in the current source file.",
                        )
                    )
                    continue

                occurrence_count = text.count(before_contains)
                patched_text = text.replace(before_contains, after_contains)
                file_path.write_text(patched_text, encoding="utf-8")
                results.append(
                    PatchResult(
                        control_id,
                        action,
                        gesture,
                        "patched",
                        file=file_text,
                        line=target_line,
                        before=before_contains,
                        after=after_contains,
                        reason=f"Replaced {occurrence_count} occurrence(s).",
                    )
                )
                continue

            if after_contains in current_without_newline:
                results.append(
                    PatchResult(
                        control_id,
                        action,
                        gesture,
                        "already_present",
                        file=file_text,
                        line=target_line,
                        before=before_contains,
                        after=after_contains,
                    )
                )
                continue

            if before_contains not in current_without_newline:
                results.append(
                    PatchResult(
                        control_id,
                        action,
                        gesture,
                        "manual_review",
                        file=file_text,
                        line=target_line,
                        before=current_without_newline,
                        after=after_contains,
                        reason="Reviewed before_contains text does not exist on the current source line.",
                    )
                )
                continue

            lines[target_line - 1] = current.replace(before_contains, after_contains, 1)
            file_path.write_text("".join(lines), encoding="utf-8")
            results.append(
                PatchResult(
                    control_id,
                    action,
                    gesture,
                    "patched",
                    file=file_text,
                    line=target_line,
                    before=before_contains,
                    after=after_contains,
                )
            )
            continue

        if current_without_newline != before:
            results.append(
                PatchResult(
                    control_id,
                    action,
                    gesture,
                    "manual_review",
                    file=file_text,
                    line=target_line,
                    before=current_without_newline,
                    after=after,
                    reason="Reviewed before text does not exactly match the current source line.",
                )
            )
            continue

        lines[target_line - 1] = after + newline
        file_path.write_text("".join(lines), encoding="utf-8")
        results.append(PatchResult(control_id, action, gesture, "patched", file=file_text, line=target_line, before=before, after=after))

    return results


def apply_mapping(source: Path, analysis_path: Path, mapping_path: Path, out_dir: Path, plan_path: Path | None = None) -> dict[str, Any]:
    analysis = load_json(analysis_path)
    mapping = load_json(mapping_path)
    plan = load_json(plan_path) if plan_path and plan_path.exists() else None

    clean_output_dir(source, out_dir)

    results: list[PatchResult] = []

    if plan:
        results.extend(apply_runtime_injections_from_plan(out_dir, plan, mapping))
        results.extend(apply_plan_patches(out_dir, plan))
        apply_mode = "reviewed_plan"
    else:
        results.extend(inject_runtime(out_dir, mapping))

        for control in mapping_controls(mapping):
            results.extend(patch_control(out_dir, control))

        apply_mode = "direct_mapping_fallback"

    patched_count = sum(1 for result in results if result.status == "patched")
    manual_count = sum(1 for result in results if result.status == "manual_review")

    return {
        "status": "patched",
        "source": str(source),
        "out": str(out_dir),
        "analysis_controls": len(analysis.get("controls", [])) if isinstance(analysis.get("controls"), list) else 0,
        "mapping_controls": len(mapping_controls(mapping)),
        "apply_mode": apply_mode,
        "patched_count": patched_count,
        "manual_review_count": manual_count,
        "results": [asdict(result) for result in results],
    }


def main() -> None:
    args = parse_args()
    report = apply_mapping(
        Path(args.source).resolve(),
        Path(args.analysis).resolve(),
        Path(args.mapping).resolve(),
        Path(args.out).resolve(),
        Path(args.plan).resolve() if args.plan else None,
    )
    output = json.dumps(report, ensure_ascii=False, indent=2)

    if args.report_out:
        report_path = Path(args.report_out)
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(output + "\n", encoding="utf-8")

    print(output)


if __name__ == "__main__":
    main()
