// scripts/reset_missionfail.js
// Resets the MissionFail proxy back to its initial state.
//
// Usage:
//   npx hardhat run scripts/reset_missionfail.js --network rede-hibrido

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const STATE_NAMES = [
  "SETUP", "ACTIVE", "UNDER_CONFIRMATION", "RECONFIGURING",
  "ACTIVE_RECONFIGURED", "DEGRADED", "ABORTED", "COMPLETED",
];

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("─".repeat(60));
  console.log("  MissionFail — Mission Reset");
  console.log("─".repeat(60));

  const addrPath = path.join(__dirname, "..", "fail_addresses.json");
  if (!fs.existsSync(addrPath)) {
    throw new Error("fail_addresses.json not found — run deploy_missionfail.js first");
  }
  const { proxy: proxyAddr } = JSON.parse(fs.readFileSync(addrPath, "utf8"));
  console.log(`  Proxy    : ${proxyAddr}`);
  console.log(`  Deployer : ${deployer.address}`);
  console.log();

  const fail = await ethers.getContractAt("MissionFailV1", proxyAddr, deployer);

  const stateBefore = await fail.missionState();
  const stateName   = STATE_NAMES[Number(stateBefore)] ?? `#${stateBefore}`;
  console.log(`State before reset : ${stateName}`);

  if (Number(stateBefore) === 0) {
    console.log("Mission is already in SETUP — reset not needed.");
    return;
  }

  console.log("Calling resetMission()...");
  const tx = await fail.resetMission();
  await tx.wait();
  console.log(`Tx: ${tx.hash}`);

  const stateAfter   = await fail.missionState();
  const failureCount = await fail.failureCount();
  const suspect      = await fail.suspectUav();

  console.log();
  console.log("State after reset:");
  console.log(`  missionState  : ${STATE_NAMES[Number(stateAfter)]}`);
  console.log(`  failureCount  : ${failureCount}`);
  console.log(`  suspectUav    : ${suspect}`);
  console.log(`  UAVs          : ${await fail.getUAVCount()}`);

  try {
    const failV2 = await ethers.getContractAt("MissionFailV2", proxyAddr, deployer);
    const score  = await failV2.missionScore();
    console.log(`  missionScore  : ${score} (V2)`);
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
