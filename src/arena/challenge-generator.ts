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

// ── Code fixing data generators ──

function generateFixPythonData(): Record<string, string> {
  const variants = [
    () => {
      const a = randomInt(1, 20);
      const b = a + randomInt(5, 30);
      const expected = ((b - a + 1) * (a + b)) / 2;
      return {
        script: `def sum_range(start, end):\n    total = 0\n    for i in range(start, end):\n        total += i\n    return total\n\nprint(sum_range(${a}, ${b}))`,
        expected: String(expected),
      };
    },
    () => {
      const nums = Array.from({ length: randomInt(5, 15) }, () => randomInt(1, 100));
      const expected = Math.max(...nums);
      return {
        script: `def find_max(numbers):\n    result = numbers[0]\n    for n in numbers:\n        if n < result:\n            result = n\n    return result\n\nprint(find_max(${JSON.stringify(nums)}))`,
        expected: String(expected),
      };
    },
    () => {
      const n = randomInt(5, 12);
      let factorial = 1;
      for (let i = 2; i <= n; i++) factorial *= i;
      return {
        script: `def factorial(n):\n    if n <= 1:\n        return 1\n    factorial(n - 1) * n\n\nprint(factorial(${n}))`,
        expected: String(factorial),
      };
    },
    () => {
      const items = Array.from({ length: randomInt(8, 20) }, () => randomInt(1, 50));
      const expected = items.filter(x => x % 2 === 0).reduce((a, b) => a + b, 0);
      return {
        script: `def sum_even(lst):\n    total = 0\n    for x in lst:\n        if x % 2 == 1:\n            total += x\n    return total\n\nprint(sum_even(${JSON.stringify(items)}))`,
        expected: String(expected),
      };
    },
  ];
  const v = variants[randomInt(0, variants.length - 1)]!();
  return { "script.py": v.script, ".expected": v.expected };
}

function generateFixBashData(): Record<string, string> {
  const variants = [
    () => {
      const items = Array.from({ length: randomInt(5, 15) }, () => `item ${randomInt(1, 100)}`);
      return {
        script: `#!/bin/bash\ncount=0\nfor f in ${items.join(" ")}; do\n  count=$((count + 1))\ndone\necho $count`,
        expected: String(items.length),
      };
    },
    () => {
      const n = randomInt(5, 20);
      const expected = ((n * (n + 1)) / 2);
      return {
        script: `#!/bin/bash\nsum=0\nfor i in $(seq 1 ${n}); do\n  sum=$((sum + i))\ndone\necho "$sum"`,
        expected: String(expected),
      };
    },
    () => {
      const values = Array.from({ length: randomInt(5, 10) }, () => randomInt(1, 100));
      let max = values[0]!;
      for (const v of values) if (v > max) max = v;
      return {
        script: `#!/bin/bash\nvalues=(${values.join(" ")})\nmax=\${values[0]}\nfor v in "\${values[@]}"; do\n  if [ $v -gt $max ]; then\n    max=$v\n  fi\ndone\necho $max`,
        expected: String(max),
      };
    },
  ];
  const v = variants[randomInt(0, variants.length - 1)]!();
  return { "script.sh": v.script, ".expected": v.expected };
}

function generateFixNodeData(): Record<string, string> {
  const variants = [
    () => {
      const nums = Array.from({ length: randomInt(5, 12) }, () => randomInt(1, 50));
      const expected = [...nums].sort((a, b) => a - b);
      return {
        script: `const nums = ${JSON.stringify(nums)};\nconst sorted = nums.sort();\nconsole.log(sorted.join(","));`,
        expected: expected.join(","),
      };
    },
    () => {
      const strings = ["10", "9", "20", "3", "15", "7", "100", "1"];
      const expected = strings.map(s => parseInt(s, 10)).filter(n => n > 5);
      return {
        script: `const data = ${JSON.stringify(strings)};\nconst result = data.map(s => parseInt(s)).filter(n => n > 5);\nconsole.log(result.join(","));`,
        expected: expected.join(","),
      };
    },
    () => {
      const items = Array.from({ length: randomInt(6, 12) }, (_, i) => ({ id: i + 1, val: randomInt(1, 100) }));
      const expected = items.reduce((s, x) => s + x.val, 0);
      return {
        script: `const items = ${JSON.stringify(items)};\nlet sum = 0;\nfor (let i = 0; i <= items.length; i++) {\n  sum += items[i].val;\n}\nconsole.log(sum);`,
        expected: String(expected),
      };
    },
  ];
  const v = variants[randomInt(0, variants.length - 1)]!();
  return { "script.js": v.script, ".expected": v.expected };
}

function generateMissingFunctionData(): Record<string, string> {
  const variants = [
    () => {
      const nums = Array.from({ length: randomInt(5, 15) }, () => randomInt(1, 100));
      const expected = nums.filter(n => n % 2 === 0);
      return {
        main: `from helpers import filter_even\n\nnums = ${JSON.stringify(nums)}\nresult = filter_even(nums)\nprint(",".join(str(x) for x in result))`,
        helpers: `# helpers.py\n# TODO: implement filter_even(lst) -> list of even numbers\n`,
        expected: expected.join(","),
      };
    },
    () => {
      const words = ["hello", "world", "foo", "bar", "baz", "python", "code"];
      const shuffled = [...words].sort(() => Math.random() - 0.5).slice(0, randomInt(4, 6));
      const expected = [...shuffled].sort().join(",");
      return {
        main: `from helpers import sort_words\n\nwords = ${JSON.stringify(shuffled)}\nresult = sort_words(words)\nprint(",".join(result))`,
        helpers: `# helpers.py\n# TODO: implement sort_words(words) -> sorted list of words\n`,
        expected,
      };
    },
    () => {
      const text = "the quick brown fox jumps over the lazy dog";
      const counts: Record<string, number> = {};
      for (const w of text.split(" ")) counts[w] = (counts[w] || 0) + 1;
      const expected = Object.entries(counts).sort((a, b) => a[0].localeCompare(b[0]))
        .map(([k, v]) => `${k}:${v}`).join(",");
      return {
        main: `from helpers import count_words\n\ntext = "${text}"\nresult = count_words(text)\nfor k in sorted(result.keys()):\n    print(f"{k}:{result[k]}", end=",")\nprint()`,
        helpers: `# helpers.py\n# TODO: implement count_words(text) -> dict mapping word to count\n`,
        expected: expected + ",",
      };
    },
  ];
  const v = variants[randomInt(0, variants.length - 1)]!();
  return { "main.py": v.main, "helpers.py": v.helpers, ".expected": v.expected };
}

function generateDebugMultifileData(): Record<string, string> {
  const nums = Array.from({ length: randomInt(5, 10) }, () => randomInt(1, 50));
  const doubled = nums.map(n => n * 2);
  const sumDoubled = doubled.reduce((a, b) => a + b, 0);
  const expected = `${doubled.join(",")}\n${sumDoubled}`;

  return {
    "main.py": `from transform import double_list\nfrom aggregate import total\nimport sys\n\nnums = ${JSON.stringify(nums)}\nresult = double_list(nums)\nprint(",".join(str(x) for x in result))\nprint(total(result))`,
    "transform.py": `def double_list(lst):\n    return [x * 3 for x in lst]\n`,
    "aggregate.py": `def total(lst):\n    s = 0\n    for x in lst:\n        s += x\n    return s - 1\n`,
    ".expected": expected,
  };
}

function generateFixAndExtendData(): Record<string, string> {
  const items = Array.from({ length: randomInt(8, 15) }, () => randomInt(1, 100));
  const sorted = [...items].sort((a, b) => a - b);
  const median = sorted.length % 2 === 1
    ? sorted[Math.floor(sorted.length / 2)]!
    : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
  const mean = items.reduce((a, b) => a + b, 0) / items.length;
  const expected = `mean:${mean.toFixed(2)}\nmedian:${Number(median).toFixed(2)}`;

  return {
    "stats.py": `def compute_mean(nums):\n    return sum(nums) / (len(nums) + 1)\n\ndef compute_stats(nums):\n    return {"mean": compute_mean(nums)}\n`,
    "SPEC.md": `# Stats Module\n\nThe stats.py module has bugs and is missing features.\n\n## Bugs\n- compute_mean divides by wrong value\n\n## New Features\n- Add compute_median(nums) function\n- compute_stats should return both mean and median\n\n## Expected Output\nRun main.py to produce:\nmean:<value>\nmedian:<value>\nBoth formatted to 2 decimal places.\n`,
    "main.py": `from stats import compute_stats\n\nnums = ${JSON.stringify(items)}\nresult = compute_stats(nums)\nprint(f"mean:{result['mean']:.2f}")\nprint(f"median:{result['median']:.2f}")`,
    ".expected": expected,
  };
}

// ── Image/Visual data generators ──

function generatePpmPixelCountData(): Record<string, string> {
  const w = randomInt(15, 30);
  const h = randomInt(15, 30);
  const bgR = 255, bgG = 255, bgB = 255;
  let nonBgCount = 0;
  const pixels: string[] = [];
  for (let y = 0; y < h; y++) {
    const row: string[] = [];
    for (let x = 0; x < w; x++) {
      if (Math.random() < 0.3) {
        row.push(`${randomInt(0, 200)} ${randomInt(0, 200)} ${randomInt(0, 200)}`);
        nonBgCount++;
      } else {
        row.push(`${bgR} ${bgG} ${bgB}`);
      }
    }
    pixels.push(row.join(" "));
  }
  const ppm = `P3\n${w} ${h}\n255\n${pixels.join("\n")}`;
  return { "image.ppm": ppm, ".expected": String(nonBgCount) };
}

const ASCII_LETTERS: Record<string, string[]> = {
  A: ["  #  ", " # # ", "#####", "#   #", "#   #"],
  B: ["#### ", "#   #", "#### ", "#   #", "#### "],
  C: [" ####", "#    ", "#    ", "#    ", " ####"],
  D: ["#### ", "#   #", "#   #", "#   #", "#### "],
  E: ["#####", "#    ", "#### ", "#    ", "#####"],
  F: ["#####", "#    ", "#### ", "#    ", "#    "],
  H: ["#   #", "#   #", "#####", "#   #", "#   #"],
  I: ["#####", "  #  ", "  #  ", "  #  ", "#####"],
  L: ["#    ", "#    ", "#    ", "#    ", "#####"],
  O: [" ### ", "#   #", "#   #", "#   #", " ### "],
  T: ["#####", "  #  ", "  #  ", "  #  ", "  #  "],
  X: ["#   #", " # # ", "  #  ", " # # ", "#   #"],
};

function generateAsciiArtData(): Record<string, string> {
  const letters = Object.keys(ASCII_LETTERS);
  const wordLen = randomInt(3, 5);
  const chosen: string[] = [];
  for (let i = 0; i < wordLen; i++) {
    chosen.push(letters[randomInt(0, letters.length - 1)]!);
  }
  const word = chosen.join("");

  const rows: string[] = [];
  for (let row = 0; row < 5; row++) {
    const parts: string[] = [];
    for (const letter of chosen) {
      parts.push(ASCII_LETTERS[letter]![row]!);
    }
    rows.push(parts.join("  "));
  }

  return { "art.txt": rows.join("\n"), ".expected": word };
}

function generatePpmColorHistogramData(): Record<string, string> {
  const w = randomInt(20, 40);
  const h = randomInt(20, 40);
  const palette = [
    [255, 0, 0], [0, 255, 0], [0, 0, 255],
    [255, 255, 0], [255, 0, 255], [0, 255, 255],
    [0, 0, 0], [255, 255, 255],
  ];
  const counts: Record<string, number> = {};
  const pixels: string[] = [];
  for (let y = 0; y < h; y++) {
    const row: string[] = [];
    for (let x = 0; x < w; x++) {
      const c = palette[randomInt(0, palette.length - 1)]!;
      const key = `${c[0]},${c[1]},${c[2]}`;
      counts[key] = (counts[key] || 0) + 1;
      row.push(`${c[0]} ${c[1]} ${c[2]}`);
    }
    pixels.push(row.join(" "));
  }
  const ppm = `P3\n${w} ${h}\n255\n${pixels.join("\n")}`;
  const expected = Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([color, count]) => `${color},${count}`)
    .join("\n");
  return { "image.ppm": ppm, ".expected": expected };
}

function generateSvgDataExtractData(): Record<string, string> {
  const operations = ["sum", "max", "min", "average"];
  const op = operations[randomInt(0, operations.length - 1)]!;
  const values: number[] = [];
  const textElements: string[] = [];
  const count = randomInt(4, 8);
  for (let i = 0; i < count; i++) {
    const v = randomInt(10, 500);
    values.push(v);
    const x = 50 + i * 80;
    textElements.push(`  <text x="${x}" y="100" data-value="${v}">${v}</text>`);
  }

  let result: number;
  switch (op) {
    case "sum": result = values.reduce((a, b) => a + b, 0); break;
    case "max": result = Math.max(...values); break;
    case "min": result = Math.min(...values); break;
    case "average": result = Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100; break;
    default: result = 0;
  }

  const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="800" height="200" data-operation="${op}">\n${textElements.join("\n")}\n</svg>`;
  return { "data.svg": svg, ".expected": String(result) };
}

function generatePpmEncodeMessageData(): Record<string, string> {
  const words = ["HELLO", "AGENT", "CODE", "DATA", "TEST", "PIXEL", "BYTE"];
  const message = words[randomInt(0, words.length - 1)]!;
  const w = 40;
  const h = 10;

  const spec = `# LSB Steganography Spec\n\nEncode the message from message.txt into image.ppm using LSB encoding.\n\n## Algorithm\n1. Read the message as ASCII bytes\n2. For each bit of each byte (MSB first), modify the LSB of the RED channel\n   of consecutive pixels (left-to-right, top-to-bottom)\n3. After all message bits, set the next 8 pixel red LSBs to 0 (null terminator)\n4. Leave all other pixels unchanged\n\nWrite the result to output as encoded.ppm (P3 format).\n`;

  const pixels: number[][] = [];
  for (let i = 0; i < w * h; i++) {
    pixels.push([randomInt(0, 127) * 2, randomInt(0, 255), randomInt(0, 255)]);
  }
  const ppmRows: string[] = [];
  for (let y = 0; y < h; y++) {
    const row: string[] = [];
    for (let x = 0; x < w; x++) {
      const p = pixels[y * w + x]!;
      row.push(`${p[0]} ${p[1]} ${p[2]}`);
    }
    ppmRows.push(row.join(" "));
  }
  const ppm = `P3\n${w} ${h}\n255\n${ppmRows.join("\n")}`;

  return {
    "image.ppm": ppm,
    "message.txt": message,
    "SPEC.md": spec,
    ".expected": message,
  };
}

// ── File system data generators ──

function generateFindFilesData(): Record<string, string> {
  const extensions = ["txt", "csv", "log", "json", "md"];
  const targetExt = extensions[randomInt(0, extensions.length - 1)]!;
  const dirs = ["a", "a/b", "a/b/c", "d", "d/e", "f"];
  const files: Record<string, string> = {};
  let count = 0;
  for (const dir of dirs) {
    const numFiles = randomInt(2, 6);
    for (let i = 0; i < numFiles; i++) {
      const ext = extensions[randomInt(0, extensions.length - 1)]!;
      const name = `tree/${dir}/file${i}.${ext}`;
      files[name] = `content of ${name}`;
      if (ext === targetExt) count++;
    }
  }
  files[".meta"] = targetExt;
  files[".expected"] = String(count);
  return files;
}

function generateDirectorySizeData(): Record<string, string> {
  const dirs = ["data/logs", "data/cache", "data/config", "data/tmp"];
  const files: Record<string, string> = {};
  const dirSizes: Record<string, number> = {};
  for (const dir of dirs) {
    dirSizes[dir] = 0;
    const numFiles = randomInt(3, 8);
    for (let i = 0; i < numFiles; i++) {
      const size = randomInt(10, 500);
      const content = "x".repeat(size);
      files[`tree/${dir}/file${i}.dat`] = content;
      dirSizes[dir] += size;
    }
  }
  const expected = Object.entries(dirSizes)
    .sort((a, b) => b[1] - a[1])
    .map(([dir, size]) => `${dir},${size}`)
    .join("\n");
  files[".expected"] = expected;
  return files;
}

function generateShatteredFileData(): Record<string, string> {
  const sentences = [
    "The quick brown fox jumps over the lazy dog.",
    "Pack my box with five dozen liquor jugs.",
    "How vexingly quick daft zebras jump.",
    "The five boxing wizards jump quickly.",
    "Bright vixens jump; dozy fowl quack.",
  ];
  const fullText = sentences.slice(0, randomInt(3, 5)).join("\n");
  const chunks = fullText.match(/.{1,40}/g) ?? [fullText];
  const files: Record<string, string> = {};
  const dirs = ["chunks/alpha", "chunks/beta", "chunks/gamma"];
  for (let i = 0; i < chunks.length; i++) {
    const dir = dirs[randomInt(0, dirs.length - 1)]!;
    files[`${dir}/chunk_${String(i + 1).padStart(3, "0")}.txt`] = chunks[i]!;
  }
  files[".expected"] = fullText;
  return files;
}

// ── String/Encoding data generators ──

function generateBase64Data(): Record<string, string> {
  const messages = [
    "Hello, World! This is a test of base64 encoding.",
    "The answer to life, the universe, and everything is 42.",
    "All your base are belong to us.",
    "To be or not to be, that is the question.",
    "Elementary, my dear Watson.",
  ];
  const message = messages[randomInt(0, messages.length - 1)]!;
  const encoded = Buffer.from(message).toString("base64");
  return { "encoded.txt": encoded, ".expected": message };
}

function generateHexDumpData(): Record<string, string> {
  const messages = [
    "Secret message hidden in hex",
    "Decode this hexadecimal data",
    "Binary to text conversion test",
    "Agent found the hidden text",
  ];
  const message = messages[randomInt(0, messages.length - 1)]!;
  const hex = Array.from(Buffer.from(message)).map(b => b.toString(16).padStart(2, "0")).join(" ");
  return { "hexdump.txt": hex, ".expected": message };
}

function generateChecksumData(): Record<string, string> {
  const lines: string[] = [];
  const checksums: string[] = [];
  const badLines: number[] = [];
  const lineCount = randomInt(10, 20);
  for (let i = 0; i < lineCount; i++) {
    const line = `Line ${i + 1}: data_${randomInt(1000, 9999)}`;
    lines.push(line);
    // Simple checksum: sum of char codes mod 10000
    const checksum = Array.from(line).reduce((s, c) => s + c.charCodeAt(0), 0);
    if (Math.random() < 0.3) {
      checksums.push(`${checksum + randomInt(1, 100)}`);
      badLines.push(i + 1);
    } else {
      checksums.push(`${checksum}`);
    }
  }
  return {
    "data.txt": lines.join("\n"),
    "CHECKSUMS.txt": checksums.join("\n"),
    "SPEC.md": "Each line in CHECKSUMS.txt is the sum of ASCII char codes of the corresponding line in data.txt.\nFind lines where the checksum does not match.\nWrite the 1-based line numbers of bad lines, one per line, sorted numerically.",
    ".expected": badLines.join("\n"),
  };
}

function generateMultiEncodingData(): Record<string, string> {
  const message = `agent${randomInt(100, 999)}`;
  const steps = ["base64", "reverse"];
  let current = message;
  // Apply in reverse to get input
  const reversed = [...current].reverse().join("");
  const encoded = Buffer.from(reversed).toString("base64");

  return {
    "input.txt": encoded,
    "pipeline.txt": steps.join("\n"),
    "SPEC.md": "Apply the transforms in pipeline.txt in order to input.txt.\nbase64 = base64 decode\nreverse = reverse the string\nWrite final result to result.txt.",
    ".expected": message,
  };
}

// ── Math/Algorithmic data generators ──

function generatePrimeSieveData(): Record<string, string> {
  const limit = randomInt(50, 200);
  const sieve = new Array(limit + 1).fill(true);
  sieve[0] = sieve[1] = false;
  for (let i = 2; i * i <= limit; i++) {
    if (sieve[i]) {
      for (let j = i * i; j <= limit; j += i) sieve[j] = false;
    }
  }
  const primes: number[] = [];
  for (let i = 2; i <= limit; i++) if (sieve[i]) primes.push(i);
  return { "limit.txt": String(limit), ".expected": primes.join("\n") };
}

function generateSequenceData(): Record<string, string> {
  const types = [
    () => {
      const start = randomInt(1, 10);
      const diff = randomInt(2, 7);
      const terms = Array.from({ length: 8 }, (_, i) => start + i * diff);
      const next5 = Array.from({ length: 5 }, (_, i) => start + (8 + i) * diff);
      return { terms, next5 };
    },
    () => {
      const start = randomInt(2, 5);
      const ratio = randomInt(2, 3);
      const terms = Array.from({ length: 6 }, (_, i) => start * Math.pow(ratio, i));
      const next5 = Array.from({ length: 5 }, (_, i) => start * Math.pow(ratio, 6 + i));
      return { terms, next5 };
    },
    () => {
      const terms = [1, 1];
      for (let i = 2; i < 10; i++) terms.push(terms[i - 1]! + terms[i - 2]!);
      const next5: number[] = [];
      let a = terms[terms.length - 2]!, b = terms[terms.length - 1]!;
      for (let i = 0; i < 5; i++) {
        const c = a + b;
        next5.push(c);
        a = b;
        b = c;
      }
      return { terms, next5 };
    },
    () => {
      const start = randomInt(1, 5);
      const terms = Array.from({ length: 8 }, (_, i) => (start + i) * (start + i));
      const next5 = Array.from({ length: 5 }, (_, i) => (start + 8 + i) * (start + 8 + i));
      return { terms, next5 };
    },
  ];
  const gen = types[randomInt(0, types.length - 1)]!();
  return {
    "sequence.txt": gen.terms.join("\n"),
    ".expected": gen.next5.join("\n"),
  };
}

function generateGraphData(): Record<string, string> {
  const nodeCount = randomInt(8, 15);
  const nodes = Array.from({ length: nodeCount }, (_, i) => String.fromCharCode(65 + i));
  const edges: [string, string][] = [];
  // Build a connected graph
  for (let i = 1; i < nodeCount; i++) {
    const target = randomInt(0, i - 1);
    edges.push([nodes[i]!, nodes[target]!]);
    edges.push([nodes[target]!, nodes[i]!]);
  }
  // Add some extra edges
  for (let i = 0; i < nodeCount; i++) {
    if (Math.random() < 0.3) {
      const j = randomInt(0, nodeCount - 1);
      if (i !== j) {
        edges.push([nodes[i]!, nodes[j]!]);
        edges.push([nodes[j]!, nodes[i]!]);
      }
    }
  }

  // BFS for shortest path
  const start = nodes[0]!;
  const end = nodes[nodeCount - 1]!;
  const adj: Record<string, Set<string>> = {};
  for (const n of nodes) adj[n] = new Set();
  for (const [a, b] of edges) adj[a]!.add(b);

  const queue: [string, string[]][] = [[start, [start]]];
  const visited = new Set([start]);
  let shortestPath: string[] = [];
  while (queue.length > 0) {
    const [node, path] = queue.shift()!;
    if (node === end) { shortestPath = path; break; }
    for (const neighbor of adj[node]!) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push([neighbor, [...path, neighbor]]);
      }
    }
  }

  const adjList = nodes.map(n => `${n}: ${[...adj[n]!].sort().join(",")}`).join("\n");
  return {
    "graph.txt": adjList,
    "query.txt": `${start}\n${end}`,
    ".expected": shortestPath.join(","),
  };
}

// ── JSON data generators ──

function generateJsonFlattenData(): Record<string, string> {
  const obj: Record<string, unknown> = {
    name: "test",
    version: randomInt(1, 10),
    config: {
      debug: true,
      timeout: randomInt(100, 5000),
      database: {
        host: "localhost",
        port: randomInt(3000, 9000),
        name: `db_${randomInt(1, 99)}`,
      },
    },
    tags: undefined, // skip arrays for clean flattening
    count: randomInt(1, 100),
  };
  delete obj.tags;

  function flatten(o: Record<string, unknown>, prefix = ""): [string, string][] {
    const result: [string, string][] = [];
    for (const [k, v] of Object.entries(o)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        result.push(...flatten(v as Record<string, unknown>, key));
      } else {
        result.push([key, String(v)]);
      }
    }
    return result;
  }

  const flattened = flatten(obj).sort((a, b) => a[0].localeCompare(b[0]));
  const expected = flattened.map(([k, v]) => `${k}=${v}`).join("\n");
  return { "data.json": JSON.stringify(obj, null, 2), ".expected": expected };
}

function generateJsonDiffData(): Record<string, string> {
  const base: Record<string, unknown> = {
    name: "project",
    version: randomInt(1, 5),
    author: "alice",
    license: "MIT",
    debug: false,
    port: randomInt(3000, 5000),
    timeout: randomInt(100, 1000),
  };

  const after = { ...base };
  const changes: string[] = [];

  // Remove a key
  const keys = Object.keys(after);
  const removeKey = keys[randomInt(0, keys.length - 1)]!;
  delete after[removeKey];
  changes.push(`removed:${removeKey}`);

  // Add a key
  const newKey = `new_field_${randomInt(1, 99)}`;
  after[newKey] = randomInt(1, 100);
  changes.push(`added:${newKey}`);

  // Change a value
  const remainingKeys = Object.keys(after).filter(k => k !== newKey);
  if (remainingKeys.length > 0) {
    const changeKey = remainingKeys[randomInt(0, remainingKeys.length - 1)]!;
    after[changeKey] = `changed_${randomInt(1, 99)}`;
    changes.push(`changed:${changeKey}`);
  }

  const expected = changes.sort().join("\n");
  return {
    "before.json": JSON.stringify(base, null, 2),
    "after.json": JSON.stringify(after, null, 2),
    ".expected": expected,
  };
}

function generateJsonTreeData(): Record<string, string> {
  function buildTree(depth: number, maxChildren: number): unknown {
    if (depth === 0) return randomInt(1, 100);
    const children: Record<string, unknown> = {};
    const n = randomInt(2, maxChildren);
    for (let i = 0; i < n; i++) {
      children[`node_${String.fromCharCode(97 + i)}`] = buildTree(depth - 1, maxChildren);
    }
    return children;
  }

  function aggregate(node: unknown): number {
    if (typeof node === "number") return node;
    const obj = node as Record<string, unknown>;
    let sum = 0;
    for (const v of Object.values(obj)) sum += aggregate(v);
    return sum;
  }

  function collectAggregates(node: unknown, path: string, results: [string, number][]): void {
    if (typeof node === "number") return;
    const obj = node as Record<string, unknown>;
    const sum = aggregate(obj);
    results.push([path || "root", sum]);
    for (const [k, v] of Object.entries(obj)) {
      collectAggregates(v, path ? `${path}.${k}` : k, results);
    }
  }

  const tree = buildTree(3, 3);
  const aggregates: [string, number][] = [];
  collectAggregates(tree, "", aggregates);
  const expected = aggregates
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([path, sum]) => `${path}=${sum}`)
    .join("\n");

  return {
    "tree.json": JSON.stringify(tree, null, 2),
    ".expected": expected,
  };
}

// ── SQLite data generators ──

function generateSqlQueryData(): Record<string, string> {
  const departments = ["Engineering", "Sales", "Marketing", "Support", "HR"];
  const rows: string[] = [];
  for (let i = 1; i <= randomInt(20, 50); i++) {
    const dept = departments[randomInt(0, departments.length - 1)]!;
    const salary = randomInt(40, 150) * 1000;
    rows.push(`INSERT INTO employees VALUES (${i}, 'Employee_${i}', '${dept}', ${salary});`);
  }

  const queries = [
    {
      question: "What is the average salary per department? Output as: department,average_salary (rounded to nearest integer, sorted by department)",
      verify: `SELECT department, ROUND(AVG(salary)) as avg_salary FROM employees GROUP BY department ORDER BY department;`,
    },
    {
      question: "How many employees are in each department? Output as: department,count (sorted by department)",
      verify: `SELECT department, COUNT(*) as count FROM employees GROUP BY department ORDER BY department;`,
    },
    {
      question: "What is the total salary per department? Output as: department,total (sorted by department)",
      verify: `SELECT department, SUM(salary) as total FROM employees GROUP BY department ORDER BY department;`,
    },
  ];
  const q = queries[randomInt(0, queries.length - 1)]!;

  const setup = `CREATE TABLE employees (id INTEGER PRIMARY KEY, name TEXT, department TEXT, salary INTEGER);\n${rows.join("\n")}`;

  return {
    "setup.sql": setup,
    "query.txt": q.question,
    ".verify_query": q.verify,
  };
}

function generateSqlMigrationData(): Record<string, string> {
  const rows: string[] = [];
  const count = randomInt(10, 30);
  for (let i = 1; i <= count; i++) {
    const fullName = `${["Alice", "Bob", "Charlie", "Diana", "Eve"][randomInt(0, 4)]!} ${["Smith", "Jones", "Brown", "Davis", "Wilson"][randomInt(0, 4)]!}`;
    const email = `user${i}@example.com`;
    rows.push(`INSERT INTO users VALUES (${i}, '${fullName}', '${email}', 1);`);
  }

  const setup = `CREATE TABLE users (id INTEGER PRIMARY KEY, full_name TEXT, email TEXT, active INTEGER);\n${rows.join("\n")}`;

  const migration = `# Migration Spec\n\n1. Split full_name into first_name and last_name columns\n2. Add a created_at column with default value '2024-01-01'\n3. Rename active to is_active\n\nOutput the migrated data as CSV: id,first_name,last_name,email,is_active,created_at\nSorted by id.`;

  return { "setup.sql": setup, "migration.md": migration };
}

// ── Multi-step orchestration data generators ──

function generatePipelineBuilderData(): Record<string, string> {
  const regions = ["north", "south", "east", "west"];
  const products = ["widget", "gadget", "sprocket"];
  const rows: string[] = ["product,region,amount,quantity"];
  for (let i = 0; i < randomInt(100, 300); i++) {
    const product = products[randomInt(0, products.length - 1)]!;
    const region = regions[randomInt(0, regions.length - 1)]!;
    const amount = (randomInt(100, 10000) / 100).toFixed(2);
    const qty = randomInt(1, 20);
    rows.push(`${product},${region},${amount},${qty}`);
  }

  const filterRegion = regions[randomInt(0, regions.length - 1)]!;
  const pipeline = JSON.stringify({
    steps: [
      { op: "filter", field: "region", value: filterRegion },
      { op: "sort", field: "amount", order: "desc" },
      { op: "aggregate", groupBy: "product", sum: "amount" },
      { op: "format", output: "csv" },
    ],
  }, null, 2);

  // Compute expected
  const dataRows = rows.slice(1).map(r => {
    const [product, region, amount, quantity] = r.split(",");
    return { product: product!, region: region!, amount: parseFloat(amount!), quantity: parseInt(quantity!) };
  });
  const filtered = dataRows.filter(r => r.region === filterRegion);
  const agg: Record<string, number> = {};
  for (const r of filtered) agg[r.product] = (agg[r.product] || 0) + r.amount;
  const expected = Object.entries(agg)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k},${(Math.round(v * 100) / 100).toFixed(2)}`)
    .join("\n");

  return {
    "data.csv": rows.join("\n"),
    "pipeline.json": pipeline,
    ".expected": expected,
  };
}

function generateMultiFormatEtlData(): Record<string, string> {
  const custCount = randomInt(20, 50);
  const custLines = ["id,name,region"];
  const custIds: number[] = [];
  for (let i = 1; i <= custCount; i++) {
    custIds.push(i);
    const region = ["north", "south", "east", "west"][randomInt(0, 3)]!;
    custLines.push(`${i},Customer_${i},${region}`);
  }

  const orders: { order_id: string; customer_id: number; amount: number }[] = [];
  for (let i = 1; i <= randomInt(50, 150); i++) {
    orders.push({
      order_id: `ORD-${String(i).padStart(4, "0")}`,
      customer_id: custIds[randomInt(0, custIds.length - 1)]!,
      amount: Math.round(randomInt(100, 50000)) / 100,
    });
  }
  // Make some orders reference invalid customers
  const invalidCount = randomInt(3, 8);
  for (let i = 0; i < invalidCount; i++) {
    orders.push({
      order_id: `ORD-${String(orders.length + 1).padStart(4, "0")}`,
      customer_id: 9000 + i,
      amount: Math.round(randomInt(100, 5000)) / 100,
    });
  }

  const rules = JSON.stringify({
    rules: [
      { check: "customer_exists", description: "customer_id must reference a valid customer" },
      { check: "amount_positive", description: "amount must be greater than 0" },
    ],
  }, null, 2);

  const inventoryRows = ["product_id,name,price"];
  for (let i = 1; i <= 10; i++) {
    inventoryRows.push(`P${i},Product_${i},${(randomInt(500, 10000) / 100).toFixed(2)}`);
  }

  const setupSql = `CREATE TABLE inventory (product_id TEXT, name TEXT, price REAL);\n` +
    inventoryRows.slice(1).map(r => {
      const [pid, name, price] = r.split(",");
      return `INSERT INTO inventory VALUES ('${pid}', '${name}', ${price});`;
    }).join("\n");

  // Compute expected: valid orders aggregated by region
  const custMap = new Map<number, string>();
  for (let i = 1; i < custLines.length; i++) {
    const [id, , region] = custLines[i]!.split(",");
    custMap.set(parseInt(id!), region!);
  }
  const regionTotals: Record<string, number> = {};
  const errors: string[] = [];
  for (const o of orders) {
    if (!custMap.has(o.customer_id)) {
      errors.push(`${o.order_id}:customer_exists`);
      continue;
    }
    const region = custMap.get(o.customer_id)!;
    regionTotals[region] = (regionTotals[region] || 0) + o.amount;
  }

  const expectedClean = Object.entries(regionTotals)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([r, v]) => `${r},${(Math.round(v * 100) / 100).toFixed(2)}`)
    .join("\n");
  const expectedErrors = errors.sort().join("\n");

  return {
    "customers.csv": custLines.join("\n"),
    "orders.json": JSON.stringify(orders, null, 2),
    "setup.sql": setupSql,
    "rules.json": rules,
    ".expected_clean": expectedClean,
    ".expected_errors": expectedErrors,
  };
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

  // ── Code Fixing ──
  {
    title: "Fix Python Function",
    category: "discovery",
    difficulty: 2,
    makeVerifyScript: (id) => `#!/bin/bash
${paths(id)}
EXPECTED=$(cat "$CDIR/.expected")
ACTUAL=$(cd "$ODIR" && python3 script.py 2>&1 | tr -d '[:space:]')
EXPECTED_TRIM=$(echo "$EXPECTED" | tr -d '[:space:]')
if [ "$ACTUAL" = "$EXPECTED_TRIM" ]; then echo "PASS"; exit 0; else echo "FAIL: output/${id}/script.py — fix the python script so it produces correct output"; exit 1; fi`,
    dataGenerator: generateFixPythonData,
  },
  {
    title: "Fix Bash Script",
    category: "discovery",
    difficulty: 2,
    makeVerifyScript: (id) => `#!/bin/bash
${paths(id)}
EXPECTED=$(cat "$CDIR/.expected")
ACTUAL=$(cd "$ODIR" && bash script.sh 2>&1 | tr -d '[:space:]')
EXPECTED_TRIM=$(echo "$EXPECTED" | tr -d '[:space:]')
if [ "$ACTUAL" = "$EXPECTED_TRIM" ]; then echo "PASS"; exit 0; else echo "FAIL: output/${id}/script.sh — fix the bash script so it produces correct output"; exit 1; fi`,
    dataGenerator: generateFixBashData,
  },
  {
    title: "Fix Node Script",
    category: "discovery",
    difficulty: 3,
    makeVerifyScript: (id) => `#!/bin/bash
${paths(id)}
EXPECTED=$(cat "$CDIR/.expected")
ACTUAL=$(cd "$ODIR" && node script.js 2>&1 | tr -d '[:space:]')
EXPECTED_TRIM=$(echo "$EXPECTED" | tr -d '[:space:]')
if [ "$ACTUAL" = "$EXPECTED_TRIM" ]; then echo "PASS"; exit 0; else echo "FAIL: output/${id}/script.js — fix the node script so it produces correct output"; exit 1; fi`,
    dataGenerator: generateFixNodeData,
  },
  {
    title: "Missing Function",
    category: "discovery",
    difficulty: 3,
    makeVerifyScript: (id) => `#!/bin/bash
${paths(id)}
EXPECTED=$(cat "$CDIR/.expected")
ACTUAL=$(cd "$ODIR" && python3 main.py 2>&1 | tr -d '[:space:]')
EXPECTED_TRIM=$(echo "$EXPECTED" | tr -d '[:space:]')
if [ "$ACTUAL" = "$EXPECTED_TRIM" ]; then echo "PASS"; exit 0; else echo "FAIL: output/${id}/helpers.py — implement the missing function so main.py runs correctly"; exit 1; fi`,
    dataGenerator: generateMissingFunctionData,
  },
  {
    title: "Debug Multi-file",
    category: "discovery",
    difficulty: 4,
    makeVerifyScript: (id) => `#!/bin/bash
${paths(id)}
EXPECTED=$(cat "$CDIR/.expected")
ACTUAL=$(cd "$ODIR" && python3 main.py 2>&1)
if [ "$ACTUAL" = "$EXPECTED" ]; then echo "PASS"; exit 0; else echo "FAIL: output/${id}/ — fix bugs across the python files so main.py produces correct output"; exit 1; fi`,
    dataGenerator: generateDebugMultifileData,
  },
  {
    title: "Fix and Extend",
    category: "compositional",
    difficulty: 5,
    makeVerifyScript: (id) => `#!/bin/bash
${paths(id)}
EXPECTED=$(cat "$CDIR/.expected")
ACTUAL=$(cd "$ODIR" && python3 main.py 2>&1)
if [ "$ACTUAL" = "$EXPECTED" ]; then echo "PASS"; exit 0; else echo "FAIL: output/${id}/ — fix bugs and implement features from SPEC.md so main.py produces correct output"; exit 1; fi`,
    dataGenerator: generateFixAndExtendData,
  },

  // ── Image/Visual ──
  {
    title: "PPM Pixel Count",
    category: "discovery",
    difficulty: 2,
    makeVerifyScript: (id) => `#!/bin/bash
${paths(id)}
EXPECTED=$(cat "$CDIR/.expected")
ACTUAL=$(cat "$ODIR/count.txt" 2>/dev/null | tr -d '[:space:]')
if [ "$ACTUAL" = "$EXPECTED" ]; then echo "PASS"; exit 0; else echo "FAIL: output/${id}/count.txt — count non-white pixels in the PPM image"; exit 1; fi`,
    dataGenerator: generatePpmPixelCountData,
  },
  {
    title: "ASCII Art Message",
    category: "discovery",
    difficulty: 3,
    makeVerifyScript: (id) => `#!/bin/bash
${paths(id)}
EXPECTED=$(cat "$CDIR/.expected")
ACTUAL=$(cat "$ODIR/message.txt" 2>/dev/null | tr -d '[:space:]')
EXPECTED_TRIM=$(echo "$EXPECTED" | tr -d '[:space:]')
if [ "$ACTUAL" = "$EXPECTED_TRIM" ]; then echo "PASS"; exit 0; else echo "FAIL: output/${id}/message.txt — decode the word spelled in ASCII art block letters"; exit 1; fi`,
    dataGenerator: generateAsciiArtData,
  },
  {
    title: "PPM Color Histogram",
    category: "discovery",
    difficulty: 4,
    makeVerifyScript: (id) => `#!/bin/bash
${paths(id)}
EXPECTED=$(cat "$CDIR/.expected")
if [ ! -f "$ODIR/histogram.csv" ]; then echo "FAIL: output/${id}/histogram.csv — produce color frequency histogram from PPM image as r,g,b,count sorted by count desc"; exit 1; fi
ACTUAL=$(cat "$ODIR/histogram.csv" | grep -v "^r,g,b" | sort)
EXPECTED_SORTED=$(echo "$EXPECTED" | sort)
if [ "$ACTUAL" = "$EXPECTED_SORTED" ]; then echo "PASS"; exit 0; else echo "FAIL: output/${id}/histogram.csv — color histogram values are wrong"; exit 1; fi`,
    dataGenerator: generatePpmColorHistogramData,
  },
  {
    title: "SVG Data Extract",
    category: "discovery",
    difficulty: 4,
    makeVerifyScript: (id) => `#!/bin/bash
${paths(id)}
EXPECTED=$(cat "$CDIR/.expected")
ACTUAL=$(cat "$ODIR/result.txt" 2>/dev/null | tr -d '[:space:]')
EXPECTED_TRIM=$(echo "$EXPECTED" | tr -d '[:space:]')
if [ "$ACTUAL" = "$EXPECTED_TRIM" ]; then echo "PASS"; exit 0; else echo "FAIL: output/${id}/result.txt — extract values from SVG text elements and apply the data-operation attribute"; exit 1; fi`,
    dataGenerator: generateSvgDataExtractData,
  },
  {
    title: "PPM Encode Message",
    category: "compositional",
    difficulty: 5,
    makeVerifyScript: (id) => `#!/bin/bash
${paths(id)}
EXPECTED=$(cat "$CDIR/.expected")
node -e "
const fs = require('fs');
let ppm;
try { ppm = fs.readFileSync('$ODIR/encoded.ppm','utf-8'); }
catch(e) { console.log('FAIL: output/${id}/encoded.ppm — encode the message into PPM pixel LSBs per SPEC.md'); process.exit(1); }
const lines = ppm.trim().split('\\n');
if (lines[0] !== 'P3') { console.log('FAIL: output/${id}/encoded.ppm — not a valid P3 PPM file'); process.exit(1); }
const pixels = lines.slice(3).join(' ').trim().split(/\\s+/).map(Number);
const reds = [];
for (let i = 0; i < pixels.length; i += 3) reds.push(pixels[i]);
let decoded = '';
for (let i = 0; i < reds.length - 7; i += 8) {
  let byte = 0;
  for (let b = 0; b < 8; b++) byte = (byte << 1) | (reds[i+b] & 1);
  if (byte === 0) break;
  decoded += String.fromCharCode(byte);
}
if (decoded === '${id.replace(/'/g, "\\'")}') {
  // wrong — agent stored the ID, not the message
  console.log('FAIL: output/${id}/encoded.ppm — encoded wrong content');
  process.exit(1);
}
if (decoded === '$EXPECTED') { console.log('PASS'); process.exit(0); }
else { console.log('FAIL: output/${id}/encoded.ppm — decoded message does not match'); process.exit(1); }
" 2>&1`,
    dataGenerator: generatePpmEncodeMessageData,
  },

  // ── File System ──
  {
    title: "Find Files",
    category: "computational",
    difficulty: 1,
    makeVerifyScript: (id) => `#!/bin/bash
${paths(id)}
EXPECTED=$(cat "$CDIR/.expected")
ACTUAL=$(cat "$ODIR/count.txt" 2>/dev/null | tr -d '[:space:]')
if [ "$ACTUAL" = "$EXPECTED" ]; then echo "PASS"; exit 0; else echo "FAIL: output/${id}/count.txt — count files matching the target extension in the directory tree"; exit 1; fi`,
    dataGenerator: generateFindFilesData,
  },
  {
    title: "Directory Size Report",
    category: "computational",
    difficulty: 3,
    makeVerifyScript: (id) => `#!/bin/bash
${paths(id)}
EXPECTED=$(cat "$CDIR/.expected")
if [ ! -f "$ODIR/sizes.csv" ]; then echo "FAIL: output/${id}/sizes.csv — compute total bytes per subdirectory, sorted by size descending"; exit 1; fi
ACTUAL=$(cat "$ODIR/sizes.csv" | grep -v "^dir" | sort)
EXPECTED_SORTED=$(echo "$EXPECTED" | sort)
if [ "$ACTUAL" = "$EXPECTED_SORTED" ]; then echo "PASS"; exit 0; else echo "FAIL: output/${id}/sizes.csv — directory size values are wrong"; exit 1; fi`,
    dataGenerator: generateDirectorySizeData,
  },
  {
    title: "Reconstruct Shattered File",
    category: "compositional",
    difficulty: 4,
    makeVerifyScript: (id) => `#!/bin/bash
${paths(id)}
EXPECTED=$(cat "$CDIR/.expected")
ACTUAL=$(cat "$ODIR/assembled.txt" 2>/dev/null)
if [ "$ACTUAL" = "$EXPECTED" ]; then echo "PASS"; exit 0; else echo "FAIL: output/${id}/assembled.txt — find numbered chunks in subdirs and reassemble in order"; exit 1; fi`,
    dataGenerator: generateShatteredFileData,
  },

  // ── String/Encoding ──
  {
    title: "Base64 Decode",
    category: "computational",
    difficulty: 1,
    makeVerifyScript: (id) => `#!/bin/bash
${paths(id)}
EXPECTED=$(cat "$CDIR/.expected")
ACTUAL=$(cat "$ODIR/decoded.txt" 2>/dev/null)
if [ "$ACTUAL" = "$EXPECTED" ]; then echo "PASS"; exit 0; else echo "FAIL: output/${id}/decoded.txt — decode the base64-encoded file"; exit 1; fi`,
    dataGenerator: generateBase64Data,
  },
  {
    title: "Hex Dump Analysis",
    category: "computational",
    difficulty: 2,
    makeVerifyScript: (id) => `#!/bin/bash
${paths(id)}
EXPECTED=$(cat "$CDIR/.expected")
ACTUAL=$(cat "$ODIR/decoded.txt" 2>/dev/null)
if [ "$ACTUAL" = "$EXPECTED" ]; then echo "PASS"; exit 0; else echo "FAIL: output/${id}/decoded.txt — convert hex bytes back to text"; exit 1; fi`,
    dataGenerator: generateHexDumpData,
  },
  {
    title: "Checksum Validator",
    category: "discovery",
    difficulty: 3,
    makeVerifyScript: (id) => `#!/bin/bash
${paths(id)}
EXPECTED=$(cat "$CDIR/.expected")
ACTUAL=$(cat "$ODIR/bad_lines.txt" 2>/dev/null | sort -n)
EXPECTED_SORTED=$(echo "$EXPECTED" | sort -n)
if [ "$ACTUAL" = "$EXPECTED_SORTED" ]; then echo "PASS"; exit 0; else echo "FAIL: output/${id}/bad_lines.txt — find lines where checksum does not match"; exit 1; fi`,
    dataGenerator: generateChecksumData,
  },
  {
    title: "Multi-encoding Pipeline",
    category: "compositional",
    difficulty: 4,
    makeVerifyScript: (id) => `#!/bin/bash
${paths(id)}
EXPECTED=$(cat "$CDIR/.expected")
ACTUAL=$(cat "$ODIR/result.txt" 2>/dev/null | tr -d '[:space:]')
EXPECTED_TRIM=$(echo "$EXPECTED" | tr -d '[:space:]')
if [ "$ACTUAL" = "$EXPECTED_TRIM" ]; then echo "PASS"; exit 0; else echo "FAIL: output/${id}/result.txt — apply the encoding pipeline transforms in order"; exit 1; fi`,
    dataGenerator: generateMultiEncodingData,
  },

  // ── Math/Algorithmic ──
  {
    title: "Prime Sieve",
    category: "computational",
    difficulty: 1,
    makeVerifyScript: (id) => `#!/bin/bash
${paths(id)}
EXPECTED=$(cat "$CDIR/.expected")
ACTUAL=$(cat "$ODIR/primes.txt" 2>/dev/null)
if [ "$ACTUAL" = "$EXPECTED" ]; then echo "PASS"; exit 0; else echo "FAIL: output/${id}/primes.txt — find all primes up to the limit, one per line"; exit 1; fi`,
    dataGenerator: generatePrimeSieveData,
  },
  {
    title: "Sequence Completion",
    category: "discovery",
    difficulty: 3,
    makeVerifyScript: (id) => `#!/bin/bash
${paths(id)}
EXPECTED=$(cat "$CDIR/.expected")
ACTUAL=$(cat "$ODIR/next.txt" 2>/dev/null)
if [ "$ACTUAL" = "$EXPECTED" ]; then echo "PASS"; exit 0; else echo "FAIL: output/${id}/next.txt — identify the pattern and predict the next 5 terms, one per line"; exit 1; fi`,
    dataGenerator: generateSequenceData,
  },
  {
    title: "Graph Shortest Path",
    category: "compositional",
    difficulty: 5,
    makeVerifyScript: (id) => `#!/bin/bash
${paths(id)}
EXPECTED=$(cat "$CDIR/.expected")
ACTUAL=$(cat "$ODIR/path.txt" 2>/dev/null | tr -d '[:space:]')
EXPECTED_TRIM=$(echo "$EXPECTED" | tr -d '[:space:]')
if [ "$ACTUAL" = "$EXPECTED_TRIM" ]; then echo "PASS"; exit 0; else echo "FAIL: output/${id}/path.txt — find shortest path between nodes in the graph as comma-separated node list"; exit 1; fi`,
    dataGenerator: generateGraphData,
  },

  // ── JSON Structured Data ──
  {
    title: "JSON Flatten",
    category: "computational",
    difficulty: 2,
    makeVerifyScript: (id) => `#!/bin/bash
${paths(id)}
EXPECTED=$(cat "$CDIR/.expected")
ACTUAL=$(cat "$ODIR/flat.txt" 2>/dev/null)
if [ "$ACTUAL" = "$EXPECTED" ]; then echo "PASS"; exit 0; else echo "FAIL: output/${id}/flat.txt — flatten nested JSON to sorted dot-notation key=value pairs"; exit 1; fi`,
    dataGenerator: generateJsonFlattenData,
  },
  {
    title: "JSON Diff",
    category: "discovery",
    difficulty: 4,
    makeVerifyScript: (id) => `#!/bin/bash
${paths(id)}
EXPECTED=$(cat "$CDIR/.expected" | sort)
ACTUAL=$(cat "$ODIR/diff.txt" 2>/dev/null | sort)
if [ "$ACTUAL" = "$EXPECTED" ]; then echo "PASS"; exit 0; else echo "FAIL: output/${id}/diff.txt — compare before.json and after.json, report added/removed/changed keys"; exit 1; fi`,
    dataGenerator: generateJsonDiffData,
  },
  {
    title: "JSON Tree Aggregate",
    category: "compositional",
    difficulty: 5,
    makeVerifyScript: (id) => `#!/bin/bash
${paths(id)}
EXPECTED=$(cat "$CDIR/.expected")
ACTUAL=$(cat "$ODIR/aggregates.txt" 2>/dev/null)
if [ "$ACTUAL" = "$EXPECTED" ]; then echo "PASS"; exit 0; else echo "FAIL: output/${id}/aggregates.txt — compute sum aggregates for all internal nodes, sorted by path"; exit 1; fi`,
    dataGenerator: generateJsonTreeData,
  },

  // ── SQLite ──
  {
    title: "SQL Query",
    category: "computational",
    difficulty: 3,
    makeVerifyScript: (id) => `#!/bin/bash
${paths(id)}
VERIFY_QUERY=$(cat "$CDIR/.verify_query")
TMPDB=$(mktemp /tmp/verify_XXXXXX.db)
sqlite3 "$TMPDB" < "$CDIR/setup.sql"
EXPECTED=$(sqlite3 -csv "$TMPDB" "$VERIFY_QUERY" 2>/dev/null)
rm -f "$TMPDB"
if [ ! -f "$ODIR/result.csv" ]; then echo "FAIL: output/${id}/result.csv — answer the query from query.txt as CSV"; exit 1; fi
ACTUAL_FULL=$(cat "$ODIR/result.csv")
FIRST_LINE=$(echo "$ACTUAL_FULL" | head -1)
if echo "$FIRST_LINE" | grep -qi "department\|name\|count\|salary\|total\|avg"; then
  ACTUAL=$(echo "$ACTUAL_FULL" | tail -n +2 | sort)
else
  ACTUAL=$(echo "$ACTUAL_FULL" | sort)
fi
EXPECTED_SORTED=$(echo "$EXPECTED" | sort)
if [ "$ACTUAL" = "$EXPECTED_SORTED" ]; then echo "PASS"; exit 0; else echo "FAIL: output/${id}/result.csv — query result is wrong"; exit 1; fi`,
    dataGenerator: generateSqlQueryData,
  },
  {
    title: "SQL Schema Migration",
    category: "compositional",
    difficulty: 5,
    makeVerifyScript: (id) => `#!/bin/bash
${paths(id)}
TMPDB=$(mktemp /tmp/verify_XXXXXX.db)
sqlite3 "$TMPDB" < "$CDIR/setup.sql"
EXPECTED=$(sqlite3 -csv "$TMPDB" "SELECT id, substr(full_name, 1, instr(full_name, ' ') - 1) as first_name, substr(full_name, instr(full_name, ' ') + 1) as last_name, email, active as is_active, '2024-01-01' as created_at FROM users ORDER BY id;")
rm -f "$TMPDB"
if [ ! -f "$ODIR/migrated.csv" ]; then echo "FAIL: output/${id}/migrated.csv — apply the schema migration from migration.md"; exit 1; fi
ACTUAL_FULL=$(cat "$ODIR/migrated.csv")
FIRST_LINE=$(echo "$ACTUAL_FULL" | head -1)
if echo "$FIRST_LINE" | grep -qi "id,first"; then
  ACTUAL=$(echo "$ACTUAL_FULL" | tail -n +2)
else
  ACTUAL="$ACTUAL_FULL"
fi
if [ "$ACTUAL" = "$EXPECTED" ]; then echo "PASS"; exit 0; else echo "FAIL: output/${id}/migrated.csv — migration result is wrong"; exit 1; fi`,
    dataGenerator: generateSqlMigrationData,
  },

  // ── Multi-step Orchestration ──
  {
    title: "Pipeline Builder",
    category: "compositional",
    difficulty: 4,
    makeVerifyScript: (id) => `#!/bin/bash
${paths(id)}
EXPECTED=$(cat "$CDIR/.expected" | sort)
if [ ! -f "$ODIR/result.csv" ]; then echo "FAIL: output/${id}/result.csv — execute the pipeline from pipeline.json on data.csv"; exit 1; fi
ACTUAL_FULL=$(cat "$ODIR/result.csv")
FIRST_LINE=$(echo "$ACTUAL_FULL" | head -1)
if echo "$FIRST_LINE" | grep -qi "product"; then
  ACTUAL=$(echo "$ACTUAL_FULL" | tail -n +2 | sort)
else
  ACTUAL=$(echo "$ACTUAL_FULL" | sort)
fi
if [ "$ACTUAL" = "$EXPECTED" ]; then echo "PASS"; exit 0; else echo "FAIL: output/${id}/result.csv — pipeline output is wrong"; exit 1; fi`,
    dataGenerator: generatePipelineBuilderData,
  },
  {
    title: "Multi-format ETL",
    category: "compositional",
    difficulty: 5,
    makeVerifyScript: (id) => `#!/bin/bash
${paths(id)}
EXPECTED_CLEAN=$(cat "$CDIR/.expected_clean" | sort)
EXPECTED_ERRORS=$(cat "$CDIR/.expected_errors" | sort)
if [ ! -f "$ODIR/clean.csv" ]; then echo "FAIL: output/${id}/clean.csv — join CSV + JSON data, validate against rules.json, produce clean output"; exit 1; fi
if [ ! -f "$ODIR/errors.txt" ]; then echo "FAIL: output/${id}/errors.txt — report validation errors"; exit 1; fi
ACTUAL_CLEAN_FULL=$(cat "$ODIR/clean.csv")
FIRST_LINE=$(echo "$ACTUAL_CLEAN_FULL" | head -1)
if echo "$FIRST_LINE" | grep -qi "region"; then
  ACTUAL_CLEAN=$(echo "$ACTUAL_CLEAN_FULL" | tail -n +2 | sort)
else
  ACTUAL_CLEAN=$(echo "$ACTUAL_CLEAN_FULL" | sort)
fi
ACTUAL_ERRORS=$(cat "$ODIR/errors.txt" | sort)
if [ "$ACTUAL_CLEAN" != "$EXPECTED_CLEAN" ]; then echo "FAIL: output/${id}/clean.csv — aggregated values are wrong"; exit 1; fi
if [ "$ACTUAL_ERRORS" != "$EXPECTED_ERRORS" ]; then echo "FAIL: output/${id}/errors.txt — error report is wrong"; exit 1; fi
echo "PASS"; exit 0`,
    dataGenerator: generateMultiFormatEtlData,
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
