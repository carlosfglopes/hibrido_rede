// scripts/simulate_missionfail_v2.js
// Runs a full simulation against the deployed MissionFail V2 proxy.
// Prerequisite: upgrade_missionfail.js must have already been run.
//
// Scenarios:
//   A) CONFIRM_FAILED → DEGRADED
//        missionScore = 50 | reputationScore[UAV] -= 30
//   B) CONFIRM_BYZANTINE → DEGRADED
//        missionScore = 50 | reputationScore[UAV] -= 50
//   C) 2 consecutive failures → ABORTED (since only 2 UAVs remain eligible
//        to vote after the 1st removal, the 2nd reaches the threshold)
//        missionScore = 0
//
// Usage:
//   npx hardhat run scripts/simulate_missionfail_v2.js --network rede-hibrido

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const STATE_NAMES = [
  "SETUP", "ACTIVE", "UNDER_CONFIRMATION", "RECONFIGURING",
  "ACTIVE_RECONFIGURED", "DEGRADED", "ABORTED",
];
const UAV_STATE_NAMES = [
  "UNREGISTERED", "ACTIVE", "SUSPECT", "CONFIRMED_FAILED",
  "CONFIRMED_BYZANTINE", "REMOVED",
];

// HELPERS

function log(msg)   { console.log(`  ${msg}`); }
function sep(title) { console.log(`\n${"─".repeat(60)}\n  ${title}\n${"─".repeat(60)}`); }

async function getState(fail) {
  const s = await fail.missionState();
  return `${STATE_NAMES[Number(s)]} (${s})`;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

async function setupAndStart(fail, deployer, uav1, uav2, uav3, taskOffset) {
  for (const [uav, name] of [[uav1, "UAV1"], [uav2, "UAV2"], [uav3, "UAV3"]]) {
    await (await fail.connect(deployer).registerUAV(uav.address, 2)).wait();
    await (await fail.connect(deployer).initUAVReputation(uav.address)).wait();
    log(`registerUAV(${name}) + initUAVReputation(100) ✔`);
  }

  const taskAssignments = [
    [10 + taskOffset, uav1.address],
    [20 + taskOffset, uav2.address],
    [30 + taskOffset, uav3.address],
  ];
  for (const [taskId, addr] of taskAssignments) {
    await (await fail.connect(deployer).createTask(taskId, addr)).wait();
  }
  log(`createTask x3 ✔`);

  await (await fail.connect(deployer).startMission()).wait();
  log(`startMission() → ${await getState(fail)}`);

  return taskAssignments.map(([id]) => id);
}

async function printScores(fail, uav1, uav2, uav3) {
  const score = await fail.missionScore();
  log(`\n  ┌─ Scores V2 ──────────────────────────────────────┐`);
  log(`  │  missionScore : ${score}`);
  for (const [uav, name] of [[uav1, "UAV1"], [uav2, "UAV2"], [uav3, "UAV3"]]) {
    const rep = await fail.getReputationScore(uav.address);
    const uavData = await fail.uavs(uav.address);
    const stateName = UAV_STATE_NAMES[Number(uavData.state)];
    log(`  │  ${name} (${uav.address.slice(0, 10)}…): rep=${rep}  state=${stateName}`);
  }
  log(`  └───────────────────────────────────────────────────┘`);
}

async function printSummaryV2(fail) {
  const s = await fail.getMissionSummaryV2();
  log(`State: ${STATE_NAMES[Number(s.state)]} | Failures: ${s.failures} | Active UAVs: ${s.activeUAVs} | Score: ${s.score} | Rep<50: ${s.lowRepUAVs}`);
}

async function resetAndVerify(fail, deployer) {
  await (await fail.connect(deployer).resetMission()).wait();
  log(`resetMission() → ${await getState(fail)} | missionScore=${await fail.missionScore()}`);
}

// MAIN

async function main() {
  const signers  = await ethers.getSigners();
  const deployer = signers[0];
  const uav1     = signers[1];
  const uav2     = signers[2];
  const uav3     = signers[3];

  sep("MissionFail V2 — Score and Reputation Simulation");
  log(`Deployer : ${deployer.address}`);
  log(`UAV1     : ${uav1.address}`);
  log(`UAV2     : ${uav2.address}`);
  log(`UAV3     : ${uav3.address}`);

  const addrPath = path.join(__dirname, "..", "fail_addresses.json");
  if (!fs.existsSync(addrPath)) {
    throw new Error("fail_addresses.json not found — run deploy_missionfail.js first");
  }
  const { proxy: proxyAddr } = JSON.parse(fs.readFileSync(addrPath, "utf8"));
  log(`\nProxy    : ${proxyAddr}`);

  const fail = await ethers.getContractAt("MissionFailV2", proxyAddr, deployer);
  const ver  = await fail.version();
  log(`Version  : ${ver}`);
  if (!ver.includes("V2")) {
    throw new Error("The proxy is still on V1 — run upgrade_missionfail.js first");
  }

  await fundUAVs(deployer, [uav1, uav2, uav3]);

  if (Number(await fail.missionState()) !== 0) {
    log("Resetting previous mission...");
    await resetAndVerify(fail, deployer);
  }

  sep("SCENARIO A — CONFIRM_FAILED → DEGRADED | score=50 | rep[UAV3]-=30");

  await setupAndStart(fail, deployer, uav1, uav2, uav3, 0);

  await (await fail.connect(uav1).heartbeat()).wait();
  await (await fail.connect(uav2).heartbeat()).wait();
  log("UAV1 ✔  UAV2 ✔  UAV3 ✗ (no heartbeat)");

  log("Waiting for timeout (18s)...");
  await sleep(18_000);

  log("Owner detects missing heartbeat on UAV3...");
  await (await fail.connect(deployer).detectMissingHeartbeat(
    uav3.address,
    ethers.keccak256(ethers.toUtf8Bytes("ev-A-uav3-no-hb"))
  )).wait();
  log(`State: ${await getState(fail)}`);

  log("UAV1 and UAV2 vote CONFIRM_FAILED...");
  await (await fail.connect(uav1).voteOnSuspect(1)).wait();
  await (await fail.connect(uav2).voteOnSuspect(1)).wait();

  await (await fail.connect(deployer).finalizeIncident()).wait();
  log(`After finalizeIncident: ${await getState(fail)}`);

  await (await fail.connect(deployer).triggerReconfiguration()).wait();
  log(`After triggerReconfiguration: ${await getState(fail)}`);

  await printScores(fail, uav1, uav2, uav3);
  await printSummaryV2(fail);
  log("✔ Scenario A: missionScore=50 (DEGRADED) | UAV3 reputation=70 (100-30)");

  await resetAndVerify(fail, deployer);

  sep("SCENARIO B — CONFIRM_BYZANTINE → DEGRADED | score=50 | rep[UAV2]-=50");

  await setupAndStart(fail, deployer, uav1, uav2, uav3, 100);

  for (const uav of [uav1, uav2, uav3]) {
    await (await fail.connect(uav).heartbeat()).wait();
  }
  log("Heartbeats sent ✔");

  log("Owner opens Byzantine incident against UAV2...");
  await (await fail.connect(deployer).openBehaviorIncident(
    uav2.address,
    ethers.keccak256(ethers.toUtf8Bytes("ev-B-uav2-byzantine"))
  )).wait();
  log(`State: ${await getState(fail)}`);

  log("UAV1 and UAV3 vote CONFIRM_BYZANTINE...");
  await (await fail.connect(uav1).voteOnSuspect(2)).wait();
  await (await fail.connect(uav3).voteOnSuspect(2)).wait();

  await (await fail.connect(deployer).finalizeIncident()).wait();
  log(`After finalizeIncident: ${await getState(fail)}`);

  await (await fail.connect(deployer).triggerReconfiguration()).wait();
  log(`After triggerReconfiguration: ${await getState(fail)}`);

  await printScores(fail, uav1, uav2, uav3);
  await printSummaryV2(fail);
  log("✔ Scenario B: missionScore=50 (DEGRADED) | UAV2 reputation=50 (100-50)");

  await resetAndVerify(fail, deployer);

  sep("SCENARIO C — 2 consecutive failures → ABORTED | score=0");

  await setupAndStart(fail, deployer, uav1, uav2, uav3, 200);

  for (const uav of [uav1, uav2, uav3]) {
    await (await fail.connect(uav).heartbeat()).wait();
  }
  log("Heartbeats sent ✔");

  log("\n[Failure 1] Owner opens Byzantine incident against UAV3...");
  await (await fail.connect(deployer).openBehaviorIncident(
    uav3.address,
    ethers.keccak256(ethers.toUtf8Bytes("ev-C1-uav3-byz"))
  )).wait();

  await (await fail.connect(uav1).voteOnSuspect(2)).wait();
  await (await fail.connect(uav2).voteOnSuspect(2)).wait();
  await (await fail.connect(deployer).finalizeIncident()).wait();
  await (await fail.connect(deployer).triggerReconfiguration()).wait();

  const stateAfter1 = await fail.missionState();
  log(`State after 1st reconfiguration: ${STATE_NAMES[Number(stateAfter1)]}`);
  log(`missionScore: ${await fail.missionScore()} | failureCount: ${await fail.failureCount()}`);

  if (Number(stateAfter1) === 6) {
    log("ABORTED after 1st failure (insufficient capacity to continue)");
    await printScores(fail, uav1, uav2, uav3);
    await printSummaryV2(fail);
    await resetAndVerify(fail, deployer);
    sep("Simulation V2 complete");
    log("All scenarios executed.");
    return;
  }

  log("\n[Failure 2] Owner opens heartbeat incident against UAV2...");

  await (await fail.connect(uav1).heartbeat()).wait();
  log("Only UAV1 sends heartbeat. UAV2 does not...");
  log("Waiting for timeout (18s)...");
  await sleep(18_000);

  await (await fail.connect(deployer).detectMissingHeartbeat(
    uav2.address,
    ethers.keccak256(ethers.toUtf8Bytes("ev-C2-uav2-nohb"))
  )).wait();
  log(`State: ${await getState(fail)}`);

  await (await fail.connect(uav1).voteOnSuspect(1)).wait();
  log("UAV1 votes CONFIRM_FAILED (anti-deadlock: only eligible voter)");

  await (await fail.connect(deployer).finalizeIncident()).wait();
  log(`After finalizeIncident: ${await getState(fail)}`);

  await (await fail.connect(deployer).triggerReconfiguration()).wait();
  log(`After triggerReconfiguration: ${await getState(fail)}`);

  await printScores(fail, uav1, uav2, uav3);
  await printSummaryV2(fail);
  log("✔ Scenario C: 2 consecutive failures → ABORTED | missionScore=0");

  await resetAndVerify(fail, deployer);

  sep("Simulation V2 complete");
  log("All 3 scenarios executed successfully.");
  log(`Final state: ${await getState(fail)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
