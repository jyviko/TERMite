"""
CLI entry point.

Usage:
  python -m analysis.run <run_dir> [--out <output_dir>]
  python -m analysis.run arena-workspace/run-2026-02-28T01-14-56
  python -m analysis.run arena-workspace/run-2026-02-28T01-14-56 --out paper/data/run1
"""

from __future__ import annotations
import argparse
import sys
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Compute emergence metrics from a TERM-ITE arena run."
    )
    parser.add_argument("run_dir", help="Path to the run directory")
    parser.add_argument("--out", help="Output directory (default: <run_dir>/analysis)")
    args = parser.parse_args()

    run_dir = Path(args.run_dir)
    if not run_dir.exists():
        print(f"Error: run directory not found: {run_dir}", file=sys.stderr)
        sys.exit(1)

    from .report import generate
    output_dir = generate(run_dir, args.out)

    # Print key metrics to stdout for quick review
    import json
    summary = json.loads((output_dir / "summary.json").read_text())

    print("\n=== KEY METRICS ===\n")

    modes = summary.get("modes", {})
    print("MODES scores:")
    print(f"  change:               {modes.get('change', 'N/A')}")
    print(f"  novelty:              {modes.get('novelty', 'N/A')}")
    print(f"  complexity:           {modes.get('complexity', 'N/A')}")
    print(f"  ecological_potential: {modes.get('ecological_potential', 'N/A')}")
    print(f"  bedau_distribution:   {modes.get('bedau_distribution', {})}")

    pool = summary.get("pool", {})
    print("\nPool dynamics:")
    print(f"  total_withdrawn:   {pool.get('total_withdrawn', 0):,}")
    print(f"  total_regen:       {pool.get('total_regen', 0):,}")
    print(f"  total_deposited:   {pool.get('total_deposited', 0):,}")
    print(f"  gini_withdrawals:  {pool.get('gini_withdrawals', 'N/A')}")
    print(f"  cooperation_rate:  {pool.get('cooperation_rate', 'N/A')}")
    print(f"  pool_pressure:     {pool.get('pool_pressure', 'N/A')}")

    lin = summary.get("lineage", {})
    print("\nLineage:")
    print(f"  n_agents:                    {lin.get('n_total_agents', 0)}")
    print(f"  max_generation:              {lin.get('max_generation', 0)}")
    print(f"  n_surviving_end_of_run:      {lin.get('n_surviving_end_of_run', 0)}")
    print(f"  surviving_by_generation:     {lin.get('surviving_by_generation', {})}")
    print(f"  n_distinct_founders_surviving: {lin.get('n_distinct_founders_surviving', 0)}")
    print(f"  monoculture:                 {lin.get('monoculture', False)}")
    print(f"  dominant_founder:            {lin.get('dominant_founder', 'None')}")
    print(f"  total_solved:                {lin.get('total_challenges_solved', 0)}")

    # Founder dominance trajectory summary
    fd = summary.get("final_founder_dominance", {})
    if fd:
        print(f"\nFounder convergence (end of run):")
        print(f"  n_active:                 {fd.get('n_active', 0)}")
        print(f"  n_founders_represented:   {fd.get('n_founders_represented', 0)}")
        print(f"  dominant_founder_pct:     {fd.get('dominant_founder_pct', 0)}")

    final_div = summary.get("final_diversity", {})
    if final_div:
        print("\nFinal diversity snapshot:")
        print(f"  simpson:                {final_div.get('simpson', 'N/A')}")
        print(f"  shannon:                {final_div.get('shannon', 'N/A')}")
        print(f"  dominant_lineage_pct:   {final_div.get('dominant_lineage_pct', 'N/A')}")
        print(f"  n_phenotype_clusters:   {final_div.get('n_phenotype_clusters', 'N/A')}")

    final_mem = summary.get("final_memory", {})
    if final_mem:
        print("\nFinal memory composition (per agent avg):")
        print(f"  mean_episodic:    {final_mem.get('mean_episodic', 'N/A')}")
        print(f"  mean_semantic:    {final_mem.get('mean_semantic', 'N/A')}")
        print(f"  mean_procedural:  {final_mem.get('mean_procedural', 'N/A')}")
        print(f"  mean_crystallization: {final_mem.get('mean_crystallization', 'N/A')}")


if __name__ == "__main__":
    main()
