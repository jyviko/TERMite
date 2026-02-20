import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFloat(min: number, max: number, decimals = 2): string {
  return (Math.random() * (max - min) + min).toFixed(decimals);
}

function randomDate(yearStart: number, yearEnd: number): string {
  const year = randomInt(yearStart, yearEnd);
  const month = randomInt(1, 12);
  const day = randomInt(1, 28);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function randomTimestamp(): string {
  return `${randomDate(2023, 2024)}T${String(randomInt(0, 23)).padStart(2, "0")}:${String(randomInt(0, 59)).padStart(2, "0")}:${String(randomInt(0, 59)).padStart(2, "0")}Z`;
}

type DatasetGenerator = () => Record<string, string>;

interface DatasetTemplate {
  name: string;
  generate: DatasetGenerator;
}

// ── Dataset Templates ──

function generateEcommerce(): Record<string, string> {
  const productCount = randomInt(200, 500);
  const customerCount = randomInt(1000, 3000);
  const transactionCount = randomInt(20000, 50000);

  const categories = ["Electronics", "Clothing", "Home", "Books", "Sports", "Food", "Toys", "Tools"];
  const productNames = ["Widget", "Gadget", "Sprocket", "Gizmo", "Thingamajig", "Doohickey", "Contraption", "Device"];
  const adjectives = ["Premium", "Basic", "Pro", "Ultra", "Mini", "Mega", "Eco", "Smart"];

  // Products
  const productLines = ["product_id,name,category,price,stock"];
  const productIds: string[] = [];
  for (let i = 0; i < productCount; i++) {
    const id = `P${String(i + 1).padStart(4, "0")}`;
    productIds.push(id);
    const adj = adjectives[randomInt(0, adjectives.length - 1)]!;
    const name = productNames[randomInt(0, productNames.length - 1)]!;
    const cat = categories[randomInt(0, categories.length - 1)]!;
    const price = randomFloat(0.99, 999.99);
    const stock = randomInt(0, 5000);
    // Occasional missing stock (data messiness)
    const stockStr = Math.random() < 0.03 ? "" : String(stock);
    productLines.push(`${id},${adj} ${name} ${i},${cat},${price},${stockStr}`);
  }

  // Customers
  const customerLines = ["customer_id,name,email,region,signup_date"];
  const customerIds: string[] = [];
  const regions = ["US-East", "US-West", "EU-North", "EU-South", "APAC", "LATAM"];
  for (let i = 0; i < customerCount; i++) {
    const id = `C${String(i + 1).padStart(5, "0")}`;
    customerIds.push(id);
    const region = regions[randomInt(0, regions.length - 1)]!;
    const date = randomDate(2020, 2024);
    // Occasional missing email
    const email = Math.random() < 0.05 ? "" : `user${i}@${region.toLowerCase().replace("-", "")}.example.com`;
    customerLines.push(`${id},Customer ${i},${email},${region},${date}`);
  }

  // Transactions
  const txnLines = ["transaction_id,customer_id,product_id,quantity,total,date,status"];
  const statuses = ["completed", "completed", "completed", "completed", "refunded", "pending", "cancelled"];
  for (let i = 0; i < transactionCount; i++) {
    const txnId = `T${String(i + 1).padStart(7, "0")}`;
    const custId = customerIds[randomInt(0, customerIds.length - 1)]!;
    const prodId = productIds[randomInt(0, productIds.length - 1)]!;
    const qty = randomInt(1, 10);
    const total = randomFloat(1.00, 4999.99);
    const date = randomTimestamp();
    const status = statuses[randomInt(0, statuses.length - 1)]!;
    txnLines.push(`${txnId},${custId},${prodId},${qty},${total},${date},${status}`);
  }

  return {
    "transactions.csv": txnLines.join("\n"),
    "products.csv": productLines.join("\n"),
    "customers.csv": customerLines.join("\n"),
  };
}

function generateServerLogs(): Record<string, string> {
  const nginxLines = randomInt(50000, 100000);
  const errorLines = randomInt(5000, 10000);

  const ips = Array.from({ length: 100 }, () =>
    `${randomInt(10, 223)}.${randomInt(0, 255)}.${randomInt(0, 255)}.${randomInt(1, 254)}`);
  const paths = ["/", "/api/v1/users", "/api/v1/products", "/api/v1/orders", "/api/v1/auth/login",
    "/api/v1/auth/refresh", "/api/v1/search", "/api/v1/upload", "/static/app.js", "/static/index.html",
    "/health", "/metrics", "/api/v2/data", "/api/v1/webhook", "/favicon.ico"];
  const methods = ["GET", "GET", "GET", "POST", "POST", "PUT", "DELETE", "PATCH"];
  const statusCodes = [200, 200, 200, 200, 201, 204, 301, 302, 304, 400, 401, 403, 404, 500, 502, 503];
  const agents = [
    "Mozilla/5.0 (compatible; bot/1.0)",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    "curl/7.81.0",
    "python-requests/2.28",
    "Go-http-client/2.0",
  ];

  // nginx.log (combined format)
  const nginx: string[] = [];
  for (let i = 0; i < nginxLines; i++) {
    const ip = ips[randomInt(0, ips.length - 1)]!;
    const method = methods[randomInt(0, methods.length - 1)]!;
    const path = paths[randomInt(0, paths.length - 1)]!;
    const status = statusCodes[randomInt(0, statusCodes.length - 1)]!;
    const size = randomInt(0, 500000);
    const agent = agents[randomInt(0, agents.length - 1)]!;
    const day = randomInt(1, 28);
    const hour = randomInt(0, 23);
    const min = randomInt(0, 59);
    const sec = randomInt(0, 59);
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const month = months[randomInt(0, 11)]!;
    const ts = `${String(day).padStart(2, "0")}/${month}/2024:${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")} +0000`;
    const referer = Math.random() < 0.7 ? "-" : "https://example.com/page";
    // Occasional malformed line (data messiness)
    if (Math.random() < 0.002) {
      nginx.push(`${ip} - - [${ts}] MALFORMED`);
    } else {
      nginx.push(`${ip} - - [${ts}] "${method} ${path} HTTP/1.1" ${status} ${size} "${referer}" "${agent}"`);
    }
  }

  // error.log
  const errorLevels = ["error", "crit", "warn", "emerg"];
  const errorMsgs = [
    "upstream timed out (110: Connection timed out)",
    "connect() failed (111: Connection refused)",
    "open() \"/var/www/missing\" failed (2: No such file or directory)",
    "SSL_do_handshake() failed",
    "client intended to send too large body",
    "limiting requests, excess: 5.432",
    "upstream prematurely closed connection",
    "worker_connections are not enough",
  ];
  const errors: string[] = [];
  for (let i = 0; i < errorLines; i++) {
    const level = errorLevels[randomInt(0, errorLevels.length - 1)]!;
    const msg = errorMsgs[randomInt(0, errorMsgs.length - 1)]!;
    const ts = randomTimestamp().replace("T", " ").replace("Z", "");
    const pid = randomInt(1000, 9999);
    errors.push(`${ts} [${level}] ${pid}#0: *${randomInt(1, 99999)} ${msg}, client: ${ips[randomInt(0, ips.length - 1)]}, server: example.com`);
  }

  // metrics.json
  const metrics = {
    collected_at: randomTimestamp(),
    uptime_seconds: randomInt(86400, 8640000),
    total_requests: nginxLines,
    active_connections: randomInt(50, 500),
    requests_per_second: parseFloat(randomFloat(10, 500)),
    avg_response_time_ms: parseFloat(randomFloat(5, 250)),
    p99_response_time_ms: parseFloat(randomFloat(100, 2000)),
    memory_used_mb: randomInt(512, 8192),
    cpu_percent: parseFloat(randomFloat(5, 95)),
    disk_used_percent: parseFloat(randomFloat(20, 90)),
    error_rate: parseFloat(randomFloat(0.01, 0.15)),
  };

  return {
    "nginx.log": nginx.join("\n"),
    "error.log": errors.join("\n"),
    "metrics.json": JSON.stringify(metrics, null, 2),
  };
}

function generateWeatherStation(): Record<string, string> {
  const readingCount = randomInt(30000, 50000);
  const stationCount = randomInt(20, 50);
  const alertCount = randomInt(100, 500);

  // Stations
  const stationIds: string[] = [];
  const stations: Array<{ id: string; name: string; lat: number; lon: number; elevation: number }> = [];
  for (let i = 0; i < stationCount; i++) {
    const id = `WS-${String(i + 1).padStart(3, "0")}`;
    stationIds.push(id);
    stations.push({
      id,
      name: `Station ${["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel"][i % 8]} ${i}`,
      lat: parseFloat(randomFloat(25, 48)),
      lon: parseFloat(randomFloat(-125, -70)),
      elevation: randomInt(0, 4000),
    });
  }

  // Readings
  const readingLines = ["timestamp,station_id,temperature_c,humidity_pct,pressure_hpa,wind_speed_kmh,wind_direction,precipitation_mm"];
  const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  for (let i = 0; i < readingCount; i++) {
    const station = stationIds[randomInt(0, stationIds.length - 1)]!;
    const ts = randomTimestamp();
    const temp = randomFloat(-30, 45);
    // Occasional missing values
    const humidity = Math.random() < 0.02 ? "" : randomFloat(5, 100, 1);
    const pressure = randomFloat(950, 1050, 1);
    const wind = randomFloat(0, 120, 1);
    const dir = directions[randomInt(0, directions.length - 1)]!;
    const precip = Math.random() < 0.6 ? "0.0" : randomFloat(0, 50, 1);
    readingLines.push(`${ts},${station},${temp},${humidity},${pressure},${wind},${dir},${precip}`);
  }

  // Alerts
  const alertTypes = ["HEAT_WARNING", "FROST_WARNING", "FLOOD_WATCH", "HIGH_WIND", "STORM_WARNING", "DROUGHT_ALERT"];
  const severities = ["low", "moderate", "high", "critical"];
  const alertLines: string[] = [];
  for (let i = 0; i < alertCount; i++) {
    const ts = randomTimestamp();
    const station = stationIds[randomInt(0, stationIds.length - 1)]!;
    const type = alertTypes[randomInt(0, alertTypes.length - 1)]!;
    const severity = severities[randomInt(0, severities.length - 1)]!;
    alertLines.push(`[${ts}] ${station} ${type} severity=${severity} duration=${randomInt(1, 72)}h`);
  }

  return {
    "readings.csv": readingLines.join("\n"),
    "stations.json": JSON.stringify(stations, null, 2),
    "alerts.txt": alertLines.join("\n"),
  };
}

function generateSensorNetwork(): Record<string, string> {
  const telemetryCount = randomInt(50000, 100000);
  const deviceCount = randomInt(50, 200);
  const anomalyCount = randomInt(100, 500);

  // Devices
  const deviceIds: string[] = [];
  const deviceTypes = ["temperature", "pressure", "vibration", "humidity", "flow", "voltage"];
  const locations = ["Building-A", "Building-B", "Warehouse-1", "Warehouse-2", "Factory-Floor", "Server-Room", "Lab-1", "Lab-2"];
  const devices: Array<{ device_id: string; type: string; location: string; installed: string; firmware: string }> = [];
  for (let i = 0; i < deviceCount; i++) {
    const id = `DEV-${String(i + 1).padStart(4, "0")}`;
    deviceIds.push(id);
    devices.push({
      device_id: id,
      type: deviceTypes[randomInt(0, deviceTypes.length - 1)]!,
      location: locations[randomInt(0, locations.length - 1)]!,
      installed: randomDate(2020, 2023),
      firmware: `v${randomInt(1, 5)}.${randomInt(0, 9)}.${randomInt(0, 99)}`,
    });
  }

  // Telemetry
  const telemetryLines = ["timestamp,device_id,value,unit,battery_pct,signal_strength"];
  const units = ["celsius", "hpa", "mm/s", "percent", "l/min", "volts"];
  for (let i = 0; i < telemetryCount; i++) {
    const device = devices[randomInt(0, devices.length - 1)]!;
    const ts = randomTimestamp();
    const typeIdx = deviceTypes.indexOf(device.type);
    const unit = units[typeIdx] ?? "unknown";
    let value = randomFloat(-10, 100);
    // Occasional outlier
    if (Math.random() < 0.01) value = randomFloat(900, 9999);
    // Occasional null reading
    const valueStr = Math.random() < 0.005 ? "NaN" : value;
    const battery = randomFloat(0, 100, 0);
    const signal = randomInt(-100, -20);
    telemetryLines.push(`${ts},${device.device_id},${valueStr},${unit},${battery},${signal}`);
  }

  // Anomalies
  const anomalyLines = ["timestamp,device_id,anomaly_type,severity,value,expected_range"];
  const anomalyTypes = ["spike", "dropout", "drift", "flatline", "out_of_range"];
  for (let i = 0; i < anomalyCount; i++) {
    const ts = randomTimestamp();
    const device = deviceIds[randomInt(0, deviceIds.length - 1)]!;
    const type = anomalyTypes[randomInt(0, anomalyTypes.length - 1)]!;
    const severity = randomInt(1, 5);
    const value = randomFloat(-50, 500);
    const lo = randomFloat(-10, 30);
    const hi = randomFloat(40, 90);
    anomalyLines.push(`${ts},${device},${type},${severity},${value},${lo}-${hi}`);
  }

  return {
    "telemetry.csv": telemetryLines.join("\n"),
    "devices.json": JSON.stringify(devices, null, 2),
    "anomalies.csv": anomalyLines.join("\n"),
  };
}

const DATASET_TEMPLATES: DatasetTemplate[] = [
  { name: "ecommerce", generate: generateEcommerce },
  { name: "server_logs", generate: generateServerLogs },
  { name: "weather_station", generate: generateWeatherStation },
  { name: "sensor_network", generate: generateSensorNetwork },
];

export class OpenDataGenerator {
  placeData(workspacePath: string): { datasetName: string; files: string[] } {
    // Remove old quest directory
    const questDir = join(workspacePath, "quests");
    if (existsSync(questDir)) {
      rmSync(questDir, { recursive: true, force: true });
    }

    // Create data and output directories
    const dataDir = join(workspacePath, "data");
    // Clean previous data if any
    if (existsSync(dataDir)) {
      rmSync(dataDir, { recursive: true, force: true });
    }
    mkdirSync(dataDir, { recursive: true });

    const outputDir = join(workspacePath, "output");
    // Clean previous output
    if (existsSync(outputDir)) {
      rmSync(outputDir, { recursive: true, force: true });
    }
    mkdirSync(outputDir, { recursive: true });

    // Pick a random dataset
    const template = DATASET_TEMPLATES[randomInt(0, DATASET_TEMPLATES.length - 1)]!;
    const files = template.generate();

    const fileNames: string[] = [];
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dataDir, name), content, "utf-8");
      fileNames.push(name);
    }

    return { datasetName: template.name, files: fileNames };
  }
}
