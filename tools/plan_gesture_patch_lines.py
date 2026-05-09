"""Create a line-level GestureForge patch plan without modifying source files."""

from __future__ import annotations

import argparse
import json
import posixpath
import re
from pathlib import Path
from typing import Any


SUPPORTED_PATCH_EXTENSIONS = {".js", ".jsx", ".ts", ".tsx", ".html", ".htm"}
HTML_EXTENSIONS = {".html", ".htm"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Plan line-level gesture patches from analysis and mapping JSON.")
    parser.add_argument("--source", required=True, help="Original game source directory.")
    parser.add_argument("--analysis", required=True, help="analysis.json path.")
    parser.add_argument("--mapping", required=True, help="mapping.json path.")
    parser.add_argument("--json-out", help="Optional patch-plan.json path.")
    return parser.parse_args()


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def safe_relative(path_text: str) -> Path:
    relative = Path(path_text)

    if relative.is_absolute() or any(part == ".." for part in relative.parts):
        raise ValueError(f"Unsafe relative path: {path_text}")

    return relative


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


def mapping_controls(mapping: dict[str, Any]) -> list[dict[str, Any]]:
    controls = mapping.get("controls", [])

    if not isinstance(controls, list):
        return []

    return [control for control in controls if isinstance(control, dict)]


def loaded_script_files(source: Path) -> set[str]:
    scripts: set[str] = set()

    for html_path in sorted(path for path in source.rglob("*") if path.suffix.lower() in HTML_EXTENSIONS):
        text = html_path.read_text(encoding="utf-8", errors="ignore")

        for match in re.finditer(r"<script\b[^>]*\bsrc\s*=\s*(['\"])(.*?)\1", text, re.IGNORECASE):
            src = match.group(2).split("?", 1)[0].split("#", 1)[0]

            if not src or re.match(r"^[a-z]+://", src, re.IGNORECASE):
                continue

            try:
                script_path = (html_path.parent / src).resolve().relative_to(source.resolve())
            except ValueError:
                continue

            scripts.add(str(script_path).replace("\\", "/"))

    return scripts


def composed_check_expression(action_token: str, original_expression: str) -> str:
    return (
        f"gestureForge.input.check({json.dumps(action_token)}, "
        f"function gestureForgeOriginalPredicate() {{ return {original_expression}; }})"
    )


def is_event_action_expression(text: str) -> bool:
    return bool(
        re.search(r"\baction\s*={2,3}\s*['\"][^'\"]+['\"]", text)
        or re.search(r"['\"][^'\"]+['\"]\s*={2,3}\s*action\b", text)
    )


def replace_usage_expression(line: str, action_token: str) -> tuple[str, bool]:
    escaped = re.escape(action_token)
    patterns = [
        re.compile(rf"me\.input\.isKeyPressed\s*\(\s*(['\"]){escaped}\1\s*\)", re.IGNORECASE),
    ]

    for pattern in patterns:
        match = pattern.search(line)

        if match:
            expression = match.group(0)
            patched = line[: match.start()] + composed_check_expression(action_token, expression) + line[match.end() :]
            return patched, True

    return line, False


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


def replacement_for_expression(action_token: str, expression: str) -> str:
    return composed_check_expression(action_token, expression)


def expression_candidates(action_token: str, target_text: str) -> list[str]:
    lower_action = action_token[:1].lower() + action_token[1:]
    candidates = [
        f"me.input.isKeyPressed('{lower_action}')",
        f'me.input.isKeyPressed("{lower_action}")',
        f"me.input.isKeyPressed('{action_token}')",
        f'me.input.isKeyPressed("{action_token}")',
    ]

    return list(dict.fromkeys(candidates))


def quoted_token_comparison_patterns(action_token: str) -> list[re.Pattern[str]]:
    token_pattern = re.escape(action_token)
    identifier = r"[_$A-Za-z][_$A-Za-z0-9]*"

    return [
        re.compile(rf"['\"]{token_pattern}['\"]\s*={2,3}\s*{identifier}", re.IGNORECASE),
        re.compile(rf"{identifier}\s*={2,3}\s*['\"]{token_pattern}['\"]", re.IGNORECASE),
    ]


def bundle_patches_for_control(source: Path, loaded_scripts: set[str], control: dict[str, Any], target_text: str) -> list[dict[str, Any]]:
    control_id = str(control.get("control_id") or control.get("id") or "")
    action = str(control.get("action") or "")
    gesture = str(control.get("gesture") or "")
    patches: list[dict[str, Any]] = []
    seen: set[tuple[str, str, int]] = set()

    def append_patch(script: str, text: str, index: int, before_contains: str, action_token: str, reason: str) -> None:
        key = (script, before_contains, index)

        if key in seen:
            return

        seen.add(key)
        patches.append(
            {
                "control_id": control_id,
                "action": action,
                "gesture": gesture,
                "file": script,
                "line": text.count("\n", 0, index) + 1,
                "before_contains": before_contains,
                "after_contains": replacement_for_expression(action_token, before_contains),
                "replace_all": True,
                "occurrences": text.count(before_contains),
                "confidence": 0.88,
                "reason": reason,
            }
        )

    for script in sorted(loaded_scripts):
        file_path = source / script

        if not file_path.exists() or file_path.suffix.lower() not in {".js", ".jsx", ".ts", ".tsx"}:
            continue

        text = file_path.read_text(encoding="utf-8", errors="ignore")
        action_token = action[:1].lower() + action[1:]

        for candidate in expression_candidates(action, target_text):
            start = 0

            while True:
                index = text.find(candidate, start)

                if index == -1:
                    break

                candidate_action_token = action_token
                before_contains = candidate
                match_index = index

                if "isKeyPressed" in candidate:
                    match = re.search(r"isKeyPressed\s*\(\s*(['\"])([^'\"]+)\1\s*\)", candidate)
                    candidate_action_token = match.group(2) if match else action_token
                elif "===" in candidate:
                    match = re.search(r"['\"]([^'\"]+)['\"]", candidate)
                    candidate_action_token = match.group(1) if match else action_token
                    identifier = r"[_$A-Za-z][_$A-Za-z0-9]*"

                    if candidate.endswith("==="):
                        suffix_match = re.match(identifier, text[index + len(candidate) :])

                        if not suffix_match:
                            start = index + max(len(candidate), 1)
                            continue

                        before_contains = candidate + suffix_match.group(0)

                    elif candidate.startswith("==="):
                        prefix_text = text[max(0, index - 80) : index]
                        prefix_match = re.search(rf"{identifier}\s*$", prefix_text)

                        if not prefix_match:
                            start = index + max(len(candidate), 1)
                            continue

                        before_contains = prefix_match.group(0) + candidate
                        match_index = index - len(prefix_match.group(0))

                append_patch(
                    script,
                    text,
                    match_index,
                    before_contains,
                    candidate_action_token,
                    "Runtime HTML loads this bundled script; patch the loaded bundle instead of unused source files.",
                )
                start = index + max(len(candidate), 1)

    return patches


def runtime_injections(source: Path) -> list[dict[str, Any]]:
    injections = []

    for html_path in sorted(path for path in source.rglob("*") if path.suffix.lower() in HTML_EXTENSIONS):
        text = html_path.read_text(encoding="utf-8", errors="ignore")

        if "gestureforge-runtime.js" in text:
            continue

        html_relative = html_path.relative_to(source)
        html_dir = str(html_relative.parent).replace("\\", "/")
        runtime_src = posixpath.relpath("gestureforge-runtime.js", html_dir or ".")
        insert_before = "</head>" if re.search(r"</head\s*>", text, re.IGNORECASE) else "</body>"
        injections.append(
            {
                "file": str(html_path.relative_to(source)),
                "insert_before": insert_before,
                "content": f'<script src="{runtime_src}"></script>',
                "confidence": 0.95 if insert_before == "</head>" else 0.85,
                "reason": "Inject GestureForge runtime before game scripts can call gestureForge.controls.",
            }
        )
        break

    return injections


def plan_control(source: Path, control: dict[str, Any], loaded_scripts: set[str]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    patches: list[dict[str, Any]] = []
    manual_review: list[dict[str, Any]] = []
    control_id = str(control.get("control_id") or control.get("id") or "")
    action = str(control.get("action") or "")
    gesture = str(control.get("gesture") or "")
    usage_targets = control.get("usage_targets") or []

    if not isinstance(usage_targets, list) or not usage_targets:
        manual_review.append(
            {
                "control_id": control_id,
                "action": action,
                "gesture": gesture,
                "reason": "No usage_targets available. Need AI or engine-specific reasoning to find safe lines.",
            }
        )
        return patches, manual_review

    for target in usage_targets:
        if not isinstance(target, dict):
            continue

        file_text = str(target.get("file") or "")
        target_line = int(target.get("line") or 0)
        target_text = str(target.get("text") or "").strip()

        if is_event_action_expression(target_text):
            continue

        try:
            relative = safe_relative(file_text)
        except ValueError as exc:
            manual_review.append({"control_id": control_id, "action": action, "gesture": gesture, "reason": str(exc)})
            continue

        file_path = source / relative
        normalized_file = str(relative).replace("\\", "/")
        target_is_loaded = not loaded_scripts or normalized_file in loaded_scripts

        if file_path.suffix.lower() not in SUPPORTED_PATCH_EXTENSIONS:
            manual_review.append(
                {
                    "control_id": control_id,
                    "action": action,
                    "gesture": gesture,
                    "file": file_text,
                    "line": target_line,
                    "reason": f"Unsupported patch file type: {file_path.suffix}. Use AI/engine-specific planner.",
                }
            )
            continue

        if not file_path.exists():
            manual_review.append({"control_id": control_id, "action": action, "gesture": gesture, "file": file_text, "line": target_line, "reason": "File not found."})
            continue

        if not target_is_loaded:
            bundle_patches = bundle_patches_for_control(source, loaded_scripts, control, target_text)

            if bundle_patches:
                patches.extend(bundle_patches)

            else:
                manual_review.append(
                    {
                        "control_id": control_id,
                        "action": action,
                        "gesture": gesture,
                        "file": file_text,
                        "line": target_line,
                        "reason": "Target source file is not loaded by HTML, and no matching expression was found in loaded bundles.",
                    }
                )
            continue

        lines = file_path.read_text(encoding="utf-8", errors="ignore").splitlines()

        if target_line < 1 or target_line > len(lines):
            manual_review.append({"control_id": control_id, "action": action, "gesture": gesture, "file": file_text, "line": target_line, "reason": "Line out of range."})
            continue

        before = lines[target_line - 1]

        if target_text and target_text not in before.strip():
            manual_review.append(
                {
                    "control_id": control_id,
                    "action": action,
                    "gesture": gesture,
                    "file": file_text,
                    "line": target_line,
                    "before": before,
                    "reason": "Target text does not match current line.",
                }
            )
            continue

        after, changed = replace_usage_expression(before, action[:1].lower() + action[1:])

        if not changed:
            after, changed = replace_usage_expression(before, action)

        if not changed:
            after, changed = replace_any_supported_usage_expression(before, action)

        if not changed:
            manual_review.append(
                {
                    "control_id": control_id,
                    "action": action,
                    "gesture": gesture,
                    "file": file_text,
                    "line": target_line,
                    "before": before,
                    "reason": "No supported keyboard usage expression found. Ask AI planner for this line.",
                }
            )
            continue

        patches.append(
            {
                "control_id": control_id,
                "action": action,
                "gesture": gesture,
                "file": file_text,
                "line": target_line,
                "before": before,
                "after": after,
                "confidence": 0.92,
                "reason": "Wrap the original keyboard/action predicate and compose it with selected gesture predicates.",
            }
        )

    return patches, manual_review


def plan_patches(source: Path, analysis_path: Path, mapping_path: Path) -> dict[str, Any]:
    analysis = load_json(analysis_path)
    mapping = load_json(mapping_path)
    loaded_scripts = loaded_script_files(source)
    patches: list[dict[str, Any]] = []
    manual_review: list[dict[str, Any]] = []

    for control in mapping_controls(mapping):
        next_patches, next_manual = plan_control(source, control, loaded_scripts)
        patches.extend(next_patches)
        manual_review.extend(next_manual)

    deduped_patches = []
    seen_patches: set[tuple[str, str, str]] = set()

    for patch in patches:
        key = (
            str(patch.get("file") or ""),
            str(patch.get("before") or patch.get("before_contains") or ""),
            str(patch.get("after") or patch.get("after_contains") or ""),
        )

        if key in seen_patches:
            continue

        seen_patches.add(key)
        deduped_patches.append(patch)

    return {
        "status": "planned",
        "source": str(source),
        "analysis_controls": len(analysis.get("controls", [])) if isinstance(analysis.get("controls"), list) else 0,
        "mapping_controls": len(mapping_controls(mapping)),
        "loaded_scripts": sorted(loaded_scripts),
        "patches": deduped_patches,
        "runtime_injections": runtime_injections(source),
        "manual_review": manual_review,
        "needs_ai": bool(manual_review),
    }


def main() -> None:
    args = parse_args()
    plan = plan_patches(
        Path(args.source).resolve(),
        Path(args.analysis).resolve(),
        Path(args.mapping).resolve(),
    )
    output = json.dumps(plan, ensure_ascii=False, indent=2)

    if args.json_out:
        output_path = Path(args.json_out)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(output + "\n", encoding="utf-8")

    print(output)


if __name__ == "__main__":
    main()
