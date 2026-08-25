/**
 * Script to deploy a MockOwnableTarget and register an XNS name for it via
 * `registerNameForOwnedContract` (caller must be the contract owner).
 *
 * NOTE:
 * - This script uses `registerNameForOwnedContract`, which only works for public namespaces
 *   after the exclusivity period (7 days after namespace creation on Ethereum Mainnet).
 * - For private namespaces or during exclusivity period, use
 *   `registerNameWithAuthorization` instead (see registerNameWithAuthorizationForERC20.ts).
 * - Ownership is verified on Ethereum only via `owner()` / `getOwner()` on the recipient contract.
 *
 * USAGE:
 * Run the script with:
 * `npx hardhat run scripts/examples/registerNameForOwnedContract.ts --network <network_name>`
 *
 * EXAMPLE:
 * To deploy and register on Sepolia:
 * `npx hardhat run scripts/examples/registerNameForOwnedContract.ts --network sepolia`
 *
 * REQUIRED SETUP:
 * Before running, set these environment variables using hardhat-vars:
 *
 * 1. Network Independent Setup:
 *    - MNEMONIC:          `npx hardhat vars set MNEMONIC`
 *    - ETHERSCAN_API_KEY: `npx hardhat vars set ETHERSCAN_API_KEY`
 *
 * 2. Network Specific Setup:
 *    - ETH_SEPOLIA_TESTNET_URL: `npx hardhat vars set ETH_SEPOLIA_TESTNET_URL`
 */

import hre from "hardhat";
import { formatEther, parseEther } from "ethers";
import { XNS_ADDRESS } from "../../constants/addresses";

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

/*//////////////////////////////////////////////////////////////
                            USER INPUTS
//////////////////////////////////////////////////////////////*/

// Label to register (e.g., "myprotocol", "diva")
const label = "myprotocol";

// Namespace (e.g., "xns", "001", etc.)
const namespace = "xns";

// Signer index (0 = account 1, 1 = account 2, 2 = account 3, etc.)
const signerIndex = 0;

// Set to an existing contract address to skip demo deployment (caller must be owner/getOwner).
// Leave empty to deploy MockOwnableTarget with the signer as owner.
const existingContractAddress = "";

async function main() {
  const networkName = hre.network.name;

  const contractAddress = XNS_ADDRESS[networkName];
  if (!contractAddress) {
    throw new Error(
      `XNS contract address not set for network: ${networkName}. Please add address to constants/addresses.ts`,
    );
  }

  const signers = await hre.ethers.getSigners();
  const signer = signers[signerIndex];

  console.log(`\nNetwork: ${GREEN}${networkName}${RESET}`);
  console.log(`XNS contract: ${GREEN}${contractAddress}${RESET}`);
  console.log(`Registering with account: ${GREEN}${signer.address}${RESET}\n`);

  const balance = await hre.ethers.provider.getBalance(signer.address);
  console.log(
    `Account balance: ${GREEN}${formatEther(balance)} ETH${RESET}\n`,
  );

  const xns = await hre.ethers.getContractAt("XNSv2", contractAddress);
  console.log(`Fetching namespace info for "${namespace}"...\n`);
  const getNamespaceInfo = xns.getFunction("getNamespaceInfo(string)");
  const [pricePerName, creator, createdAt, isPrivate] =
    await getNamespaceInfo(namespace);

  console.log(`Namespace: ${GREEN}${namespace}${RESET}`);
  console.log(
    `Price per name: ${GREEN}${formatEther(pricePerName)} ETH${RESET}`,
  );
  console.log(`Namespace creator: ${GREEN}${creator}${RESET}`);
  console.log(`Is private: ${GREEN}${isPrivate}${RESET}\n`);

  if (isPrivate) {
    throw new Error(
      `Cannot use registerNameForOwnedContract for private namespace "${namespace}". Use registerNameWithAuthorization instead.`,
    );
  }

  const EXCLUSIVITY_PERIOD = 7n * 24n * 60n * 60n;
  const exclusivityEnd = createdAt + EXCLUSIVITY_PERIOD;
  const currentTimestamp = BigInt(Math.floor(Date.now() / 1000));

  if (currentTimestamp <= exclusivityEnd) {
    const exclusivityEndDate = new Date(Number(exclusivityEnd) * 1000);
    throw new Error(
      `Cannot use registerNameForOwnedContract during exclusivity period. Exclusivity period ends at ${exclusivityEndDate.toLocaleString()}. Use registerNameWithAuthorization instead.`,
    );
  }

  const getAddress = xns.getFunction("getAddress(string,string)");
  const existingOwner = await getAddress(label, namespace);
  if (existingOwner !== hre.ethers.ZeroAddress) {
    throw new Error(
      `Name "${label}@${namespace}" is already registered to ${existingOwner}`,
    );
  }

  if (balance < pricePerName) {
    throw new Error(
      `Insufficient balance. Need at least ${formatEther(pricePerName)} ETH for registration, but have ${formatEther(balance)} ETH`,
    );
  }

  let recipient = existingContractAddress;

  if (!recipient) {
    console.log(`Deploying MockOwnableTarget (owner = signer)...`);
    const MockOwnableTarget = await hre.ethers.getContractFactory(
      "MockOwnableTarget",
    );
    const target = await MockOwnableTarget.deploy(signer.address);
    await target.waitForDeployment();
    recipient = await target.getAddress();
    console.log(
      `\n${GREEN}✓${RESET} MockOwnableTarget deployed to: ${GREEN}${recipient}${RESET}\n`,
    );
  } else {
    console.log(`Using existing contract: ${GREEN}${recipient}${RESET}\n`);
    const code = await hre.ethers.provider.getCode(recipient);
    if (code === "0x") {
      throw new Error(`Recipient ${recipient} is not a contract`);
    }
  }

  const getName = xns.getFunction("getName(address)");
  const existingName = await getName(recipient);
  if (existingName !== "") {
    console.log(
      `${YELLOW}⚠${RESET} Contract ${recipient} already has a name: ${existingName}`,
    );
    console.log(`Skipping registration.\n`);
    return;
  }

  const fullName = `${label}@${namespace}`;
  console.log(
    `Registering XNS name for owned contract: ${GREEN}${fullName}${RESET}`,
  );
  console.log(`Recipient: ${GREEN}${recipient}${RESET}`);
  console.log(`Sending ${GREEN}${formatEther(pricePerName)} ETH${RESET}...\n`);

  const registerTx = await xns
    .connect(signer)
    .registerNameForOwnedContract(recipient, label, namespace, {
      value: pricePerName,
    });

  console.log(`Transaction hash: ${GREEN}${registerTx.hash}${RESET}\n`);
  console.log("Waiting for confirmation...\n");
  await registerTx.wait();

  const nameOwner = await getAddress(label, namespace);
  const registeredName = await getName(recipient);
  const callerName = await getName(signer.address);

  console.log(`\n${GREEN}✓ Registration successful!${RESET}\n`);
  console.log(`Contract address: ${GREEN}${recipient}${RESET}`);
  console.log(`XNS name: ${GREEN}${fullName}${RESET}`);
  console.log(`Name owner: ${GREEN}${nameOwner}${RESET}`);
  console.log(
    `Registered name for contract: ${GREEN}${registeredName}${RESET}`,
  );
  console.log(
    `Caller (${signer.address}) name: ${GREEN}${callerName || "(none)"}${RESET}\n`,
  );

  const balanceAfter = await hre.ethers.provider.getBalance(signer.address);
  console.log(
    `Account balance after: ${GREEN}${formatEther(balanceAfter)} ETH${RESET}\n`,
  );
}

main().catch((error: unknown) => {
  console.error(
    RED + (error instanceof Error ? error.message : String(error)) + RESET,
  );
  process.exitCode = 1;
});
