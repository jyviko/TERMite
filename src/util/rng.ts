/**
 * Seedable PRNG based on xoshiro128** — fast, well-distributed, deterministic.
 * Drop-in replacement for Math.random() in environment components.
 */

export class SeededRng {
  private s: Uint32Array;

  constructor(seed: number) {
    // SplitMix32 to expand a single integer seed into 4 state words
    this.s = new Uint32Array(4);
    let z = seed >>> 0;
    for (let i = 0; i < 4; i++) {
      z = (z + 0x9e3779b9) >>> 0;
      let t = z ^ (z >>> 16);
      t = Math.imul(t, 0x21f0aaad);
      t = (t ^ (t >>> 15)) >>> 0;
      t = Math.imul(t, 0x735a2d97);
      t = (t ^ (t >>> 15)) >>> 0;
      this.s[i] = t;
    }
  }

  /** Returns a float in [0, 1) — same contract as Math.random(). */
  random(): number {
    const s = this.s;
    const result = Math.imul(s[1]! * 5, 7) >>> 0;
    const t = (s[1]! << 9) >>> 0;

    s[2]! ^= s[0]!;
    s[3]! ^= s[1]!;
    s[1]! ^= s[2]!;
    s[0]! ^= s[3]!;

    s[2]! ^= t;
    s[3] = ((s[3]! << 11) | (s[3]! >>> 21)) >>> 0;

    return (result >>> 0) / 0x100000000;
  }

  /** Returns an integer in [min, max] inclusive. */
  randomInt(min: number, max: number): number {
    return Math.floor(this.random() * (max - min + 1)) + min;
  }

  /** Create a child RNG from a derived seed — useful for forked subcomponents. */
  fork(): SeededRng {
    return new SeededRng(this.s[0]! ^ this.s[3]!);
  }
}
