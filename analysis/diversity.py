"""
Population diversity metrics over time.

Computes:
  - Simpson diversity index per global time-step
  - Shannon entropy per global time-step
  - Bedau activity classification (Class 1-4) per agent
  - MODES-style scores: change, novelty, complexity, ecological potential
  - Phenotype trajectory per agent
"""

from __future__ import annotations
import math
from collections import defaultdict
from .load import phenotype_vector, euclidean, parse_memory_op


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _discretize(vec: list[float], bins: int = 3) -> tuple:
    """Bin each dimension into `bins` equal buckets (0, 1, 2) to form a discrete phenotype label."""
    # Rough ranges per dimension: mem counts 0-10, promptVersion 0-15, tools 0-6, difficulty 0-5, drives 0-1
    ranges = [10, 10, 10, 15, 6, 5, 1, 1, 1, 1]
    result = []
    for v, r in zip(vec, ranges):
        bucket = int(v / r * bins) if r > 0 else 0
        result.append(min(bucket, bins - 1))
    return tuple(result)


def _change_score(seq: list[list[float]]) -> float:
    """Mean Euclidean distance between consecutive phenotype vectors."""
    if len(seq) < 2:
        return 0.0
    dists = [euclidean(seq[i], seq[i + 1]) for i in range(len(seq) - 1)]
    return sum(dists) / len(dists)


def _novelty_score(seq: list[list[float]]) -> float:
    """
    Mean distance of each phenotype from the running historical mean up to that point.
    High novelty = agent keeps moving into unexplored phenotype territory.
    """
    if len(seq) < 2:
        return 0.0
    scores = []
    for i in range(1, len(seq)):
        history = seq[:i]
        mean = [sum(h[d] for h in history) / len(history) for d in range(len(seq[0]))]
        scores.append(euclidean(seq[i], mean))
    return sum(scores) / len(scores)


def _entropy_of_sequence(seq: list[tuple]) -> float:
    """Shannon entropy of a discrete sequence."""
    counts: dict[tuple, int] = defaultdict(int)
    for item in seq:
        counts[item] += 1
    n = len(seq)
    return -sum((c / n) * math.log2(c / n) for c in counts.values() if c > 0)


# ---------------------------------------------------------------------------
# Per-agent Bedau activity classification
# ---------------------------------------------------------------------------

def bedau_classify(phenotype_seq: list[list[float]]) -> str:
    """
    Classify an agent's phenotype trajectory using Bedau activity heuristics.

    Class 1 — Extinct/stillborn: no trajectory (0 or 1 cycles)
    Class 2 — Fixed: phenotype never changes (change_score ≈ 0)
    Class 3 — Fading: change score declines over time (agent adapts then freezes)
    Class 4 — Persistent: change score is sustained or growing

    Returns one of: "extinct", "fixed", "fading", "persistent"
    """
    if len(phenotype_seq) < 2:
        return "extinct"

    if len(phenotype_seq) < 4:
        c = _change_score(phenotype_seq)
        return "fixed" if c < 0.1 else "persistent"

    # Split into first and second halves
    mid = len(phenotype_seq) // 2
    first_half = phenotype_seq[:mid]
    second_half = phenotype_seq[mid:]

    c_first = _change_score(first_half)
    c_second = _change_score(second_half)
    total = _change_score(phenotype_seq)

    if total < 0.05:
        return "fixed"
    if c_second < c_first * 0.4:   # second half changes < 40% as much as first
        return "fading"
    return "persistent"


def agent_activity_stats(agent: dict) -> dict:
    """
    Compute per-agent activity statistics from its metrics list.

    Returns:
      {
        agent_id, generation, cycles, survived_cycles, challenges_solved,
        bedau_class, change_score, novelty_score, complexity,
        prompt_rewrite_count, fork_count, total_stores, total_forgets,
        crystallization_rate (procedural stores / total stores),
      }
    """
    metrics = agent["metrics"]
    if not metrics:
        return {}

    agent_id = metrics[0].get("agentId", "unknown")
    census_entry = agent.get("census_entry", {})
    generation = census_entry.get("generation", metrics[0].get("fingerprint", {}).get("generation", 0))

    phenotypes = [phenotype_vector(m.get("fingerprint", {})) for m in metrics]

    # Memory ops aggregation
    rewrite_count = 0
    stores_total = 0
    stores_procedural = 0
    forgets = 0
    consolidations = 0

    for m in metrics:
        for op_str in m.get("memoryOps", []):
            op = parse_memory_op(op_str)
            if op["action"] == "rewrote":
                rewrite_count += 1
            elif op["action"] == "stored":
                stores_total += 1
                if op.get("type") == "procedural":
                    stores_procedural += 1
            elif op["action"] == "forgot":
                forgets += 1
            elif op["action"] == "consolidated":
                consolidations += 1

    crystallization_rate = stores_procedural / stores_total if stores_total > 0 else 0.0

    outcomes = [m.get("outcome", "failure") for m in metrics]
    challenges_solved = max((m.get("fingerprint", {}).get("challengesSolved", 0) for m in metrics), default=0)

    return {
        "agent_id": agent_id,
        "generation": generation,
        "cycles": len(metrics),
        "challenges_solved": challenges_solved,
        "bedau_class": bedau_classify(phenotypes),
        "change_score": round(_change_score(phenotypes), 4),
        "novelty_score": round(_novelty_score(phenotypes), 4),
        "complexity": round(_entropy_of_sequence([_discretize(p) for p in phenotypes]), 4),
        "prompt_rewrite_count": rewrite_count,
        "total_stores": stores_total,
        "stores_procedural": stores_procedural,
        "total_forgets": forgets,
        "consolidations": consolidations,
        "crystallization_rate": round(crystallization_rate, 4),
        "outcomes": {
            "success": outcomes.count("success"),
            "partial": outcomes.count("partial"),
            "failure": outcomes.count("failure"),
        },
    }


# ---------------------------------------------------------------------------
# Population-level diversity over time
# ---------------------------------------------------------------------------

def _agents_active_at(run: dict, timestamp: str) -> list[str]:
    """Return agent IDs that had at least one cycle before or at `timestamp`."""
    active = []
    for agent_id, agent in run["agents"].items():
        for m in agent["metrics"]:
            if m.get("timestamp", "") <= timestamp:
                active.append(agent_id)
                break
    return active


def population_diversity_over_cycles(run: dict) -> list[dict]:
    """
    Compute per-global-cycle population diversity.

    For each global cycle N, take the most recent fingerprint from each
    agent that has run at least one cycle, and compute:
      - n_active: number of active agents
      - simpson: Simpson diversity index (phenotype buckets)
      - shannon: Shannon entropy (phenotype buckets)
      - mean_pairwise_distance: average Euclidean distance across all pairs
      - dominant_lineage_pct: fraction of active agents from the most common source lineage

    Returns list sorted by global_cycle.
    """
    # Build a mapping: global_cycle -> {agent_id -> latest phenotype at or before that cycle}
    # Use pool_ledger regen events to identify global cycle boundaries
    regen_events = [e for e in run["pool_ledger"] if e["type"] == "regen"]

    if not regen_events:
        return []

    results = []

    for i, regen in enumerate(regen_events):
        t = regen["t"]
        n_active = regen.get("activeAgents", 0)

        # Gather most recent phenotype for each agent before this timestamp
        phenotypes: list[list[float]] = []
        agent_sources: list[str] = []

        for agent_id, agent in run["agents"].items():
            # Find latest metric before timestamp t
            latest = None
            for m in agent["metrics"]:
                if m.get("timestamp", "") <= t:
                    latest = m
                else:
                    break
            if latest is None:
                continue
            fp = latest.get("fingerprint", {})
            if not fp:
                continue
            phenotypes.append(phenotype_vector(fp))

            # Source for lineage tracking
            gen = fp.get("generation", 0)
            agent_sources.append(agent_id if gen == 0 else agent_id)

        if len(phenotypes) < 2:
            continue

        # Simpson diversity
        labels = [_discretize(p) for p in phenotypes]
        label_counts: dict[tuple, int] = defaultdict(int)
        for lbl in labels:
            label_counts[lbl] += 1
        n = len(labels)
        simpson = 1.0 - sum(c * (c - 1) for c in label_counts.values()) / (n * (n - 1)) if n > 1 else 0.0

        # Shannon entropy
        shannon = -sum((c / n) * math.log2(c / n) for c in label_counts.values() if c > 0)

        # Mean pairwise Euclidean distance
        pairs = 0
        dist_sum = 0.0
        for a in range(len(phenotypes)):
            for b in range(a + 1, len(phenotypes)):
                dist_sum += euclidean(phenotypes[a], phenotypes[b])
                pairs += 1
        mean_dist = dist_sum / pairs if pairs > 0 else 0.0

        # Dominant lineage fraction
        # Use census to find generation-0 source for each agent
        lineage_counts: dict[str | None, int] = defaultdict(int)
        census_map = {c["id"]: c for c in run["census"]}
        for agent_id in run["agents"]:
            # Walk up the lineage to find gen-0 ancestor
            current = census_map.get(agent_id)
            if current is None:
                continue
            # Check if agent was active (had a metric before timestamp t)
            agent = run["agents"][agent_id]
            if not any(m.get("timestamp", "") <= t for m in agent["metrics"]):
                continue
            # Find root ancestor
            root = current
            seen = set()
            while root.get("sourceId") and root["sourceId"] not in seen:
                seen.add(root.get("id"))
                parent = census_map.get(root["sourceId"])
                if parent is None:
                    break
                root = parent
            lineage_counts[root.get("id")] += 1

        dominant_lineage_pct = max(lineage_counts.values()) / sum(lineage_counts.values()) if lineage_counts else 0.0

        results.append({
            "global_cycle": i + 1,
            "timestamp": t,
            "n_active": n_active,
            "n_with_phenotype": n,
            "simpson": round(simpson, 4),
            "shannon": round(shannon, 4),
            "mean_pairwise_distance": round(mean_dist, 4),
            "dominant_lineage_pct": round(dominant_lineage_pct, 4),
            "n_phenotype_clusters": len(label_counts),
        })

    return results


# ---------------------------------------------------------------------------
# MODES-style population score
# ---------------------------------------------------------------------------

def modes_scores(run: dict) -> dict:
    """
    Compute MODES-style aggregate scores for the entire run.

    - change:    mean per-agent change score (avg phenotype drift across cycles)
    - novelty:   mean per-agent novelty score (avg distance from historical mean)
    - complexity: mean per-agent phenotype sequence entropy
    - ecological_potential: number of distinct phenotype clusters ever occupied
    - bedau_distribution: {class: count}
    """
    per_agent = []
    all_phenotypes: list[tuple] = []

    for agent_id, agent in run["agents"].items():
        # Find census entry for generation
        census_map = {c["id"]: c for c in run["census"]}
        agent["census_entry"] = census_map.get(agent_id, {})

        stats = agent_activity_stats(agent)
        if stats:
            per_agent.append(stats)

        for m in agent["metrics"]:
            fp = m.get("fingerprint", {})
            if fp:
                all_phenotypes.append(_discretize(phenotype_vector(fp)))

    if not per_agent:
        return {}

    bedau_dist: dict[str, int] = defaultdict(int)
    for s in per_agent:
        bedau_dist[s["bedau_class"]] += 1

    return {
        "change": round(sum(s["change_score"] for s in per_agent) / len(per_agent), 4),
        "novelty": round(sum(s["novelty_score"] for s in per_agent) / len(per_agent), 4),
        "complexity": round(sum(s["complexity"] for s in per_agent) / len(per_agent), 4),
        "ecological_potential": len(set(all_phenotypes)),
        "bedau_distribution": dict(bedau_dist),
        "n_agents": len(per_agent),
        "mean_crystallization_rate": round(
            sum(s["crystallization_rate"] for s in per_agent) / len(per_agent), 4
        ),
        "mean_challenges_per_agent": round(
            sum(s["challenges_solved"] for s in per_agent) / len(per_agent), 2
        ),
    }
