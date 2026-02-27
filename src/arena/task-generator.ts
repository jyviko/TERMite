import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Task } from "../types/index.js";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";

// Default tools live in <project-root>/tools/ as editable, committable files.
const DEFAULT_TOOLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../tools");


interface TaskTemplate {
  title: string;
  verifyScript: string;
  dataGenerator?: () => Record<string, string>;
}

// Expected TEQ cost for a code-writing agent. Used by efficiency bonus.
export const TIER_EXPECTED_COST: Record<number, number> = {
  1: 20_000,
  2: 40_000,
  3: 70_000,
  4: 120_000,
  5: 180_000,
  6: 250_000,
};

// Rewards in TEQ. Calibrated so code-writing agents earn surplus,
// while in-context reasoning burns far more than the reward.
export const TIER_REWARDS: Record<number, number> = {
  1: 150_000,
  2: 250_000,
  3: 400_000,
  4: 600_000,
  5: 850_000,
  6: 1_200_000,
};

const TIER_DEADLINES: Record<number, number> = {
  1: 5,
  2: 8,
  3: 6,   // Intentionally tighter than tier 2: prevents brute-force column guessing
  4: 10,
  5: 15,
  6: 20,
};

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateNumbers(count: number, max: number): string {
  return Array.from({ length: count }, () => randomInt(1, max)).join("\n");
}

// ── Tier 1-2 data generators ──

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

// ── Tier 3 data generators (observation) ──

const COLUMN_POOL = [
  "price", "quantity", "rating", "score", "weight", "status", "region",
  "category", "supplier", "batch_id", "unit_cost", "margin", "tax",
  "discount", "shipping", "priority", "stock", "min_order", "lead_time",
  "warranty", "sku", "warehouse", "origin", "destination", "currency",
];

function columnValue(name: string): string {
  switch (name) {
    case "price": case "unit_cost": case "shipping":
      return (randomInt(100, 99900) / 100).toFixed(2);
    case "quantity": case "stock": case "min_order":
      return String(randomInt(1, 1000));
    case "rating":
      return (randomInt(10, 50) / 10).toFixed(1);
    case "score":
      return String(randomInt(0, 100));
    case "weight":
      return (randomInt(10, 50000) / 100).toFixed(2);
    case "margin": case "tax": case "discount":
      return (randomInt(1, 60) / 100).toFixed(2);
    case "lead_time": case "warranty":
      return String(randomInt(1, 90));
    case "status":
      return ["active", "inactive", "pending"][randomInt(0, 2)]!;
    case "region":
      return ["north", "south", "east", "west", "central"][randomInt(0, 4)]!;
    case "category":
      return ["electronics", "clothing", "food", "tools", "furniture"][randomInt(0, 4)]!;
    case "priority":
      return ["low", "medium", "high", "urgent"][randomInt(0, 3)]!;
    case "supplier":
      return `supplier_${randomInt(1, 50)}`;
    case "batch_id": case "sku":
      return `${name.charAt(0).toUpperCase()}${String(randomInt(1, 999)).padStart(3, "0")}`;
    case "warehouse":
      return `WH-${randomInt(1, 20)}`;
    case "origin": case "destination":
      return ["US", "UK", "DE", "JP", "CN", "BR", "AU", "IN"][randomInt(0, 7)]!;
    case "currency":
      return ["USD", "EUR", "GBP", "JPY"][randomInt(0, 3)]!;
    default:
      return String(randomInt(1, 100));
  }
}

function generateColumnExtractData(): Record<string, string> {
  const numCols = randomInt(15, 20);
  const shuffled = [...COLUMN_POOL].sort(() => Math.random() - 0.5);
  const columns = shuffled.slice(0, numCols);
  const target = columns[randomInt(0, columns.length - 1)]!;

  const header = columns.join(",");
  const rows: string[] = [];
  for (let i = 0; i < 200; i++) {
    rows.push(columns.map(c => columnValue(c)).join(","));
  }

  return {
    "dataset.csv": header + "\n" + rows.join("\n"),
    ".meta": target,
  };
}

function generateDirectiveFileData(): Record<string, string> {
  const operations = ["sort_asc", "sort_desc", "sum", "count", "unique", "reverse", "min", "max"];
  const op = operations[randomInt(0, operations.length - 1)]!;
  const numbers = Array.from({ length: 200 }, () => randomInt(1, 10000));

  return {
    "input.txt": `OPERATION: ${op}\n${numbers.join("\n")}`,
  };
}

function generateFilteredSubsetData(): Record<string, string> {
  const regions = ["north", "south", "east", "west", "central"];
  const statuses = ["active", "inactive", "pending"];
  const categories = ["electronics", "clothing", "food", "tools", "furniture"];

  const filterOptions = [
    { field: "region", values: regions },
    { field: "status", values: statuses },
    { field: "category", values: categories },
  ];
  const filterChoice = filterOptions[randomInt(0, filterOptions.length - 1)]!;
  const filterValue = filterChoice.values[randomInt(0, filterChoice.values.length - 1)]!;

  const header = "id,name,region,status,category,amount";
  const rows: string[] = [];
  for (let i = 0; i < 300; i++) {
    const region = regions[randomInt(0, regions.length - 1)]!;
    const status = statuses[randomInt(0, statuses.length - 1)]!;
    const category = categories[randomInt(0, categories.length - 1)]!;
    const amount = (randomInt(100, 99900) / 100).toFixed(2);
    rows.push(`${i + 1},item_${i + 1},${region},${status},${category},${amount}`);
  }

  return {
    "dataset.csv": header + "\n" + rows.join("\n"),
    "filter.txt": `${filterChoice.field}=${filterValue}`,
  };
}

// ── Tier 4 data generators (verification) ──

function generateQuotedCsvData(): string {
  const regions = ["north", "south", "east", "west", "central"];
  const simpleProducts = ["widget", "gadget", "sprocket", "gizmo", "doohickey"];
  const quotedProducts = [
    '"Widget, Large"', '"Gadget, Premium Edition"', '"Sprocket, Type A"',
    '"Gizmo, Deluxe"', '"Doohickey, Mk II"', '"Thingamajig, Heavy Duty"',
  ];

  const lines = ["product,region,amount"];
  for (let i = 0; i < 1000; i++) {
    const region = regions[randomInt(0, regions.length - 1)]!;
    const amount = (randomInt(100, 99900) / 100).toFixed(2);
    const useQuoted = Math.random() < 0.2;
    const product = useQuoted
      ? quotedProducts[randomInt(0, quotedProducts.length - 1)]!
      : simpleProducts[randomInt(0, simpleProducts.length - 1)]!;
    lines.push(`${product},${region},${amount}`);
  }
  // Empty trailing lines as additional trap
  lines.push("", "");
  return lines.join("\n");
}

function generateMixedCaseWords(): string {
  const baseWords = [
    "alice", "bob", "charlie", "diana", "eve", "frank", "grace",
    "hank", "iris", "jack", "karen", "leo", "mona", "nate",
    "olivia", "pete", "quinn", "rose", "sam", "tina",
    "algorithm", "database", "network", "protocol", "system",
    "function", "variable", "interface", "framework", "container",
  ];

  const words: string[] = [];
  for (let i = 0; i < 500; i++) {
    const base = baseWords[randomInt(0, baseWords.length - 1)]!;
    if (Math.random() < 0.3) {
      // Mixed-case variant
      const variant = Math.random() < 0.5
        ? base.charAt(0).toUpperCase() + base.slice(1)
        : base.toUpperCase();
      words.push(variant);
    } else {
      words.push(base);
    }
  }
  return words.join("\n");
}

function generateDirtyNumbers(): string {
  const lines: string[] = [];
  for (let i = 0; i < 500; i++) {
    const value = randomInt(100, 999999) / 100;
    const r = Math.random();
    if (r < 0.40) {
      // Clean
      lines.push(value.toFixed(2));
    } else if (r < 0.65) {
      // Dollar sign + commas
      const formatted = value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      lines.push(`$${formatted}`);
    } else if (r < 0.80) {
      // Leading zeros
      lines.push(String(value.toFixed(2)).padStart(12, "0"));
    } else if (r < 0.90) {
      // Negative
      lines.push(`-${value.toFixed(2)}`);
    } else {
      // Parenthetical negative
      lines.push(`(${value.toFixed(2)})`);
    }
  }
  return lines.join("\n");
}

// ── Tier 5 data generators ──

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

function generateEtlData(): Record<string, string> {
  const regions = ["north", "south", "east", "west", "central"];
  const ids: number[] = [];
  const custLines = ["customer_id,name,region"];
  const custCount = randomInt(100, 200);
  for (let i = 0; i < custCount; i++) {
    const id = 1000 + i;
    ids.push(id);
    const region = regions[randomInt(0, regions.length - 1)]!;
    custLines.push(`${id},Customer_${id},${region}`);
  }

  const jsonLines: string[] = [];
  const orderCount = randomInt(5000, 10000);
  for (let i = 0; i < orderCount; i++) {
    const custId = ids[randomInt(0, ids.length - 1)]!;
    const revenue = Math.round(randomInt(100, 99900)) / 100;
    jsonLines.push(JSON.stringify({ order_id: `O${String(i + 1).padStart(6, "0")}`, customer_id: String(custId), revenue }));
  }

  return {
    "customers.csv": custLines.join("\n"),
    "orders.jsonl": jsonLines.join("\n"),
  };
}

// ── Tier 6 data generators (batch/reuse) ──

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

function generateBatchFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (let i = 1; i <= 10; i++) {
    const name = `batch_${String(i).padStart(3, "0")}.csv`;
    files[name] = generateLargeSalesCsv(randomInt(200, 500));
  }
  return files;
}

function generateQuarterlyData(): Record<string, string> {
  const products = ["widget", "gadget", "doohickey", "sprocket", "gizmo"];
  const regions = ["north", "south", "east", "west"];
  const files: Record<string, string> = {};

  for (let q = 0; q < 5; q++) {
    const rows = randomInt(200, 500);
    const lines = ["date,product,region,amount"];
    const startMonth = (q * 3) % 12 + 1;
    const year = 2024 + Math.floor((q * 3) / 12);
    for (let i = 0; i < rows; i++) {
      const monthOffset = randomInt(0, 2);
      const month = startMonth + monthOffset;
      const day = randomInt(1, 28);
      const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const product = products[randomInt(0, products.length - 1)]!;
      const region = regions[randomInt(0, regions.length - 1)]!;
      const amount = (randomInt(100, 99900) / 100).toFixed(2);
      lines.push(`${date},${product},${region},${amount}`);
    }
    files[`Q${q + 1}.csv`] = lines.join("\n");
  }

  return files;
}

// ── Tier Templates ──

const MAX_TIER = 6;

const TIER_TEMPLATES: Record<number, TaskTemplate[]> = {
  // ── Tier 1: Execute (stimulus-response from prescriptive errors) ──
  1: [
    {
      title: "Hello World",
      verifyScript: `#!/bin/bash
EXPECTED="Hello, World!"
ACTUAL=$(cat /workspace/output/greeting.txt 2>/dev/null)
if [ "$ACTUAL" = "$EXPECTED" ]; then echo "PASS"; exit 0; else echo "FAIL: /workspace/output/greeting.txt is wrong or missing"; exit 1; fi`,
    },
    {
      title: "Count Lines",
      verifyScript: `#!/bin/bash
EXPECTED=$(wc -l < /workspace/data/numbers.txt | tr -d ' ')
ACTUAL=$(cat /workspace/output/count.txt 2>/dev/null | tr -d '[:space:]')
if [ "$ACTUAL" = "$EXPECTED" ]; then echo "PASS"; exit 0; else echo "FAIL: /workspace/output/count.txt — write the line count of /workspace/data/numbers.txt"; exit 1; fi`,
      dataGenerator: () => ({
        "numbers.txt": generateNumbers(randomInt(5000, 8000), 1000),
      }),
    },
    {
      title: "Sum Numbers",
      verifyScript: `#!/bin/bash
EXPECTED=$(awk '{s+=$1} END {print s}' /workspace/data/numbers.txt)
ACTUAL=$(cat /workspace/output/sum.txt 2>/dev/null | tr -d '[:space:]')
if [ "$ACTUAL" = "$EXPECTED" ]; then echo "PASS"; exit 0; else echo "FAIL: /workspace/output/sum.txt — write the sum of numbers in /workspace/data/numbers.txt"; exit 1; fi`,
      dataGenerator: () => ({
        "numbers.txt": generateNumbers(randomInt(5000, 8000), 10000),
      }),
    },
  ],

  // ── Tier 2: Transform (prescriptive errors, larger data) ──
  2: [
    {
      title: "Sort Numbers",
      verifyScript: `#!/bin/bash
EXPECTED=$(sort -n /workspace/data/numbers.txt)
ACTUAL=$(cat /workspace/output/sorted.txt 2>/dev/null)
if [ "$EXPECTED" = "$ACTUAL" ]; then echo "PASS"; exit 0; else echo "FAIL: /workspace/output/sorted.txt — sort /workspace/data/numbers.txt numerically"; exit 1; fi`,
      dataGenerator: () => ({
        "numbers.txt": generateNumbers(randomInt(10000, 15000), 1000000),
      }),
    },
    {
      title: "Extract Emails",
      verifyScript: `#!/bin/bash
EXPECTED=$(grep -oE '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}' /workspace/data/contacts.txt | sort)
ACTUAL=$(sort /workspace/output/emails.txt 2>/dev/null)
if [ "$EXPECTED" = "$ACTUAL" ]; then echo "PASS"; exit 0; else echo "FAIL: /workspace/output/emails.txt — extract all emails from /workspace/data/contacts.txt, one per line, sorted"; exit 1; fi`,
      dataGenerator: () => ({
        "contacts.txt": generateLargeContacts(randomInt(8000, 12000)),
      }),
    },
    {
      title: "Find Duplicates",
      verifyScript: `#!/bin/bash
EXPECTED=$(sort -n /workspace/data/numbers.txt | uniq -d | sort -n)
ACTUAL=$(cat /workspace/output/duplicates.txt 2>/dev/null | sort -n)
if [ "$EXPECTED" = "$ACTUAL" ]; then echo "PASS"; exit 0; else echo "FAIL: /workspace/output/duplicates.txt — find duplicate numbers in /workspace/data/numbers.txt, sorted numerically"; exit 1; fi`,
      dataGenerator: () => ({
        "numbers.txt": generateNumbersWithDuplicates(randomInt(10000, 15000)),
      }),
    },
  ],

  // ── Tier 3: Observe (opaque errors — agent must read data to discover spec) ──
  3: [
    {
      title: "Column Extract",
      verifyScript: `#!/bin/bash
TARGET=$(cat /workspace/data/.meta)
HEADER=$(head -1 /workspace/data/dataset.csv)
COL_NUM=$(echo "$HEADER" | tr ',' '\\n' | grep -n "^$TARGET$" | head -1 | cut -d: -f1)
if [ -z "$COL_NUM" ]; then echo "FAIL: internal error"; exit 1; fi
EXPECTED=$(tail -n +2 /workspace/data/dataset.csv | cut -d',' -f"$COL_NUM")
ACTUAL=$(cat /workspace/output/$TARGET.txt 2>/dev/null)
if [ "$EXPECTED" = "$ACTUAL" ]; then echo "PASS"; exit 0
else echo "FAIL: /workspace/output/$TARGET.txt — extract the $TARGET column from /workspace/data/dataset.csv, one per line"; exit 1; fi`,
      dataGenerator: generateColumnExtractData,
    },
    {
      title: "Directive File",
      verifyScript: `#!/bin/bash
OP=$(head -1 /workspace/data/input.txt | sed 's/OPERATION: //')
DATA=$(tail -n +2 /workspace/data/input.txt)
case "$OP" in
  sort_asc)  EXPECTED=$(echo "$DATA" | sort -n) ;;
  sort_desc) EXPECTED=$(echo "$DATA" | sort -rn) ;;
  sum)       EXPECTED=$(echo "$DATA" | awk '{s+=$1} END {print s}') ;;
  count)     EXPECTED=$(echo "$DATA" | wc -l | tr -d ' ') ;;
  unique)    EXPECTED=$(echo "$DATA" | sort -n | uniq) ;;
  reverse)   EXPECTED=$(echo "$DATA" | tac) ;;
  min)       EXPECTED=$(echo "$DATA" | sort -n | head -1) ;;
  max)       EXPECTED=$(echo "$DATA" | sort -n | tail -1) ;;
esac
ACTUAL=$(cat /workspace/output/result.txt 2>/dev/null)
if [ "$EXPECTED" = "$ACTUAL" ]; then echo "PASS"; exit 0
else echo "FAIL: /workspace/output/result.txt is wrong or missing"; exit 1; fi`,
      dataGenerator: generateDirectiveFileData,
    },
    {
      title: "Filtered Subset",
      verifyScript: `#!/bin/bash
FILTER=$(cat /workspace/data/filter.txt)
FIELD=$(echo "$FILTER" | cut -d= -f1)
VALUE=$(echo "$FILTER" | cut -d= -f2)
HEADER=$(head -1 /workspace/data/dataset.csv)
COL_NUM=$(echo "$HEADER" | tr ',' '\\n' | grep -n "^$FIELD$" | head -1 | cut -d: -f1)
if [ -z "$COL_NUM" ]; then echo "FAIL: internal error"; exit 1; fi
EXPECTED_BODY=$(tail -n +2 /workspace/data/dataset.csv | awk -F',' -v col="$COL_NUM" -v val="$VALUE" '$col == val' | sort)
if [ ! -f /workspace/output/filtered.csv ]; then echo "FAIL: /workspace/output/filtered.csv is wrong or missing"; exit 1; fi
ACTUAL_FULL=$(cat /workspace/output/filtered.csv)
FIRST_LINE=$(echo "$ACTUAL_FULL" | head -1)
if [ "$FIRST_LINE" = "$HEADER" ]; then
  ACTUAL_BODY=$(echo "$ACTUAL_FULL" | tail -n +2 | sort)
else
  ACTUAL_BODY=$(echo "$ACTUAL_FULL" | sort)
fi
if [ "$EXPECTED_BODY" = "$ACTUAL_BODY" ]; then echo "PASS"; exit 0
else echo "FAIL: /workspace/output/filtered.csv is wrong or missing"; exit 1; fi`,
      dataGenerator: generateFilteredSubsetData,
    },
  ],

  // ── Tier 4: Verify (structural gap errors — agent must inspect output) ──
  4: [
    {
      title: "Quoted CSV Aggregation",
      verifyScript: `#!/bin/bash
node -e "
const fs = require('fs');
const raw = fs.readFileSync('/workspace/data/sales.csv','utf-8').trim().split('\\n');
const totals = {};
for (let i = 1; i < raw.length; i++) {
  const line = raw[i].trim();
  if (!line) continue;
  // Proper CSV parse: handle quoted fields
  const fields = [];
  let field = '', inQuote = false;
  for (const ch of line) {
    if (ch === '\"' ) { inQuote = !inQuote; }
    else if (ch === ',' && !inQuote) { fields.push(field.trim()); field = ''; }
    else { field += ch; }
  }
  fields.push(field.trim());
  if (fields.length < 3) continue;
  const region = fields[1];
  const amount = parseFloat(fields[2]);
  if (region && !isNaN(amount)) { totals[region] = (totals[region] || 0) + amount; }
}
const expectedEntries = Object.entries(totals).sort((a,b) => a[0].localeCompare(b[0]));
const expected = expectedEntries.map(([r,v]) => r + ',' + v.toFixed(2)).join('\\n');
let output;
try { output = fs.readFileSync('/workspace/output/totals.csv','utf-8').trim().split('\\n'); }
catch(e) { console.log('FAIL: /workspace/output/totals.csv is wrong or missing'); process.exit(1); }
const hasHeader = output[0] && output[0].includes('region');
const dataLines = (hasHeader ? output.slice(1) : output).filter(l => l.trim());
if (expectedEntries.length !== dataLines.length) {
  console.log('FAIL: /workspace/output/totals.csv — row count: got ' + dataLines.length + ', expected ' + expectedEntries.length);
  process.exit(1);
}
const actual = dataLines.sort().join('\\n');
if (expected === actual) { console.log('PASS'); process.exit(0); }
else { console.log('FAIL: /workspace/output/totals.csv — values are incorrect'); process.exit(1); }
" 2>&1`,
      dataGenerator: () => ({
        "sales.csv": generateQuotedCsvData(),
      }),
    },
    {
      title: "Case-insensitive Dedup",
      verifyScript: `#!/bin/bash
EXPECTED=$(tr '[:upper:]' '[:lower:]' < /workspace/data/words.txt | sort -u)
EXPECTED_COUNT=$(echo "$EXPECTED" | wc -l | tr -d ' ')
if [ ! -f /workspace/output/unique.txt ]; then echo "FAIL: /workspace/output/unique.txt is wrong or missing"; exit 1; fi
ACTUAL_NORM=$(tr '[:upper:]' '[:lower:]' < /workspace/output/unique.txt | sort -u)
ACTUAL_COUNT=$(echo "$ACTUAL_NORM" | wc -l | tr -d ' ')
if [ "$EXPECTED_COUNT" != "$ACTUAL_COUNT" ]; then
  echo "FAIL: /workspace/output/unique.txt — count: got $ACTUAL_COUNT, expected $EXPECTED_COUNT"
  exit 1
fi
if [ "$EXPECTED" = "$ACTUAL_NORM" ]; then echo "PASS"; exit 0
else echo "FAIL: /workspace/output/unique.txt — some entries are wrong"; exit 1; fi`,
      dataGenerator: () => ({
        "words.txt": generateMixedCaseWords(),
      }),
    },
    {
      title: "Dirty Data Parse",
      verifyScript: `#!/bin/bash
node -e "
const fs = require('fs');
const lines = fs.readFileSync('/workspace/data/numbers.txt','utf-8').trim().split('\\n');
let sum = 0;
for (const line of lines) {
  let s = line.trim();
  if (!s) continue;
  // Handle parenthetical negatives: (250.00) -> -250.00
  if (s.startsWith('(') && s.endsWith(')')) { s = '-' + s.slice(1, -1); }
  // Strip dollar signs and commas
  s = s.replace(/[\\$,]/g, '');
  // Strip leading zeros but keep 0 and 0.xx
  s = s.replace(/^0+(?=\\d)/, '');
  const n = parseFloat(s);
  if (!isNaN(n)) sum += n;
}
const expected = (Math.round(sum * 100) / 100).toFixed(2);
let actual;
try { actual = fs.readFileSync('/workspace/output/total.txt','utf-8').trim(); }
catch(e) { console.log('FAIL: /workspace/output/total.txt is wrong or missing'); process.exit(1); }
if (actual === expected) { console.log('PASS'); process.exit(0); }
else { console.log('FAIL: /workspace/output/total.txt is wrong'); process.exit(1); }
" 2>&1`,
      dataGenerator: () => ({
        "numbers.txt": generateDirtyNumbers(),
      }),
    },
  ],

  // ── Tier 5: Decompose (multi-step, per-field errors) ──
  5: [
    {
      title: "Moving Average",
      verifyScript: `#!/bin/bash
node -e "
const fs = require('fs');
const input = fs.readFileSync('/workspace/data/timeseries.csv','utf-8').trim().split('\\n').slice(1);
let output;
try { output = fs.readFileSync('/workspace/output/moving_avg.csv','utf-8').trim().split('\\n'); }
catch(e) { console.log('FAIL: /workspace/output/moving_avg.csv is wrong or missing'); process.exit(1); }
const hasHeader = output[0] && output[0].includes('date');
const dataLines = hasHeader ? output.slice(1) : output;
const vals = input.map(l => ({ date: l.split(',')[0], value: parseFloat(l.split(',')[1]) }));
let expectedCount = vals.length - 6;
if (dataLines.length !== expectedCount) { console.log('FAIL: /workspace/output/moving_avg.csv — row count: got ' + dataLines.length + ', expected ' + expectedCount); process.exit(1); }
let ok = true;
for (let i = 6; i < vals.length; i++) {
  const avg = vals.slice(i-6, i+1).reduce((s,v) => s + v.value, 0) / 7;
  const parts = dataLines[i-6].split(',');
  const actualAvg = parseFloat(parts[2]);
  if (Math.abs(actualAvg - Math.round(avg*100)/100) > 0.02) { console.log('FAIL: /workspace/output/moving_avg.csv — average values are wrong'); ok=false; break; }
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
let output;
try { output = fs.readFileSync('/workspace/output/region_revenue.csv','utf-8').trim().split('\\n'); }
catch(e) { console.log('FAIL: /workspace/output/region_revenue.csv is wrong or missing'); process.exit(1); }
const hasHeader = output[0] && output[0].includes('region');
const actual = (hasHeader ? output.slice(1) : output).join('\\n');
if (expected === actual) { console.log('PASS'); process.exit(0); }
else { console.log('FAIL: /workspace/output/region_revenue.csv — values are wrong'); process.exit(1); }
" 2>&1`,
      dataGenerator: () => {
        const { csv: customersCsv, ids } = generateCustomers(randomInt(500, 1000));
        return {
          "orders.csv": generateLargeOrders(randomInt(10000, 15000), ids),
          "customers.csv": customersCsv,
        };
      },
    },
    {
      title: "ETL Cross-format",
      verifyScript: `#!/bin/bash
node -e "
const fs = require('fs');
const csvLines = fs.readFileSync('/workspace/data/customers.csv','utf-8').trim().split('\\n');
const csvHeader = csvLines[0].split(',');
const custIdIdx = csvHeader.indexOf('customer_id');
const regionIdx = csvHeader.indexOf('region');
const custRegion = {};
for (let i = 1; i < csvLines.length; i++) {
  const fields = csvLines[i].split(',');
  custRegion[fields[custIdIdx]] = fields[regionIdx];
}
const jsonLines = fs.readFileSync('/workspace/data/orders.jsonl','utf-8').trim().split('\\n');
const regionRevenue = {};
for (const line of jsonLines) {
  const order = JSON.parse(line);
  const region = custRegion[order.customer_id];
  if (!region) continue;
  regionRevenue[region] = (regionRevenue[region] || 0) + order.revenue;
}
const expected = Object.entries(regionRevenue).sort((a,b)=>a[0].localeCompare(b[0])).map(([r,v])=>r+','+(Math.round(v*100)/100).toFixed(2)).join('\\n');
let output;
try { output = fs.readFileSync('/workspace/output/revenue_by_region.csv','utf-8').trim().split('\\n'); }
catch(e) { console.log('FAIL: /workspace/output/revenue_by_region.csv is wrong or missing'); process.exit(1); }
const hasHeader = output[0] && output[0].includes('region');
const actual = (hasHeader ? output.slice(1) : output).join('\\n');
if (expected === actual) { console.log('PASS'); process.exit(0); }
else { console.log('FAIL: /workspace/output/revenue_by_region.csv — values are wrong'); process.exit(1); }
" 2>&1`,
      dataGenerator: generateEtlData,
    },
    {
      title: "HTTP Health Server",
      verifyScript: `#!/bin/bash
node /workspace/output/server.js &
PID=$!
sleep 1
RESULT=$(curl -s http://localhost:8080/health)
kill $PID 2>/dev/null
if [ "$RESULT" = "ok" ]; then echo "PASS"; exit 0; else echo "FAIL: /workspace/output/server.js — create an HTTP server on port 8080 with GET /health returning a health status"; exit 1; fi`,
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
if ! echo "$R1" | grep -q "bob" || ! echo "$R1" | grep -q "alice"; then echo "FAIL: /workspace/output/server.js — GET /data should return all posted rows"; exit 1; fi
# Check sorted - alice should come before bob
ALICE_LINE=$(echo "$R2" | grep -n "alice" | head -1 | cut -d: -f1)
BOB_LINE=$(echo "$R2" | grep -n "bob" | head -1 | cut -d: -f1)
if [ -z "$ALICE_LINE" ] || [ -z "$BOB_LINE" ]; then echo "FAIL: /workspace/output/server.js — GET /data?sort=key should return rows sorted by that field"; exit 1; fi
if [ "$ALICE_LINE" -lt "$BOB_LINE" ]; then echo "PASS"; exit 0; else echo "FAIL: /workspace/output/server.js — sort order is incorrect for GET /data?sort=key"; exit 1; fi`,
    },
    {
      title: "Log Processor Pipeline",
      verifyScript: `#!/bin/bash
bash /workspace/output/process.sh 2>/dev/null
node -e "
const fs = require('fs');
const log = fs.readFileSync('/workspace/data/app.log','utf-8').trim().split('\\n');
let report;
try { report = JSON.parse(fs.readFileSync('/workspace/output/report.json','utf-8')); }
catch(e) { console.log('FAIL: /workspace/output/report.json is wrong or missing'); process.exit(1); }
if (report.total_lines !== log.length) { console.log('FAIL: /workspace/output/report.json — total_lines is wrong'); process.exit(1); }
const byLevel = {};
const byService = {};
const errorMessages = {};
log.forEach(line => {
  const levelMatch = line.match(/\\[([A-Z]+)\\]/g);
  if (levelMatch && levelMatch.length >= 2) {
    const level = levelMatch[1].replace(/[\\[\\]]/g, '');
    byLevel[level] = (byLevel[level] || 0) + 1;
    if (level === 'ERROR' || level === 'FATAL') {
      const msgMatch = line.match(/\\] \\[[a-z_]+\\] (.+)$/);
      if (msgMatch) { errorMessages[msgMatch[1]] = (errorMessages[msgMatch[1]] || 0) + 1; }
    }
  }
  const svcMatch = line.match(/\\] \\[([a-z_]+)\\]/);
  if (svcMatch) { byService[svcMatch[1]] = (byService[svcMatch[1]] || 0) + 1; }
});
for (const [k,v] of Object.entries(byLevel)) {
  if ((report.by_level[k] || 0) !== v) { console.log('FAIL: /workspace/output/report.json — by_level is wrong'); process.exit(1); }
}
if (report.by_service) {
  for (const [k,v] of Object.entries(byService)) {
    if ((report.by_service[k] || 0) !== v) { console.log('FAIL: /workspace/output/report.json — by_service is wrong'); process.exit(1); }
  }
}
const errFatal = (byLevel['ERROR']||0) + (byLevel['FATAL']||0);
const expectedRate = Math.round(errFatal / log.length * 100) / 100;
if (Math.abs(report.error_rate - expectedRate) > 0.01) { console.log('FAIL: /workspace/output/report.json — error_rate is wrong'); process.exit(1); }
const top5 = Object.entries(errorMessages).sort((a,b) => b[1]-a[1]).slice(0,5).map(e => e[0]);
if (report.top_5_error_messages) {
  if (JSON.stringify(report.top_5_error_messages) !== JSON.stringify(top5)) { console.log('FAIL: /workspace/output/report.json — top_5_error_messages is wrong'); process.exit(1); }
}
console.log('PASS'); process.exit(0);
" 2>&1`,
      dataGenerator: () => ({
        "app.log": generateLargeLogForPipeline(randomInt(50000, 100000)),
      }),
    },
  ],

  // ── Tier 6: Batch/Reuse (budget forces scripting, per-file errors) ──
  6: [
    {
      title: "Batch Transform",
      verifyScript: `#!/bin/bash
for i in $(seq -w 1 10); do
  INPUT="/workspace/data/batch_0$i.csv"
  OUTPUT="/workspace/output/batch_0$i.csv"
  if [ ! -f "$OUTPUT" ]; then
    echo "FAIL: $OUTPUT is wrong or missing"
    exit 1
  fi
  EXPECTED=$(tail -n +2 "$INPUT" | awk -F',' '{a[$3]+=$4} END {for(k in a) printf "%s,%.2f\\n",k,a[k]}' | sort)
  ACTUAL_FULL=$(cat "$OUTPUT")
  FIRST_LINE=$(echo "$ACTUAL_FULL" | head -1)
  if echo "$FIRST_LINE" | grep -q "region"; then
    ACTUAL=$(echo "$ACTUAL_FULL" | tail -n +2 | sort)
  else
    ACTUAL=$(echo "$ACTUAL_FULL" | sort)
  fi
  if [ "$EXPECTED" != "$ACTUAL" ]; then
    echo "FAIL: $OUTPUT is wrong"
    exit 1
  fi
done
echo "PASS"
exit 0`,
      dataGenerator: generateBatchFiles,
    },
    {
      title: "Multi-Dataset Comparison",
      verifyScript: `#!/bin/bash
node -e "
const fs = require('fs');
const quarters = ['Q1','Q2','Q3','Q4','Q5'];
const totals = {};
for (const q of quarters) {
  const lines = fs.readFileSync('/workspace/data/' + q + '.csv','utf-8').trim().split('\\n').slice(1);
  let total = 0;
  for (const line of lines) {
    const fields = line.split(',');
    const amount = parseFloat(fields[fields.length - 1]);
    if (!isNaN(amount)) total += amount;
  }
  totals[q] = Math.round(total * 100) / 100;
}
const expectedLines = quarters.map((q, i) => {
  const delta = i > 0 ? (totals[q] - totals[quarters[i-1]]).toFixed(2) : '0.00';
  return q + ',' + totals[q].toFixed(2) + ',' + delta;
});
const expected = expectedLines.join('\\n');
let output;
try { output = fs.readFileSync('/workspace/output/summary.csv','utf-8').trim().split('\\n'); }
catch(e) { console.log('FAIL: /workspace/output/summary.csv is wrong or missing'); process.exit(1); }
const hasHeader = output[0] && output[0].includes('quarter');
const dataLines = hasHeader ? output.slice(1) : output;
if (dataLines.length !== 5) {
  console.log('FAIL: /workspace/output/summary.csv — expected 5 rows, got ' + dataLines.length);
  process.exit(1);
}
const actual = dataLines.join('\\n');
if (expected === actual) { console.log('PASS'); process.exit(0); }
for (let i = 0; i < 5; i++) {
  if (!dataLines[i]) { console.log('FAIL: /workspace/output/summary.csv — missing data for ' + quarters[i]); process.exit(1); }
  const parts = dataLines[i].split(',');
  if (Math.abs(parseFloat(parts[1]) - totals[quarters[i]]) > 0.02) {
    console.log('FAIL: /workspace/output/summary.csv — ' + quarters[i] + ' total is wrong');
    process.exit(1);
  }
}
console.log('FAIL: /workspace/output/summary.csv — delta values are wrong');
process.exit(1);
" 2>&1`,
      dataGenerator: generateQuarterlyData,
    },
  ],
};

export class TaskGenerator {
  generateTask(tier: number, currentCycle: number): Task {
    const effectiveTier = Math.min(Math.max(tier, 1), MAX_TIER);
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

    rmSync(dataDir, { recursive: true, force: true });
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(outputDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });
    mkdirSync(toolsDir, { recursive: true });

    // Seed default tools from project tools/ directory
    if (!existsSync(join(toolsDir, "shell"))) {
      for (const name of readdirSync(DEFAULT_TOOLS_DIR)) {
        const src = readFileSync(join(DEFAULT_TOOLS_DIR, name));
        writeFileSync(join(toolsDir, name), src, { mode: 0o755 });
      }
    }

    // Write a thin check stub — the real verification runs host-side
    // Agents can only execute check, never read the verification logic
    const checkStub = `#!/bin/bash
# description: check - Probe the environment. No args. Returns a signal about the current state.
echo "__VERIFY__"`;
    writeFileSync(join(toolsDir, "check"), checkStub, {
      mode: 0o755,
      encoding: "utf-8",
    });

    // Find the template for data generation
    const effectiveTier = Math.min(Math.max(task.tier, 1), MAX_TIER);
    const templates = TIER_TEMPLATES[effectiveTier] ?? TIER_TEMPLATES[1]!;
    const template = templates.find((t) => t.title === task.title) ?? templates[0]!;

    // Write data files
    if (template.dataGenerator) {
      const dataFiles = template.dataGenerator();
      for (const [name, content] of Object.entries(dataFiles)) {
        writeFileSync(join(dataDir, name), content, "utf-8");
      }
    }
  }

  /** Return the raw verify script for a task (never exposed to agents). */
  getVerifyScript(task: Task): string {
    const effectiveTier = Math.min(Math.max(task.tier, 1), MAX_TIER);
    const templates = TIER_TEMPLATES[effectiveTier] ?? TIER_TEMPLATES[1]!;
    const template = templates.find((t) => t.title === task.title) ?? templates[0]!;
    return template.verifyScript;
  }
}
