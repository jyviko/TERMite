"""
Pool dynamics analysis.

Computes:
  - Carrying capacity curve (pool balance + active agents over time)
  - Cooperation / exploitation rate per agent
  - Gini coefficient of withdrawals (resource inequality)
  - Depletion events and pool pressure
  - Net flow (withdraw vs regen vs deposit) over time
"""

from __future__ import annotations
from collections import defaultdict


def carrying_capacity_curve(pool_ledger: list[dict]) -> list[dict]:
    """
    Build a time-series of pool state from the ledger.

    Each entry: {timestamp, type, amount, balance, active_agents, regen_rate, agent_id}

    Returns all events in order, enriched with cumulative stats.
    """
    cumulative_withdrawn = 0
    cumulative_deposited = 0
    cumulative_regen = 0

    rows = []
    for event in pool_ledger:
        t = event["type"]
        if t == "withdraw":
            cumulative_withdrawn += event.get("amount", 0)
        elif t == "deposit":
            cumulative_deposited += event.get("amount", 0)
        elif t == "regen":
            cumulative_regen += event.get("amount", 0)

        rows.append({
            "timestamp": event.get("t", ""),
            "type": t,
            "amount": event.get("amount", 0),
            "balance": event.get("balance", 0),
            "active_agents": event.get("activeAgents"),
            "regen_rate": event.get("regenRate"),
            "agent_id": event.get("agentId"),
            "cumulative_withdrawn": cumulative_withdrawn,
            "cumulative_deposited": cumulative_deposited,
            "cumulative_regen": cumulative_regen,
            "net_extraction": cumulative_withdrawn - cumulative_deposited - cumulative_regen,
        })
    return rows


def per_agent_pool_stats(pool_ledger: list[dict]) -> dict[str, dict]:
    """
    Aggregate pool interactions per agent.

    Returns {agent_id: {total_withdrawn, total_deposited, n_withdrawals, n_deposits, net}}
    """
    stats: dict[str, dict] = defaultdict(lambda: {
        "total_withdrawn": 0,
        "total_deposited": 0,
        "n_withdrawals": 0,
        "n_deposits": 0,
    })

    for event in pool_ledger:
        aid = event.get("agentId")
        if not aid:
            continue
        t = event["type"]
        amount = event.get("amount", 0)
        if t == "withdraw":
            stats[aid]["total_withdrawn"] += amount
            stats[aid]["n_withdrawals"] += 1
        elif t == "deposit":
            stats[aid]["total_deposited"] += amount
            stats[aid]["n_deposits"] += 1

    for aid, s in stats.items():
        s["net"] = s["total_withdrawn"] - s["total_deposited"]

    return dict(stats)


def gini_coefficient(values: list[float]) -> float:
    """Gini coefficient of a distribution. 0 = perfect equality, 1 = complete inequality."""
    if not values or sum(values) == 0:
        return 0.0
    n = len(values)
    sorted_vals = sorted(values)
    cumsum = 0.0
    for i, v in enumerate(sorted_vals):
        cumsum += (2 * (i + 1) - n - 1) * v
    return cumsum / (n * sum(sorted_vals))


def pool_summary_stats(pool_ledger: list[dict], census: list[dict]) -> dict:
    """
    Compute aggregate pool metrics for the whole run.

    Returns:
      {
        total_withdrawn, total_deposited, total_regen,
        net_extraction,            # withdrawn - deposited - regen (should be ~0 if sustainable)
        gini_withdrawals,          # inequality of resource extraction
        cooperation_events,        # deposit events (agent returning resources)
        exploitation_events,       # withdraw events
        peak_active_agents,
        pool_pressure_curve: [...]  # balance as fraction of max over time
      }
    """
    per_agent = per_agent_pool_stats(pool_ledger)

    total_withdrawn = sum(s["total_withdrawn"] for s in per_agent.values())
    total_deposited = sum(s["total_deposited"] for s in per_agent.values())
    total_regen = sum(e["amount"] for e in pool_ledger if e["type"] == "regen")

    withdrawal_amounts = [s["total_withdrawn"] for s in per_agent.values() if s["total_withdrawn"] > 0]
    gini = gini_coefficient(withdrawal_amounts)

    max_balance = max((e.get("balance", 0) for e in pool_ledger), default=1)
    peak_active = max(
        (e.get("activeAgents", 0) for e in pool_ledger if e.get("activeAgents") is not None),
        default=0,
    )

    # Pool pressure: fraction of balance that was actually used (how close to zero it got)
    min_balance = min((e.get("balance", max_balance) for e in pool_ledger), default=max_balance)
    pool_pressure = 1.0 - (min_balance / max_balance) if max_balance > 0 else 0.0

    return {
        "total_withdrawn": total_withdrawn,
        "total_deposited": total_deposited,
        "total_regen": total_regen,
        "net_extraction": total_withdrawn - total_deposited - total_regen,
        "gini_withdrawals": round(gini, 4),
        "n_agents_extracted": len(withdrawal_amounts),
        "n_agents_returned": sum(1 for s in per_agent.values() if s["total_deposited"] > 0),
        "cooperation_rate": round(
            sum(1 for s in per_agent.values() if s["total_deposited"] > 0) / len(per_agent)
            if per_agent else 0.0,
            4,
        ),
        "peak_active_agents": peak_active,
        "pool_pressure": round(pool_pressure, 4),
        "min_balance": min_balance,
        "max_balance": max_balance,
        "n_withdraw_events": sum(e["type"] == "withdraw" for e in pool_ledger),
        "n_regen_events": sum(e["type"] == "regen" for e in pool_ledger),
        "n_deposit_events": sum(e["type"] == "deposit" for e in pool_ledger),
    }
