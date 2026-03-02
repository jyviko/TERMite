"""
Load raw run data from a TERM-ITE arena-workspace run directory.

All functions return plain dicts/lists — no runtime dependencies.
"""

from __future__ import annotations
import json
import os
import re
from pathlib import Path
from typing import Iterator


def iter_jsonl(path: Path) -> Iterator[dict]:
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                yield json.loads(line)


def load_run(run_dir: str | Path) -> dict:
    """
    Load all data from a run directory into a single dict:

    {
      "run_id": str,
      "agents": {agent_id: {"metrics": [...], "state": {...}, "entry": {...}}},
      "census": [...],          # list of agent census entries
      "pool_ledger": [...],     # all pool events in order
      "pool_summary": {...},    # final pool state
      "challenges": {...},      # challenge manifest
    }
    """
    root = Path(run_dir)
    shared = root / "shared"

    run = {
        "run_id": root.name,
        "agents": {},
        "census": [],
        "pool_ledger": [],
        "pool_summary": {},
        "challenges": {},
    }

    # Pool ledger
    ledger_path = shared / "_pool_ledger.jsonl"
    if ledger_path.exists():
        run["pool_ledger"] = list(iter_jsonl(ledger_path))

    def load_json_file(path, default=None):
        try:
            text = path.read_text().strip()
            return json.loads(text) if text else (default if default is not None else {})
        except (json.JSONDecodeError, OSError):
            return default if default is not None else {}

    # Pool summary
    pool_path = shared / "_pool.json"
    if pool_path.exists():
        run["pool_summary"] = load_json_file(pool_path)

    # Census
    census_path = shared / "_census.json"
    if census_path.exists():
        data = load_json_file(census_path)
        run["census"] = data.get("agents", [])

    # Challenge manifest
    manifest_path = shared / "challenges" / "_manifest.json"
    if manifest_path.exists():
        run["challenges"] = load_json_file(manifest_path, default=[])

    # Challenge pool state (includes evicted challenges if still present)
    state_path = shared / "challenges" / "_state.json"
    if state_path.exists():
        run["challenge_state"] = load_json_file(state_path)

    # Per-agent data
    for agent_dir in sorted(root.iterdir()):
        if not agent_dir.is_dir() or not agent_dir.name.startswith("agent-"):
            continue
        agent_id = agent_dir.name

        metrics_path = agent_dir / "metrics.jsonl"
        state_path = agent_dir / "state.json"
        entry_path = agent_dir / "entry.json"

        def load_json(path):
            try:
                text = path.read_text().strip()
                return json.loads(text) if text else {}
            except (json.JSONDecodeError, OSError):
                return {}

        agent = {
            "metrics": list(iter_jsonl(metrics_path)) if metrics_path.exists() else [],
            "state": load_json(state_path) if state_path.exists() else {},
            "entry": load_json(entry_path) if entry_path.exists() else {},
        }
        run["agents"][agent_id] = agent

    return run


def parse_memory_op(op: str) -> dict:
    """
    Parse a memoryOps string into a structured dict.

    Examples:
      "stored procedural:0.9"   -> {action: "stored", type: "procedural", score: 0.9}
      "forgot mem_abc123"        -> {action: "forgot",  id: "mem_abc123"}
      "compressed mem_abc123"    -> {action: "compressed", id: "mem_abc123"}
      "consolidated 2 memories"  -> {action: "consolidated", count: 2}
      "rewrote systemPrompt"     -> {action: "rewrote", target: "systemPrompt"}
    """
    op = op.strip()

    m = re.match(r"^stored (\w+):([0-9.]+)$", op)
    if m:
        return {"action": "stored", "type": m.group(1), "score": float(m.group(2))}

    m = re.match(r"^forgot (\S+)$", op)
    if m:
        return {"action": "forgot", "id": m.group(1)}

    m = re.match(r"^compressed (\S+)$", op)
    if m:
        return {"action": "compressed", "id": m.group(1)}

    m = re.match(r"^consolidated (\d+) memories?$", op)
    if m:
        return {"action": "consolidated", "count": int(m.group(1))}

    m = re.match(r"^rewrote (\S+)$", op)
    if m:
        return {"action": "rewrote", "target": m.group(1)}

    return {"action": "unknown", "raw": op}


def phenotype_vector(fingerprint: dict) -> list[float]:
    """
    Encode a fingerprint as a fixed-length numeric vector for distance/diversity computation.

    Dimensions:
      0  memEpisodic
      1  memSemantic
      2  memProcedural
      3  promptVersion (capped at 15)
      4  toolCount (base 9, delta)
      5  preferredDifficulty (0-5)
      6  drives.explore
      7  drives.acquire
      8  drives.grow
      9  drives.coordinate
    """
    if not fingerprint:
        return [0.0] * 10
    drives = fingerprint.get("drives", {})
    return [
        float(fingerprint.get("memEpisodic", 0)),
        float(fingerprint.get("memSemantic", 0)),
        float(fingerprint.get("memProcedural", 0)),
        float(min(fingerprint.get("promptVersion", 0), 15)),
        float(max(fingerprint.get("toolCount", 9) - 9, 0)),
        float(fingerprint.get("preferredDifficulty", 0)),
        float(drives.get("explore", 0)),
        float(drives.get("acquire", 0)),
        float(drives.get("grow", 0)),
        float(drives.get("coordinate", 0)),
    ]


def euclidean(a: list[float], b: list[float]) -> float:
    return sum((x - y) ** 2 for x, y in zip(a, b)) ** 0.5
