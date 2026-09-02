#!/usr/bin/env node

/**
 * Builds Safe Transaction Builder JSON for v1→v2 name migration using
 * `batchRegisterNameFor` (grouped by namespace, chunked for gas/Safe size).
 *
 * Import each output JSON into Safe Transaction Builder and submit as a batch.
 *
 * Run:
 *   node scripts/tools/build-safe-name-migration-batch.js --xns 0x...
 *
 * With overrides:
 *   XNS_ADDRESS=0x... node scripts/tools/build-safe-name-migration-batch.js
 *   node scripts/tools/build-safe-name-migration-batch.js --skip xns@x --batch-size 100
 *   node scripts/tools/build-safe-name-migration-batch.js --input path/to/names.json --output path/to/out.json
 *   node scripts/tools/build-safe-name-migration-batch.js --chunk-size 20
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
/** Names per `batchRegisterNameFor` call (gas / calldata sized). */
const DEFAULT_BATCH_SIZE = 100;

/**
 * v2_name values to omit from the batch (e.g. v1 contract self-name `xns@x`).
 * Additional skips: `--skip foo@bar,baz@xns`
 */
const DEFAULT_SKIP_V2_NAMES = [];

const BATCH_REGISTER_NAME_FOR_INPUTS = [
  { internalType: "address[]", name: "recipients", type: "address[]" },
  { internalType: "string[]", name: "labels", type: "string[]" },
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
    batchSize: DEFAULT_BATCH_SIZE,
    chunkSize: 0,
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
    } else if (arg === "--batch-size" && argv[i + 1]) {
      opts.batchSize = Number(argv[++i]);
      if (!Number.isInteger(opts.batchSize) || opts.batchSize < 1) {
        throw new Error(`Invalid --batch-size: ${argv[i]}`);
      }
    } else if (arg === "--chunk-size" && argv[i + 1]) {
      opts.chunkSize = Number(argv[++i]);
      if (!Number.isInteger(opts.chunkSize) || opts.chunkSize < 0) {
        throw new Error(`Invalid --chunk-size: ${argv[i]}`);
      }
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
  --batch-size <n>     Names per batchRegisterNameFor call (default: ${DEFAULT_BATCH_SIZE})
  --chunk-size <n>     Split into multiple files of at most n txs (0 = single file)
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

/**
 * Group by namespace, then split each group into batches of `batchSize`.
 * Returns ordered list of { namespace, recipients, labels } for each contract call.
 */
function buildCallBatches(entries, batchSize) {
  const byNamespace = new Map();
  for (const entry of entries) {
    const key = entry.namespace;
    if (!byNamespace.has(key)) byNamespace.set(key, []);
    byNamespace.get(key).push(entry);
  }

  const calls = [];
  for (const [namespace, group] of byNamespace) {
    for (let i = 0; i < group.length; i += batchSize) {
      const slice = group.slice(i, i + batchSize);
      calls.push({
        namespace,
        recipients: slice.map((e) => e.recipient),
        labels: slice.map((e) => e.label),
      });
    }
  }
  return calls;
}

function buildBatch(calls, { safe, xns, chainId, description }) {
  const transactions = calls.map(({ recipients, labels, namespace }) => ({
    to: xns,
    value: "0",
    data: null,
    contractMethod: {
      inputs: BATCH_REGISTER_NAME_FOR_INPUTS,
      name: "batchRegisterNameFor",
      payable: false,
    },
    contractInputsValues: {
      // Safe Transaction Builder expects array args as JSON strings.
      recipients: JSON.stringify(recipients),
      labels: JSON.stringify(labels),
      namespace,
    },
  }));

  return {
    version: "1.0",
    chainId,
    createdAt: Date.now(),
    meta: {
      name: "XNS v1 name migration batch",
      description,
      txBuilderVersion: "1.18.3",
      createdFromSafeAddress: safe,
      createdFromOwnerAddress: "",
      checksum: "",
    },
    transactions,
  };
}

function chunkArray(items, size) {
  if (!size || size <= 0) return [items];
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function chunkOutputPath(baseOutput, index, total) {
  if (total === 1) return baseOutput;
  const dir = path.dirname(baseOutput);
  const ext = path.extname(baseOutput);
  const stem = path.basename(baseOutput, ext);
  const pad = String(index + 1).padStart(String(total).length, "0");
  return path.join(dir, `${stem}-${pad}-of-${total}${ext || ".json"}`);
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
  const calls = buildCallBatches(selected, opts.batchSize);
  const files = chunkArray(calls, opts.chunkSize);

  fs.mkdirSync(path.dirname(opts.output), { recursive: true });

  let totalTxs = 0;
  let totalNames = 0;
  for (let i = 0; i < files.length; i++) {
    const outPath = chunkOutputPath(opts.output, i, files.length);
    const nameCount = files[i].reduce((n, c) => n + c.recipients.length, 0);
    totalNames += nameCount;
    const description =
      files.length === 1
        ? `${files[i].length} batchRegisterNameFor calls (${nameCount} names) from ${path.relative(root, opts.input)}`
        : `Chunk ${i + 1}/${files.length}: ${files[i].length} batchRegisterNameFor calls (${nameCount} names) from ${path.relative(root, opts.input)}`;

    const batch = buildBatch(files[i], {
      safe: opts.safe,
      xns: opts.xns,
      chainId: opts.chainId,
      description,
    });
    totalTxs += batch.transactions.length;

    fs.writeFileSync(outPath, `${JSON.stringify(batch, null, 2)}\n`, "utf8");
    console.log(`Wrote ${batch.transactions.length} txs (${nameCount} names) to ${outPath}`);
  }

  console.log(`Source: ${opts.input}`);
  console.log(
    `Export snapshot: ${meta.count ?? selected.length} names (${meta.verifiedCount ?? "?"} verified in file)`,
  );
  console.log(
    `Selected ${selected.length} names → ${totalTxs} batchRegisterNameFor txs (${totalNames} names) in ${files.length} file(s) [batch-size=${opts.batchSize}]`,
  );
  if (skipped.length > 0) {
    console.log(`Skipped ${skipped.length} entries:`);
    for (const s of skipped) {
      console.log(`  - ${s.v2_name}: ${s.reason}`);
    }
  }
}

main();
