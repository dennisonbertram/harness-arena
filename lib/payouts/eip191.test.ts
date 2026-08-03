import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { verifyEip191AddressProof } from "./external-address";

const TEST_ONLY_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

describe("EIP-191 payout-address verifier", () => {
  it("accepts the exact signer/message and rejects changed or malformed proofs without RPC", async () => {
    const account = privateKeyToAccount(TEST_ONLY_PRIVATE_KEY);
    const message = "harness-arena.example payout address verification\n\nChain ID: 1\nNonce: fixture";
    const signature = await account.signMessage({ message });

    await expect(verifyEip191AddressProof({ address: account.address, message, signature })).resolves.toBe(true);
    await expect(verifyEip191AddressProof({ address: account.address, message: `${message}!`, signature })).resolves.toBe(false);
    await expect(verifyEip191AddressProof({ address: account.address, message, signature: "0xinvalid" })).resolves.toBe(false);
  });
});
