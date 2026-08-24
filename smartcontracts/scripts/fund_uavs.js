// scripts/fund_uavs.js
// Funds the 4 standard UAV accounts (Hardhat mnemonic) from the authority —
// the rede-hibrido genesis only pre-allocates the authority account. Same
// pattern used in Model 2 (proxy_rede/scripts/fund_uavs.js).
//
// Usage:
//   npx hardhat run scripts/fund_uavs.js --network rede-hibrido

const hre = require("hardhat");

const UAV_ADDRESSES = [
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
];

const AMOUNT = hre.ethers.parseEther("5");

async function main() {
  const [authority] = await hre.ethers.getSigners();
  console.log(`Authority: ${authority.address}`);

  for (const addr of UAV_ADDRESSES) {
    const balBefore = await hre.ethers.provider.getBalance(addr);
    if (balBefore >= AMOUNT) {
      console.log(`${addr} already has enough balance (${hre.ethers.formatEther(balBefore)} ETH) — skipping.`);
      continue;
    }
    const tx = await authority.sendTransaction({ to: addr, value: AMOUNT });
    await tx.wait();
    const balAfter = await hre.ethers.provider.getBalance(addr);
    console.log(`Funded ${addr}: ${hre.ethers.formatEther(balAfter)} ETH`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
