"""
Memory dynamics analysis.

Computes:
  - Crystallization rate: episodic → procedural conversion rate per agent per cycle
  - Forgetting rate: memories evicted per cycle
  - Prompt rewrite rate and timing
  - Memory type distribution over time
  - Knowledge inheritance: what was present at cycle 0 (inherited vs self-discovered)
"""

from __future__ import annotations
from collections import defaultdict
from .load import parse_memory_op


def per_cycle_memory_stats(metrics: list[dict]) -> list[dict]:
    """
    For each cycle, compute memory operation counts and rates.

    Returns list of dicts, one per cycle:
      {
        cycle, timestamp, agent_id,
        stores_total, stores_episodic, stores_semantic, stores_procedural,
        forgets, compressions, consolidations, rewrites,
        crystallization_rate,   # procedural / total stores
        net_memory_change,      # stores - forgets
        mem_episodic, mem_semantic, mem_procedural, mem_total_tokens,
      }
    """
    rows = []
    for m in metrics:
        ops = [parse_memory_op(op) for op in m.get("memoryOps", [])]

        stores = [op for op in ops if op["action"] == "stored"]
        s_episodic = sum(1 for op in stores if op.get("type") == "episodic")
        s_semantic = sum(1 for op in stores if op.get("type") == "semantic")
        s_procedural = sum(1 for op in stores if op.get("type") == "procedural")
        forgets = sum(1 for op in ops if op["action"] == "forgot")
        compressions = sum(1 for op in ops if op["action"] == "compressed")
        consolidations = sum(op.get("count", 1) for op in ops if op["action"] == "consolidated")
        rewrites = sum(1 for op in ops if op["action"] == "rewrote")

        total_stores = len(stores)
        crystallization = s_procedural / total_stores if total_stores > 0 else 0.0

        fp = m.get("fingerprint", {})
        rows.append({
            "cycle": m.get("cycle", 0),
            "timestamp": m.get("timestamp", ""),
            "agent_id": m.get("agentId", ""),
            "stores_total": total_stores,
            "stores_episodic": s_episodic,
            "stores_semantic": s_semantic,
            "stores_procedural": s_procedural,
            "forgets": forgets,
            "compressions": compressions,
            "consolidations": consolidations,
            "rewrites": rewrites,
            "crystallization_rate": round(crystallization, 4),
            "net_memory_change": total_stores - forgets,
            "mem_episodic": fp.get("memEpisodic", 0),
            "mem_semantic": fp.get("memSemantic", 0),
            "mem_procedural": fp.get("memProcedural", 0),
            "mem_total_tokens": fp.get("memTotalTokens", 0),
            "prompt_version": fp.get("promptVersion", 0),
        })
    return rows


def agent_memory_summary(metrics: list[dict]) -> dict:
    """
    Aggregate memory stats across an agent's full lifecycle.

    Returns summary dict with rates (per cycle) and totals.
    """
    rows = per_cycle_memory_stats(metrics)
    if not rows:
        return {}

    n = len(rows)
    return {
        "agent_id": rows[0]["agent_id"],
        "cycles": n,
        "total_stores": sum(r["stores_total"] for r in rows),
        "total_episodic_stores": sum(r["stores_episodic"] for r in rows),
        "total_semantic_stores": sum(r["stores_semantic"] for r in rows),
        "total_procedural_stores": sum(r["stores_procedural"] for r in rows),
        "total_forgets": sum(r["forgets"] for r in rows),
        "total_compressions": sum(r["compressions"] for r in rows),
        "total_consolidations": sum(r["consolidations"] for r in rows),
        "total_rewrites": sum(r["rewrites"] for r in rows),
        "overall_crystallization_rate": round(
            sum(r["stores_procedural"] for r in rows) /
            max(sum(r["stores_total"] for r in rows), 1), 4
        ),
        "forget_rate_per_cycle": round(sum(r["forgets"] for r in rows) / n, 4),
        "rewrite_rate_per_cycle": round(sum(r["rewrites"] for r in rows) / n, 4),
        "net_memory_change_per_cycle": round(sum(r["net_memory_change"] for r in rows) / n, 4),
        # First vs last memory composition
        "initial_mem_procedural": rows[0]["mem_procedural"],
        "final_mem_procedural": rows[-1]["mem_procedural"],
        "initial_prompt_version": rows[0]["prompt_version"],
        "final_prompt_version": rows[-1]["prompt_version"],
    }


def inheritance_profile(metrics: list[dict], census_entry: dict) -> dict:
    """
    Characterize what an agent inherited vs discovered.

    For generation-0 agents: cycle-0 fingerprint is the baseline (no inheritance).
    For generation > 0 agents: cycle-0 fingerprint reflects inherited state.

    Returns {generation, inherited_procedural, inherited_semantic, self_discovered_procedural, ...}
    """
    if not metrics:
        return {}

    generation = census_entry.get("generation", 0)
    first = metrics[0].get("fingerprint", {})
    last = metrics[-1].get("fingerprint", {})

    inherited_procedural = first.get("memProcedural", 0) if generation > 0 else 0
    inherited_semantic = first.get("memSemantic", 0) if generation > 0 else 0

    total_proc = last.get("memProcedural", 0)
    total_sem = last.get("memSemantic", 0)

    return {
        "agent_id": metrics[0].get("agentId", ""),
        "generation": generation,
        "source_id": census_entry.get("sourceId"),
        "inherited_procedural": inherited_procedural,
        "inherited_semantic": inherited_semantic,
        "peak_procedural": max(
            (m.get("fingerprint", {}).get("memProcedural", 0) for m in metrics), default=0
        ),
        "peak_semantic": max(
            (m.get("fingerprint", {}).get("memSemantic", 0) for m in metrics), default=0
        ),
        "first_solve_cycle": next(
            (m.get("cycle") for m in metrics
             if m.get("fingerprint", {}).get("challengesSolved", 0) > 0),
            None,
        ),
    }


def population_memory_over_time(run: dict) -> list[dict]:
    """
    Per significant population event (pool regen or agent death): aggregate
    memory composition across all agents active within the preceding 120 seconds.

    Shares the same event timeline as diversity_over_time and founder_dominance.
    """
    from datetime import datetime, timedelta

    def memory_at(t: str, global_cycle: int, event_type: str) -> dict | None:
        t_dt = datetime.fromisoformat(t.replace("Z", "+00:00"))
        t_early = (t_dt - timedelta(seconds=120)).isoformat().replace("+00:00", "Z")

        ep_counts, sem_counts, proc_counts = [], [], []
        crystallization_rates = []

        for agent_id, agent in run["agents"].items():
            latest = None
            for m in agent["metrics"]:
                ts = m.get("timestamp", "")
                if t_early <= ts <= t:
                    latest = m
            if latest is None:
                continue
            fp = latest.get("fingerprint", {})
            ep_counts.append(fp.get("memEpisodic", 0))
            sem_counts.append(fp.get("memSemantic", 0))
            proc_counts.append(fp.get("memProcedural", 0))

            ops = [parse_memory_op(op) for op in latest.get("memoryOps", [])]
            stores = [op for op in ops if op["action"] == "stored"]
            proc_stores = [op for op in stores if op.get("type") == "procedural"]
            if stores:
                crystallization_rates.append(len(proc_stores) / len(stores))

        n = len(ep_counts)
        if n == 0:
            return None

        def mean(lst): return sum(lst) / len(lst) if lst else 0

        return {
            "global_cycle": global_cycle,
            "timestamp": t,
            "event_type": event_type,
            "n_agents": n,
            "mean_episodic": round(mean(ep_counts), 3),
            "mean_semantic": round(mean(sem_counts), 3),
            "mean_procedural": round(mean(proc_counts), 3),
            "mean_crystallization": round(mean(crystallization_rates), 4),
            "total_procedural": sum(proc_counts),
            "total_semantic": sum(sem_counts),
            "total_episodic": sum(ep_counts),
        }

    # Build unified event list: regen ticks + agent deaths
    events: list[tuple[str, str]] = []
    for e in run["pool_ledger"]:
        if e["type"] == "regen":
            events.append((e["t"], "regen"))
    for agent_id, agent in run["agents"].items():
        timestamps = [m.get("timestamp", "") for m in agent["metrics"] if m.get("timestamp")]
        if timestamps:
            events.append((max(timestamps), f"death:{agent_id}"))

    events.sort(key=lambda x: x[0])

    # Deduplicate near-simultaneous deaths (within 2s)
    deduplicated: list[tuple[str, str]] = []
    for ts, etype in events:
        if (deduplicated
                and "death" in etype
                and "death" in deduplicated[-1][1]
                and abs((datetime.fromisoformat(ts.replace("Z", "+00:00")) -
                         datetime.fromisoformat(deduplicated[-1][0].replace("Z", "+00:00"))).total_seconds()) < 2):
            deduplicated[-1] = (ts, "death:batch")
        else:
            deduplicated.append((ts, etype))

    results = []
    prev_n = None
    for i, (ts, etype) in enumerate(deduplicated):
        label = etype if not etype.startswith("death:") else "death"
        row = memory_at(ts, i + 1, label)
        if row is None:
            continue
        if etype == "regen" and row["n_agents"] == prev_n:
            continue
        prev_n = row["n_agents"]
        results.append(row)

    return results
