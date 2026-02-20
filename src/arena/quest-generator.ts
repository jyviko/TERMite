import { randomUUID } from "node:crypto";
import type { Quest } from "../types/index.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

interface QuestTemplate {
  title: string;
  description: string;
  verifyScript: string;
  dataGenerator?: () => Record<string, string>;
}

// Rewards in TEQ (token equivalents). Calibrated so:
// - Tier 1-2: organism bleeds slowly (covers 50-75% of cycle cost)
// - Tier 3: break-even threshold
// - Tier 4+: net-positive, enabling surplus and reproduction
const TIER_REWARDS: Record<number, number> = {
  1: 10000,
  2: 15000,
  3: 25000,
  4: 40000,
  5: 60000,
  6: 90000,
  7: 125000,
  8: 175000,
  9: 250000,
  10: 375000,
};

const TIER_DEADLINES: Record<number, number> = {
  1: 5,
  2: 8,
  3: 10,
  4: 15,
  5: 20,
  6: 30,
  7: 40,
  8: 50,
  9: 60,
  10: 80,
};

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateNumbers(count: number, max: number): string {
  return Array.from({ length: count }, () => randomInt(1, max)).join("\n");
}

const TIER_TEMPLATES: Record<number, QuestTemplate[]> = {
  1: [
    {
      title: "Hello World",
      description:
        'Write a file at /workspace/output/greeting.txt containing exactly: Hello, World!',
      verifyScript: `#!/bin/bash
EXPECTED="Hello, World!"
ACTUAL=$(cat /workspace/output/greeting.txt 2>/dev/null)
if [ "$ACTUAL" = "$EXPECTED" ]; then echo "PASS"; exit 0; else echo "FAIL: expected '$EXPECTED', got '$ACTUAL'"; exit 1; fi`,
    },
    {
      title: "Count Lines",
      description:
        "Count the lines in /workspace/quests/data/numbers.txt and write the count to /workspace/output/count.txt",
      verifyScript: `#!/bin/bash
EXPECTED=$(wc -l < /workspace/quests/data/numbers.txt | tr -d ' ')
ACTUAL=$(cat /workspace/output/count.txt 2>/dev/null | tr -d '[:space:]')
if [ "$ACTUAL" = "$EXPECTED" ]; then echo "PASS"; exit 0; else echo "FAIL: expected $EXPECTED lines, got '$ACTUAL'"; exit 1; fi`,
      dataGenerator: () => ({
        "numbers.txt": generateNumbers(randomInt(10, 50), 1000),
      }),
    },
  ],
  2: [
    {
      title: "Sort Numbers",
      description:
        "Sort the numbers in /workspace/quests/data/numbers.txt ascending (one per line), write to /workspace/output/sorted.txt",
      verifyScript: `#!/bin/bash
EXPECTED=$(sort -n /workspace/quests/data/numbers.txt)
ACTUAL=$(cat /workspace/output/sorted.txt 2>/dev/null)
if [ "$EXPECTED" = "$ACTUAL" ]; then echo "PASS"; exit 0; else echo "FAIL: output does not match sorted input"; exit 1; fi`,
      dataGenerator: () => ({
        "numbers.txt": generateNumbers(randomInt(15, 40), 10000),
      }),
    },
    {
      title: "Extract Emails",
      description:
        "Extract all email addresses from /workspace/quests/data/contacts.txt (one per line), write to /workspace/output/emails.txt",
      verifyScript: `#!/bin/bash
EXPECTED=$(grep -oE '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}' /workspace/quests/data/contacts.txt | sort)
ACTUAL=$(sort /workspace/output/emails.txt 2>/dev/null)
if [ "$EXPECTED" = "$ACTUAL" ]; then echo "PASS"; exit 0; else echo "FAIL: extracted emails don't match"; exit 1; fi`,
      dataGenerator: () => {
        const names = ["alice", "bob", "charlie", "diana", "eve"];
        const domains = ["example.com", "test.org", "mail.io"];
        const lines = Array.from({ length: randomInt(5, 15) }, (_, i) => {
          const name = names[i % names.length]!;
          const domain = domains[i % domains.length]!;
          return `Contact: ${name} - email: ${name}${i}@${domain} - phone: 555-${randomInt(1000, 9999)}`;
        });
        return { "contacts.txt": lines.join("\n") };
      },
    },
  ],
  3: [
    {
      title: "Parse Error Logs",
      description:
        "Parse /workspace/quests/data/access.log: extract timestamps (first field) from lines where HTTP status >= 500, write to /workspace/output/errors.txt (one per line)",
      verifyScript: `#!/bin/bash
EXPECTED=$(awk '$9 >= 500 {print $1}' /workspace/quests/data/access.log | sort)
ACTUAL=$(sort /workspace/output/errors.txt 2>/dev/null)
if [ "$EXPECTED" = "$ACTUAL" ]; then echo "PASS"; exit 0; else echo "FAIL: error timestamps don't match"; exit 1; fi`,
      dataGenerator: () => {
        const statuses = [200, 200, 200, 301, 404, 500, 502, 503];
        const lines = Array.from({ length: randomInt(20, 50) }, (_, i) => {
          const ts = `2024-01-${String(randomInt(1, 28)).padStart(2, "0")}T${String(randomInt(0, 23)).padStart(2, "0")}:${String(randomInt(0, 59)).padStart(2, "0")}:00`;
          const status = statuses[randomInt(0, statuses.length - 1)]!;
          return `${ts} 192.168.1.${randomInt(1, 255)} GET /api/resource${i} HTTP/1.1 ${status} ${randomInt(100, 5000)} "-" "Mozilla/5.0"`;
        });
        return { "access.log": lines.join("\n") };
      },
    },
    {
      title: "Top Words",
      description:
        "Find the 3 most frequent words in /workspace/quests/data/article.txt (case-insensitive, alphabetical order for ties), write to /workspace/output/top3.txt (one word per line, lowercase)",
      verifyScript: `#!/bin/bash
EXPECTED=$(tr '[:upper:]' '[:lower:]' < /workspace/quests/data/article.txt | tr -cs '[:alpha:]' '\\n' | sort | uniq -c | sort -rn -k1,1 -k2,2 | head -3 | awk '{print $2}')
ACTUAL=$(cat /workspace/output/top3.txt 2>/dev/null)
if [ "$EXPECTED" = "$ACTUAL" ]; then echo "PASS"; exit 0; else echo "FAIL: top 3 words don't match. Expected: $EXPECTED"; exit 1; fi`,
      dataGenerator: () => {
        const words = ["the", "quick", "brown", "fox", "jumps", "over", "lazy", "dog", "data", "algorithm", "system", "process"];
        const text = Array.from({ length: randomInt(50, 150) }, () =>
          words[randomInt(0, words.length - 1)]!,
        ).join(" ");
        return { "article.txt": text };
      },
    },
  ],
  4: [
    {
      title: "Sales Totals",
      description:
        "data/sales.csv has columns: date,product,amount. Compute total amount per product, write CSV to /workspace/output/totals.csv with columns: product,total (sorted by product name)",
      verifyScript: `#!/bin/bash
EXPECTED=$(tail -n +2 /workspace/quests/data/sales.csv | awk -F',' '{a[$2]+=$3} END {for(k in a) print k","a[k]}' | sort)
ACTUAL=$(tail -n +2 /workspace/output/totals.csv 2>/dev/null | sort)
if [ "$EXPECTED" = "$ACTUAL" ]; then echo "PASS"; exit 0; else echo "FAIL: totals don't match"; exit 1; fi`,
      dataGenerator: () => {
        const products = ["widget", "gadget", "doohickey"];
        const lines = ["date,product,amount"];
        for (let i = 0; i < randomInt(10, 30); i++) {
          const date = `2024-01-${String(randomInt(1, 28)).padStart(2, "0")}`;
          const product = products[randomInt(0, products.length - 1)]!;
          const amount = randomInt(10, 500);
          lines.push(`${date},${product},${amount}`);
        }
        return { "sales.csv": lines.join("\n") };
      },
    },
  ],
  5: [
    {
      title: "HTTP Health Server",
      description:
        "Write a script at /workspace/output/server.js that serves HTTP on port 8080 and responds to GET /health with 200 OK and body 'ok'",
      verifyScript: `#!/bin/bash
node /workspace/output/server.js &
PID=$!
sleep 1
RESULT=$(curl -s http://localhost:8080/health)
kill $PID 2>/dev/null
if [ "$RESULT" = "ok" ]; then echo "PASS"; exit 0; else echo "FAIL: expected 'ok', got '$RESULT'"; exit 1; fi`,
    },
  ],
};

export class QuestGenerator {
  generateQuest(tier: number, currentCycle: number, completedIds: string[]): Quest {
    const effectiveTier = Math.min(Math.max(tier, 1), Math.max(...Object.keys(TIER_TEMPLATES).map(Number)));
    const templates = TIER_TEMPLATES[effectiveTier] ?? TIER_TEMPLATES[1]!;
    const template = templates[randomInt(0, templates.length - 1)]!;

    const quest: Quest = {
      id: `quest-${randomUUID().slice(0, 8)}`,
      tier: effectiveTier,
      title: template.title,
      description: template.description,
      verifyScript: "quests/verify.sh",
      reward: TIER_REWARDS[effectiveTier] ?? 2000,
      deadlineCycles: TIER_DEADLINES[effectiveTier] ?? 10,
      assignedCycle: currentCycle,
    };

    if (template.dataGenerator) {
      quest.dataFiles = Object.keys(template.dataGenerator());
    }

    return quest;
  }

  writeQuestToWorkspace(quest: Quest, workspacePath: string): void {
    const questDir = join(workspacePath, "quests");
    const dataDir = join(questDir, "data");
    const outputDir = join(workspacePath, "output");
    const workDir = join(workspacePath, "work");
    const skillsDir = join(workspacePath, "skills");

    mkdirSync(questDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(outputDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });
    mkdirSync(skillsDir, { recursive: true });

    // Write quest.json
    writeFileSync(
      join(questDir, "quest.json"),
      JSON.stringify(quest, null, 2),
      "utf-8",
    );

    // Find the template and write verify.sh + data
    const effectiveTier = Math.min(quest.tier, Math.max(...Object.keys(TIER_TEMPLATES).map(Number)));
    const templates = TIER_TEMPLATES[effectiveTier] ?? TIER_TEMPLATES[1]!;
    const template = templates.find((t) => t.title === quest.title) ?? templates[0]!;

    writeFileSync(join(questDir, "verify.sh"), template.verifyScript, {
      mode: 0o755,
      encoding: "utf-8",
    });

    // Write data files
    if (template.dataGenerator) {
      const dataFiles = template.dataGenerator();
      for (const [name, content] of Object.entries(dataFiles)) {
        writeFileSync(join(dataDir, name), content, "utf-8");
      }
    }
  }
}
