"""Analyze game source code with the local keyboard evidence extractor.

This intentionally skips Composio sessions. It uses the same local candidates
that the Composio analyzer already collects, then writes the controls JSON that
the rest of GestureForge expects.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from analyze_game_controls_with_composio import (
    asdict,
    collect_evidence,
    collect_local_candidates,
    fallback_output_from_local_candidates,
    filter_agent_sources,
    merge_duplicate_controls,
    merge_source_lists,
    write_output,
    write_stage,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Extract keyboard controls from game source locally.")
    parser.add_argument("--source", required=True, help="Game source directory or single source file.")
    parser.add_argument("--max-files", type=int, default=160, help="Maximum source files to scan.")
    parser.add_argument("--max-evidence", type=int, default=220, help="Maximum evidence blocks to scan.")
    parser.add_argument("--max-context-lines", type=int, default=2, help="Number of nearby lines kept around each evidence line.")
    parser.add_argument("--json-out", help="Optional path to write the final JSON result.")
    parser.add_argument("--stage-out", help="Optional path to write analyzer stage diagnostics.")
    parser.add_argument("--collect-only", action="store_true", help="Only print local keyboard evidence.")
    return parser.parse_args()


def action_dedupe_key(control: dict[str, object]) -> str:
    suggested = str(control.get("suggested_function") or "").strip().lower()
    action = str(control.get("action") or control.get("id") or "").strip().lower()

    return suggested or action


def primary_binding_score(control: dict[str, object]) -> float:
    action = str(control.get("action") or "").strip().lower()
    key = str(control.get("key") or "").strip().lower()
    code = str(control.get("code") or "").strip().lower()
    confidence = float(control.get("confidence") or 0)
    usage_targets = control.get("usage_targets")
    score = confidence

    if key == action or code == action:
        score += 10

    if usage_targets:
        score += 1

    return score


def merge_controls_by_action(parsed: dict[str, object]) -> dict[str, object]:
    controls = parsed.get("controls", [])

    if not isinstance(controls, list):
        return parsed

    merged_controls: list[dict[str, object]] = []
    by_action: dict[str, dict[str, object]] = {}

    for item in controls:
        if not isinstance(item, dict):
            continue

        key = action_dedupe_key(item)

        if not key:
            merged_controls.append(item)
            continue

        existing = by_action.get(key)

        if existing is None:
            copied = dict(item)
            copied["usage_targets"] = merge_source_lists(item.get("usage_targets", []))
            copied["evidence"] = merge_source_lists(item.get("evidence", []))
            by_action[key] = copied
            merged_controls.append(copied)
            continue

        preferred = existing
        secondary = item

        if primary_binding_score(item) > primary_binding_score(existing):
            preferred = dict(item)
            secondary = existing
            index = merged_controls.index(existing)
            by_action[key] = preferred
            merged_controls[index] = preferred

        preferred["usage_targets"] = merge_source_lists(
            preferred.get("usage_targets", []),
            secondary.get("usage_targets", []),
        )
        preferred["evidence"] = merge_source_lists(
            preferred.get("evidence", []),
            secondary.get("evidence", []),
        )

        alternate_bindings = [
            binding
            for binding_list in (
                preferred.get("alternate_bindings", []),
                [secondary.get("binding_target")] if secondary.get("binding_target") else [],
                secondary.get("alternate_bindings", []),
            )
            if isinstance(binding_list, list)
            for binding in binding_list
        ]
        preferred["alternate_bindings"] = merge_source_lists(alternate_bindings)
        preferred["confidence"] = max(float(preferred.get("confidence") or 0), float(secondary.get("confidence") or 0))

    parsed["controls"] = merged_controls
    return parsed


def local_analysis_output(source: Path, args: argparse.Namespace) -> str:
    write_stage(args, "collecting_evidence")
    evidence = collect_evidence(source, args.max_files, args.max_evidence, args.max_context_lines)
    write_stage(args, "collecting_local_candidates")
    local_candidates = collect_local_candidates(source, args.max_files, args.max_context_lines)

    if args.collect_only:
        return json.dumps(
            {
                "local_candidates": [asdict(item) for item in local_candidates],
                "evidence": [asdict(item) for item in evidence],
            },
            ensure_ascii=False,
            indent=2,
        )

    write_stage(args, "running_local_analysis")
    parsed = fallback_output_from_local_candidates(local_candidates)
    parsed = filter_agent_sources(parsed, evidence, local_candidates)
    parsed = merge_duplicate_controls(parsed)
    parsed = merge_controls_by_action(parsed)
    return json.dumps(parsed, ensure_ascii=False, indent=2)


def main() -> None:
    args = parse_args()
    source = Path(args.source).resolve()

    write_stage(args, "validating_source")
    if not source.exists():
        write_stage(args, "source_missing", str(source))
        raise FileNotFoundError(f"Source path does not exist: {source}")

    output = local_analysis_output(source, args)
    write_stage(args, "writing_analysis_output")
    write_output(output, args.json_out)
    write_stage(args, "complete")


if __name__ == "__main__":
    main()
