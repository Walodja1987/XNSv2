/**
 * Submit one `batchRegisterNameFor` call from `context/batch-register-args/batch-NNN.json`.
 *
 * USAGE:
 *   npx hardhat run scripts/examples/batchRegisterNameFor.ts --network sepolia
 *
 * Set `batchIndex` below (0 → batch-000.json, 1 → batch-001.json, 35 → batch-035.json)
 * or override with BATCH_INDEX=35.
 * Override args dir with ARGS_DIR=… if needed.
 *
 * Requires: signer is XNS owner, migration still open, and the batch namespace exists on-chain.
 */

import { existsSync, readFileSync } from "node:fs";
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

// 0 = batch-000.json, 1 = batch-001.json, 35 = batch-035.json
const batchIndexDefault = 0;

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
  const batchIndex = process.env.BATCH_INDEX != null ? Number(process.env.BATCH_INDEX) : batchIndexDefault;
  const argsDir = process.env.ARGS_DIR ?? argsDirDefault;
  const { filePath, args } = loadBatch(argsDir, batchIndex);

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

  const owner = await xns.owner();
  const migrationOpen = await xns.isMigrationOpen();
  const getNamespaceInfo = xns.getFunction("getNamespaceInfo(string)");
  const [, nsOwner] = await getNamespaceInfo(args.namespace);

  console.log(`\nNetwork: ${GREEN}${networkName}${RESET}`);
  console.log(`XNS contract: ${GREEN}${contractAddress}${RESET}`);
  console.log(`Signer: ${GREEN}${signer.address}${RESET}`);
  console.log(`XNS owner: ${GREEN}${owner}${RESET}`);
  console.log(`Batch: ${GREEN}${batchIndex}${RESET} (${path.basename(filePath)})`);
  console.log(`Names: ${GREEN}${args.labels.length}${RESET}  namespace ${GREEN}${args.namespace}${RESET}`);
  console.log(`First: ${GREEN}${args.labels[0]}@${args.namespace}${RESET} -> ${args.recipients[0]}`);
  console.log(
    `Last:  ${GREEN}${args.labels[args.labels.length - 1]}@${args.namespace}${RESET} -> ${args.recipients[args.recipients.length - 1]}\n`,
  );

  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(
      `Signer is not the XNS owner. Transfer ownership to ${signer.address} and accept it before running.`,
    );
  }
  if (!migrationOpen) {
    throw new Error("XNS migration window is closed (`isMigrationOpen()` is false).");
  }
  if (nsOwner === hre.ethers.ZeroAddress) {
    throw new Error(`Namespace "${args.namespace}" is not registered on XNS.`);
  }

  const balance = await hre.ethers.provider.getBalance(signer.address);
  console.log(`Owner ETH balance: ${GREEN}${formatEther(balance)}${RESET}`);
  if (balance === 0n) throw new Error("Owner account has 0 ETH for gas");

  const register = xns.connect(signer).getFunction("batchRegisterNameFor");
  const estimated = await register.estimateGas(args.recipients, args.labels, args.namespace);
  const gasLimit = (estimated * 120n) / 100n;
  console.log(`Estimated gas: ${GREEN}${estimated.toString()}${RESET}  (limit ${gasLimit.toString()})`);
  console.log(
    `Max fee: ${GREEN}0.05 gwei${RESET}  priority ${GREEN}0.05 gwei${RESET}\n`,
  );

  console.log(`${YELLOW}Submitting batchRegisterNameFor…${RESET}`);
  const tx = await register(args.recipients, args.labels, args.namespace, {
    gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas,
  });
  console.log(`Transaction hash: ${GREEN}${tx.hash}${RESET}\n`);
  const receipt = await tx.wait();
  if (!receipt || receipt.status === 0) {
    throw new Error(`Transaction reverted: ${tx.hash}`);
  }

  let successfulCount: bigint | string = "?";
  try {
    const parsed = receipt.logs
      .map((log) => {
        try {
          return xns.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .filter((e) => e?.name === "NameRegistered");
    successfulCount = parsed.length;
  } catch {
    // keep "?"
  }

  console.log(`${GREEN}✓ Batch ${batchIndex} confirmed${RESET}`);
  console.log(`Gas used: ${GREEN}${receipt.gasUsed.toString()}${RESET}`);
  console.log(`NameRegistered events: ${GREEN}${successfulCount}${RESET} / ${args.labels.length}\n`);
}

main().catch((error: unknown) => {
  console.error(RED + (error instanceof Error ? error.message : formatErr(error)) + RESET);
  process.exitCode = 1;
});
