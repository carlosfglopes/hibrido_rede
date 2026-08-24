// scripts/simulate_missionrecon_v1.js
// Runs a full simulation against the deployed MissionRecon V1 proxy.
//
// Scenarios:
//   A) TARGET_DETECTED - mission completed successfully
//   B) NOTHING_FOUND   - mission completed with no target
//   C) INCONCLUSIVE    - re-election - TARGET_DETECTED
//   D) TIMEOUT         - leader unresponsive - re-election - NOTHING_FOUND
//
// Usage:
//   npx hardhat run scripts/simulate_missionrecon_v1.js --network rede-hibrido

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const STATE_NAMES = [
  "IDLE", "ACTIVE", "ELECTION", "ASSIGNED",
  "REPORTING", "COMPLETED", "FAILED", "TERMINATED",
];
const RESULT_NAMES = ["NONE", "TARGET_DETECTED", "NOTHING_FOUND", "INCONCLUSIVE"];

// HELPERS

function log(msg)   { console.log(`  ${msg}`); }
function sep(title) { console.log(`\n${"─".repeat(60)}\n  ${title}\n${"─".repeat(60)}`); }

async function getState(recon) {
  const s = await recon.missionState();
  return `${STATE_NAMES[Number(s)]} (${s})`;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fundUAVs(deployer, uavs) {
  log("Funding UAV accounts with 0.5 ETH each...");
  for (const uav of uavs) {
    const bal = await ethers.provider.getBalance(uav.address);
    if (bal < ethers.parseEther("0.1")) {
      const tx = await deployer.sendTransaction({
        to: uav.address,
        value: ethers.parseEther("0.5"),
      });
      await tx.wait();
      log(`  → ${uav.address} funded`);
    } else {
      log(`  → ${uav.address} already has enough ETH`);
    }
  }
}

async function setupMission(recon, deployer, uav1, uav2, uav3, zone) {
  log(`Zone: "${zone}"`);

  for (const [uav, name] of [[uav1, "UAV1"], [uav2, "UAV2"], [uav3, "UAV3"]]) {
    const tx = await recon.connect(deployer).permitUAV(uav.address);
    await tx.wait();
    log(`permitUAV(${name}) ✔`);
  }

  const txAct = await recon.connect(deployer).activateMission(zone);
  await txAct.wait();
  log(`activateMission("${zone}") → ${await getState(recon)}`);

  for (const [uav, name] of [[uav1, "UAV1"], [uav2, "UAV2"], [uav3, "UAV3"]]) {
    const tx = await recon.connect(uav).registerUAV();
    await tx.wait();
    log(`registerUAV(${name}) ✔`);
  }

  const profiles = [
    [uav1, "UAV1", 92, 110],
    [uav2, "UAV2", 78, 140],
    [uav3, "UAV3", 65, 160],
  ];
  for (const [uav, name, bat, spd] of profiles) {
    const score = bat * 60 + spd * 40;
    const tx = await recon.connect(uav).publishStatus(bat, spd);
    await tx.wait();
    log(`publishStatus(${name}: bat=${bat}, spd=${spd} → score=${score}) ✔`);
  }

  const txElect = await recon.connect(deployer).startElection();
  await txElect.wait();
  const leader = await recon.electedLeader();
  log(`startElection() → elected leader: ${leader}`);
  log(`Current state: ${await getState(recon)}`);
}

async function resetAndVerify(recon, deployer) {
  const tx = await recon.connect(deployer).resetMission();
  await tx.wait();
  log(`resetMission() → ${await getState(recon)}`);
}

// MAIN

async function main() {
  const signers  = await ethers.getSigners();
  const deployer = signers[0];
  const uav1     = signers[1];
  const uav2     = signers[2];
  const uav3     = signers[3];

  sep("MissionRecon V1 — Full Simulation");
  log(`Deployer : ${deployer.address}`);
  log(`UAV1     : ${uav1.address}`);
  log(`UAV2     : ${uav2.address}`);
  log(`UAV3     : ${uav3.address}`);

  const addrPath = path.join(__dirname, "..", "recon_addresses.json");
  if (!fs.existsSync(addrPath)) {
    throw new Error("recon_addresses.json not found — run deploy_missionrecon.js first");
  }
  const { proxy: proxyAddr } = JSON.parse(fs.readFileSync(addrPath, "utf8"));
  log(`\nProxy    : ${proxyAddr}`);

  const recon = await ethers.getContractAt("MissionReconV1", proxyAddr, deployer);
  log(`Version  : ${await recon.version()}`);

  await fundUAVs(deployer, [uav1, uav2, uav3]);

  if (Number(await recon.missionState()) !== 0) {
    log("Mission is not in IDLE — resetting...");
    await resetAndVerify(recon, deployer);
  }

  sep("SCENARIO A — TARGET_DETECTED");

  await setupMission(recon, deployer, uav1, uav2, uav3, "Zone-Alpha");

  const leaderA = await recon.electedLeader();
  const leaderSignerA = signers.find((s) => s.address.toLowerCase() === leaderA.toLowerCase());
  if (!leaderSignerA) throw new Error(`Leader ${leaderA} not found among signers`);

  const evidenceA = ethers.keccak256(ethers.toUtf8Bytes("target-coords-42.1N-8.5W"));
  log(`\nLeader (${leaderA}) submitting TARGET_DETECTED...`);
  const txA = await recon.connect(leaderSignerA).submitReport(1, evidenceA);
  await txA.wait();

  const summaryA = await recon.getMissionSummary();
  log(`State      : ${STATE_NAMES[Number(summaryA.state)]}`);
  log(`Result     : ${RESULT_NAMES[Number(summaryA.report)]}`);
  log(`Evidence   : ${summaryA.evidenceHash}`);
  log("✔ Scenario A complete: COMPLETED");

  await resetAndVerify(recon, deployer);

  sep("SCENARIO B — NOTHING_FOUND");

  await setupMission(recon, deployer, uav1, uav2, uav3, "Zone-Bravo");

  const leaderB = await recon.electedLeader();
  const leaderSignerB = signers.find((s) => s.address.toLowerCase() === leaderB.toLowerCase());

  log(`\nLeader (${leaderB}) submitting NOTHING_FOUND...`);
  const evidenceB = ethers.keccak256(ethers.toUtf8Bytes("scan-complete-nothing-detected"));
  const txB = await recon.connect(leaderSignerB).submitReport(2, evidenceB);
  await txB.wait();

  const summaryB = await recon.getMissionSummary();
  log(`State      : ${STATE_NAMES[Number(summaryB.state)]}`);
  log(`Result     : ${RESULT_NAMES[Number(summaryB.report)]}`);
  log("✔ Scenario B complete: COMPLETED");

  await resetAndVerify(recon, deployer);

  sep("SCENARIO C — INCONCLUSIVE → Re-election → TARGET_DETECTED");

  await setupMission(recon, deployer, uav1, uav2, uav3, "Zone-Charlie");

  const leaderC1 = await recon.electedLeader();
  const leaderSignerC1 = signers.find((s) => s.address.toLowerCase() === leaderC1.toLowerCase());
  log(`\n1st election → leader: ${leaderC1}`);

  log("Leader submitting INCONCLUSIVE...");
  const evidenceC1 = ethers.keccak256(ethers.toUtf8Bytes("inconclusive-scan"));
  const txC1 = await recon.connect(leaderSignerC1).submitReport(3, evidenceC1);
  await txC1.wait();

  const reelectCount = await recon.reelectionCount();
  const leaderC2 = await recon.electedLeader();
  log(`Re-election #${reelectCount} → new leader: ${leaderC2}`);
  log(`State: ${await getState(recon)}`);

  const leaderSignerC2 = signers.find((s) => s.address.toLowerCase() === leaderC2.toLowerCase());
  log("New leader submitting TARGET_DETECTED...");
  const evidenceC2 = ethers.keccak256(ethers.toUtf8Bytes("target-found-after-reelection"));
  const txC2 = await recon.connect(leaderSignerC2).submitReport(1, evidenceC2);
  await txC2.wait();

  const summaryC = await recon.getMissionSummary();
  log(`State      : ${STATE_NAMES[Number(summaryC.state)]}`);
  log(`Result     : ${RESULT_NAMES[Number(summaryC.report)]}`);
  log(`Re-elections : ${summaryC.reelections}`);
  log("✔ Scenario C complete: COMPLETED after re-election");

  await resetAndVerify(recon, deployer);

  sep("SCENARIO D — TIMEOUT → Re-election → NOTHING_FOUND");

  await setupMission(recon, deployer, uav1, uav2, uav3, "Zone-Delta");

  const leaderD = await recon.electedLeader();
  log(`\nElected leader: ${leaderD}`);
  log("Leader unresponsive — waiting for timeout (reportTimeoutSec=30s)...");

  log("Waiting 35 seconds...");
  await sleep(35_000);

  log("Calling checkTimeout()...");
  const txTimeout = await recon.connect(deployer).checkTimeout();
  await txTimeout.wait();

  const reelectD = await recon.reelectionCount();
  const leaderD2 = await recon.electedLeader();
  log(`Re-election #${reelectD} → new leader: ${leaderD2}`);
  log(`State: ${await getState(recon)}`);

  const leaderSignerD2 = signers.find((s) => s.address.toLowerCase() === leaderD2.toLowerCase());
  log("New leader submitting NOTHING_FOUND...");
  const evidenceD = ethers.keccak256(ethers.toUtf8Bytes("nothing-found-after-timeout"));
  const txD = await recon.connect(leaderSignerD2).submitReport(2, evidenceD);
  await txD.wait();

  const summaryD = await recon.getMissionSummary();
  log(`State      : ${STATE_NAMES[Number(summaryD.state)]}`);
  log(`Result     : ${RESULT_NAMES[Number(summaryD.report)]}`);
  log(`Re-elections : ${summaryD.reelections}`);
  log("✔ Scenario D complete: COMPLETED after timeout + re-election");

  await resetAndVerify(recon, deployer);

  sep("Simulation V1 complete");
  log("All 4 scenarios executed successfully.");
  log(`Final state: ${await getState(recon)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
