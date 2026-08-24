// scripts/simulate_missionfail_v1.js
// Runs a full simulation against the deployed MissionFail V1 proxy.
//
// Scenarios:
//   A) Normal mission - heartbeats + completed tasks + manual abort
//   B) Heartbeat failure - CONFIRM_FAILED - DEGRADED
//   C) Byzantine behavior - CONFIRM_BYZANTINE - DEGRADED
//   D) Innocent suspect - REJECT vote - back to ACTIVE
//
// Usage:
//   npx hardhat run scripts/simulate_missionfail_v1.js --network rede-hibrido

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

const VOTE_NAMES = ["NONE", "CONFIRM_FAILED", "CONFIRM_BYZANTINE", "REJECT"];

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

async function setupAndStart(fail, deployer, uav1, uav2, uav3, taskOffset = 0) {
  for (const [uav, name] of [[uav1, "UAV1"], [uav2, "UAV2"], [uav3, "UAV3"]]) {
    const tx = await fail.connect(deployer).registerUAV(uav.address, 2);
    await tx.wait();
    log(`registerUAV(${name}, cap=2) ✔`);
  }

  const taskAssignments = [
    [10 + taskOffset, uav1.address, "UAV1"],
    [20 + taskOffset, uav2.address, "UAV2"],
    [30 + taskOffset, uav3.address, "UAV3"],
  ];
  for (const [taskId, addr, name] of taskAssignments) {
    const tx = await fail.connect(deployer).createTask(taskId, addr);
    await tx.wait();
    log(`createTask(${taskId} → ${name}) ✔`);
  }

  const txStart = await fail.connect(deployer).startMission();
  await txStart.wait();
  log(`startMission() → ${await getState(fail)}`);

  return taskAssignments.map(([id]) => id);
}

async function resetAndVerify(fail, deployer) {
  const tx = await fail.connect(deployer).resetMission();
  await tx.wait();
  log(`resetMission() → ${await getState(fail)}`);
}

async function printSummary(fail) {
  const s = await fail.getMissionSummary();
  log(`  State: ${STATE_NAMES[Number(s.state)]}  | Failures: ${s.failures} | Active UAVs: ${s.activeUAVs} | Active tasks: ${s.activeTasks}`);
  if (s.suspect !== ethers.ZeroAddress) {
    log(`  Suspect: ${s.suspect} | Reason: ${s.reason} | vFailed=${s.vFailed} vByz=${s.vByzantine} vReject=${s.vReject}`);
  }
}

// MAIN

async function main() {
  const signers  = await ethers.getSigners();
  const deployer = signers[0];
  const uav1     = signers[1];
  const uav2     = signers[2];
  const uav3     = signers[3];

  sep("MissionFail V1 — Full Simulation");
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

  const fail = await ethers.getContractAt("MissionFailV1", proxyAddr, deployer);
  log(`Version  : ${await fail.version()}`);

  await fundUAVs(deployer, [uav1, uav2, uav3]);

  if (Number(await fail.missionState()) !== 0) {
    log("Resetting previous mission...");
    await resetAndVerify(fail, deployer);
  }

  sep("SCENARIO A — Normal mission: heartbeats + tasks + manual abort");

  const tasksA = await setupAndStart(fail, deployer, uav1, uav2, uav3, 0);

  log("\nUAVs sending heartbeats...");
  for (const [uav, name] of [[uav1, "UAV1"], [uav2, "UAV2"], [uav3, "UAV3"]]) {
    const tx = await fail.connect(uav).heartbeat();
    await tx.wait();
    log(`  heartbeat(${name}) ✔`);
  }

  log("\nCompleting tasks...");
  for (const taskId of tasksA) {
    const tx = await fail.connect(deployer).completeTask(taskId);
    await tx.wait();
    log(`  completeTask(${taskId}) ✔`);
  }
  log(`Remaining active tasks: ${await fail.getActiveTaskCount()}`);

  log("\nAborting mission manually...");
  const txAbort = await fail.connect(deployer).abortMission("Mission completed - manual abort");
  await txAbort.wait();
  log(`State: ${await getState(fail)}`);
  log("✔ Scenario A complete: ABORTED (manual abort)");

  await resetAndVerify(fail, deployer);

  sep("SCENARIO B — Heartbeat failure → CONFIRM_FAILED → DEGRADED");

  await setupAndStart(fail, deployer, uav1, uav2, uav3, 100);

  log("\nUAV1 and UAV2 send heartbeat. UAV3 does NOT...");
  await (await fail.connect(uav1).heartbeat()).wait();
  await (await fail.connect(uav2).heartbeat()).wait();
  log("UAV1 ✔  UAV2 ✔  UAV3 ✗ (no heartbeat)");

  log("Waiting for heartbeatTimeoutSec=15s + margin (18s)...");
  await sleep(18_000);

  log("Owner calling detectMissingHeartbeat(UAV3)...");
  const evidenceB = ethers.keccak256(ethers.toUtf8Bytes("uav3-no-heartbeat-log"));
  const txDetect = await fail.connect(deployer).detectMissingHeartbeat(uav3.address, evidenceB);
  await txDetect.wait();
  log(`State: ${await getState(fail)}`);

  log("\nUAV1 and UAV2 voting CONFIRM_FAILED...");
  await (await fail.connect(uav1).voteOnSuspect(1)).wait();
  log("  UAV1 → CONFIRM_FAILED ✔");
  await (await fail.connect(uav2).voteOnSuspect(1)).wait();
  log("  UAV2 → CONFIRM_FAILED ✔");

  log("\nOwner finalizing incident...");
  await (await fail.connect(deployer).finalizeIncident()).wait();
  log(`State: ${await getState(fail)}`);

  log("Owner calling triggerReconfiguration()...");
  await (await fail.connect(deployer).triggerReconfiguration()).wait();
  log(`State: ${await getState(fail)}`);

  await printSummary(fail);
  log("✔ Scenario B complete: UAV3 CONFIRMED_FAILED → DEGRADED");

  await resetAndVerify(fail, deployer);

  sep("SCENARIO C — Byzantine behavior → CONFIRM_BYZANTINE → DEGRADED");

  await setupAndStart(fail, deployer, uav1, uav2, uav3, 200);

  for (const uav of [uav1, uav2, uav3]) {
    await (await fail.connect(uav).heartbeat()).wait();
  }
  log("Heartbeats sent by all ✔");

  log("\nOwner opening Byzantine incident (openBehaviorIncident) against UAV2...");
  const evidenceC = ethers.keccak256(ethers.toUtf8Bytes("uav2-byzantine-spoofed-coords"));
  await (await fail.connect(deployer).openBehaviorIncident(uav2.address, evidenceC)).wait();
  log(`State: ${await getState(fail)}`);

  log("\nUAV1 and UAV3 voting CONFIRM_BYZANTINE...");
  await (await fail.connect(uav1).voteOnSuspect(2)).wait();
  log("  UAV1 → CONFIRM_BYZANTINE ✔");
  await (await fail.connect(uav3).voteOnSuspect(2)).wait();
  log("  UAV3 → CONFIRM_BYZANTINE ✔");

  log("\nOwner finalizing incident...");
  await (await fail.connect(deployer).finalizeIncident()).wait();
  log(`State: ${await getState(fail)}`);

  log("Owner calling triggerReconfiguration()...");
  await (await fail.connect(deployer).triggerReconfiguration()).wait();
  log(`State: ${await getState(fail)}`);

  await printSummary(fail);
  log("✔ Scenario C complete: UAV2 CONFIRMED_BYZANTINE → DEGRADED");

  await resetAndVerify(fail, deployer);

  sep("SCENARIO D — REJECT vote → suspect exonerated → back to ACTIVE");

  await setupAndStart(fail, deployer, uav1, uav2, uav3, 300);

  for (const uav of [uav1, uav2, uav3]) {
    await (await fail.connect(uav).heartbeat()).wait();
  }
  log("Heartbeats sent by all ✔");

  log("\nOwner opening Byzantine incident against UAV1 (wrong suspicion)...");
  const evidenceD = ethers.keccak256(ethers.toUtf8Bytes("uav1-false-positive-alarm"));
  await (await fail.connect(deployer).openBehaviorIncident(uav1.address, evidenceD)).wait();
  log(`State: ${await getState(fail)}`);

  log("\nUAV2 and UAV3 voting REJECT...");
  await (await fail.connect(uav2).voteOnSuspect(3)).wait();
  log("  UAV2 → REJECT ✔");
  await (await fail.connect(uav3).voteOnSuspect(3)).wait();
  log("  UAV3 → REJECT ✔");

  log("\nOwner finalizing incident...");
  await (await fail.connect(deployer).finalizeIncident()).wait();
  log(`State: ${await getState(fail)}`);

  const uav1State = (await fail.uavs(uav1.address)).state;
  log(`UAV1 state: ${UAV_STATE_NAMES[Number(uav1State)]} (expected: ACTIVE)`);

  await printSummary(fail);
  log("✔ Scenario D complete: UAV1 exonerated → ACTIVE state restored");

  await resetAndVerify(fail, deployer);

  sep("Simulation V1 complete");
  log("All 4 scenarios executed successfully.");
  log(`Final state: ${await getState(fail)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
