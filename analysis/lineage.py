"""
Lineage and inheritance analysis.

Computes:
  - Full lineage tree with survival stats
  - Founder effect: dominance of single source lineage over time
  - Generation-level aggregates (fitness, diversity, lifespan)
  - Trophic coherence (how "vertical" the inheritance graph is)
  - Fork ROI: did forks create net-positive outcomes?
"""

from __future__ import annotations
from collections import defaultdict


def build_lineage_tree(census: list[dict]) -> dict:
    """
    Build a lineage tree from census data.

    Returns {
      agent_id: {
        id, generation, source_id, children: [agent_ids],
        active, cycles, challenges_solved, energy_pct, reserves, model
      }
    }
    """
    nodes: dict[str, dict] = {}
    for entry in census:
        nodes[entry["id"]] = {
            "id": entry["id"],
            "generation": entry.get("generation", 0),
            "source_id": entry.get("sourceId"),
            "children": [],
            "active": entry.get("active", False),
            "cycle_count": entry.get("cycleCount", 0),
            "challenges_solved": entry.get("challengesSolved", 0),
            "energy_pct": entry.get("energyPct", 0),
            "reserves": entry.get("reserves", 0),
            "model": entry.get("model", ""),
            "config_version": entry.get("configVersion", 0),
        }

    # Wire parent → children
    for node in nodes.values():
        parent_id = node["source_id"]
        if parent_id and parent_id in nodes:
            nodes[parent_id]["children"].append(node["id"])

    return nodes


def generation_stats(lineage_tree: dict, agent_metrics: dict[str, list[dict]]) -> list[dict]:
    """
    Aggregate metrics by generation.

    agent_metrics: {agent_id: metrics list}

    Returns list of {generation, n_agents, mean_cycles, mean_solved, mean_config_version,
                     survival_rate (fraction that solved > 0), total_cycles, total_solved}
    """
    by_gen: dict[int, list[dict]] = defaultdict(list)
    for node in lineage_tree.values():
        by_gen[node["generation"]].append(node)

    rows = []
    for gen in sorted(by_gen.keys()):
        nodes = by_gen[gen]
        n = len(nodes)
        survived = [nd for nd in nodes if nd["challenges_solved"] > 0]

        # Use metrics to get actual cycle count (more reliable than census)
        cycle_counts = []
        for nd in nodes:
            m = agent_metrics.get(nd["id"], [])
            cycle_counts.append(len(m))

        rows.append({
            "generation": gen,
            "n_agents": n,
            "mean_cycles": round(sum(cycle_counts) / n if cycle_counts else 0, 2),
            "total_cycles": sum(cycle_counts),
            "mean_solved": round(sum(nd["challenges_solved"] for nd in nodes) / n, 2),
            "total_solved": sum(nd["challenges_solved"] for nd in nodes),
            "survival_rate": round(len(survived) / n, 4),
            "mean_config_version": round(sum(nd["config_version"] for nd in nodes) / n, 2),
            "n_active": sum(1 for nd in nodes if nd["active"]),
        })
    return rows


def fork_roi(lineage_tree: dict, agent_metrics: dict[str, list[dict]]) -> list[dict]:
    """
    For each fork event (agent with source_id != None), compute the return on investment.

    Estimates fork cost from pool_ledger (withdrawals labeled as fork).
    Alternatively, uses the "Split history" convention: the forked agent's starting reserves
    can be inferred from the source agent's metrics.

    Returns list of {
      fork_id, source_id, generation,
      child_cycles, child_solved, child_income,
      estimated_fork_cost,  # inferred from reserves at cycle 0
      roi_cycles,           # cycles before child breaks even
      outcome               # "positive" | "neutral" | "negative"
    }
    """
    rows = []
    for agent_id, node in lineage_tree.items():
        if node["source_id"] is None:
            continue  # gen-0, no fork

        child_metrics = agent_metrics.get(agent_id, [])
        if not child_metrics:
            continue

        # Total income across child's life
        child_income = sum(m.get("income", 0) for m in child_metrics)
        child_cost = sum(m.get("cost", 0) for m in child_metrics)
        child_solved = max((m.get("fingerprint", {}).get("challengesSolved", 0) for m in child_metrics), default=0)

        # Estimate fork cost: look for large single-cycle withdrawal in the source
        # or infer from child's starting reserves (first metrics[0] fingerprint)
        # We use the first cycle cost as a proxy if reserves aren't available
        initial_reserves = child_metrics[0].get("reserves", 0) if child_metrics else 0
        if initial_reserves == 0:
            # Try to get from a "deposits" pattern — rough estimate
            initial_reserves = None

        # Break-even: how many cycles until cumulative income >= estimated fork cost
        roi_cycles = None
        if initial_reserves:
            cumulative_income = 0
            for i, m in enumerate(child_metrics):
                cumulative_income += m.get("income", 0)
                if cumulative_income >= initial_reserves:
                    roi_cycles = i + 1
                    break

        net = child_income - child_cost
        rows.append({
            "fork_id": agent_id,
            "source_id": node["source_id"],
            "generation": node["generation"],
            "child_cycles": len(child_metrics),
            "child_solved": child_solved,
            "child_income": child_income,
            "child_cost": child_cost,
            "child_net": net,
            "initial_reserves": initial_reserves,
            "roi_cycles": roi_cycles,
            "outcome": "positive" if net > 0 else ("neutral" if net == 0 else "negative"),
        })

    return rows


def founder_dominance_over_time(run: dict) -> list[dict]:
    """
    At each significant population event (pool regen or agent death), compute
    the fraction of *currently alive* agents that descend from each gen-0 ancestor.

    "Currently alive" = ran at least one cycle within the 120 seconds before this event.

    Events:
      - regen: pool regeneration tick (regular heartbeat)
      - death: last recorded metric for an agent (population shrinks)

    The final snapshot is always anchored to the true end-of-run timestamp.
    """
    from datetime import datetime, timedelta

    census_map = {c["id"]: c for c in run["census"]}

    def find_root(agent_id: str) -> str | None:
        seen = set()
        current = census_map.get(agent_id)
        while current and current.get("sourceId"):
            if current["id"] in seen:
                return None
            seen.add(current["id"])
            parent_id = current["sourceId"]
            parent = census_map.get(parent_id)
            if parent is None:
                return parent_id
            current = parent
        return current["id"] if current else agent_id

    def snapshot_at(t: str, global_cycle: int, event_type: str) -> dict | None:
        t_dt = datetime.fromisoformat(t.replace("Z", "+00:00"))
        t_early = (t_dt - timedelta(seconds=120)).isoformat().replace("+00:00", "Z")

        founder_counts: dict[str, int] = defaultdict(int)
        n_active = 0

        for agent_id, agent in run["agents"].items():
            recently_active = any(
                t_early <= m.get("timestamp", "") <= t
                for m in agent["metrics"]
            )
            if not recently_active:
                continue
            n_active += 1
            root = find_root(agent_id)
            if root:
                founder_counts[root] += 1

        if n_active == 0:
            return None

        dominant = max(founder_counts.values(), default=0)
        return {
            "global_cycle": global_cycle,
            "timestamp": t,
            "event_type": event_type,
            "n_active": n_active,
            "n_founders_represented": len(founder_counts),
            "dominant_founder_pct": round(dominant / n_active, 4),
            "founder_distribution": dict(founder_counts),
        }

    # Build event list: regen ticks + agent death events (last metric per agent)
    events: list[tuple[str, str]] = []  # (timestamp, event_type)

    for e in run["pool_ledger"]:
        if e["type"] == "regen":
            events.append((e["t"], "regen"))

    for agent_id, agent in run["agents"].items():
        timestamps = [m.get("timestamp", "") for m in agent["metrics"] if m.get("timestamp")]
        if timestamps:
            events.append((max(timestamps), f"death:{agent_id}"))

    # Sort chronologically; deduplicate events within 2 seconds of each other
    events.sort(key=lambda x: x[0])
    deduplicated: list[tuple[str, str]] = []
    for ts, etype in events:
        if deduplicated and abs(
            (datetime.fromisoformat(ts.replace("Z", "+00:00")) -
             datetime.fromisoformat(deduplicated[-1][0].replace("Z", "+00:00"))).total_seconds()
        ) < 2 and "death" in etype and "death" in deduplicated[-1][1]:
            # Merge near-simultaneous deaths — keep the later timestamp
            deduplicated[-1] = (ts, "death:batch")
        else:
            deduplicated.append((ts, etype))

    results = []
    prev_n_active = None
    for i, (ts, etype) in enumerate(deduplicated):
        row = snapshot_at(ts, i + 1, etype if not etype.startswith("death:") else "death")
        if row is None:
            continue
        # Skip regen ticks where population didn't change (noise reduction)
        if etype == "regen" and row["n_active"] == prev_n_active:
            continue
        prev_n_active = row["n_active"]
        results.append(row)

    return results


def lineage_summary(run: dict) -> dict:
    """
    Top-level lineage stats for the whole run.

    "Active" agents are determined from metrics (ran at least one cycle),
    not from the census active flag (which can be stale).
    "Surviving" at end-of-run = had a cycle in the final 10% of the run's duration.
    """
    census = run["census"]
    census_map = {c["id"]: c for c in census}

    n_total = len(census)
    n_gen0 = sum(1 for c in census if c.get("generation", 0) == 0)
    max_generation = max((c.get("generation", 0) for c in census), default=0)
    total_solved = sum(c.get("challengesSolved", 0) for c in census)

    # Determine "end of run" timestamp from last metric across all agents
    # (pool ledger can lag behind agents that were mid-cycle at termination)
    first_t = run["pool_ledger"][0]["t"] if run["pool_ledger"] else ""
    all_metric_ts = [
        m.get("timestamp", "")
        for agent in run["agents"].values()
        for m in agent["metrics"]
        if m.get("timestamp")
    ]
    last_t = max(all_metric_ts) if all_metric_ts else (run["pool_ledger"][-1]["t"] if run["pool_ledger"] else "")

    # Agents that had a metric in the last 20% of the run duration
    from datetime import datetime, timezone, timedelta
    surviving_ids: list[str] = []
    if first_t and last_t:
        try:
            t0 = datetime.fromisoformat(first_t.replace("Z", "+00:00"))
            t1 = datetime.fromisoformat(last_t.replace("Z", "+00:00"))
            duration = t1 - t0
            cutoff = (t1 - duration * 0.20).isoformat().replace("+00:00", "Z")
            for agent_id, agent in run["agents"].items():
                if any(m.get("timestamp", "") >= cutoff for m in agent["metrics"]):
                    surviving_ids.append(agent_id)
        except Exception:
            pass

    # Active agents by generation (from metrics, not census)
    active_by_gen: dict[int, int] = defaultdict(int)
    for agent_id in surviving_ids:
        gen = census_map.get(agent_id, {}).get("generation", 0)
        active_by_gen[gen] += 1

    def find_root(agent_id: str) -> str:
        seen = set()
        current = census_map.get(agent_id)
        while current and current.get("sourceId"):
            if current["id"] in seen:
                return agent_id
            seen.add(current["id"])
            parent = census_map.get(current["sourceId"])
            if parent is None:
                return current.get("sourceId", agent_id)
            current = parent
        return current["id"] if current else agent_id

    roots: set[str] = {find_root(aid) for aid in surviving_ids}

    return {
        "n_total_agents": n_total,
        "n_gen0_agents": n_gen0,
        "max_generation": max_generation,
        "n_surviving_end_of_run": len(surviving_ids),
        "total_challenges_solved": total_solved,
        "surviving_by_generation": dict(active_by_gen),
        "n_distinct_founders_surviving": len(roots),
        "monoculture": len(roots) == 1,
        "dominant_founder": list(roots)[0] if len(roots) == 1 else None,
    }
