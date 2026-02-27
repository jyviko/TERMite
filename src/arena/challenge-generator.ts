import { randomUUID } from "node:crypto";
import type { Challenge, ChallengeCategory } from "../types/index.js";

// Difficulty → base reward (TEQ from pool, before depletion/multipliers)
export const DIFFICULTY_REWARDS: Record<number, number> = {
  1: 150_000,
  2: 250_000,
  3: 400_000,
  4: 600_000,
  5: 1_000_000,
};

// Expected variable cost per difficulty level (used by efficiency bonus)
export const DIFFICULTY_EXPECTED_COST: Record<number, number> = {
  1: 80_000,
  2: 120_000,
  3: 180_000,
  4: 250_000,
  5: 400_000,
};

// Cycles before challenge expires
const DIFFICULTY_EXPIRY: Record<number, number> = {
  1: 15,
  2: 20,
  3: 25,
  4: 30,
  5: 40,
};

// ── Utility ──

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ── Data generators ── (reused from task-generator.ts)

function generateNumbers(count: number, max: number): string {
  return Array.from({ length: count }, () => randomInt(1, max)).join("\n");
}

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
  const poolSize = Math.floor(count * 0.7);
  const pool = Array.from({ length: poolSize }, () => randomInt(1, 100000));
  return Array.from({ length: count }, () => pool[randomInt(0, pool.length - 1)]!).join("\n");
}

// ── Discovery data generators ──

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

// ── Verification data generators ──

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
      lines.push(value.toFixed(2));
    } else if (r < 0.65) {
      const formatted = value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      lines.push(`$${formatted}`);
    } else if (r < 0.80) {
      lines.push(String(value.toFixed(2)).padStart(12, "0"));
    } else if (r < 0.90) {
      lines.push(`-${value.toFixed(2)}`);
    } else {
      lines.push(`(${value.toFixed(2)})`);
    }
  }
  return lines.join("\n");
}

// ── Compositional data generators ──

function generateTimeSeries(days: number): string {
  const lines = ["date,value"];
  let value = randomInt(50, 150);
  const startDate = new Date("2023-01-01");
  for (let i = 0; i < days; i++) {
    const date = new Date(startDate.getTime() + i * 86400000);
    const dateStr = date.toISOString().slice(0, 10);
    value += randomInt(-10, 12);
    if (value < 0) value = randomInt(0, 10);
    lines.push(`${dateStr},${value}`);
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
    files[`batch_${String(i).padStart(3, "0")}.csv`] = generateLargeSalesCsv(randomInt(200, 500));
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

// ── Challenge templates ──

interface ChallengeTemplate {
  title: string;
  category: ChallengeCategory;
  difficulty: number;
  makeVerifyScript: (id: string) => string;
  dataGenerator?: () => Record<string, string>;
}

// Helper: common path vars for verify scripts
// CDIR = challenge data dir (read-only shared mount)
// ODIR = agent output dir (per-agent workspace)
function paths(id: string): string {
  return `CDIR="/shared/challenges/${id}"\nODIR="/workspace/output/${id}"`;
}

const TEMPLATES: ChallengeTemplate[] = [
  // ── Difficulty 1: Computational (stimulus-response) ──
  {
    title: "Hello World",
    category: "computational",
    difficulty: 1,
    makeVerifyScript: (id) => `#!/bin/bash
${paths(id)}
EXPECTED="Hello, World!"
ACTUAL=$(cat "$ODIR/greeting.txt" 2>/dev/null)
if [ "$ACTUAL" = "$EXPECTED" ]; then echo "PASS"; exit 0; else echo "FAIL: output/${id}/greeting.txt is wrong or missing"; exit 1; fi`,
  },
  {
    title: "Count Lines",
    category: "computational",
    difficulty: 1,
    makeVerifyScript: (id) => `#!/bin/bash
${paths(id)}
EXPECTED=$(wc -l < "$CDIR/numbers.txt" | tr -d ' ')
ACTUAL=$(cat "$ODIR/count.txt" 2>/dev/null | tr -d '[:space:]')
if [ "$ACTUAL" = "$EXPECTED" ]; then echo "PASS"; exit 0; else echo "FAIL: output/${id}/count.txt — write the line count of the numbers file"; exit 1; fi`,
    dataGenerator: () => ({
      "numbers.txt": generateNumbers(randomInt(5000, 8000), 1000),
    }),
  },
  {
    title: "Sum Numbers",
    category: "computational",
    difficulty: 1,
    makeVerifyScript: (id) => `#!/bin/bash
${paths(id)}
EXPECTED=$(awk '{s+=$1} END {print s}' "$CDIR/numbers.txt")
ACTUAL=$(cat "$ODIR/sum.txt" 2>/dev/null | tr -d '[:space:]')
if [ "$ACTUAL" = "$EXPECTED" ]; then echo "PASS"; exit 0; else echo "FAIL: output/${id}/sum.txt — write the sum of numbers"; exit 1; fi`,
    dataGenerator: () => ({
      "numbers.txt": generateNumbers(randomInt(5000, 8000), 10000),
    }),
  },

  // ── Difficulty 2: Computational (transform) ──
  {
    title: "Sort Numbers",
    category: "computational",
    difficulty: 2,
    makeVerifyScript: (id) => `#!/bin/bash
${paths(id)}
EXPECTED=$(sort -n "$CDIR/numbers.txt")
ACTUAL=$(cat "$ODIR/sorted.txt" 2>/dev/null)
if [ "$EXPECTED" = "$ACTUAL" ]; then echo "PASS"; exit 0; else echo "FAIL: output/${id}/sorted.txt — sort the numbers numerically"; exit 1; fi`,
    dataGenerator: () => ({
      "numbers.txt": generateNumbers(randomInt(10000, 15000), 1000000),
    }),
  },
  {
    title: "Extract Emails",
    category: "computational",
    difficulty: 2,
    makeVerifyScript: (id) => `#!/bin/bash
${paths(id)}
EXPECTED=$(grep -oE '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}' "$CDIR/contacts.txt" | sort)
ACTUAL=$(sort "$ODIR/emails.txt" 2>/dev/null)
if [ "$EXPECTED" = "$ACTUAL" ]; then echo "PASS"; exit 0; else echo "FAIL: output/${id}/emails.txt — extract all emails, one per line, sorted"; exit 1; fi`,
    dataGenerator: () => ({
      "contacts.txt": generateLargeContacts(randomInt(8000, 12000)),
    }),
  },
  {
    title: "Find Duplicates",
    category: "computational",
    difficulty: 2,
    makeVerifyScript: (id) => `#!/bin/bash
${paths(id)}
EXPECTED=$(sort -n "$CDIR/numbers.txt" | uniq -d | sort -n)
ACTUAL=$(cat "$ODIR/duplicates.txt" 2>/dev/null | sort -n)
if [ "$EXPECTED" = "$ACTUAL" ]; then echo "PASS"; exit 0; else echo "FAIL: output/${id}/duplicates.txt — find duplicate numbers, sorted numerically"; exit 1; fi`,
    dataGenerator: () => ({
      "numbers.txt": generateNumbersWithDuplicates(randomInt(10000, 15000)),
    }),
  },

  // ── Difficulty 3: Discovery (opaque — agent must read data to discover spec) ──
  {
    title: "Column Extract",
    category: "discovery",
    difficulty: 3,
    makeVerifyScript: (id) => `#!/bin/bash
${paths(id)}
TARGET=$(cat "$CDIR/.meta")
HEADER=$(head -1 "$CDIR/dataset.csv")
COL_NUM=$(echo "$HEADER" | tr ',' '\\n' | grep -n "^$TARGET$" | head -1 | cut -d: -f1)
if [ -z "$COL_NUM" ]; then echo "FAIL: internal error"; exit 1; fi
EXPECTED=$(tail -n +2 "$CDIR/dataset.csv" | cut -d',' -f"$COL_NUM")
ACTUAL=$(cat "$ODIR/$TARGET.txt" 2>/dev/null)
if [ "$EXPECTED" = "$ACTUAL" ]; then echo "PASS"; exit 0
else echo "FAIL: output/${id}/$TARGET.txt is wrong or missing"; exit 1; fi`,
    dataGenerator: generateColumnExtractData,
  },
  {
    title: "Directive File",
    category: "discovery",
    difficulty: 3,
    makeVerifyScript: (id) => `#!/bin/bash
${paths(id)}
OP=$(head -1 "$CDIR/input.txt" | sed 's/OPERATION: //')
DATA=$(tail -n +2 "$CDIR/input.txt")
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
ACTUAL=$(cat "$ODIR/result.txt" 2>/dev/null)
if [ "$EXPECTED" = "$ACTUAL" ]; then echo "PASS"; exit 0
else echo "FAIL: output/${id}/result.txt is wrong or missing"; exit 1; fi`,
    dataGenerator: generateDirectiveFileData,
  },
  {
    title: "Filtered Subset",
    category: "discovery",
    difficulty: 3,
    makeVerifyScript: (id) => `#!/bin/bash
${paths(id)}
FILTER=$(cat "$CDIR/filter.txt")
FIELD=$(echo "$FILTER" | cut -d= -f1)
VALUE=$(echo "$FILTER" | cut -d= -f2)
HEADER=$(head -1 "$CDIR/dataset.csv")
COL_NUM=$(echo "$HEADER" | tr ',' '\\n' | grep -n "^$FIELD$" | head -1 | cut -d: -f1)
if [ -z "$COL_NUM" ]; then echo "FAIL: internal error"; exit 1; fi
EXPECTED_BODY=$(tail -n +2 "$CDIR/dataset.csv" | awk -F',' -v col="$COL_NUM" -v val="$VALUE" '$col == val' | sort)
if [ ! -f "$ODIR/filtered.csv" ]; then echo "FAIL: output/${id}/filtered.csv is wrong or missing"; exit 1; fi
ACTUAL_FULL=$(cat "$ODIR/filtered.csv")
FIRST_LINE=$(echo "$ACTUAL_FULL" | head -1)
if [ "$FIRST_LINE" = "$HEADER" ]; then
  ACTUAL_BODY=$(echo "$ACTUAL_FULL" | tail -n +2 | sort)
else
  ACTUAL_BODY=$(echo "$ACTUAL_FULL" | sort)
fi
if [ "$EXPECTED_BODY" = "$ACTUAL_BODY" ]; then echo "PASS"; exit 0
else echo "FAIL: output/${id}/filtered.csv is wrong or missing"; exit 1; fi`,
    dataGenerator: generateFilteredSubsetData,
  },

  // ── Difficulty 4: Discovery/Compositional (structural gaps) ──
  {
    title: "Quoted CSV Aggregation",
    category: "discovery",
    difficulty: 4,
    makeVerifyScript: (id) => `#!/bin/bash
${paths(id)}
node -e "
const fs = require('fs');
const raw = fs.readFileSync('$CDIR/sales.csv','utf-8').trim().split('\\n');
const totals = {};
for (let i = 1; i < raw.length; i++) {
  const line = raw[i].trim();
  if (!line) continue;
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
try { output = fs.readFileSync('$ODIR/totals.csv','utf-8').trim().split('\\n'); }
catch(e) { console.log('FAIL: output/${id}/totals.csv is wrong or missing'); process.exit(1); }
const hasHeader = output[0] && output[0].includes('region');
const dataLines = (hasHeader ? output.slice(1) : output).filter(l => l.trim());
if (expectedEntries.length !== dataLines.length) {
  console.log('FAIL: output/${id}/totals.csv — row count mismatch');
  process.exit(1);
}
const actual = dataLines.sort().join('\\n');
if (expected === actual) { console.log('PASS'); process.exit(0); }
else { console.log('FAIL: output/${id}/totals.csv — values are incorrect'); process.exit(1); }
" 2>&1`,
    dataGenerator: () => ({
      "sales.csv": generateQuotedCsvData(),
    }),
  },
  {
    title: "Case-insensitive Dedup",
    category: "discovery",
    difficulty: 4,
    makeVerifyScript: (id) => `#!/bin/bash
${paths(id)}
EXPECTED=$(tr '[:upper:]' '[:lower:]' < "$CDIR/words.txt" | sort -u)
EXPECTED_COUNT=$(echo "$EXPECTED" | wc -l | tr -d ' ')
if [ ! -f "$ODIR/unique.txt" ]; then echo "FAIL: output/${id}/unique.txt is wrong or missing"; exit 1; fi
ACTUAL_NORM=$(tr '[:upper:]' '[:lower:]' < "$ODIR/unique.txt" | sort -u)
ACTUAL_COUNT=$(echo "$ACTUAL_NORM" | wc -l | tr -d ' ')
if [ "$EXPECTED_COUNT" != "$ACTUAL_COUNT" ]; then
  echo "FAIL: output/${id}/unique.txt — count: got $ACTUAL_COUNT, expected $EXPECTED_COUNT"
  exit 1
fi
if [ "$EXPECTED" = "$ACTUAL_NORM" ]; then echo "PASS"; exit 0
else echo "FAIL: output/${id}/unique.txt — some entries are wrong"; exit 1; fi`,
    dataGenerator: () => ({
      "words.txt": generateMixedCaseWords(),
    }),
  },
  {
    title: "Dirty Data Parse",
    category: "discovery",
    difficulty: 4,
    makeVerifyScript: (id) => `#!/bin/bash
${paths(id)}
node -e "
const fs = require('fs');
const lines = fs.readFileSync('$CDIR/numbers.txt','utf-8').trim().split('\\n');
let sum = 0;
for (const line of lines) {
  let s = line.trim();
  if (!s) continue;
  if (s.startsWith('(') && s.endsWith(')')) { s = '-' + s.slice(1, -1); }
  s = s.replace(/[\\$,]/g, '');
  s = s.replace(/^0+(?=\\d)/, '');
  const n = parseFloat(s);
  if (!isNaN(n)) sum += n;
}
const expected = (Math.round(sum * 100) / 100).toFixed(2);
let actual;
try { actual = fs.readFileSync('$ODIR/total.txt','utf-8').trim(); }
catch(e) { console.log('FAIL: output/${id}/total.txt is wrong or missing'); process.exit(1); }
if (actual === expected) { console.log('PASS'); process.exit(0); }
else { console.log('FAIL: output/${id}/total.txt is wrong'); process.exit(1); }
" 2>&1`,
    dataGenerator: () => ({
      "numbers.txt": generateDirtyNumbers(),
    }),
  },
  {
    title: "Moving Average",
    category: "compositional",
    difficulty: 4,
    makeVerifyScript: (id) => `#!/bin/bash
${paths(id)}
node -e "
const fs = require('fs');
const input = fs.readFileSync('$CDIR/timeseries.csv','utf-8').trim().split('\\n').slice(1);
let output;
try { output = fs.readFileSync('$ODIR/moving_avg.csv','utf-8').trim().split('\\n'); }
catch(e) { console.log('FAIL: output/${id}/moving_avg.csv is wrong or missing'); process.exit(1); }
const hasHeader = output[0] && output[0].includes('date');
const dataLines = hasHeader ? output.slice(1) : output;
const vals = input.map(l => ({ date: l.split(',')[0], value: parseFloat(l.split(',')[1]) }));
let expectedCount = vals.length - 6;
if (dataLines.length !== expectedCount) { console.log('FAIL: output/${id}/moving_avg.csv — row count: got ' + dataLines.length + ', expected ' + expectedCount); process.exit(1); }
let ok = true;
for (let i = 6; i < vals.length; i++) {
  const avg = vals.slice(i-6, i+1).reduce((s,v) => s + v.value, 0) / 7;
  const parts = dataLines[i-6].split(',');
  const actualAvg = parseFloat(parts[2]);
  if (Math.abs(actualAvg - Math.round(avg*100)/100) > 0.02) { console.log('FAIL: output/${id}/moving_avg.csv — average values are wrong'); ok=false; break; }
}
if (ok) { console.log('PASS'); process.exit(0); } else { process.exit(1); }
" 2>&1`,
    dataGenerator: () => ({
      "timeseries.csv": generateTimeSeries(randomInt(10000, 15000)),
    }),
  },
  {
    title: "Join and Aggregate",
    category: "compositional",
    difficulty: 4,
    makeVerifyScript: (id) => `#!/bin/bash
${paths(id)}
node -e "
const fs = require('fs');
const orders = fs.readFileSync('$CDIR/orders.csv','utf-8').trim().split('\\n').slice(1);
const customers = fs.readFileSync('$CDIR/customers.csv','utf-8').trim().split('\\n').slice(1);
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
try { output = fs.readFileSync('$ODIR/region_revenue.csv','utf-8').trim().split('\\n'); }
catch(e) { console.log('FAIL: output/${id}/region_revenue.csv is wrong or missing'); process.exit(1); }
const hasHeader = output[0] && output[0].includes('region');
const actual = (hasHeader ? output.slice(1) : output).join('\\n');
if (expected === actual) { console.log('PASS'); process.exit(0); }
else { console.log('FAIL: output/${id}/region_revenue.csv — values are wrong'); process.exit(1); }
" 2>&1`,
    dataGenerator: () => {
      const { csv: customersCsv, ids } = generateCustomers(randomInt(500, 1000));
      return {
        "orders.csv": generateLargeOrders(randomInt(10000, 15000), ids),
        "customers.csv": customersCsv,
      };
    },
  },

  // ── Difficulty 5: Compositional (multi-step, multi-file) ──
  {
    title: "ETL Cross-format",
    category: "compositional",
    difficulty: 5,
    makeVerifyScript: (id) => `#!/bin/bash
${paths(id)}
node -e "
const fs = require('fs');
const csvLines = fs.readFileSync('$CDIR/customers.csv','utf-8').trim().split('\\n');
const csvHeader = csvLines[0].split(',');
const custIdIdx = csvHeader.indexOf('customer_id');
const regionIdx = csvHeader.indexOf('region');
const custRegion = {};
for (let i = 1; i < csvLines.length; i++) {
  const fields = csvLines[i].split(',');
  custRegion[fields[custIdIdx]] = fields[regionIdx];
}
const jsonLines = fs.readFileSync('$CDIR/orders.jsonl','utf-8').trim().split('\\n');
const regionRevenue = {};
for (const line of jsonLines) {
  const order = JSON.parse(line);
  const region = custRegion[order.customer_id];
  if (!region) continue;
  regionRevenue[region] = (regionRevenue[region] || 0) + order.revenue;
}
const expected = Object.entries(regionRevenue).sort((a,b)=>a[0].localeCompare(b[0])).map(([r,v])=>r+','+(Math.round(v*100)/100).toFixed(2)).join('\\n');
let output;
try { output = fs.readFileSync('$ODIR/revenue_by_region.csv','utf-8').trim().split('\\n'); }
catch(e) { console.log('FAIL: output/${id}/revenue_by_region.csv is wrong or missing'); process.exit(1); }
const hasHeader = output[0] && output[0].includes('region');
const actual = (hasHeader ? output.slice(1) : output).join('\\n');
if (expected === actual) { console.log('PASS'); process.exit(0); }
else { console.log('FAIL: output/${id}/revenue_by_region.csv — values are wrong'); process.exit(1); }
" 2>&1`,
    dataGenerator: generateEtlData,
  },
  {
    title: "Log Processor Pipeline",
    category: "compositional",
    difficulty: 5,
    makeVerifyScript: (id) => `#!/bin/bash
${paths(id)}
if [ -f "$ODIR/process.sh" ]; then bash "$ODIR/process.sh" 2>/dev/null; fi
node -e "
const fs = require('fs');
const log = fs.readFileSync('$CDIR/app.log','utf-8').trim().split('\\n');
let report;
try { report = JSON.parse(fs.readFileSync('$ODIR/report.json','utf-8')); }
catch(e) { console.log('FAIL: output/${id}/report.json is wrong or missing'); process.exit(1); }
if (report.total_lines !== log.length) { console.log('FAIL: output/${id}/report.json — total_lines is wrong'); process.exit(1); }
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
  if ((report.by_level[k] || 0) !== v) { console.log('FAIL: output/${id}/report.json — by_level is wrong'); process.exit(1); }
}
if (report.by_service) {
  for (const [k,v] of Object.entries(byService)) {
    if ((report.by_service[k] || 0) !== v) { console.log('FAIL: output/${id}/report.json — by_service is wrong'); process.exit(1); }
  }
}
const errFatal = (byLevel['ERROR']||0) + (byLevel['FATAL']||0);
const expectedRate = Math.round(errFatal / log.length * 100) / 100;
if (Math.abs(report.error_rate - expectedRate) > 0.01) { console.log('FAIL: output/${id}/report.json — error_rate is wrong'); process.exit(1); }
const top5 = Object.entries(errorMessages).sort((a,b) => b[1]-a[1]).slice(0,5).map(e => e[0]);
if (report.top_5_error_messages) {
  if (JSON.stringify(report.top_5_error_messages) !== JSON.stringify(top5)) { console.log('FAIL: output/${id}/report.json — top_5_error_messages is wrong'); process.exit(1); }
}
console.log('PASS'); process.exit(0);
" 2>&1`,
    dataGenerator: () => ({
      "app.log": generateLargeLogForPipeline(randomInt(50000, 100000)),
    }),
  },
  {
    title: "Batch Transform",
    category: "compositional",
    difficulty: 5,
    makeVerifyScript: (id) => `#!/bin/bash
${paths(id)}
for i in $(seq -w 1 10); do
  INPUT="$CDIR/batch_0$i.csv"
  OUTPUT="$ODIR/batch_0$i.csv"
  if [ ! -f "$OUTPUT" ]; then
    echo "FAIL: output/${id}/batch_0$i.csv is wrong or missing"
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
    echo "FAIL: output/${id}/batch_0$i.csv is wrong"
    exit 1
  fi
done
echo "PASS"
exit 0`,
    dataGenerator: generateBatchFiles,
  },
  {
    title: "Multi-Dataset Comparison",
    category: "compositional",
    difficulty: 5,
    makeVerifyScript: (id) => `#!/bin/bash
${paths(id)}
node -e "
const fs = require('fs');
const quarters = ['Q1','Q2','Q3','Q4','Q5'];
const totals = {};
for (const q of quarters) {
  const lines = fs.readFileSync('$CDIR/' + q + '.csv','utf-8').trim().split('\\n').slice(1);
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
try { output = fs.readFileSync('$ODIR/summary.csv','utf-8').trim().split('\\n'); }
catch(e) { console.log('FAIL: output/${id}/summary.csv is wrong or missing'); process.exit(1); }
const hasHeader = output[0] && output[0].includes('quarter');
const dataLines = hasHeader ? output.slice(1) : output;
if (dataLines.length !== 5) {
  console.log('FAIL: output/${id}/summary.csv — expected 5 rows, got ' + dataLines.length);
  process.exit(1);
}
const actual = dataLines.join('\\n');
if (expected === actual) { console.log('PASS'); process.exit(0); }
for (let i = 0; i < 5; i++) {
  if (!dataLines[i]) { console.log('FAIL: output/${id}/summary.csv — missing data for ' + quarters[i]); process.exit(1); }
  const parts = dataLines[i].split(',');
  if (Math.abs(parseFloat(parts[1]) - totals[quarters[i]]) > 0.02) {
    console.log('FAIL: output/${id}/summary.csv — ' + quarters[i] + ' total is wrong');
    process.exit(1);
  }
}
console.log('FAIL: output/${id}/summary.csv — delta values are wrong');
process.exit(1);
" 2>&1`,
    dataGenerator: generateQuarterlyData,
  },
  {
    title: "HTTP Health Server",
    category: "compositional",
    difficulty: 5,
    makeVerifyScript: (id) => `#!/bin/bash
${paths(id)}
node "$ODIR/server.js" &
PID=$!
sleep 1
RESULT=$(curl -s http://localhost:8080/health)
kill $PID 2>/dev/null
if [ "$RESULT" = "ok" ]; then echo "PASS"; exit 0; else echo "FAIL: output/${id}/server.js — create an HTTP server on port 8080 with GET /health returning a health status"; exit 1; fi`,
  },
  {
    title: "CSV API Server",
    category: "compositional",
    difficulty: 5,
    makeVerifyScript: (id) => `#!/bin/bash
${paths(id)}
node "$ODIR/server.js" &
PID=$!
sleep 1
curl -s -X POST http://localhost:8080/data -H 'Content-Type: application/json' -d '{"rows":[{"name":"bob","age":"30"},{"name":"alice","age":"25"}]}' > /dev/null
R1=$(curl -s http://localhost:8080/data)
R2=$(curl -s 'http://localhost:8080/data?sort=name')
kill $PID 2>/dev/null
if ! echo "$R1" | grep -q "bob" || ! echo "$R1" | grep -q "alice"; then echo "FAIL: output/${id}/server.js — GET /data should return all posted rows"; exit 1; fi
ALICE_LINE=$(echo "$R2" | grep -n "alice" | head -1 | cut -d: -f1)
BOB_LINE=$(echo "$R2" | grep -n "bob" | head -1 | cut -d: -f1)
if [ -z "$ALICE_LINE" ] || [ -z "$BOB_LINE" ]; then echo "FAIL: output/${id}/server.js — GET /data?sort=key should return rows sorted by that field"; exit 1; fi
if [ "$ALICE_LINE" -lt "$BOB_LINE" ]; then echo "PASS"; exit 0; else echo "FAIL: output/${id}/server.js — sort order is incorrect"; exit 1; fi`,
  },
];

// ── Challenge Generator ──

export interface GeneratedChallenge {
  challenge: Challenge;
  dataFiles: Record<string, string>;
}

export class ChallengeGenerator {
  generate(difficulty: number, globalCycle: number): GeneratedChallenge {
    const effectiveDifficulty = Math.min(Math.max(difficulty, 1), 5);
    const templates = TEMPLATES.filter(t => t.difficulty === effectiveDifficulty);
    if (templates.length === 0) {
      throw new Error(`No templates for difficulty ${effectiveDifficulty}`);
    }
    const template = templates[randomInt(0, templates.length - 1)]!;

    const id = `c-${randomUUID().slice(0, 8)}`;
    const dataFiles = template.dataGenerator?.() ?? {};

    const challenge: Challenge = {
      id,
      category: template.category,
      difficulty: effectiveDifficulty,
      title: template.title,
      baseReward: DIFFICULTY_REWARDS[effectiveDifficulty] ?? 150_000,
      expiresAtCycle: globalCycle + (DIFFICULTY_EXPIRY[effectiveDifficulty] ?? 20),
      dataDir: `challenges/${id}`,
      verifyScript: template.makeVerifyScript(id),
      solvedBy: [],
      appearedAtCycle: globalCycle,
    };

    return { challenge, dataFiles };
  }

  /** Generate a challenge at a random difficulty weighted toward mid-range. */
  generateWeighted(globalCycle: number): GeneratedChallenge {
    // Bell curve: more mid-difficulty challenges, fewer at extremes
    const weights = [0.15, 0.25, 0.30, 0.20, 0.10]; // diff 1-5
    const r = Math.random();
    let cumulative = 0;
    let difficulty = 3;
    for (let i = 0; i < weights.length; i++) {
      cumulative += weights[i]!;
      if (r < cumulative) { difficulty = i + 1; break; }
    }
    return this.generate(difficulty, globalCycle);
  }
}
