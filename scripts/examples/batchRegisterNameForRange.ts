/**
 * Submit `batchRegisterNameFor` for a contiguous range of
 * `context/batch-register-args/batch-NNN.json` files (inclusive).
 *
 * USAGE:
 *   npx hardhat run scripts/examples/batchRegisterNameForRange.ts --network sepolia
 *
 * Set `startIndex` / `endIndex` below (0 → batch-000.json, 703 → batch-703.json)
 * or override with START_INDEX / END_INDEX.
 * Override args dir with ARGS_DIR=… if needed.
 *
 * Requires: signer is XNS owner, migration still open, and the batch namespace exists on-chain.
 *
 * Resume:
 *   After each successful batch, progress is written to
 *   `context/batch-register-args.checkpoint.json`. Restarting continues from the next
 *   index. A reverted batch is appended to `context/batch-register-args.failures.jsonl`
 *   and the checkpoint is not advanced (restart retries that batch).
 *   RESET_CHECKPOINT=1 ignores the checkpoint and uses startIndex.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import hre from "hardhat";
import { formatEther, parseUnits } from "ethers";
import { XNS_ADDRESS } from "../../constants/addresses";

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

/*//////////////////////////////////////////////////////////////
                            USER INPUTS
//////////////////////////////////////////////////////////////*/

// Inclusive range. 0 = batch-000.json, 703 = batch-703.json
const startIndexDefault = 704;
const endIndexDefault = 705;

// Signer index (0 = account 1, 1 = account 2, …)
const signerIndex = 2;

// EIP-1559 fee cap (tx may stay pending if base fee exceeds this)
const maxFeePerGas = parseUnits("0.05", "gwei");
const maxPriorityFeePerGas = parseUnits("0.05", "gwei");

const argsDirDefault = path.resolve(__dirname, "../../context/batch-register-args");

type BatchArgs = {
  recipients: string[];
  labels: string[];
  namespace: string;
};

type Checkpoint = {
  nextIndex: number;
  lastCompletedBatch: number;
  lastTxHash: string;
  updatedAt: string;
};

type FailureRow = {
  ts: string;
  batch: number;
  file: string;
  txHash?: string;
  reason: string;
};

function formatErr(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown> & {
      reason?: unknown;
      shortMessage?: unknown;
      message?: unknown;
      info?: { error?: { message?: unknown } };
    };
    if (e.reason) return String(e.reason);
    if (e.shortMessage) return String(e.shortMessage);
    if (e.info?.error?.message) return String(e.info.error.message);
    if (e.message) return String(e.message);
  }
  return String(err);
}

function batchFileName(index: number): string {
  return `batch-${String(index).padStart(3, "0")}.json`;
}

function loadBatch(dir: string, index: number): { filePath: string; args: BatchArgs } {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Batch index must be a non-negative integer, got ${index}`);
  }
  const filePath = path.resolve(dir, batchFileName(index));
  if (!existsSync(filePath)) {
    throw new Error(`Batch file not found: ${filePath}`);
  }
  const args = JSON.parse(readFileSync(filePath, "utf8")) as BatchArgs;
  if (!Array.isArray(args.recipients) || !Array.isArray(args.labels) || !args.namespace) {
    throw new Error(`Invalid batch JSON: ${filePath}`);
  }
  if (args.recipients.length === 0 || args.recipients.length !== args.labels.length) {
    throw new Error(
      `recipients/labels length mismatch in ${filePath}: ${args.recipients.length} vs ${args.labels.length}`,
    );
  }
  return { filePath, args };
}

async function main() {
  const startIndex = process.env.START_INDEX != null ? Number(process.env.START_INDEX) : startIndexDefault;
  const endIndex = process.env.END_INDEX != null ? Number(process.env.END_INDEX) : endIndexDefault;
  const argsDir = process.env.ARGS_DIR ?? argsDirDefault;
  const checkpointPath = path.resolve(`${argsDir}.checkpoint.json`);
  const failuresPath = path.resolve(`${argsDir}.failures.jsonl`);

  if (!Number.isInteger(startIndex) || startIndex < 0) {
    throw new Error(`START_INDEX must be a non-negative integer, got ${startIndex}`);
  }
  if (!Number.isInteger(endIndex) || endIndex < startIndex) {
    throw new Error(`END_INDEX must be an integer >= START_INDEX (${startIndex}), got ${endIndex}`);
  }

  const networkName = hre.network.name;
  const contractAddress = XNS_ADDRESS[networkName];
  if (!contractAddress) {
    throw new Error(
      `XNS contract address not set for network: ${networkName}. Use --network ethMain (or sepolia) and ensure constants/addresses.ts has an entry.`,
    );
  }

  const xns = await hre.ethers.getContractAt("XNSv2", contractAddress);
  const signers = await hre.ethers.getSigners();
  const signer = signers[signerIndex];
  if (!signer) throw new Error(`No signer at index ${signerIndex}`);

  const first = loadBatch(argsDir, startIndex);
  const owner = await xns.owner();
  const migrationOpen = await xns.isMigrationOpen();
  const getNamespaceInfo = xns.getFunction("getNamespaceInfo(string)");
  const [, nsOwner] = await getNamespaceInfo(first.args.namespace);

  console.log(`\nNetwork: ${GREEN}${networkName}${RESET}`);
  console.log(`XNS contract: ${GREEN}${contractAddress}${RESET}`);
  console.log(`Signer: ${GREEN}${signer.address}${RESET}`);
  console.log(`XNS owner: ${GREEN}${owner}${RESET}`);
  console.log(`Range: ${GREEN}${startIndex}${RESET}–${GREEN}${endIndex}${RESET} (${batchFileName(startIndex)} … ${batchFileName(endIndex)})`);
  console.log(`Checkpoint: ${GREEN}${checkpointPath}${RESET}`);
  console.log(`Failures: ${GREEN}${failuresPath}${RESET}\n`);

  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(
      `Signer is not the XNS owner. Transfer ownership to ${signer.address} and accept it before running.`,
    );
  }
  if (!migrationOpen) {
    throw new Error("XNS migration window is closed (`isMigrationOpen()` is false).");
  }
  if (nsOwner === hre.ethers.ZeroAddress) {
    throw new Error(`Namespace "${first.args.namespace}" is not registered on XNS.`);
  }

  const balance = await hre.ethers.provider.getBalance(signer.address);
  console.log(`Owner ETH balance: ${GREEN}${formatEther(balance)}${RESET}`);
  console.log(`Max fee: ${GREEN}0.05 gwei${RESET}  priority ${GREEN}0.05 gwei${RESET}\n`);
  if (balance === 0n) throw new Error("Owner account has 0 ETH for gas");

  let nextIndex = startIndex;
  if (process.env.RESET_CHECKPOINT !== "1" && existsSync(checkpointPath)) {
    const cp = JSON.parse(readFileSync(checkpointPath, "utf8")) as Checkpoint;
    if (Number.isInteger(cp.nextIndex) && cp.nextIndex > nextIndex) {
      nextIndex = cp.nextIndex;
      console.log(
        `${YELLOW}Resuming from batch ${nextIndex} (last completed ${cp.lastCompletedBatch})${RESET}\n`,
      );
    }
  }
  if (nextIndex > endIndex) {
    console.log(`${GREEN}Nothing to do.${RESET} Checkpoint is already past endIndex ${endIndex}.`);
    return;
  }

  const register = xns.connect(signer).getFunction("batchRegisterNameFor");
  let okBatches = 0;
  let failBatches = 0;

  for (let index = nextIndex; index <= endIndex; index++) {
    const stillOpen = await xns.isMigrationOpen();
    if (!stillOpen) {
      throw new Error("Migration window closed mid-run. Checkpoint is saved; restart after it reopens.");
    }

    const { filePath, args } = loadBatch(argsDir, index);
    console.log(
      `${YELLOW}Batch ${index}${RESET} ${path.basename(filePath)}  ${args.labels.length} names  ` +
        `${args.labels[0]} … ${args.labels[args.labels.length - 1]}`,
    );

    try {
      const estimated = await register.estimateGas(args.recipients, args.labels, args.namespace);
      const gasLimit = (estimated * 120n) / 100n;
      const tx = await register(args.recipients, args.labels, args.namespace, {
        gasLimit,
        maxFeePerGas,
        maxPriorityFeePerGas,
      });
      console.log(`  tx ${GREEN}${tx.hash}${RESET}  est ${estimated.toString()}`);
      const receipt = await tx.wait();
      if (!receipt || receipt.status === 0) {
        throw new Error(`transaction reverted (${tx.hash})`);
      }

      const registered = receipt.logs.filter((log) => {
        try {
          return xns.interface.parseLog(log)?.name === "NameRegistered";
        } catch {
          return false;
        }
      }).length;

      okBatches += 1;
      const checkpoint: Checkpoint = {
        nextIndex: index + 1,
        lastCompletedBatch: index,
        lastTxHash: tx.hash,
        updatedAt: new Date().toISOString(),
      };
      writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2) + "\n");
      console.log(
        `  ${GREEN}ok${RESET} gas ${receipt.gasUsed.toString()}  NameRegistered ${registered}/${args.labels.length}  ` +
          `checkpoint -> ${checkpoint.nextIndex}\n`,
      );
    } catch (err) {
      failBatches += 1;
      const row: FailureRow = {
        ts: new Date().toISOString(),
        batch: index,
        file: path.basename(filePath),
        reason: formatErr(err),
      };
      appendFileSync(failuresPath, JSON.stringify(row) + "\n");
      console.error(`${RED}batch ${index} failed. Checkpoint not advanced.${RESET}\n  ${row.reason}\n`);
      throw new Error(
        `Stopped at batch ${index} (${batchFileName(index)}). Fix the issue and rerun; it will retry this batch.`,
      );
    }
  }

  console.log(`${GREEN}Done.${RESET} Batches ok ${okBatches}, failed ${failBatches}.`);
}

main().catch((error: unknown) => {
  console.error(RED + (error instanceof Error ? error.message : formatErr(error)) + RESET);
  process.exitCode = 1;
});
