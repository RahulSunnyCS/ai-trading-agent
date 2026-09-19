"""
Shared strategy-YAML mutation helper — a partial dict deep-merged into a
base strategy's parsed YAML. Used by both the MCP server's
`propose_strategy` tool (a single ad-hoc mutation) and the sweep runner
(`analytics/sweep.py`, many mutations over the same base). `yaml.safe_load`/
`yaml.safe_dump` only — never `eval`, matching the design's hard
non-negotiable.
"""

from __future__ import annotations

from typing import Any


def deep_merge(base: dict[str, Any], overrides: dict[str, Any]) -> dict[str, Any]:
    result = dict(base)
    for k, v in overrides.items():
        if isinstance(v, dict) and isinstance(result.get(k), dict):
            result[k] = deep_merge(result[k], v)
        else:
            result[k] = v
    return result
