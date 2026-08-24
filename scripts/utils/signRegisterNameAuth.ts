/**
 * Utility function to sign RegisterNameAuth for EIP-712
 * Shared between scripts and tests
 */

import { ethers } from "hardhat";
import { XNSv2 } from "../../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

/** Default authorization expiry used by scripts/tests when none is specified. */
export const DEFAULT_AUTH_VALID_UNTIL = ethers.MaxUint256;

/**
 * Signs a RegisterNameAuth struct using EIP-712 for use in registerNameWithAuthorization
 * @param xns The XNSv2 contract instance
 * @param signer The signer that will authorize the registration
 * @param recipient The address that will receive the name (must match signer for EOA, or be the contract for EIP-1271)
 * @param label The label part of the name
 * @param namespace The namespace part of the name
 * @param validUntil Unix timestamp after which the authorization is invalid (defaults to MaxUint256)
 * @returns The EIP-712 signature
 */
export async function signRegisterNameAuth(
  xns: XNSv2,
  signer: SignerWithAddress,
  recipient: string,
  label: string,
  namespace: string,
  validUntil: bigint = DEFAULT_AUTH_VALID_UNTIL
): Promise<string> {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const domain = {
    name: "XNSv2",
    version: "1",
    chainId: Number(chainId),
    verifyingContract: await xns.getAddress(),
  };

  const types = {
    RegisterNameAuth: [
      { name: "recipient", type: "address" },
      { name: "label", type: "string" },
      { name: "namespace", type: "string" },
      { name: "validUntil", type: "uint256" },
    ],
  };

  const value = {
    recipient: recipient,
    label: label,
    namespace: namespace,
    validUntil: validUntil,
  };

  return await signer.signTypedData(domain, types, value);
}
