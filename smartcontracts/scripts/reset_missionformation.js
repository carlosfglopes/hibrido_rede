// scripts/reset_missionformation.js
// Resets the MissionFormation proxy back to its initial state.
//
// Usage:
//   npx hardhat run scripts/reset_missionformation.js --network rede-hibrido

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const STATE_NAMES = [
  "SETUP", "ACTIVE", "RECONFIGURING_FORMATION", "DEGRADED", "COMPLETED", "ABORTED",
];

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("─".repeat(60));
  console.log("  MissionFormation — Mission Reset");
  console.log("─".repeat(60));

  const addrPath = path.join(__dirname, "..", "formation_addresses.json");
  if (!fs.existsSync(addrPath)) {
    throw new Error("formation_addresses.json not found — run deploy_missionformation.js first");
  }
  const { proxy: proxyAddr } = JSON.parse(fs.readFileSync(addrPath, "utf8"));
  console.log(`  Proxy    : ${proxyAddr}`);
  console.log(`  Deployer : ${deployer.address}`);
  console.log();

  const form = await ethers.getContractAt("MissionFormationV1", proxyAddr, deployer);

  const stateBefore = await form.missionState();
  const stateName   = STATE_NAMES[Number(stateBefore)] ?? `#${stateBefore}`;
  console.log(`State before reset : ${stateName}`);

  if (Number(stateBefore) === 0) {
    console.log("Mission is already in SETUP — reset not needed.");
    return;
  }

  console.log("Calling resetMission()...");
  const tx = await form.resetMission();
  await tx.wait();
  console.log(`Tx: ${tx.hash}`);

  const stateAfter = await form.missionState();
  const centroid   = await form.getCentroid();
  console.log();
  console.log("State after reset:");
  console.log(`  missionState : ${STATE_NAMES[Number(stateAfter)]}`);
  console.log(`  centroid     : (${centroid.x}, ${centroid.y})`);
  console.log(`  UAVs         : ${await form.getUAVCount()}`);

  try {
    const formV2 = await ethers.getContractAt("MissionFormationV2", proxyAddr, deployer);
    const score  = await formV2.formationScore();
    console.log(`  formationScore: ${score} (V2)`);
  } catch (_) {}

  console.log();
  console.log("─".repeat(60));
  console.log("  Reset complete.");
  console.log("─".repeat(60));
}

main().catch((e) => { console.error(e); process.exit(1); });
