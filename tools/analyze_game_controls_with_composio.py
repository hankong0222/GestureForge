"""Analyze game source code and extract keyboard controls with Composio.

Usage:
  python tools/analyze_game_controls_with_composio.py --source path/to/game

Required environment:
  COMPOSIO_API_KEY
  OPENAI_API_KEY

Install optional dependencies:
  pip install composio composio-openai-agents openai-agents
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
from dataclasses import asdict, dataclass
from pathlib import Path


SUPPORTED_EXTENSIONS = {
    ".c",
    ".cc",
    ".cpp",
    ".cs",
    ".gd",
    ".h",
    ".hpp",
    ".html",
    ".java",
    ".js",
    ".jsx",
    ".lua",
    ".py",
    ".ts",
    ".tsx",
}

SKIPPED_FILENAMES = {
    "melonjs-min.js",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
}

IGNORED_DIRS = {
    ".git",
    ".next",
    ".nuxt",
    "build",
    "coverage",
    "dist",
    "Library",
    "logs",
    "node_modules",
    "obj",
    "out",
    "public",
    "vendor",
    "vendors",
    "target",
    "Temp",
    "venv",
}

KEYBOARD_PATTERNS = [
    re.compile(r"\b(?:keypress|keydown|keyup|KeyboardEvent|addEventListener\s*\(\s*['\"]key(?:down|up|press)['\"])", re.IGNORECASE),
    re.compile(r"\b(?:event|e|evt)\.(?:key|code|keyCode|which)\b"),
    re.compile(r"\b(?:Input\.Get(?:Key|Button|Axis)|KeyCode\.[A-Za-z0-9_]+)\b"),
    re.compile(r"\bInput\.is_action_(?:pressed|just_pressed|just_released)\s*\("),
    re.compile(r"\b(?:pygame\.K_[A-Za-z0-9_]+|pygame\.key|get_pressed)\b"),
    re.compile(r"\b(?:Phaser\.Input\.Keyboard|this\.input\.keyboard|createCursorKeys|addKey)\b"),
    re.compile(r"\bme\.(?:input|event)\.(?:bindKey|isKeyPressed|KEYDOWN|KEYUP|KEYPRESS)\b"),
    re.compile(
        r"\b(?:command|code|keyCode|binding|bindings?)\s*[:=]\s*['\"]"
        r"(?:[A-Z0-9]|Arrow(?:Up|Down|Left|Right)|Space|Enter|Escape|Shift|Control|Ctrl|Alt|Tab)['\"]",
        re.IGNORECASE,
    ),
    re.compile(r"\b(?:Key[A-Z][A-Za-z0-9_]*|Arrow(?:Up|Down|Left|Right)|Space|Enter|Escape|Shift|Control|Alt)\b"),
]

ACTION_HINT_PATTERNS = [
    re.compile(r"\b(?:jump|fire|shoot|attack|dash|boost|brake|left|right|up|down|move|run|walk|pause|menu|interact|action)\b", re.IGNORECASE),
    re.compile(r"\b(?:steer|accelerate|reverse|crouch|sprint|cast|spell|inventory|reload|aim)\b", re.IGNORECASE),
    re.compile(r"\b(?:play|start|restart|title|gameover|resume|select|confirm|back)\b", re.IGNORECASE),
]

ENTRYPOINT_PATTERNS = [
    re.compile(r"\b(?:main|game|player|input|control|controller|keyboard|scene|level|play|engine)\b", re.IGNORECASE),
]


@dataclass(frozen=True)
class Evidence:
    file: str
    line: int
    text: str
    context: list[str]


@dataclass(frozen=True)
class LocalCandidate:
    api: str
    key: str
    action_token: str
    bindings: list[Evidence]
    usages: list[Evidence]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Extract keyboard controls from game source with Composio.")
    parser.add_argument("--source", required=True, help="Game source directory or single source file.")
    parser.add_argument("--user-id", default="gestureforge-user", help="Composio user id.")
    parser.add_argument("--model", default="gpt-4o", help="OpenAI model used by the Agents SDK.")
    parser.add_argument("--max-files", type=int, default=160, help="Maximum source files to scan.")
    parser.add_argument("--max-evidence", type=int, default=220, help="Maximum evidence blocks to send to the agent.")
    parser.add_argument("--max-context-lines", type=int, default=2, help="Number of nearby lines kept around each evidence line.")
    parser.add_argument("--json-out", help="Optional path to write the final JSON result.")
    parser.add_argument("--collect-only", action="store_true", help="Only print local keyboard evidence, skip Composio.")
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


def require_environment() -> None:
    missing = [key for key in ("COMPOSIO_API_KEY", "OPENAI_API_KEY") if not os.environ.get(key)]

    if missing:
        joined = ", ".join(missing)
        raise RuntimeError(
            f"Missing required environment variable(s): {joined}. "
            "Create a local .env from .env.example or set them in PowerShell."
        )


def iter_source_files(source: Path, max_files: int) -> list[Path]:
    if source.is_file():
        return [source]

    files: list[Path] = []
    for path in source.rglob("*"):
        if not path.is_file():
            continue

        if any(part in IGNORED_DIRS for part in path.parts):
            continue

        if should_skip_file(path):
            continue

        if path.suffix.lower() in SUPPORTED_EXTENSIONS:
            files.append(path)

    return sorted(files, key=lambda path: file_rank(path, source), reverse=True)[:max_files]


def should_skip_file(path: Path) -> bool:
    name = path.name.lower()

    if name in SKIPPED_FILENAMES:
        return True

    if name.endswith(".min.js") or name.endswith("-min.js"):
        return True

    return False


def file_rank(path: Path, source: Path) -> int:
    try:
        relative = path.relative_to(source)
    except ValueError:
        relative = path

    text = str(relative).replace("\\", "/")
    score = 0

    if any(pattern.search(text) for pattern in ENTRYPOINT_PATTERNS):
        score += 20

    if path.suffix.lower() in {".js", ".jsx", ".ts", ".tsx", ".html", ".cs", ".gd", ".py"}:
        score += 8

    if re.search(r"\b(?:component|style|styles|css|theme|layout|page|view|screen|menu|hud)\b", text, re.IGNORECASE):
        score -= 12

    if re.search(r"\b(?:test|spec|mock|demo|example)\b", text, re.IGNORECASE):
        score -= 8

    if path.stem.lower() in {"app", "index", "main", "game", "player", "input", "controls", "controller"}:
        score += 10

    return score


def line_matches(line: str) -> bool:
    return keyboard_signal_score(line) >= 10


def keyboard_signal_score(line: str) -> int:
    score = 0

    for pattern in KEYBOARD_PATTERNS:
        if pattern.search(line):
            score += 10

    if any(pattern.search(line) for pattern in ACTION_HINT_PATTERNS):
        score += 3

    if re.search(r"\b(?:className|aria-|style=|css|color|font|render|return\s+<)\b", line, re.IGNORECASE):
        score -= 8

    if re.search(r"\b(?:command|code|keyCode|binding|bindings?)\s*[:=]", line, re.IGNORECASE):
        score += 4

    return score


def block_window(lines: list[str], index: int, max_context_lines: int) -> tuple[int, int]:
    line = lines[index]

    if re.search(r"\b(?:KEYDOWN|KEYUP|keypress|keydown|keyup|addEventListener|subscribe)\b", line, re.IGNORECASE):
        return max(0, index - 4), min(len(lines), index + max(18, max_context_lines + 1))

    if re.search(r"\b(?:bindKey|isKeyPressed|createCursorKeys|addKey|Input\.Get)\b", line):
        return max(0, index - 4), min(len(lines), index + max(8, max_context_lines + 1))

    return max(0, index - max_context_lines), min(len(lines), index + max_context_lines + 1)


def evidence_from_line(
    file_path: Path,
    source_root: Path,
    lines: list[str],
    index: int,
    max_context_lines: int,
) -> Evidence:
    start, end = block_window(lines, index, max_context_lines)
    return Evidence(
        file=str(file_path.relative_to(source_root)),
        line=index + 1,
        text=lines[index].strip(),
        context=[context_line.strip() for context_line in lines[start:end]],
    )


def collect_evidence(source: Path, max_files: int, max_evidence: int, max_context_lines: int) -> list[Evidence]:
    candidates: list[tuple[int, Evidence]] = []
    files = iter_source_files(source, max_files)
    seen_lines: set[tuple[str, str]] = set()
    source_root = source if source.is_dir() else source.parent

    for file_path in files:
        try:
            lines = file_path.read_text(encoding="utf-8", errors="ignore").splitlines()
        except OSError:
            continue

        for index, line in enumerate(lines):
            if not line_matches(line):
                continue

            text = line.strip()
            relative_file = str(file_path.relative_to(source_root))
            dedupe_key = (relative_file, text)

            if dedupe_key in seen_lines:
                continue

            seen_lines.add(dedupe_key)
            score = file_rank(file_path, source_root) + keyboard_signal_score(line)
            candidates.append(
                (
                    score,
                    evidence_from_line(file_path, source_root, lines, index, max_context_lines),
                )
            )

    candidates.sort(key=lambda item: item[0], reverse=True)
    return [evidence for _, evidence in candidates[:max_evidence]]


def collect_local_candidates(source: Path, max_files: int, max_context_lines: int) -> list[LocalCandidate]:
    source_root = source if source.is_dir() else source.parent
    bindings: dict[str, list[tuple[str, str, Evidence]]] = {}
    usages: dict[str, list[Evidence]] = {}
    binding_patterns = [
        (
            "melonjs",
            re.compile(
                r"me\.input\.bindKey\s*\(\s*me\.input\.KEY\.([A-Z0-9_]+)\s*,\s*['\"]([^'\"]+)['\"]",
                re.IGNORECASE,
            ),
        ),
        (
            "godot_input_map",
            re.compile(
                r"InputMap\.action_add_event\s*\(\s*['\"]([^'\"]+)['\"].*?(?:keycode|physical_keycode)\s*=\s*KEY_([A-Z0-9_]+)",
                re.IGNORECASE,
            ),
        ),
        (
            "config_binding",
            re.compile(
                r"\b(?:command|code|key|binding|bindings?)\s*[:=]\s*['\"]"
                r"(Arrow(?:Up|Down|Left|Right)|Space|Enter|Escape|Shift|Control|Ctrl|Alt|Tab|[A-Z0-9])['\"].*?"
                r"\b(?:action|name|command)\s*[:=]\s*['\"]([^'\"]+)['\"]",
                re.IGNORECASE,
            ),
        ),
    ]
    usage_patterns = [
        re.compile(r"me\.input\.isKeyPressed\s*\(\s*['\"]([^'\"]+)['\"]\s*\)", re.IGNORECASE),
        re.compile(r"\baction\s*={2,3}\s*['\"]([^'\"]+)['\"]", re.IGNORECASE),
        re.compile(r"Input\.is_action_(?:pressed|just_pressed|just_released)\s*\(\s*['\"]([^'\"]+)['\"]", re.IGNORECASE),
        re.compile(r"Input\.GetButton(?:Down|Up)?\s*\(\s*['\"]([^'\"]+)['\"]", re.IGNORECASE),
        re.compile(r"Input\.GetAxis(?:Raw)?\s*\(\s*['\"]([^'\"]+)['\"]", re.IGNORECASE),
    ]

    for file_path in iter_source_files(source, max_files):
        try:
            lines = file_path.read_text(encoding="utf-8", errors="ignore").splitlines()
        except OSError:
            continue

        for index, line in enumerate(lines):
            for api, pattern in binding_patterns:
                for match in pattern.finditer(line):
                    first, second = match.groups()
                    key, action_token = (second, first) if api == "godot_input_map" else (first, second)
                    bindings.setdefault(action_token, []).append(
                        (api, key, evidence_from_line(file_path, source_root, lines, index, max_context_lines))
                    )

            for pattern in usage_patterns:
                for match in pattern.finditer(line):
                    action_token = match.group(1)
                    usages.setdefault(action_token, []).append(
                        evidence_from_line(file_path, source_root, lines, index, max_context_lines)
                    )

    candidates: list[LocalCandidate] = []
    for action_token, binding_evidence in bindings.items():
        for api, key, binding in binding_evidence:
            candidates.append(
                LocalCandidate(
                    api=api,
                    key=key,
                    action_token=action_token,
                    bindings=[binding],
                    usages=usages.get(action_token, [])[:4],
                )
            )

    return candidates


def build_agent_input(source: Path, evidence: list[Evidence], local_candidates: list[LocalCandidate]) -> str:
    evidence_json = json.dumps([asdict(item) for item in evidence], ensure_ascii=False, indent=2)
    candidates_json = json.dumps([asdict(item) for item in local_candidates], ensure_ascii=False, indent=2)
    return f"""
Analyze this game source evidence and extract the keyboard controls.

Source path: {source}

Return only valid JSON with this shape:
{{
  "controls": [
    {{
      "id": "ctrl_jump_space",
      "key": "Space",
      "code": "Space",
      "action": "Jump",
      "event": "keydown",
      "source_kind": "event_listener",
      "binding_target": {{
        "file": "src/game.js",
        "line": 42,
        "text": "me.input.bindKey(me.input.KEY.SPACE, \"jump\", true);"
      }},
      "usage_targets": [
        {{
          "file": "src/player.js",
          "line": 80,
          "text": "if (me.input.isKeyPressed(\"jump\")) {{"
        }}
      ],
      "replacement_strategy": "replace_usage_check_with_gesture_function",
      "suggested_function": "gestureForge.controls.jump()",
      "confidence": 0.0,
      "evidence": [
        {{"file": "src/game.js", "line": 42, "text": "if (e.code === 'Space') jump();"}}
      ]
    }}
  ],
  "unresolved": [
    {{
      "hint": "A keyboard event was found but no concrete key or action could be proven.",
      "evidence": []
    }}
  ]
}}

Rules:
- Prefer concrete key names and key codes found in source.
- Infer the gameplay action from nearby function names, variables, comments, or branches.
- Treat nearby action words like jump, move, shoot, attack, pause, inventory, or interact as context only.
- For engines such as MelonJS, Phaser, Unity, Godot, or pygame, connect key binding declarations to later action checks. For example, `me.input.bindKey(me.input.KEY.ENTER, "enter")` plus `KEYDOWN` action handling means Enter triggers the action named enter.
- If an event handler receives an `action` parameter, search the provided context for comparisons, switch cases, function calls, or binding declarations that explain that action.
- Do not invent replacement expressions. `binding_target`, `usage_targets`, and `evidence` must quote exact file, line, and text values from Local pre-analysis candidates or Evidence.
- Do not copy schema examples into the result. Never output files or lines that are not present in the provided evidence.
- Keep every evidence item traceable to a file and line.
- Include a stable lowercase id for each control, derived from action and key.
- Fill binding_target with the exact key binding declaration when present.
- Fill usage_targets with exact lines where the action is checked or used.
- Use replacement_strategy values like replace_usage_check_with_gesture_function, replace_binding_action_with_gesture_function, or manual_review.
- Use source_kind values like event_listener, polling, engine_input_api, config_binding, or unknown.
- Use confidence from 0 to 1.
- Do not invent keys not supported by evidence; put ambiguous mappings in unresolved.
- The next pipeline step will show controls to a user and replace selected keyboard controls with GestureForge control functions.
- Local pre-analysis candidates are generic binding/use summaries extracted from known input APIs. Use them as hints, not as the only source of truth.

Local pre-analysis candidates:
{candidates_json}

Evidence:
{evidence_json}
""".strip()


def extract_json_object(raw_output: str) -> str:
    text = raw_output.strip()

    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)

    start = text.find("{")
    end = text.rfind("}")

    if start == -1 or end == -1 or end < start:
        raise ValueError("Agent did not return a JSON object.")

    return text[start : end + 1]


def evidence_key(item: Mapping[str, object]) -> tuple[str, int] | None:
    try:
        return str(item["file"]), int(item["line"])
    except (KeyError, TypeError, ValueError):
        return None


def allowed_source_keys(evidence: list[Evidence], local_candidates: list[LocalCandidate]) -> set[tuple[str, int]]:
    keys = {(item.file.replace("/", "\\"), item.line) for item in evidence}

    for candidate in local_candidates:
        for item in [*candidate.bindings, *candidate.usages]:
            keys.add((item.file.replace("/", "\\"), item.line))

    return keys


def is_allowed_source(item: object, allowed_keys: set[tuple[str, int]]) -> bool:
    if not isinstance(item, dict):
        return False

    key = evidence_key(item)
    if key is None:
        return False

    normalized = (key[0].replace("/", "\\"), key[1])
    return normalized in allowed_keys


def filter_agent_sources(parsed: dict[str, object], evidence: list[Evidence], local_candidates: list[LocalCandidate]) -> dict[str, object]:
    allowed_keys = allowed_source_keys(evidence, local_candidates)
    controls = parsed.get("controls", [])

    if isinstance(controls, list):
        for control in controls:
            if not isinstance(control, dict):
                continue

            binding_target = control.get("binding_target")
            if binding_target is not None and not is_allowed_source(binding_target, allowed_keys):
                control.pop("binding_target", None)
                control["replacement_strategy"] = "manual_review"

            usage_targets = control.get("usage_targets", [])
            if isinstance(usage_targets, list):
                control["usage_targets"] = [
                    target for target in usage_targets if is_allowed_source(target, allowed_keys)
                ]

            evidence_items = control.get("evidence", [])
            if isinstance(evidence_items, list):
                control["evidence"] = [
                    item for item in evidence_items if is_allowed_source(item, allowed_keys)
                ]

    unresolved = parsed.get("unresolved", [])
    if isinstance(unresolved, list):
        parsed["unresolved"] = [
            item
            for item in unresolved
            if isinstance(item, dict)
            and isinstance(item.get("evidence"), list)
            and any(is_allowed_source(source, allowed_keys) for source in item["evidence"])
        ]

    return parsed


def normalize_agent_output(
    raw_output: str,
    evidence: list[Evidence],
    local_candidates: list[LocalCandidate],
) -> str:
    json_text = extract_json_object(raw_output)
    parsed = json.loads(json_text)
    parsed = filter_agent_sources(parsed, evidence, local_candidates)
    return json.dumps(parsed, ensure_ascii=False, indent=2)


async def run_composio_analysis(args: argparse.Namespace, evidence: list[Evidence]) -> str:
    load_dotenv(Path.cwd() / ".env")
    require_environment()

    try:
        from agents import Agent, Runner
        from composio import Composio
        from composio_openai_agents import OpenAIAgentsProvider
    except ImportError as exc:
        raise RuntimeError(
            "Missing Composio/OpenAI Agents dependencies. Install with: "
            "pip install composio composio-openai-agents openai-agents"
        ) from exc

    composio = Composio(provider=OpenAIAgentsProvider())
    session = composio.create(
        user_id=args.user_id,
        workbench={"sandbox_size": "medium"},
    )

    agent = Agent(
        name="Game Control Analyzer",
        model=args.model,
        instructions=(
            "You extract keyboard controls from game source code evidence. "
            "Use Composio tools if you need extra planning or code execution, "
            "but the final answer must be compact valid JSON only."
        ),
        tools=session.tools(),
    )

    local_candidates = collect_local_candidates(Path(args.source).resolve(), args.max_files, args.max_context_lines)
    result = await Runner.run(
        starting_agent=agent,
        input=build_agent_input(
            Path(args.source).resolve(),
            evidence,
            local_candidates,
        ),
    )
    return normalize_agent_output(result.final_output, evidence, local_candidates)


def write_output(output: str, json_out: str | None) -> None:
    if json_out:
        output_path = Path(json_out)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(output + "\n", encoding="utf-8")

    print(output)


def main() -> None:
    args = parse_args()
    source = Path(args.source).resolve()

    if not source.exists():
        raise FileNotFoundError(f"Source path does not exist: {source}")

    evidence = collect_evidence(source, args.max_files, args.max_evidence, args.max_context_lines)
    local_candidates = collect_local_candidates(source, args.max_files, args.max_context_lines)

    if args.collect_only:
        output = json.dumps(
            {
                "local_candidates": [asdict(item) for item in local_candidates],
                "evidence": [asdict(item) for item in evidence],
            },
            ensure_ascii=False,
            indent=2,
        )
        write_output(output, args.json_out)
        return

    if not evidence:
        empty_result = json.dumps({"controls": [], "unresolved": []}, indent=2)
        write_output(empty_result, args.json_out)
        return

    output = asyncio.run(run_composio_analysis(args, evidence))
    write_output(output, args.json_out)


if __name__ == "__main__":
    main()
