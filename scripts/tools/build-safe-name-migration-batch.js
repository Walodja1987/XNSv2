#!/usr/bin/env node

/**
 * Builds Safe Transaction Builder JSON for v1→v2 name migration: one `registerNameFor`
 * call per entry in `context/migration scripts/out/v1-name-registrations.json`.
 *
 * Import the output JSON into Safe Transaction Builder and submit as a batch.
 *
 * Run:
 *   node scripts/tools/build-safe-name-migration-batch.js
 *
 * With overrides:
 *   XNS_ADDRESS=0x... node scripts/tools/build-safe-name-migration-batch.js
 *   node scripts/tools/build-safe-name-migration-batch.js --skip xns@x
 *   node scripts/tools/build-safe-name-migration-batch.js --input path/to/names.json --output path/to/out.json
 */

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../..");

const DEFAULT_SAFE_ADDRESS = "0xEd5356Cf46b7cFfbA4ae0bF804E5C810e60e00CC";
/** Set to the deployed XNSv2 mainnet address (or pass XNS_ADDRESS env / --xns). */
const DEFAULT_XNS_ADDRESS = process.env.XNS_ADDRESS || "";
const DEFAULT_CHAIN_ID = "1";
const DEFAULT_INPUT = path.join(
  root,
  "context/migration scripts/out/v1-name-registrations.json",
);
const DEFAULT_OUTPUT = path.join(root, "scripts/tools/out/v1-name-migration.json");

/**
 * v2_name values to omit from the batch (e.g. v1 contract self-name `xns@x`).
 * Additional skips: `--skip foo@bar,baz@xns`
 */
const DEFAULT_SKIP_V2_NAMES = [];

const REGISTER_NAME_FOR_INPUTS = [
  { internalType: "address", name: "recipient", type: "address" },
  { internalType: "string", name: "label", type: "string" },
  { internalType: "string", name: "namespace", type: "string" },
];

function parseArgs(argv) {
  const opts = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    safe: DEFAULT_SAFE_ADDRESS,
    xns: DEFAULT_XNS_ADDRESS,
    chainId: DEFAULT_CHAIN_ID,
    skip: new Set(DEFAULT_SKIP_V2_NAMES.map(normalizeV2Name)),
    verifiedOnly: true,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--input" && argv[i + 1]) {
      opts.input = path.resolve(argv[++i]);
    } else if (arg === "--output" && argv[i + 1]) {
      opts.output = path.resolve(argv[++i]);
    } else if (arg === "--safe" && argv[i + 1]) {
      opts.safe = argv[++i];
    } else if (arg === "--xns" && argv[i + 1]) {
      opts.xns = argv[++i];
    } else if (arg === "--chain-id" && argv[i + 1]) {
      opts.chainId = String(argv[++i]);
    } else if (arg === "--skip" && argv[i + 1]) {
      for (const name of argv[++i].split(",")) {
        const trimmed = normalizeV2Name(name);
        if (trimmed) opts.skip.add(trimmed);
      }
    } else if (arg === "--include-unverified") {
      opts.verifiedOnly = false;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg} (use --help)`);
    }
  }

  return opts;
}

function printHelp() {
  console.log(`Usage: node scripts/tools/build-safe-name-migration-batch.js [options]

Options:
  --input <path>       Name export JSON (default: context/migration scripts/out/v1-name-registrations.json)
  --output <path>      Safe batch output (default: scripts/tools/out/v1-name-migration.json)
  --safe <address>     Safe that will execute the batch (default: DEFAULT_SAFE_ADDRESS in script)
  --xns <address>      XNSv2 contract address (default: XNS_ADDRESS env or DEFAULT_XNS_ADDRESS in script)
  --chain-id <id>      Chain id string (default: 1)
  --skip <a@ns,b@c>    Comma-separated v2_name values to omit
  --include-unverified Include names with verified: false
  --help               Show this help

Environment:
  XNS_ADDRESS          Same as --xns
`);
}

function normalizeV2Name(name) {
  return String(name).trim().toLowerCase();
}

function isAddress(value) {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function loadNames(inputPath, { verifiedOnly, skip }) {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  const payload = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const raw = payload.names;
  if (!Array.isArray(raw)) {
    throw new Error(`Expected "names" array in ${inputPath}`);
  }

  const selected = [];
  const skipped = [];

  for (const entry of raw) {
    const v2Name = entry.v2_name || `${entry.label}@${entry.namespace}`;
    const v2Key = normalizeV2Name(v2Name);

    if (skip.has(v2Key)) {
      skipped.push({ reason: "skip list", v2_name: v2Name });
      continue;
    }
    if (verifiedOnly && entry.verified === false) {
      skipped.push({ reason: "unverified", v2_name: v2Name });
      continue;
    }
    if (!entry.label || !entry.namespace) {
      skipped.push({ reason: "missing label/namespace", v2_name: v2Name });
      continue;
    }
    if (!isAddress(entry.owner)) {
      skipped.push({ reason: "invalid owner", v2_name: v2Name, owner: entry.owner });
      continue;
    }

    selected.push({
      recipient: entry.owner,
      label: String(entry.label),
      namespace: String(entry.namespace),
      v2_name: v2Name,
    });
  }

  ensureNoDuplicateNames(selected);

  return { selected, skipped, meta: payload };
}

function ensureNoDuplicateNames(entries) {
  const seen = new Set();
  for (const entry of entries) {
    const key = normalizeV2Name(entry.v2_name);
    if (seen.has(key)) {
      throw new Error(`Duplicate v2_name in batch input: ${entry.v2_name}`);
    }
    seen.add(key);
  }
}

function buildBatch(entries, { safe, xns, chainId, inputPath }) {
  const transactions = entries.map(({ recipient, label, namespace }) => ({
    to: xns,
    value: "0",
    data: null,
    contractMethod: {
      inputs: REGISTER_NAME_FOR_INPUTS,
      name: "registerNameFor",
      payable: false,
    },
    contractInputsValues: {
      recipient,
      label,
      namespace,
    },
  }));

  return {
    version: "1.0",
    chainId,
    createdAt: Date.now(),
    meta: {
      name: "XNS v1 name migration batch",
      description: `${transactions.length} registerNameFor calls from ${path.relative(root, inputPath)}`,
      txBuilderVersion: "1.18.3",
      createdFromSafeAddress: safe,
      createdFromOwnerAddress: "",
      checksum: "",
    },
    transactions,
  };
}

function main() {
  const opts = parseArgs(process.argv);

  if (!opts.xns || !isAddress(opts.xns)) {
    throw new Error(
      "XNSv2 contract address required: set DEFAULT_XNS_ADDRESS / XNS_ADDRESS env or pass --xns 0x...",
    );
  }
  if (!isAddress(opts.safe)) {
    throw new Error(`Invalid Safe address: ${opts.safe}`);
  }

  const { selected, skipped, meta } = loadNames(opts.input, opts);
  const batch = buildBatch(selected, {
    safe: opts.safe,
    xns: opts.xns,
    chainId: opts.chainId,
    inputPath: opts.input,
  });

  fs.mkdirSync(path.dirname(opts.output), { recursive: true });
  fs.writeFileSync(opts.output, `${JSON.stringify(batch, null, 2)}\n`, "utf8");

  console.log(`Source: ${opts.input}`);
  console.log(`Export snapshot: ${meta.count ?? selected.length} names (${meta.verifiedCount ?? "?"} verified in file)`);
  console.log(`Wrote ${batch.transactions.length} txs to ${opts.output}`);
  if (skipped.length > 0) {
    console.log(`Skipped ${skipped.length} entries:`);
    for (const s of skipped) {
      console.log(`  - ${s.v2_name}: ${s.reason}`);
    }
  }
}

main();
