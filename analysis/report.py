"""
Generate analysis outputs for a run.

Writes to <output_dir>/:
  summary.json                      — top-level metrics (MODES, pool, lineage, memory)
  diversity_over_time.csv           — per-event diversity metrics
  pool_curve.csv                    — per-event pool balance + active agents
  memory_over_time.csv              — per-event memory composition
  per_agent_stats.csv               — one row per agent (all lifecycle stats)
  per_agent_cycles.csv              — one row per agent-cycle (fingerprint + memory ops)
  founder_dominance.csv             — per-event lineage convergence
  generation_stats.csv              — per-generation aggregates
  fork_roi.csv                      — per-fork cost/benefit analysis
  preferred_difficulty_over_time.csv — per-event agent ambition trajectory
  challenge_solve_stats.csv         — per-challenge difficulty and solve timing
"""

from __future__ import annotations
import csv
import json
import os
from pathlib import Path

from .load import load_run, parse_memory_op, phenotype_vector
from .diversity import (
    population_diversity_over_cycles,
    agent_activity_stats,
    modes_scores,
)
from .pool import (
    carrying_capacity_curve,
    per_agent_pool_stats,
    pool_summary_stats,
)
from .memory import (
    per_cycle_memory_stats,
    agent_memory_summary,
    inheritance_profile,
    population_memory_over_time,
)
from .lineage import (
    build_lineage_tree,
    generation_stats,
    fork_roi,
    founder_dominance_over_time,
    lineage_summary,
)
from .challenges import (
    preferred_difficulty_over_time,
    challenge_solve_stats,
    difficulty_decay_summary,
    reward_decay_over_time,
)


def _write_csv(path: Path, rows: list[dict]) -> None:
    if not rows:
        return
    keys = list(rows[0].keys())
    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=keys)
        writer.writeheader()
        for row in rows:
            # Flatten nested dicts into JSON strings for CSV compat
            flat = {}
            for k, v in row.items():
                flat[k] = json.dumps(v) if isinstance(v, (dict, list)) else v
            writer.writerow(flat)


def generate(run_dir: str | Path, output_dir: str | Path | None = None) -> Path:
    """
    Run all analyses and write outputs.

    If output_dir is None, writes to <run_dir>/analysis/.
    Returns the output directory path.
    """
    run_dir = Path(run_dir)
    output_dir = Path(output_dir) if output_dir else run_dir / "analysis"
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"Loading run: {run_dir.name}")
    run = load_run(run_dir)

    agent_metrics = {aid: a["metrics"] for aid, a in run["agents"].items()}
    census_map = {c["id"]: c for c in run["census"]}

    # -----------------------------------------------------------------------
    # Diversity over time
    # -----------------------------------------------------------------------
    print("Computing population diversity...")
    diversity_rows = population_diversity_over_cycles(run)
    _write_csv(output_dir / "diversity_over_time.csv", diversity_rows)

    # -----------------------------------------------------------------------
    # Pool curve
    # -----------------------------------------------------------------------
    print("Computing pool dynamics...")
    pool_curve = carrying_capacity_curve(run["pool_ledger"])
    _write_csv(output_dir / "pool_curve.csv", pool_curve)

    pool_stats = pool_summary_stats(run["pool_ledger"], run["census"])
    pool_per_agent = per_agent_pool_stats(run["pool_ledger"])

    # -----------------------------------------------------------------------
    # Memory over time
    # -----------------------------------------------------------------------
    print("Computing memory dynamics...")
    memory_rows = population_memory_over_time(run)
    _write_csv(output_dir / "memory_over_time.csv", memory_rows)

    # -----------------------------------------------------------------------
    # Lineage
    # -----------------------------------------------------------------------
    print("Computing lineage...")
    lineage_tree = build_lineage_tree(run["census"])
    gen_stats = generation_stats(lineage_tree, agent_metrics)
    _write_csv(output_dir / "generation_stats.csv", gen_stats)

    fork_rows = fork_roi(lineage_tree, agent_metrics)
    _write_csv(output_dir / "fork_roi.csv", fork_rows)

    founder_rows = founder_dominance_over_time(run)
    _write_csv(output_dir / "founder_dominance.csv", founder_rows)

    lin_summary = lineage_summary(run)

    # -----------------------------------------------------------------------
    # Per-agent stats
    # -----------------------------------------------------------------------
    print("Computing per-agent stats...")
    per_agent_rows = []
    per_agent_cycle_rows = []

    for agent_id, agent in run["agents"].items():
        metrics = agent["metrics"]
        if not metrics:
            continue

        ce = census_map.get(agent_id, {})
        agent["census_entry"] = ce

        activity = agent_activity_stats(agent)
        mem_summary = agent_memory_summary(metrics)
        inherit = inheritance_profile(metrics, ce)
        pool_s = pool_per_agent.get(agent_id, {})

        row = {
            "agent_id": agent_id,
            "generation": ce.get("generation", 0),
            "source_id": ce.get("sourceId"),
            "model": ce.get("model", ""),
            "active": ce.get("active", False),
            "cycles": len(metrics),
            "challenges_solved": activity.get("challenges_solved", 0),
            "bedau_class": activity.get("bedau_class", ""),
            "change_score": activity.get("change_score", 0),
            "novelty_score": activity.get("novelty_score", 0),
            "complexity": activity.get("complexity", 0),
            "crystallization_rate": activity.get("crystallization_rate", 0),
            "prompt_rewrites": activity.get("prompt_rewrite_count", 0),
            "total_stores": activity.get("total_stores", 0),
            "total_forgets": activity.get("total_forgets", 0),
            "outcomes_success": activity.get("outcomes", {}).get("success", 0),
            "outcomes_partial": activity.get("outcomes", {}).get("partial", 0),
            "outcomes_failure": activity.get("outcomes", {}).get("failure", 0),
            "total_income": sum(m.get("income", 0) for m in metrics),
            "total_cost": sum(m.get("cost", 0) for m in metrics),
            "net": sum(m.get("net", 0) for m in metrics),
            "total_withdrawn_from_pool": pool_s.get("total_withdrawn", 0),
            "total_deposited_to_pool": pool_s.get("total_deposited", 0),
            "inherited_procedural": inherit.get("inherited_procedural", 0),
            "inherited_semantic": inherit.get("inherited_semantic", 0),
            "first_solve_cycle": inherit.get("first_solve_cycle"),
            "peak_procedural": inherit.get("peak_procedural", 0),
        }
        per_agent_rows.append(row)

        # Per-cycle rows for this agent
        cycle_mem_stats = per_cycle_memory_stats(metrics)
        for i, m in enumerate(metrics):
            fp = m.get("fingerprint", {})
            pv = phenotype_vector(fp)
            cms = cycle_mem_stats[i] if i < len(cycle_mem_stats) else {}
            per_agent_cycle_rows.append({
                "agent_id": agent_id,
                "generation": ce.get("generation", 0),
                "cycle": m.get("cycle", i),
                "timestamp": m.get("timestamp", ""),
                "outcome": m.get("outcome", ""),
                "cost": m.get("cost", 0),
                "income": m.get("income", 0),
                "net": m.get("net", 0),
                "reserves": m.get("reserves", 0),
                "input_tokens": m.get("inputTokens", 0),
                "output_tokens": m.get("outputTokens", 0),
                "cache_read_tokens": m.get("cacheReadTokens", 0),
                "cache_creation_tokens": m.get("cacheCreationTokens", 0),
                "mem_episodic": fp.get("memEpisodic", 0),
                "mem_semantic": fp.get("memSemantic", 0),
                "mem_procedural": fp.get("memProcedural", 0),
                "mem_total_tokens": fp.get("memTotalTokens", 0),
                "prompt_version": fp.get("promptVersion", 0),
                "tool_count": fp.get("toolCount", 0),
                "challenges_solved": fp.get("challengesSolved", 0),
                "preferred_difficulty": fp.get("preferredDifficulty", 0),
                "drive_explore": fp.get("drives", {}).get("explore", 0),
                "drive_acquire": fp.get("drives", {}).get("acquire", 0),
                "drive_grow": fp.get("drives", {}).get("grow", 0),
                "drive_coordinate": fp.get("drives", {}).get("coordinate", 0),
                "phenotype_0_ep": pv[0],
                "phenotype_1_sem": pv[1],
                "phenotype_2_proc": pv[2],
                "phenotype_3_pv": pv[3],
                "phenotype_4_tools": pv[4],
                "phenotype_5_diff": pv[5],
                "stores_total": cms.get("stores_total", 0),
                "stores_procedural": cms.get("stores_procedural", 0),
                "forgets": cms.get("forgets", 0),
                "compressions": cms.get("compressions", 0),
                "rewrites": cms.get("rewrites", 0),
                "crystallization_rate": cms.get("crystallization_rate", 0),
            })

    _write_csv(output_dir / "per_agent_stats.csv", per_agent_rows)
    _write_csv(output_dir / "per_agent_cycles.csv", per_agent_cycle_rows)

    # -----------------------------------------------------------------------
    # Challenge difficulty
    # -----------------------------------------------------------------------
    print("Computing challenge difficulty...")
    pref_diff_rows = preferred_difficulty_over_time(run)
    _write_csv(output_dir / "preferred_difficulty_over_time.csv", pref_diff_rows)

    ch_solve_rows = challenge_solve_stats(run)
    _write_csv(output_dir / "challenge_solve_stats.csv", ch_solve_rows)

    reward_rows = reward_decay_over_time(run)
    _write_csv(output_dir / "reward_decay_over_time.csv", reward_rows)

    diff_decay = difficulty_decay_summary(pref_diff_rows)

    # -----------------------------------------------------------------------
    # MODES scores
    # -----------------------------------------------------------------------
    print("Computing MODES scores...")
    modes = modes_scores(run)

    # -----------------------------------------------------------------------
    # Summary JSON
    # -----------------------------------------------------------------------
    summary = {
        "run_id": run["run_id"],
        "pool": pool_stats,
        "lineage": lin_summary,
        "modes": modes,
        "generation_stats": gen_stats,
        "n_cycle_records": len(per_agent_cycle_rows),
        "n_pool_events": len(run["pool_ledger"]),
        "n_diversity_snapshots": len(diversity_rows),
        "final_diversity": diversity_rows[-1] if diversity_rows else None,
        "final_memory": memory_rows[-1] if memory_rows else None,
        "final_founder_dominance": founder_rows[-1] if founder_rows else None,
        "difficulty_decay": diff_decay,
    }

    (output_dir / "summary.json").write_text(json.dumps(summary, indent=2))

    print(f"\nOutputs written to: {output_dir}")
    print(f"  {len(per_agent_rows)} agents | {len(per_agent_cycle_rows)} cycle records | {len(run['pool_ledger'])} pool events")

    return output_dir
