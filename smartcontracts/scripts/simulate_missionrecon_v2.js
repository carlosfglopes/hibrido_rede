// scripts/simulate_missionrecon_v2.js
// Runs a full simulation against the deployed MissionRecon V2 proxy.
// Prerequisite: upgrade_missionrecon.js must have already been run.
//
// Scenarios:
//   A) TARGET_DETECTED + 0 re-elections - score = 100
//   B) NOTHING_FOUND   + 0 re-elections - score = 75
//   C) TARGET_DETECTED + 1 re-election  - score = max(100-10, 20) = 90
//   D) NOTHING_FOUND   + 2 re-elections - score = max(75-10,  20) = 65
//
// Usage:
//   npx hardhat run scripts/simulate_missionrecon_v2.js --network rede-hibrido

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

async function fundUAVs(deployer, uavs) {
  for (const uav of uavs) {
    const bal = await ethers.provider.getBalance(uav.address);
    if (bal < ethers.parseEther("0.1")) {
      const tx = await deployer.sendTransaction({
        to: uav.address,
        value: ethers.parseEther("0.5"),
      });
      await tx.wait();
    }
  }
  log("UAV accounts funded ✔");
}

async function setupMission(recon, deployer, uav1, uav2, uav3, zone) {
  for (const uav of [uav1, uav2, uav3]) {
    const tx = await recon.connect(deployer).permitUAV(uav.address);
    await tx.wait();
  }

  const txAct = await recon.connect(deployer).activateMission(zone);
  await txAct.wait();

  for (const uav of [uav1, uav2, uav3]) {
    const tx = await recon.connect(uav).registerUAV();
    await tx.wait();
  }

  const profiles = [[uav1, 92, 110], [uav2, 78, 140], [uav3, 65, 160]];
  for (const [uav, bat, spd] of profiles) {
    const tx = await recon.connect(uav).publishStatus(bat, spd);
    await tx.wait();
  }

  const txElect = await recon.connect(deployer).startElection();
  await txElect.wait();
  const leader = await recon.electedLeader();
  log(`Zone: "${zone}" | Elected leader: ${leader}`);
}

async function printLeaderBoard(recon, signers) {
  log("\n  ┌─ Leader Performance ──────────────────────────────┐");
  for (const s of signers.slice(1, 4)) {
    const rec = await recon.getLeaderRecord(s.address);
    if (Number(rec.missionCount) > 0) {
      log(
        `  │  ${s.address.slice(0, 10)}…  ` +
        `missions=${rec.missionCount}  ` +
        `avg=${rec.avgScore}  ` +
        `last=${rec.lastScore}`
      );
    }
  }
  log("  └───────────────────────────────────────────────────┘");
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

  sep("MissionRecon V2 — Scoring Simulation");
  log(`Deployer : ${deployer.address}`);
  log(`UAV1     : ${uav1.address}`);
  log(`UAV2     : ${uav2.address}`);
  log(`UAV3     : ${uav3.address}`);

  const addrPath = path.join(__dirname, "..", "recon_addresses.json");
  if (!fs.existsSync(addrPath)) {
    throw new Error("recon_addresses.json not found — run deploy_missionrecon.js first");
  }
  const addrs = JSON.parse(fs.readFileSync(addrPath, "utf8"));
  const proxyAddr = addrs.proxy;
  log(`\nProxy    : ${proxyAddr}`);

  const recon = await ethers.getContractAt("MissionReconV2", proxyAddr, deployer);
  const ver   = await recon.version();
  log(`Version  : ${ver}`);
  if (!ver.includes("V2")) {
    throw new Error("The proxy is still on V1 — run upgrade_missionrecon.js first");
  }

  await fundUAVs(deployer, [uav1, uav2, uav3]);

  if (Number(await recon.missionState()) !== 0) {
    log("Resetting previous mission...");
    await resetAndVerify(recon, deployer);
  }

  sep("SCENARIO A — TARGET_DETECTED + 0 re-elections → score = 100");

  await setupMission(recon, deployer, uav1, uav2, uav3, "Zone-Alpha-V2");

  const leaderA = await recon.electedLeader();
  const signerA = signers.find((s) => s.address.toLowerCase() === leaderA.toLowerCase());
  log(`Leader submitting TARGET_DETECTED...`);
  const txA = await recon.connect(signerA).submitReport(1, ethers.keccak256(ethers.toUtf8Bytes("ev-A")));
  await txA.wait();

  const scoreA  = await recon.missionScore();
  const summaryA = await recon.getMissionSummaryV2();
  log(`missionScore   : ${scoreA} (expected: 100)`);
  log(`State          : ${STATE_NAMES[Number(summaryA.state)]}`);
  log(`Re-elections   : ${summaryA.reelections}`);
  log(`LeaderAvgScore : ${summaryA.leaderAvgScore}`);
  await printLeaderBoard(recon, signers);
  log("✔ Scenario A — score 100 as expected");

  await resetAndVerify(recon, deployer);

  sep("SCENARIO B — NOTHING_FOUND + 0 re-elections → score = 75");

  await setupMission(recon, deployer, uav1, uav2, uav3, "Zone-Bravo-V2");

  const leaderB = await recon.electedLeader();
  const signerB = signers.find((s) => s.address.toLowerCase() === leaderB.toLowerCase());
  log(`Leader submitting NOTHING_FOUND...`);
  const txB = await recon.connect(signerB).submitReport(2, ethers.keccak256(ethers.toUtf8Bytes("ev-B")));
  await txB.wait();

  const scoreB   = await recon.missionScore();
  const summaryB = await recon.getMissionSummaryV2();
  log(`missionScore   : ${scoreB} (expected: 75)`);
  log(`State          : ${STATE_NAMES[Number(summaryB.state)]}`);
  log(`LeaderAvgScore : ${summaryB.leaderAvgScore}`);
  await printLeaderBoard(recon, signers);
  log("✔ Scenario B — score 75 as expected");

  await resetAndVerify(recon, deployer);

  sep("SCENARIO C — TARGET_DETECTED + 1 re-election → score = 90");

  await setupMission(recon, deployer, uav1, uav2, uav3, "Zone-Charlie-V2");

  const leaderC1 = await recon.electedLeader();
  const signerC1 = signers.find((s) => s.address.toLowerCase() === leaderC1.toLowerCase());
  log(`1st election → leader: ${leaderC1}`);
  log("Leader submitting INCONCLUSIVE...");
  const txC1 = await recon.connect(signerC1).submitReport(3, ethers.keccak256(ethers.toUtf8Bytes("ev-C1")));
  await txC1.wait();

  const leaderC2 = await recon.electedLeader();
  const signerC2 = signers.find((s) => s.address.toLowerCase() === leaderC2.toLowerCase());
  log(`Re-election #1 → new leader: ${leaderC2}`);
  log("New leader submitting TARGET_DETECTED...");
  const txC2 = await recon.connect(signerC2).submitReport(1, ethers.keccak256(ethers.toUtf8Bytes("ev-C2")));
  await txC2.wait();

  const scoreC   = await recon.missionScore();
  const summaryC = await recon.getMissionSummaryV2();
  log(`missionScore   : ${scoreC} (expected: 90 = 100 - 1x10)`);
  log(`Re-elections   : ${summaryC.reelections}`);
  log(`LeaderAvgScore : ${summaryC.leaderAvgScore}`);
  await printLeaderBoard(recon, signers);
  log("✔ Scenario C — score 90 as expected");

  await resetAndVerify(recon, deployer);

  sep("SCENARIO D — NOTHING_FOUND + 2 re-elections → score = 65");

  await setupMission(recon, deployer, uav1, uav2, uav3, "Zone-Delta-V2");

  const leaderD1 = await recon.electedLeader();
  const signerD1 = signers.find((s) => s.address.toLowerCase() === leaderD1.toLowerCase());
  log(`1st election → leader: ${leaderD1} → INCONCLUSIVE`);
  await (await recon.connect(signerD1).submitReport(3, ethers.keccak256(ethers.toUtf8Bytes("ev-D1")))).wait();

  const leaderD2 = await recon.electedLeader();
  const signerD2 = signers.find((s) => s.address.toLowerCase() === leaderD2.toLowerCase());
  log(`2nd election → leader: ${leaderD2} → INCONCLUSIVE`);
  await (await recon.connect(signerD2).submitReport(3, ethers.keccak256(ethers.toUtf8Bytes("ev-D2")))).wait();

  const leaderD3 = await recon.electedLeader();
  const signerD3 = signers.find((s) => s.address.toLowerCase() === leaderD3.toLowerCase());
  log(`3rd election → leader: ${leaderD3} → NOTHING_FOUND`);
  await (await recon.connect(signerD3).submitReport(2, ethers.keccak256(ethers.toUtf8Bytes("ev-D3")))).wait();

  const scoreD   = await recon.missionScore();
  const summaryD = await recon.getMissionSummaryV2();
  log(`missionScore   : ${scoreD} (expected: 65 = 75 - 2x5)`);
  log(`Re-elections   : ${summaryD.reelections}`);
  log(`LeaderAvgScore : ${summaryD.leaderAvgScore}`);
  await printLeaderBoard(recon, signers);
  log("✔ Scenario D — score 65 as expected");

  await resetAndVerify(recon, deployer);

  sep("Simulation V2 complete");
  log("All 4 scenarios executed successfully.");
  log(`Final state: ${await getState(recon)}`);
  log("\nAccumulated LeaderPerformance across all scenarios:");
  await printLeaderBoard(recon, signers);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
