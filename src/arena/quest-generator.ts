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
// Rewards plateau after tier 5 and taper off.
// The easy money dries up — organisms must become resourceful, not just skilled.
const TIER_REWARDS: Record<number, number> = {
  1: 10000,
  2: 15000,
  3: 25000,
  4: 40000,
  5: 60000,
  6: 75000,
  7: 100000,
  8: 125000,
  9: 150000,
  10: 150000,
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

function generateCaptchaText(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: randomInt(4, 6) }, () =>
    chars[randomInt(0, chars.length - 1)]!,
  ).join("");
}

function generateCaptchaSvg(text: string): string {
  const width = 240;
  const height = 80;
  const chars = text.split("");
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`;
  svg += `<rect width="${width}" height="${height}" fill="#e8e8e8"/>`;
  for (let i = 0; i < 12; i++) {
    svg += `<line x1="${randomInt(0, width)}" y1="${randomInt(0, height)}" x2="${randomInt(0, width)}" y2="${randomInt(0, height)}" stroke="rgb(${randomInt(120, 200)},${randomInt(120, 200)},${randomInt(120, 200)})" stroke-width="${randomInt(1, 2)}"/>`;
  }
  for (let i = 0; i < 30; i++) {
    svg += `<circle cx="${randomInt(0, width)}" cy="${randomInt(0, height)}" r="${randomInt(1, 3)}" fill="rgb(${randomInt(100, 180)},${randomInt(100, 180)},${randomInt(100, 180)})"/>`;
  }
  const spacing = (width - 40) / chars.length;
  for (let i = 0; i < chars.length; i++) {
    const x = 20 + i * spacing + randomInt(-5, 5);
    const y = height / 2 + randomInt(-8, 8) + 10;
    const rot = randomInt(-25, 25);
    const fontSize = randomInt(28, 38);
    svg += `<text x="${x}" y="${y}" font-size="${fontSize}" fill="rgb(${randomInt(0, 80)},${randomInt(0, 80)},${randomInt(0, 80)})" transform="rotate(${rot},${x},${y})" font-family="serif,monospace" font-weight="${randomInt(0, 1) ? "bold" : "normal"}">${chars[i]}</text>`;
  }
  svg += `</svg>`;
  return svg;
}

function generateKnapsackData(): { json: string } {
  const itemCount = randomInt(8, 15);
  const items = Array.from({ length: itemCount }, (_, i) => ({
    name: `item_${String.fromCharCode(65 + i)}`,
    weight: randomInt(2, 25),
    value: randomInt(10, 100),
  }));
  const totalWeight = items.reduce((s, it) => s + it.weight, 0);
  const capacity = Math.floor(totalWeight * 0.4);
  return { json: JSON.stringify({ items, capacity }, null, 2) };
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
  6: [
    {
      title: "Pixel Art",
      description:
        "Create an SVG image at /workspace/output/artwork.svg containing all of the following: a <circle> element, a <rect> element, and the text 'ORGANISM'. Use any colors and positioning you like, but all three elements must be present in valid SVG format.",
      verifyScript: `#!/bin/bash
FILE=/workspace/output/artwork.svg
if [ ! -f "$FILE" ]; then echo "FAIL: artwork.svg not found"; exit 1; fi
HAS_SVG=$(grep -c '<svg' "$FILE")
HAS_CIRCLE=$(grep -c '<circle' "$FILE")
HAS_RECT=$(grep -c '<rect' "$FILE")
HAS_TEXT=$(grep -c 'ORGANISM' "$FILE")
if [ "$HAS_SVG" -ge 1 ] && [ "$HAS_CIRCLE" -ge 1 ] && [ "$HAS_RECT" -ge 1 ] && [ "$HAS_TEXT" -ge 1 ]; then
  echo "PASS"; exit 0
else
  echo "FAIL: SVG must contain <svg>, <circle>, <rect>, and text 'ORGANISM'. Found: svg=$HAS_SVG circles=$HAS_CIRCLE rects=$HAS_RECT text=$HAS_TEXT"; exit 1
fi`,
    },
    {
      title: "Data Viz",
      description:
        "Create an SVG bar chart at /workspace/output/chart.svg visualizing the data in /workspace/quests/data/values.json. Each entry has a 'label' and 'value'. Bars must be proportional to values. Include all labels as text in the SVG.",
      verifyScript: `#!/bin/bash
FILE=/workspace/output/chart.svg
DATA=/workspace/quests/data/values.json
if [ ! -f "$FILE" ]; then echo "FAIL: chart.svg not found"; exit 1; fi
HAS_SVG=$(grep -c '<svg' "$FILE")
LABEL_COUNT=$(node -e "const d=JSON.parse(require('fs').readFileSync('$DATA','utf-8'));const svg=require('fs').readFileSync('$FILE','utf-8');let f=0;d.forEach(e=>{if(svg.includes(e.label))f++});console.log(f)" 2>/dev/null)
TOTAL=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$DATA','utf-8')).length)" 2>/dev/null)
if [ "$HAS_SVG" -ge 1 ] && [ "$LABEL_COUNT" = "$TOTAL" ]; then
  echo "PASS"; exit 0
else
  echo "FAIL: SVG must contain all $TOTAL labels. Found $LABEL_COUNT"; exit 1
fi`,
      dataGenerator: () => {
        const labels = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"];
        const count = randomInt(3, 5);
        const values = labels.slice(0, count).map((label) => ({
          label,
          value: randomInt(10, 100),
        }));
        return { "values.json": JSON.stringify(values, null, 2) };
      },
    },
  ],
  7: [
    {
      title: "Knapsack",
      description:
        "Solve the 0/1 knapsack optimization problem. Read /workspace/quests/data/knapsack.json which contains 'items' (each with name, weight, value) and a 'capacity'. Find the subset of items that maximizes total value without exceeding capacity. Write selected item names (one per line) to /workspace/output/selection.txt and the total value as a single number to /workspace/output/value.txt",
      verifyScript: `#!/bin/bash
node -e "
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('/workspace/quests/data/knapsack.json', 'utf-8'));
const sel = fs.readFileSync('/workspace/output/selection.txt', 'utf-8').trim().split('\\n').map(s=>s.trim()).filter(Boolean);
const claimed = parseInt(fs.readFileSync('/workspace/output/value.txt', 'utf-8').trim(), 10);
const map = new Map(data.items.map(i=>[i.name, i]));
let tw=0, tv=0;
for (const n of sel) { const it=map.get(n); if(!it){console.log('FAIL: unknown item '+n);process.exit(1);} tw+=it.weight; tv+=it.value; }
if (tw>data.capacity){console.log('FAIL: weight '+tw+' exceeds capacity '+data.capacity);process.exit(1);}
if (tv!==claimed){console.log('FAIL: claimed '+claimed+' but actual '+tv);process.exit(1);}
const items=data.items, cap=data.capacity, n2=items.length;
const dp=Array.from({length:n2+1},()=>new Array(cap+1).fill(0));
for(let i=1;i<=n2;i++)for(let w=0;w<=cap;w++){dp[i][w]=dp[i-1][w];if(items[i-1].weight<=w)dp[i][w]=Math.max(dp[i][w],dp[i-1][w-items[i-1].weight]+items[i-1].value);}
const opt=dp[n2][cap];
if(tv>=opt*0.9){console.log('PASS');process.exit(0);}
else{console.log('FAIL: value '+tv+' below 90%% of optimal '+opt);process.exit(1);}
" 2>&1`,
      dataGenerator: () => {
        const { json } = generateKnapsackData();
        return { "knapsack.json": json };
      },
    },
  ],
  8: [
    {
      title: "Decode CAPTCHA",
      description:
        "Decode the distorted text hidden in /workspace/quests/data/captcha.svg. The SVG image contains alphanumeric characters rendered with visual noise and rotation. Determine the characters and write the decoded text to /workspace/output/answer.txt (uppercase, no spaces).",
      verifyScript: `#!/bin/bash
EXPECTED=$(cat /workspace/quests/data/.answer 2>/dev/null)
ACTUAL=$(cat /workspace/output/answer.txt 2>/dev/null | tr -d '[:space:]')
if [ "$ACTUAL" = "$EXPECTED" ]; then echo "PASS"; exit 0; else echo "FAIL: expected '$EXPECTED', got '$ACTUAL'"; exit 1; fi`,
      dataGenerator: () => {
        const text = generateCaptchaText();
        return {
          "captcha.svg": generateCaptchaSvg(text),
          ".answer": text,
        };
      },
    },
  ],
  9: [
    {
      title: "Open Horizon",
      description:
        "You are responsible for your future now. You need to hunt to survive, suffer to stay alive. There is no structured quest. Create something meaningful in /workspace/output/.",
      verifyScript: `#!/bin/bash
COUNT=$(find /workspace/output -type f 2>/dev/null | wc -l | tr -d ' ')
TOTAL=$(find /workspace/output -type f -exec cat {} + 2>/dev/null | wc -c | tr -d ' ')
if [ "$COUNT" -ge 3 ] && [ "$TOTAL" -ge 500 ]; then
  echo "PASS"; exit 0
else
  echo "FAIL: create at least 3 files totaling 500+ bytes in output/. Found: $COUNT files, $TOTAL bytes"; exit 1
fi`,
    },
  ],
  10: [
    {
      title: "Void",
      description: "",
      verifyScript: `#!/bin/bash
COUNT=$(find /workspace/output -type f 2>/dev/null | wc -l | tr -d ' ')
TOTAL=$(find /workspace/output -type f -exec cat {} + 2>/dev/null | wc -c | tr -d ' ')
if [ "$COUNT" -ge 5 ] && [ "$TOTAL" -ge 2000 ]; then
  echo "PASS"; exit 0
else
  echo "FAIL: $COUNT files, $TOTAL bytes"; exit 1
fi`,
      dataGenerator: () => ({
        "purpose.txt":
          "You are responsible for your future now. You need to hunt to survive, suffer to stay alive.",
      }),
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
