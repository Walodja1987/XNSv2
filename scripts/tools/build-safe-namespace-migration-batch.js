#!/usr/bin/env node

/**
 * Builds Safe Transaction Builder JSON for v1→v2 namespace migration: one
 * `registerPublicNamespaceFor` or `registerPrivateNamespaceFor` call per entry in
 * `context/migration scripts/out/v1-namespaces.json`.
 *
 * Preserves each namespace's v1 owner, pricePerName, and public/private flag.
 * Import the output JSON into Safe Transaction Builder (contract owner Safe).
 *
 * Run:
 *   node scripts/tools/build-safe-namespace-migration-batch.js
 *
 * With overrides:
 *   XNS_ADDRESS=0x... node scripts/tools/build-safe-namespace-migration-batch.js
 *   node scripts/tools/build-safe-namespace-migration-batch.js --xns 0x... --chunk-size 200
 *   node scripts/tools/build-safe-namespace-migration-batch.js --public-only
 *   node scripts/tools/build-safe-namespace-migration-batch.js --skip big-week,x
 */

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../..");

const DEFAULT_SAFE_ADDRESS = "0xEd5356Cf46b7cFfbA4ae0bF804E5C810e60e00CC";
/** Deployed XNSv2 address (override via XNS_ADDRESS env or --xns). */
const DEFAULT_XNS_ADDRESS = process.env.XNS_ADDRESS || "0xA235c204bf85BB8952720A64801992F883c9072E";
const DEFAULT_CHAIN_ID = "1";
const DEFAULT_INPUT = path.join(
  root,
  "context/migration scripts/out/v1-namespaces.json",
);
const DEFAULT_OUTPUT = path.join(
  root,
  "scripts/tools/out/v1-namespace-migration.json",
);

/** Namespace names to omit (in addition to `--skip`). */
const DEFAULT_SKIP_NAMESPACES = [];

const NS_FOR_INPUTS = [
  { internalType: "address", name: "nsOwner", type: "address" },
  { internalType: "string", name: "namespace", type: "string" },
  { internalType: "uint256", name: "pricePerName", type: "uint256" },
];

function parseArgs(argv) {
  const opts = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    safe: DEFAULT_SAFE_ADDRESS,
    xns: DEFAULT_XNS_ADDRESS,
    chainId: DEFAULT_CHAIN_ID,
    skip: new Set(DEFAULT_SKIP_NAMESPACES.map(normalizeNamespace)),
    publicOnly: false,
    privateOnly: false,
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
        const trimmed = normalizeNamespace(name);
        if (trimmed) opts.skip.add(trimmed);
      }
    } else if (arg === "--public-only") {
      opts.publicOnly = true;
    } else if (arg === "--private-only") {
      opts.privateOnly = true;
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

  if (opts.publicOnly && opts.privateOnly) {
    throw new Error("Use only one of --public-only / --private-only");
  }

  return opts;
}

function printHelp() {
  console.log(`Usage: node scripts/tools/build-safe-namespace-migration-batch.js [options]

Options:
  --input <path>       Namespace export JSON (default: context/migration scripts/out/v1-namespaces.json)
  --output <path>      Safe batch output (default: scripts/tools/out/v1-namespace-migration.json)
  --safe <address>     Safe that will execute the batch (default: DEFAULT_SAFE_ADDRESS in script)
  --xns <address>      XNSv2 contract address (default: XNS_ADDRESS env or DEFAULT_XNS_ADDRESS in script)
  --chain-id <id>      Chain id string (default: 1)
  --skip <a,b,c>       Comma-separated namespace names to omit
  --public-only        Only include public namespaces
  --private-only       Only include private namespaces
  --chunk-size <n>     Split into multiple files of at most n txs (0 = single file)
  --help               Show this help

Environment:
  XNS_ADDRESS          Same as --xns
`);
}

function normalizeNamespace(ns) {
  return String(ns).trim().replace(/^\./, "").toLowerCase();
}

function isAddress(value) {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isUintString(value) {
  return typeof value === "string" && /^\d+$/.test(value);
}

function loadNamespaces(inputPath, { skip, publicOnly, privateOnly }) {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  const payload = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const raw = payload.namespaces;
  if (!Array.isArray(raw)) {
    throw new Error(`Expected "namespaces" array in ${inputPath}`);
  }

  const selected = [];
  const skipped = [];

  for (const entry of raw) {
    const ns = normalizeNamespace(entry.namespace);
    const displayName = String(entry.namespace ?? "");

    if (!ns) {
      skipped.push({ reason: "empty namespace", namespace: displayName });
      continue;
    }
    if (skip.has(ns)) {
      skipped.push({ reason: "skip list", namespace: displayName });
      continue;
    }

    const isPrivate = Boolean(entry.isPrivate);
    if (publicOnly && isPrivate) {
      skipped.push({ reason: "public-only filter", namespace: displayName });
      continue;
    }
    if (privateOnly && !isPrivate) {
      skipped.push({ reason: "private-only filter", namespace: displayName });
      continue;
    }
    if (!isAddress(entry.owner)) {
      skipped.push({
        reason: "invalid owner",
        namespace: displayName,
        owner: entry.owner,
      });
      continue;
    }

    const priceWei = entry.pricePerNameWei;
    if (!isUintString(priceWei)) {
      skipped.push({
        reason: "invalid pricePerNameWei",
        namespace: displayName,
        pricePerNameWei: priceWei,
      });
      continue;
    }

    selected.push({
      namespace: displayName.trim().replace(/^\./, ""),
      nsOwner: entry.owner,
      pricePerName: priceWei,
      isPrivate,
    });
  }

  ensureNoDuplicates(selected);

  return { selected, skipped, meta: payload };
}

function ensureNoDuplicates(entries) {
  const seen = new Set();
  for (const entry of entries) {
    const key = normalizeNamespace(entry.namespace);
    if (seen.has(key)) {
      throw new Error(`Duplicate namespace in batch input: ${entry.namespace}`);
    }
    seen.add(key);
  }
}

function buildBatch(entries, { safe, xns, chainId, description }) {
  const transactions = entries.map(
    ({ namespace, nsOwner, pricePerName, isPrivate }) => ({
      to: xns,
      value: "0",
      data: null,
      contractMethod: {
        inputs: NS_FOR_INPUTS,
        name: isPrivate
          ? "registerPrivateNamespaceFor"
          : "registerPublicNamespaceFor",
        payable: false,
      },
      contractInputsValues: {
        nsOwner,
        namespace,
        pricePerName,
      },
    }),
  );

  return {
    version: "1.0",
    chainId,
    createdAt: Date.now(),
    meta: {
      name: "XNS v1 namespace migration batch",
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

  const { selected, skipped, meta } = loadNamespaces(opts.input, opts);
  const chunks = chunkArray(selected, opts.chunkSize);

  fs.mkdirSync(path.dirname(opts.output), { recursive: true });

  let totalTxs = 0;
  for (let i = 0; i < chunks.length; i++) {
    const outPath = chunkOutputPath(opts.output, i, chunks.length);
    const description =
      chunks.length === 1
        ? `${chunks[i].length} namespace registrations from ${path.relative(root, opts.input)}`
        : `Chunk ${i + 1}/${chunks.length}: ${chunks[i].length} namespace registrations from ${path.relative(root, opts.input)}`;

    const batch = buildBatch(chunks[i], {
      safe: opts.safe,
      xns: opts.xns,
      chainId: opts.chainId,
      description,
    });

    fs.writeFileSync(outPath, `${JSON.stringify(batch, null, 2)}\n`, "utf8");
    totalTxs += batch.transactions.length;
    console.log(`Wrote ${batch.transactions.length} txs to ${outPath}`);
  }

  const publicCount = selected.filter((e) => !e.isPrivate).length;
  const privateCount = selected.filter((e) => e.isPrivate).length;

  console.log(`Source: ${opts.input}`);
  console.log(
    `Export snapshot: count=${meta.count ?? "?"} asOfBlock=${meta.asOfBlock ?? "?"} missing=${JSON.stringify(meta.missing ?? [])}`,
  );
  console.log(
    `Selected ${selected.length} namespaces (${publicCount} public, ${privateCount} private) → ${totalTxs} txs in ${chunks.length} file(s)`,
  );
  if (skipped.length > 0) {
    console.log(`Skipped ${skipped.length} entries:`);
    for (const s of skipped.slice(0, 50)) {
      console.log(`  - ${s.namespace}: ${s.reason}`);
    }
    if (skipped.length > 50) {
      console.log(`  … and ${skipped.length - 50} more`);
    }
  }
}

main();
