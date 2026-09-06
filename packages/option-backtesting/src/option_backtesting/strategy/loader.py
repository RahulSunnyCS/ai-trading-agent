"""
YAML -> validated StrategySpec, with line-numbered errors.

Loads via `yaml.safe_load` only (the handoff's non-negotiable — no `eval`,
no arbitrary-tag loader). Line numbers come from a *separate* pass over the
same source with `yaml.compose(..., Loader=yaml.SafeLoader)`, which builds a
Node tree carrying `start_mark.line` without running any constructors —
still nothing but the safe loader ever touches the file. The two passes are
reconciled by walking pydantic's `error["loc"]` path against a path->line
map built from that Node tree.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pydantic
import yaml
from yaml.nodes import MappingNode, SequenceNode

from ..features.registry import FeatureSpec, check_source_reference, parse_feature
from .schema import StrategySpec

LocPath = tuple[Any, ...]


class StrategyValidationError(Exception):
    """Raised with one or more line-numbered, human-readable messages. Never
    raised bare — `errors` always has at least one entry."""

    def __init__(self, errors: list[str]) -> None:
        self.errors = errors
        super().__init__("\n".join(errors))


@dataclass
class LoadedStrategy:
    features: dict[str, FeatureSpec] = field(default_factory=dict)
    strategy: StrategySpec | None = None


def _build_line_map(source: str) -> dict[LocPath, int]:
    """Walk the composed Node tree and record a 1-indexed source line for
    every mapping key / sequence index path, e.g. ("strategy", "ladders", 1,
    "when") -> 42."""
    root = yaml.compose(source, Loader=yaml.SafeLoader)
    lines: dict[LocPath, int] = {}

    def walk(node: Any, path: LocPath) -> None:
        lines[path] = node.start_mark.line + 1
        if isinstance(node, MappingNode):
            for key_node, value_node in node.value:
                walk(value_node, (*path, key_node.value))
        elif isinstance(node, SequenceNode):
            for i, item_node in enumerate(node.value):
                walk(item_node, (*path, i))

    if root is not None:
        walk(root, ())
    return lines


def _line_for(loc: LocPath, lines: dict[LocPath, int]) -> int | None:
    """Best-effort: walk the loc path from most-specific to least-specific
    until we find a line recorded for that exact path (pydantic's loc can be
    deeper than what the YAML line map tracked, e.g. into a Union variant's
    internals)."""
    for i in range(len(loc), 0, -1):
        if loc[:i] in lines:
            return lines[loc[:i]]
    return None


def _format_pydantic_error(
    exc: pydantic.ValidationError, lines: dict[LocPath, int], root_path: LocPath
) -> list[str]:
    out = []
    for err in exc.errors():
        loc = (*root_path, *err["loc"])
        loc_str = ".".join(str(p) for p in err["loc"])
        line = _line_for(loc, lines)
        prefix = f"line {line}: " if line is not None else ""
        out.append(f"{prefix}{loc_str}: {err['msg']}")
    return out


def load_strategy(path: Path) -> LoadedStrategy:
    """Load and validate one strategy YAML file. Raises
    StrategyValidationError with every line-numbered problem found (not just
    the first) — a strategy author fixing five bad features one at a time
    would otherwise re-run five times for no reason."""
    return load_strategy_from_source(path.read_text(), label=str(path))


def load_strategy_from_source(source: str, *, label: str = "<string>") -> LoadedStrategy:
    """Same validation as `load_strategy`, over an in-memory YAML string
    rather than a file path — used by the FastAPI service (api/routes.py),
    which receives strategy YAML as request-body text, never a filesystem
    path, so it never has occasion to open an arbitrary caller-supplied
    path. `label` only appears in the one error message that needs a
    human-readable source name."""
    try:
        data = yaml.safe_load(source)
    except yaml.YAMLError as e:
        raise StrategyValidationError([f"{label}: could not parse YAML: {e}"]) from None

    if not isinstance(data, dict):
        raise StrategyValidationError([f"{label}: top-level YAML document must be a mapping"])

    try:
        lines = _build_line_map(source)
    except yaml.YAMLError:
        # yaml.safe_load already succeeded above (a single-pass parser), so
        # this is unreachable in practice — but never let a purely cosmetic
        # line-number pass crash validation that otherwise succeeded.
        lines = {}

    errors: list[str] = []
    features: dict[str, FeatureSpec] = {}

    for name, spec in (data.get("features") or {}).items():
        feature_path: LocPath = ("features", name)
        try:
            parsed = parse_feature(spec)
            check_source_reference(name, parsed, features)
            features[name] = parsed
        except pydantic.ValidationError as e:
            errors.extend(_format_pydantic_error(e, lines, feature_path))
        except ValueError as e:
            line = _line_for(feature_path, lines)
            prefix = f"line {line}: " if line is not None else ""
            errors.append(f"{prefix}features.{name}: {e}")

    strategy: StrategySpec | None = None
    if "strategy" not in data:
        errors.append("Missing required top-level 'strategy' key")
    else:
        try:
            strategy = StrategySpec.model_validate(data["strategy"])
        except pydantic.ValidationError as e:
            errors.extend(_format_pydantic_error(e, lines, ("strategy",)))

    if errors:
        raise StrategyValidationError(errors)

    assert strategy is not None  # guaranteed: no errors means it validated
    return LoadedStrategy(features=features, strategy=strategy)
