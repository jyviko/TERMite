"""
Challenge difficulty analysis.

Computes:
  - Preferred difficulty decay: how agent ambition shifts over the run
  - Actual solve difficulty: which tiers were solved vs expired, and when
  - Ambition-execution gap: preferred difficulty vs actual solved tier
  - Cumulative weighted difficulty: total difficulty × solves over time
"""

from __future__ import annotations
from collections import defaultdict
from datetime import datetime, timedelta


# ---------------------------------------------------------------------------
# Preferred difficulty over time (from fingerprints, full coverage)
# ---------------------------------------------------------------------------

def preferred_difficulty_over_time(run: dict) -> list[dict]:
    """
    At each significant population event (regen or death), compute the
    distribution of preferredDifficulty across active agents (120s window).

    preferredDifficulty is 1-5 and reflects what tier the agent targets.
    Decay = mean preferred difficulty trending downward over time as
    harder-targeting agents die.
    """
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
        t_dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        t_early = (t_dt - timedelta(seconds=120)).isoformat().replace("+00:00", "Z")

        difficulties = []
        for agent in run["agents"].values():
            latest = None
            for m in agent["metrics"]:
                mts = m.get("timestamp", "")
                if t_early <= mts <= ts:
                    latest = m
            if latest is None:
                continue
            fp = latest.get("fingerprint", {})
            d = fp.get("preferredDifficulty")
            if d is not None:
                difficulties.append(d)

        n = len(difficulties)
        if n == 0:
            continue

        label = etype if not etype.startswith("death:") else "death"
        if etype == "regen" and n == prev_n:
            continue
        prev_n = n

        tier_dist = defaultdict(int)
        for d in difficulties:
            tier_dist[int(d)] += 1

        results.append({
            "global_cycle": i + 1,
            "timestamp": ts,
            "event_type": label,
            "n_active": n,
            "mean_preferred_difficulty": round(sum(difficulties) / n, 4),
            "min_preferred_difficulty": min(difficulties),
            "max_preferred_difficulty": max(difficulties),
            "tier_distribution": dict(sorted(tier_dist.items())),
        })

    return results


# ---------------------------------------------------------------------------
# Actual challenge solve difficulty (from _state.json)
# ---------------------------------------------------------------------------

def challenge_solve_stats(run: dict) -> list[dict]:
    """
    For each challenge in _state.json, report difficulty, timing, solve count,
    and the first agent to solve it.

    Limitations: challenges evicted before run end are not in _state.json.
    """
    state = run.get("challenge_state", {})
    challenges = state.get("challenges", [])
    if not challenges:
        return []

    # Build agent metric index: agent_id -> sorted metrics by timestamp
    agent_metrics: dict[str, list[dict]] = {
        aid: sorted(a["metrics"], key=lambda m: m.get("timestamp", ""))
        for aid, a in run["agents"].items()
    }

    rows = []
    for ch in challenges:
        ch_id = ch["id"]
        difficulty = ch.get("difficulty", 0)
        category = ch.get("category", "")
        base_reward = ch.get("baseReward", 0)
        appeared = ch.get("appearedAtCycle", 0)
        expires = ch.get("expiresAtCycle", 0)
        solved_by = ch.get("solvedBy", [])
        n_solves = len(solved_by)
        first_solver = solved_by[0] if solved_by else None

        # Approximate first-solve timestamp: first metric where income >= base_reward
        # for any agent in solvedBy (rough proxy)
        first_solve_ts = None
        if first_solver and first_solver in agent_metrics:
            for m in agent_metrics[first_solver]:
                if m.get("income", 0) >= base_reward * 0.8:
                    first_solve_ts = m.get("timestamp")
                    break

        rows.append({
            "challenge_id": ch_id,
            "difficulty": difficulty,
            "category": category,
            "base_reward": base_reward,
            "appeared_at_cycle": appeared,
            "expires_at_cycle": expires,
            "n_solves": n_solves,
            "solved": n_solves > 0,
            "first_solver": first_solver,
            "first_solve_timestamp": first_solve_ts,
        })

    rows.sort(key=lambda r: r["appeared_at_cycle"])
    return rows


# ---------------------------------------------------------------------------
# Reward decay over time
# ---------------------------------------------------------------------------

def reward_decay_over_time(run: dict) -> list[dict]:
    """
    At each significant population event (regen or death), compute the
    mean income and solve rate of active agents in the preceding 120s window.

    Shows whether agents earn less per cycle as the run progresses — reward decay.

    Also includes mean pool withdrawal per regen tick as a pool-side measure.
    """
    from datetime import datetime, timedelta

    # Pre-index pool withdrawals by timestamp for regen-tick averaging
    pool_withdrawals: list[tuple[str, int]] = [
        (e["t"], e["amount"])
        for e in run["pool_ledger"]
        if e["type"] == "withdraw"
    ]

    # Build event list (same as other time-series)
    events: list[tuple[str, str]] = []
    for e in run["pool_ledger"]:
        if e["type"] == "regen":
            events.append((e["t"], "regen"))
    for agent_id, agent in run["agents"].items():
        timestamps = [m.get("timestamp", "") for m in agent["metrics"] if m.get("timestamp")]
        if timestamps:
            events.append((max(timestamps), f"death:{agent_id}"))

    events.sort(key=lambda x: x[0])

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
        t_dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        t_early = (t_dt - timedelta(seconds=120)).isoformat().replace("+00:00", "Z")

        incomes, costs, nets = [], [], []
        n_success, n_partial, n_failure = 0, 0, 0

        for agent in run["agents"].values():
            for m in agent["metrics"]:
                mts = m.get("timestamp", "")
                if t_early <= mts <= ts:
                    incomes.append(m.get("income", 0))
                    costs.append(m.get("cost", 0))
                    nets.append(m.get("net", 0))
                    outcome = m.get("outcome", "failure")
                    if outcome == "success":
                        n_success += 1
                    elif outcome == "partial":
                        n_partial += 1
                    else:
                        n_failure += 1

        n_cycles = len(incomes)
        if n_cycles == 0:
            continue

        label = etype if not etype.startswith("death:") else "death"
        if etype == "regen" and n_cycles == prev_n:
            continue
        prev_n = n_cycles

        # Pool withdrawals in this window
        window_withdrawals = [amt for wts, amt in pool_withdrawals if t_early <= wts <= ts]
        mean_withdrawal = sum(window_withdrawals) / len(window_withdrawals) if window_withdrawals else 0

        def mean(lst): return sum(lst) / len(lst) if lst else 0

        results.append({
            "global_cycle": i + 1,
            "timestamp": ts,
            "event_type": label,
            "n_cycles": n_cycles,
            "mean_income": round(mean(incomes)),
            "mean_cost": round(mean(costs)),
            "mean_net": round(mean(nets)),
            "total_income": sum(incomes),
            "solve_rate": round(n_success / n_cycles, 4),
            "partial_rate": round(n_partial / n_cycles, 4),
            "failure_rate": round(n_failure / n_cycles, 4),
            "n_pool_withdrawals": len(window_withdrawals),
            "mean_pool_withdrawal": round(mean_withdrawal),
        })

    return results


# ---------------------------------------------------------------------------
# Difficulty decay summary
# ---------------------------------------------------------------------------

def difficulty_decay_summary(preferred_over_time: list[dict]) -> dict:
    """
    Summarize the difficulty decay trend from the preferred_difficulty_over_time series.

    Returns:
      - initial_mean: mean preferred difficulty in first 20% of events
      - final_mean: mean preferred difficulty in last 20% of events
      - decay: initial_mean - final_mean (positive = decay, negative = growth)
      - decay_pct: decay as fraction of initial_mean
      - monotone_decline: True if difficulty never increased after first drop
    """
    if not preferred_over_time:
        return {}

    n = len(preferred_over_time)
    window = max(1, n // 5)

    initial = [r["mean_preferred_difficulty"] for r in preferred_over_time[:window]]
    final = [r["mean_preferred_difficulty"] for r in preferred_over_time[-window:]]

    initial_mean = sum(initial) / len(initial)
    final_mean = sum(final) / len(final)
    decay = round(initial_mean - final_mean, 4)

    # Check for monotone decline after peak
    means = [r["mean_preferred_difficulty"] for r in preferred_over_time]
    peak_idx = means.index(max(means))
    post_peak = means[peak_idx:]
    monotone = all(post_peak[i] >= post_peak[i + 1] for i in range(len(post_peak) - 1))

    return {
        "initial_mean_difficulty": round(initial_mean, 4),
        "final_mean_difficulty": round(final_mean, 4),
        "decay": decay,
        "decay_pct": round(decay / initial_mean, 4) if initial_mean > 0 else 0.0,
        "peak_difficulty": round(max(means), 4),
        "peak_at_event": peak_idx + 1,
        "monotone_decline_after_peak": monotone,
        "n_events": n,
    }
