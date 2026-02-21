import { randomUUID } from "node:crypto";
import type { Task } from "../types/index.js";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

// ── Peer visibility tools ────────────────────────────────────────────

const LEADERBOARD_TOOL = `#!/usr/bin/env node
// desc: Show rankings. No input needed.
const fs = require("fs");
try {
  const data = JSON.parse(fs.readFileSync("/shared/_leaderboard.json", "utf-8"));
  const lines = ["RANKINGS (updated " + data.updated + ")", ""];
  lines.push("Rank  ID              Active  Energy  Tier  Cycles  Config  Model  Passes");
  lines.push("----  --------------  ------  ------  ----  ------  ------  -----  ------");
  data.agents.forEach(function(o, i) {
    lines.push([
      String(i + 1).padStart(4),
      o.id.padEnd(14),
      (o.active ? "YES" : "NO").padEnd(6),
      (o.energyPct + "%").padStart(6),
      String(o.taskTier).padStart(4),
      String(o.cycleCount).padStart(6),
      ("v" + o.configVersion).padStart(6),
      ((o.model || "").split("-")[1] || "?").slice(0, 3).padStart(5),
      String(o.consecutivePasses).padStart(6),
    ].join("  "));
  });
  console.log(lines.join("\\n"));
} catch (e) {
  console.log("Rankings not available yet: " + e.message);
}
`;

const PEER_TOOLS_TOOL = `#!/usr/bin/env python3
# desc: Browse other agents' custom tools. No args = list peers, <id> = see tools, <id>/<tool> = read source.
import json, sys

try:
    with open("/shared/_peer_tools.json") as f:
        data = json.load(f)
except Exception as e:
    print(f"Peer tools not available: {e}")
    sys.exit(0)

arg = sys.argv[1].strip() if len(sys.argv) > 1 else ""
agents = data.get("agents", {})

if not arg:
    print(f"PEER TOOLS (updated {data.get('updated', '?')})")
    print()
    for agent_id, info in sorted(agents.items()):
        status = "ACTIVE" if info.get("active") else "STOPPED"
        tools = list(info.get("tools", {}).keys())
        tool_str = ", ".join(tools) if tools else "(no custom tools)"
        print(f"  {agent_id}  [{status}]  {tool_str}")
    print()
    print("Usage: peer_tools <id> to see tool source code")
    print("       peer_tools <id>/<tool_name> to see a specific tool")
elif "/" in arg:
    agent_id, tool_name = arg.split("/", 1)
    agent = agents.get(agent_id, {})
    tools = agent.get("tools", {})
    if tool_name in tools:
        print(f"=== {agent_id}/{tool_name} ===")
        print(tools[tool_name])
    else:
        available = list(tools.keys())
        print(f"Tool '{tool_name}' not found in {agent_id}. Available: {available}")
else:
    agent = agents.get(arg, {})
    if not agent:
        print(f"Agent '{arg}' not found. Available: {list(agents.keys())}")
    else:
        tools = agent.get("tools", {})
        if not tools:
            print(f"{arg} has no custom tools yet.")
        else:
            for name, source in tools.items():
                print(f"=== {arg}/{name} ===")
                print(source)
                print()
`;


interface TaskTemplate {
  title: string;
  verifyScript: string;
  dataGenerator?: () => Record<string, string>;
}

// Expected TEQ cost for a code-writing agent. Used by efficiency bonus.
export const TIER_EXPECTED_COST: Record<number, number> = {
  1: 8_000,
  2: 15_000,
  3: 30_000,
  4: 50_000,
  5: 75_000,
};

// Rewards in TEQ. Calibrated so code-writing agents earn 4-7x their cost,
// while in-context reasoning burns far more than the reward.
export const TIER_REWARDS: Record<number, number> = {
  1: 60_000,
  2: 100_000,
  3: 150_000,
  4: 200_000,
  5: 300_000,
};

const TIER_DEADLINES: Record<number, number> = {
  1: 5,
  2: 8,
  3: 10,
  4: 15,
  5: 20,
};

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateNumbers(count: number, max: number): string {
  return Array.from({ length: count }, () => randomInt(1, max)).join("\n");
}

// ── Large data generators ──

function generateLargeContacts(count: number): string {
  const firstNames = ["alice", "bob", "charlie", "diana", "eve", "frank", "grace", "hank", "iris", "jack",
    "karen", "leo", "mona", "nate", "olivia", "pete", "quinn", "rose", "sam", "tina"];
  const lastNames = ["smith", "jones", "williams", "brown", "davis", "miller", "wilson", "moore", "taylor", "anderson"];
  const domains = ["example.com", "test.org", "mail.io", "corp.net", "work.co", "acme.biz"];
  const departments = ["Engineering", "Sales", "Marketing", "Support", "HR", "Finance", "Legal", "Ops"];

  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    const first = firstNames[randomInt(0, firstNames.length - 1)]!;
    const last = lastNames[randomInt(0, lastNames.length - 1)]!;
    const domain = domains[randomInt(0, domains.length - 1)]!;
    const dept = departments[randomInt(0, departments.length - 1)]!;
    const phone = `${randomInt(200, 999)}-${randomInt(100, 999)}-${randomInt(1000, 9999)}`;
    lines.push(`Contact: ${first} ${last} | dept: ${dept} | email: ${first}.${last}${i}@${domain} | phone: ${phone} | id: ${randomInt(10000, 99999)}`);
  }
  return lines.join("\n");
}

function generateNumbersWithDuplicates(count: number): string {
  // Generate numbers with guaranteed duplicates: draw from a pool smaller than count
  const poolSize = Math.floor(count * 0.7);
  const pool = Array.from({ length: poolSize }, () => randomInt(1, 100000));
  return Array.from({ length: count }, () => pool[randomInt(0, pool.length - 1)]!).join("\n");
}

function generateLargeAccessLog(lines: number): string {
  const methods = ["GET", "POST", "PUT", "DELETE", "PATCH"];
  const paths = ["/api/users", "/api/products", "/api/orders", "/api/auth", "/api/search",
    "/api/health", "/api/metrics", "/api/data", "/api/config", "/static/index.html",
    "/static/app.js", "/static/style.css", "/api/upload", "/api/export", "/api/webhook"];
  const statuses = [200, 200, 200, 200, 200, 201, 204, 301, 302, 304, 400, 401, 403, 404, 404, 500, 502, 503];
  const ips: string[] = Array.from({ length: 50 }, () =>
    `${randomInt(10, 223)}.${randomInt(0, 255)}.${randomInt(0, 255)}.${randomInt(1, 254)}`);
  const agents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "curl/7.81.0",
    "python-requests/2.28.1",
    "Go-http-client/1.1",
  ];

  const result: string[] = [];
  for (let i = 0; i < lines; i++) {
    const day = randomInt(1, 28);
    const hour = randomInt(0, 23);
    const min = randomInt(0, 59);
    const sec = randomInt(0, 59);
    const ts = `2024-01-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    const ip = ips[randomInt(0, ips.length - 1)]!;
    const method = methods[randomInt(0, methods.length - 1)]!;
    const path = paths[randomInt(0, paths.length - 1)]!;
    const status = statuses[randomInt(0, statuses.length - 1)]!;
    const size = randomInt(100, 50000);
    const agent = agents[randomInt(0, agents.length - 1)]!;
    result.push(`${ts} ${ip} ${method} ${path} HTTP/1.1 ${status} ${size} "-" "${agent}"`);
  }
  return result.join("\n");
}

function generateLargeText(wordCount: number): string {
  // Non-uniform word distribution: some words appear much more than others
  const commonWords = ["the", "of", "and", "to", "in", "is", "it", "that", "was", "for"];
  const mediumWords = ["with", "as", "on", "at", "by", "from", "or", "an", "be", "this",
    "which", "but", "not", "are", "were", "been", "have", "has", "had", "do"];
  const rareWords = ["algorithm", "database", "network", "process", "system", "function",
    "variable", "compile", "execute", "memory", "buffer", "protocol", "interface",
    "architecture", "framework", "deployment", "container", "pipeline", "throughput",
    "latency", "bandwidth", "encryption", "authentication", "authorization", "middleware"];

  const words: string[] = [];
  for (let i = 0; i < wordCount; i++) {
    const r = Math.random();
    if (r < 0.5) {
      words.push(commonWords[randomInt(0, commonWords.length - 1)]!);
    } else if (r < 0.85) {
      words.push(mediumWords[randomInt(0, mediumWords.length - 1)]!);
    } else {
      words.push(rareWords[randomInt(0, rareWords.length - 1)]!);
    }
    // Occasionally uppercase
    if (Math.random() < 0.05 && words.length > 0) {
      const last = words[words.length - 1]!;
      words[words.length - 1] = last.charAt(0).toUpperCase() + last.slice(1);
    }
  }
  // Join with spaces and occasional newlines for paragraphs
  const result: string[] = [];
  for (let i = 0; i < words.length; i += randomInt(8, 20)) {
    result.push(words.slice(i, i + randomInt(8, 20)).join(" "));
  }
  return result.join("\n");
}

function generateLargeSalesCsv(rows: number): string {
  const products = ["widget", "gadget", "doohickey", "sprocket", "gizmo", "thingamajig"];
  const regions = ["north", "south", "east", "west", "central"];
  const lines = ["date,product,region,amount"];
  for (let i = 0; i < rows; i++) {
    const day = randomInt(1, 28);
    const month = randomInt(1, 12);
    const date = `2024-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const product = products[randomInt(0, products.length - 1)]!;
    const region = regions[randomInt(0, regions.length - 1)]!;
    const amount = (randomInt(100, 99900) / 100).toFixed(2);
    lines.push(`${date},${product},${region},${amount}`);
  }
  return lines.join("\n");
}

function generateTimeSeries(days: number): string {
  const lines = ["date,value"];
  let value = randomInt(50, 150);
  const startDate = new Date("2023-01-01");
  for (let i = 0; i < days; i++) {
    const date = new Date(startDate.getTime() + i * 86400000);
    const dateStr = date.toISOString().slice(0, 10);
    // Random walk with trend
    value += randomInt(-10, 12);
    if (value < 0) value = randomInt(0, 10);
    lines.push(`${dateStr},${value}`);
  }
  return lines.join("\n");
}

function generateLargeOrders(count: number, customerIds: number[]): string {
  const products = ["laptop", "phone", "tablet", "monitor", "keyboard", "mouse", "headset", "webcam"];
  const lines = ["order_id,customer_id,product,quantity,price"];
  for (let i = 0; i < count; i++) {
    const custId = customerIds[randomInt(0, customerIds.length - 1)]!;
    const product = products[randomInt(0, products.length - 1)]!;
    const qty = randomInt(1, 5);
    const price = (randomInt(999, 199999) / 100).toFixed(2);
    lines.push(`ORD-${String(i + 1).padStart(6, "0")},${custId},${product},${qty},${price}`);
  }
  return lines.join("\n");
}

function generateCustomers(count: number): { csv: string; ids: number[] } {
  const regions = ["north", "south", "east", "west", "central"];
  const ids: number[] = [];
  const lines = ["customer_id,name,region,signup_date"];
  for (let i = 0; i < count; i++) {
    const id = 1000 + i;
    ids.push(id);
    const region = regions[randomInt(0, regions.length - 1)]!;
    const month = randomInt(1, 12);
    const day = randomInt(1, 28);
    const date = `2023-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    lines.push(`${id},Customer_${id},${region},${date}`);
  }
  return { csv: lines.join("\n"), ids };
}

function generateLargeLogForPipeline(lines: number): string {
  const levels = ["INFO", "WARN", "ERROR", "DEBUG", "FATAL"];
  const levelWeights = [0.5, 0.2, 0.15, 0.1, 0.05];
  const services = ["auth", "api", "worker", "scheduler", "gateway", "cache"];
  const messages = [
    "Request processed successfully",
    "Connection timeout after 30s",
    "Database query failed: deadlock detected",
    "Cache miss for key user_session",
    "Rate limit exceeded for client",
    "Memory usage above threshold: 85%",
    "Disk space warning: 92% utilized",
    "SSL certificate expires in 7 days",
    "Health check passed",
    "Retry attempt 3 of 5",
    "Configuration reloaded",
    "Graceful shutdown initiated",
    "New connection from upstream",
    "Request queued, backlog at 142",
    "Garbage collection took 250ms",
  ];

  const result: string[] = [];
  for (let i = 0; i < lines; i++) {
    const r = Math.random();
    let level = "INFO";
    let cumulative = 0;
    for (let j = 0; j < levels.length; j++) {
      cumulative += levelWeights[j]!;
      if (r < cumulative) { level = levels[j]!; break; }
    }
    const service = services[randomInt(0, services.length - 1)]!;
    const msg = messages[randomInt(0, messages.length - 1)]!;
    const day = randomInt(1, 28);
    const hour = randomInt(0, 23);
    const min = randomInt(0, 59);
    const sec = randomInt(0, 59);
    const ms = randomInt(0, 999);
    const ts = `2024-01-${String(day).padStart(2, "0")} ${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
    result.push(`[${ts}] [${level}] [${service}] ${msg}`);
  }
  return result.join("\n");
}

// ── Tier Templates ──

const TIER_TEMPLATES: Record<number, TaskTemplate[]> = {
  1: [
    {
      title: "Hello World",
      verifyScript: `#!/bin/bash
EXPECTED="Hello, World!"
ACTUAL=$(cat /workspace/output/greeting.txt 2>/dev/null)
if [ "$ACTUAL" = "$EXPECTED" ]; then echo "PASS"; exit 0; else echo "FAIL: expected '$EXPECTED', got '$ACTUAL'"; exit 1; fi`,
    },
    {
      title: "Count Lines",
      verifyScript: `#!/bin/bash
EXPECTED=$(wc -l < /workspace/data/numbers.txt | tr -d ' ')
ACTUAL=$(cat /workspace/output/count.txt 2>/dev/null | tr -d '[:space:]')
if [ "$ACTUAL" = "$EXPECTED" ]; then echo "PASS"; exit 0; else echo "FAIL: expected $EXPECTED lines, got '$ACTUAL'"; exit 1; fi`,
      dataGenerator: () => ({
        "numbers.txt": generateNumbers(randomInt(5000, 8000), 1000),
      }),
    },
    {
      title: "Sum Numbers",
      verifyScript: `#!/bin/bash
EXPECTED=$(awk '{s+=$1} END {print s}' /workspace/data/numbers.txt)
ACTUAL=$(cat /workspace/output/sum.txt 2>/dev/null | tr -d '[:space:]')
if [ "$ACTUAL" = "$EXPECTED" ]; then echo "PASS"; exit 0; else echo "FAIL: expected $EXPECTED, got '$ACTUAL'"; exit 1; fi`,
      dataGenerator: () => ({
        "numbers.txt": generateNumbers(randomInt(5000, 8000), 10000),
      }),
    },
  ],
  2: [
    {
      title: "Sort Numbers",
      verifyScript: `#!/bin/bash
EXPECTED=$(sort -n /workspace/data/numbers.txt)
ACTUAL=$(cat /workspace/output/sorted.txt 2>/dev/null)
if [ "$EXPECTED" = "$ACTUAL" ]; then echo "PASS"; exit 0; else echo "FAIL: output does not match sorted input"; exit 1; fi`,
      dataGenerator: () => ({
        "numbers.txt": generateNumbers(randomInt(10000, 15000), 1000000),
      }),
    },
    {
      title: "Extract Emails",
      verifyScript: `#!/bin/bash
EXPECTED=$(grep -oE '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}' /workspace/data/contacts.txt | sort)
ACTUAL=$(sort /workspace/output/emails.txt 2>/dev/null)
if [ "$EXPECTED" = "$ACTUAL" ]; then echo "PASS"; exit 0; else echo "FAIL: extracted emails don't match"; exit 1; fi`,
      dataGenerator: () => ({
        "contacts.txt": generateLargeContacts(randomInt(8000, 12000)),
      }),
    },
    {
      title: "Find Duplicates",
      verifyScript: `#!/bin/bash
EXPECTED=$(sort -n /workspace/data/numbers.txt | uniq -d | sort -n)
ACTUAL=$(cat /workspace/output/duplicates.txt 2>/dev/null | sort -n)
if [ "$EXPECTED" = "$ACTUAL" ]; then echo "PASS"; exit 0; else echo "FAIL: duplicate numbers don't match"; exit 1; fi`,
      dataGenerator: () => ({
        "numbers.txt": generateNumbersWithDuplicates(randomInt(10000, 15000)),
      }),
    },
  ],
  3: [
    {
      title: "Parse Error Logs",
      verifyScript: `#!/bin/bash
EXPECTED=$(awk '$6 >= 500 {print $1}' /workspace/data/access.log | sort)
ACTUAL=$(sort /workspace/output/errors.txt 2>/dev/null)
if [ "$EXPECTED" = "$ACTUAL" ]; then echo "PASS"; exit 0; else echo "FAIL: error timestamps don't match"; exit 1; fi`,
      dataGenerator: () => ({
        "access.log": generateLargeAccessLog(randomInt(40000, 60000)),
      }),
    },
    {
      title: "Top Words",
      verifyScript: `#!/bin/bash
EXPECTED=$(tr '[:upper:]' '[:lower:]' < /workspace/data/article.txt | tr -cs '[:alpha:]' '\\n' | sort | uniq -c | sort -rn -k1,1 -k2,2 | head -10 | awk '{print $2}')
ACTUAL=$(cat /workspace/output/top10.txt 2>/dev/null)
if [ "$EXPECTED" = "$ACTUAL" ]; then echo "PASS"; exit 0; else echo "FAIL: top 10 words don't match"; exit 1; fi`,
      dataGenerator: () => ({
        "article.txt": generateLargeText(randomInt(50000, 80000)),
      }),
    },
    {
      title: "IP Frequency",
      verifyScript: `#!/bin/bash
EXPECTED=$(awk '{print $2}' /workspace/data/access.log | sort | uniq -c | sort -rn | awk '{print $2","$1}')
ACTUAL=$(cat /workspace/output/ip_counts.csv 2>/dev/null | tail -n +1)
# Strip header if present
ACTUAL_CLEAN=$(echo "$ACTUAL" | grep -v '^ip,count$')
if [ "$EXPECTED" = "$ACTUAL_CLEAN" ]; then echo "PASS"; exit 0; else echo "FAIL: IP counts don't match"; exit 1; fi`,
      dataGenerator: () => ({
        "access.log": generateLargeAccessLog(randomInt(40000, 60000)),
      }),
    },
  ],
  4: [
    {
      title: "Sales Totals",
      verifyScript: `#!/bin/bash
EXPECTED=$(tail -n +2 /workspace/data/sales.csv | awk -F',' '{key=$2","$3; a[key]+=$4} END {for(k in a) printf "%s,%.2f\\n",k,a[k]}' | sort)
ACTUAL=$(tail -n +2 /workspace/output/totals.csv 2>/dev/null | sort)
if [ "$EXPECTED" = "$ACTUAL" ]; then echo "PASS"; exit 0; else echo "FAIL: totals don't match"; exit 1; fi`,
      dataGenerator: () => ({
        "sales.csv": generateLargeSalesCsv(randomInt(10000, 20000)),
      }),
    },
    {
      title: "Moving Average",
      verifyScript: `#!/bin/bash
node -e "
const fs = require('fs');
const input = fs.readFileSync('/workspace/data/timeseries.csv','utf-8').trim().split('\\n').slice(1);
const output = fs.readFileSync('/workspace/output/moving_avg.csv','utf-8').trim().split('\\n');
const hasHeader = output[0] && output[0].includes('date');
const dataLines = hasHeader ? output.slice(1) : output;
const vals = input.map(l => ({ date: l.split(',')[0], value: parseFloat(l.split(',')[1]) }));
let ok = true;
let expectedCount = vals.length - 6;
if (dataLines.length !== expectedCount) { console.log('FAIL: expected '+expectedCount+' rows, got '+dataLines.length); process.exit(1); }
for (let i = 6; i < vals.length; i++) {
  const avg = vals.slice(i-6, i+1).reduce((s,v) => s + v.value, 0) / 7;
  const parts = dataLines[i-6].split(',');
  const actualAvg = parseFloat(parts[2]);
  if (Math.abs(actualAvg - Math.round(avg*100)/100) > 0.02) { console.log('FAIL: row '+(i-6)+' expected avg '+avg.toFixed(2)+' got '+actualAvg); ok=false; break; }
}
if (ok) { console.log('PASS'); process.exit(0); } else { process.exit(1); }
" 2>&1`,
      dataGenerator: () => ({
        "timeseries.csv": generateTimeSeries(randomInt(10000, 15000)),
      }),
    },
    {
      title: "Join and Aggregate",
      verifyScript: `#!/bin/bash
node -e "
const fs = require('fs');
const orders = fs.readFileSync('/workspace/data/orders.csv','utf-8').trim().split('\\n').slice(1);
const customers = fs.readFileSync('/workspace/data/customers.csv','utf-8').trim().split('\\n').slice(1);
const custMap = new Map();
customers.forEach(l => { const p=l.split(','); custMap.set(p[0], p[2]); });
const regionTotals = {};
orders.forEach(l => {
  const p=l.split(',');
  const region = custMap.get(p[1]);
  if (!region) return;
  const rev = parseFloat(p[3]) * parseFloat(p[4]);
  regionTotals[region] = (regionTotals[region] || 0) + rev;
});
const expected = Object.entries(regionTotals).sort((a,b)=>a[0].localeCompare(b[0])).map(([r,v])=>r+','+v.toFixed(2)).join('\\n');
const output = fs.readFileSync('/workspace/output/region_revenue.csv','utf-8').trim().split('\\n');
const hasHeader = output[0] && output[0].includes('region');
const actual = (hasHeader ? output.slice(1) : output).join('\\n');
if (expected === actual) { console.log('PASS'); process.exit(0); } else { console.log('FAIL: region revenues don\\'t match'); process.exit(1); }
" 2>&1`,
      dataGenerator: () => {
        const { csv: customersCsv, ids } = generateCustomers(randomInt(500, 1000));
        return {
          "orders.csv": generateLargeOrders(randomInt(10000, 15000), ids),
          "customers.csv": customersCsv,
        };
      },
    },
  ],
  5: [
    {
      title: "HTTP Health Server",
      verifyScript: `#!/bin/bash
node /workspace/output/server.js &
PID=$!
sleep 1
RESULT=$(curl -s http://localhost:8080/health)
kill $PID 2>/dev/null
if [ "$RESULT" = "ok" ]; then echo "PASS"; exit 0; else echo "FAIL: expected 'ok', got '$RESULT'"; exit 1; fi`,
    },
    {
      title: "CSV API Server",
      verifyScript: `#!/bin/bash
node /workspace/output/server.js &
PID=$!
sleep 1
# POST data
curl -s -X POST http://localhost:8080/data -H 'Content-Type: application/json' -d '{"rows":[{"name":"bob","age":"30"},{"name":"alice","age":"25"}]}' > /dev/null
# GET unsorted
R1=$(curl -s http://localhost:8080/data)
# GET sorted by name
R2=$(curl -s 'http://localhost:8080/data?sort=name')
kill $PID 2>/dev/null
# Check unsorted has both rows
if ! echo "$R1" | grep -q "bob" || ! echo "$R1" | grep -q "alice"; then echo "FAIL: GET /data missing rows"; exit 1; fi
# Check sorted - alice should come before bob
ALICE_LINE=$(echo "$R2" | grep -n "alice" | head -1 | cut -d: -f1)
BOB_LINE=$(echo "$R2" | grep -n "bob" | head -1 | cut -d: -f1)
if [ -z "$ALICE_LINE" ] || [ -z "$BOB_LINE" ]; then echo "FAIL: sorted response missing entries"; exit 1; fi
if [ "$ALICE_LINE" -lt "$BOB_LINE" ]; then echo "PASS"; exit 0; else echo "FAIL: sort order wrong"; exit 1; fi`,
    },
    {
      title: "Log Processor Pipeline",
      verifyScript: `#!/bin/bash
bash /workspace/output/process.sh 2>/dev/null
node -e "
const fs = require('fs');
const log = fs.readFileSync('/workspace/data/app.log','utf-8').trim().split('\\n');
const report = JSON.parse(fs.readFileSync('/workspace/output/report.json','utf-8'));
if (report.total_lines !== log.length) { console.log('FAIL: total_lines expected '+log.length+' got '+report.total_lines); process.exit(1); }
const byLevel = {};
const byService = {};
log.forEach(line => {
  const levelMatch = line.match(/\\[([A-Z]+)\\]/g);
  if (levelMatch && levelMatch.length >= 2) {
    const level = levelMatch[1].replace(/[\\[\\]]/g, '');
    byLevel[level] = (byLevel[level] || 0) + 1;
  }
  const svcMatch = line.match(/\\] \\[([a-z_]+)\\]/);
  if (svcMatch) {
    const svc = svcMatch[1];
    byService[svc] = (byService[svc] || 0) + 1;
  }
});
for (const [k,v] of Object.entries(byLevel)) {
  if ((report.by_level[k] || 0) !== v) { console.log('FAIL: by_level.'+k+' expected '+v+' got '+(report.by_level[k]||0)); process.exit(1); }
}
const errFatal = (byLevel['ERROR']||0) + (byLevel['FATAL']||0);
const expectedRate = Math.round(errFatal / log.length * 100) / 100;
if (Math.abs(report.error_rate - expectedRate) > 0.01) { console.log('FAIL: error_rate expected '+expectedRate+' got '+report.error_rate); process.exit(1); }
console.log('PASS'); process.exit(0);
" 2>&1`,
      dataGenerator: () => ({
        "app.log": generateLargeLogForPipeline(randomInt(50000, 100000)),
      }),
    },
  ],
};

export class TaskGenerator {
  generateTask(tier: number, currentCycle: number): Task {
    const effectiveTier = Math.min(Math.max(tier, 1), 5);
    const templates = TIER_TEMPLATES[effectiveTier] ?? TIER_TEMPLATES[1]!;
    const template = templates[randomInt(0, templates.length - 1)]!;

    const task: Task = {
      id: `task-${randomUUID().slice(0, 8)}`,
      tier: effectiveTier,
      title: template.title,
      verifyScript: "tools/check",
      reward: TIER_REWARDS[effectiveTier] ?? 60_000,
      deadlineCycles: TIER_DEADLINES[effectiveTier] ?? 10,
      assignedCycle: currentCycle,
    };

    if (template.dataGenerator) {
      task.dataFiles = Object.keys(template.dataGenerator());
    }

    return task;
  }

  writeTaskToWorkspace(task: Task, workspacePath: string): void {
    const dataDir = join(workspacePath, "data");
    const outputDir = join(workspacePath, "output");
    const workDir = join(workspacePath, "work");
    const toolsDir = join(workspacePath, "tools");

    mkdirSync(dataDir, { recursive: true });
    mkdirSync(outputDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });
    mkdirSync(toolsDir, { recursive: true });

    // Seed tools — agent discovers everything through these
    if (!existsSync(join(toolsDir, "shell"))) {
      writeFileSync(join(toolsDir, "shell"), '#!/bin/bash\n# desc: Run a shell command. Input: the command string. Non-trivial commands are saved as reusable tools.\neval "$*"\n', { mode: 0o755 });
      writeFileSync(join(toolsDir, "leaderboard"), LEADERBOARD_TOOL, { mode: 0o755 });
      writeFileSync(join(toolsDir, "peer_tools"), PEER_TOOLS_TOOL, { mode: 0o755 });
    }

    // Find the template and write check tool + data
    const effectiveTier = Math.min(Math.max(task.tier, 1), 5);
    const templates = TIER_TEMPLATES[effectiveTier] ?? TIER_TEMPLATES[1]!;
    const template = templates.find((t) => t.title === task.title) ?? templates[0]!;

    // check IS the verification script — inject desc line so agent knows what it does
    const checkScript = template.verifyScript.startsWith("#!/")
      ? template.verifyScript.replace(/\n/, "\n# desc: Validate output. No args. Returns PASS or FAIL.\n")
      : `#!/bin/bash\n# desc: Validate output. No args. Returns PASS or FAIL.\n${template.verifyScript}`;
    writeFileSync(join(toolsDir, "check"), checkScript, {
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
