// scripts/reset_missionrecon.js
// Resets the MissionRecon proxy back to its initial state.
//
// Usage:
//   npx hardhat run scripts/reset_missionrecon.js --network rede-hibrido

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const STATE_NAMES = [
  "IDLE", "ACTIVE", "ELECTION", "ASSIGNED",
  "REPORTING", "COMPLETED", "FAILED", "TERMINATED",
];

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("─".repeat(60));
  console.log("  MissionRecon — Mission Reset");
  console.log("─".repeat(60));

  const addrPath = path.join(__dirname, "..", "recon_addresses.json");
  if (!fs.existsSync(addrPath)) {
    throw new Error("recon_addresses.json not found — run deploy_missionrecon.js first");
  }
  const addrs = JSON.parse(fs.readFileSync(addrPath, "utf8"));
  const proxyAddr = addrs.proxy;
  console.log(`  Proxy    : ${proxyAddr}`);
  console.log(`  Deployer : ${deployer.address}`);
  console.log();

  const recon = await ethers.getContractAt("MissionReconV1", proxyAddr, deployer);

  const stateBefore = await recon.missionState();
  const stateName   = STATE_NAMES[Number(stateBefore)] ?? `#${stateBefore}`;
  console.log(`State before reset : ${stateName} (${stateBefore})`);

  if (Number(stateBefore) === 0) {
    console.log("Mission is already in IDLE — reset not needed.");
    return;
  }

  console.log("Calling resetMission()...");
  const tx = await recon.resetMission();
  await tx.wait();
  console.log(`Tx: ${tx.hash}`);

  const stateAfter = await recon.missionState();
  const zone       = await recon.missionZone();
  const leader     = await recon.electedLeader();
  const reelections = await recon.reelectionCount();

  console.log();
  console.log("State after reset:");
  console.log(`  missionState    : ${STATE_NAMES[Number(stateAfter)]}`);
  console.log(`  missionZone     : "${zone}"`);
  console.log(`  electedLeader   : ${leader}`);
  console.log(`  reelectionCount : ${reelections}`);

  try {
    const reconV2  = await ethers.getContractAt("MissionReconV2", proxyAddr, deployer);
    const score    = await reconV2.missionScore();
    console.log(`  missionScore    : ${score} (V2)`);
  } catch (_) {}

  console.log();
  console.log("─".repeat(60));
  console.log("  Reset complete.");
  console.log("─".repeat(60));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
