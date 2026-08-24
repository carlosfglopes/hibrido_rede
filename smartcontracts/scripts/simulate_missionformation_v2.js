// scripts/simulate_missionformation_v2.js
// Runs a full simulation against the deployed MissionFormation V2 proxy.
// Prerequisite: upgrade_missionformation.js must have already been run
// (it calls initializeV2 and sets formationScore=100).
//
// Scenarios:
//   A) 2 confirmed violations - score = 100 - 2x5 = 90
//      + 1 confirmed recovery - score = 90 + 3 = 93
//
//   B) 4 consecutive violations (2 rounds x 2 UAVs) -
//      score = 100 - 4x5 = 80; then reset - score=100
//
//   C) Multiple violate/recover cycles: demonstrates the dynamic score
//      Violate x3 (-15) → recover x2 (+6) → violate x2 (-10)
//      Expected final score: 100 - 15 + 6 - 10 = 81
//
// Usage:
//   npx hardhat run scripts/simulate_missionformation_v2.js --network rede-hibrido

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const STATE_NAMES = [
  "SETUP", "ACTIVE", "RECONFIGURING_FORMATION", "DEGRADED", "COMPLETED", "ABORTED",
];
const UAV_STATE_NAMES = ["OK", "LATE", "OUT_OF_FORMATION", "INACTIVE"];

// HELPERS

function log(msg)   { console.log(`  ${msg}`); }
function sep(title) { console.log(`\n${"─".repeat(60)}\n  ${title}\n${"─".repeat(60)}`); }

async function getState(form) {
  const s = await form.missionState();
  return `${STATE_NAMES[Number(s)]} (${s})`;
}

async function fundUAVs(deployer, uavs) {
  for (const uav of uavs) {
    const bal = await ethers.provider.getBalance(uav.address);
    if (bal < ethers.parseEther("0.1")) {
      const tx = await deployer.sendTransaction({ to: uav.address, value: ethers.parseEther("0.5") });
      await tx.wait();
    }
  }
  log("UAV accounts funded ✔");
}

const INIT_POSITIONS = [
  [50n, 87n],
  [-100n, 0n],
  [50n, -87n],
];

async function setupAndStart(form, deployer, uav1, uav2, uav3) {
  const uavs = [uav1, uav2, uav3];
  for (let i = 0; i < uavs.length; i++) {
    const [x, y] = INIT_POSITIONS[i];
    await (await form.connect(deployer).registerUAV(uavs[i].address, x, y)).wait();
  }
  await (await form.connect(deployer).startMission()).wait();
  log(`startMission() → ${await getState(form)}`);
}

async function resetAndVerify(form, deployer) {
  await (await form.connect(deployer).resetMission()).wait();
  const score = await form.formationScore();
  log(`resetMission() → ${await getState(form)} | formationScore=${score} (expected: 100)`);
}

async function printScoreBoard(form) {
  const s = await form.getSwarmSummaryV2();
  const ct = await form.getSwarmCounts();
  log(`\n  ┌─ Formation Score V2 ──────────────────────────────┐`);
  log(`  │  formationScore       : ${s.score}`);
  log(`  │  totalViolations      : ${s.totalViolations}`);
  log(`  │  totalRecoveries      : ${s.totalRecoveries}`);
  log(`  │  UAVs: OK=${ct.okCount} LATE=${ct.lateCount} OUT=${ct.outOfFormationCount}`);
  log(`  └───────────────────────────────────────────────────┘`);
}

async function voteViolation(form, uav1, uav2, target, tag) {
  await (await form.connect(uav1).reportViolation(target.address)).wait();
  await (await form.connect(uav2).reportViolation(target.address)).wait();
  const score = await form.formationScore();
  log(`${tag} reportViolation × 2 (quorum) → score=${score}`);
}

async function voteRecovery(form, uav1, uav2, target, tag) {
  const state = (await form.uavs(target.address)).state;
  if (Number(state) !== 2) {
    log(`${tag} UAV3 is not OUT_OF_FORMATION (state=${UAV_STATE_NAMES[Number(state)]}) — skipping recovery`);
    return;
  }
  await (await form.connect(uav1).reportRecovery(target.address)).wait();
  await (await form.connect(uav2).reportRecovery(target.address)).wait();
  const score = await form.formationScore();
  log(`${tag} reportRecovery × 2 (quorum) → score=${score}`);
}

// MAIN

async function main() {
  const signers  = await ethers.getSigners();
  const deployer = signers[0];
  const uav1     = signers[1];
  const uav2     = signers[2];
  const uav3     = signers[3];

  sep("MissionFormation V2 — FormationScore Simulation");
  log(`Deployer : ${deployer.address}`);
  log(`UAV1     : ${uav1.address}`);
  log(`UAV2     : ${uav2.address}`);
  log(`UAV3     : ${uav3.address}`);

  const addrPath = path.join(__dirname, "..", "formation_addresses.json");
  if (!fs.existsSync(addrPath)) {
    throw new Error("formation_addresses.json not found — run deploy_missionformation.js first");
  }
  const { proxy: proxyAddr } = JSON.parse(fs.readFileSync(addrPath, "utf8"));
  log(`\nProxy    : ${proxyAddr}`);

  const form = await ethers.getContractAt("MissionFormationV2", proxyAddr, deployer);
  const ver  = await form.version();
  log(`Version  : ${ver}`);
  if (!ver.includes("V2")) {
    throw new Error("The proxy is still on V1 — run upgrade_missionformation.js first");
  }
  log(`Initial formationScore : ${await form.formationScore()} (expected: 100)`);
  log(`penaltyPerViolation    : ${await form.penaltyPerViolation()}`);
  log(`bonusPerRecovery       : ${await form.bonusPerRecovery()}`);

  await fundUAVs(deployer, [uav1, uav2, uav3]);

  if (Number(await form.missionState()) !== 0) {
    log("Resetting previous mission...");
    await resetAndVerify(form, deployer);
  }

  sep("SCENARIO A — 2 violations (-10) + 1 recovery (+3) → score=93");

  await setupAndStart(form, deployer, uav1, uav2, uav3);
  log(`Initial score: ${await form.formationScore()}`);

  await voteViolation(form, uav1, uav2, uav3, "[V1]");

  await voteViolation(form, uav1, uav2, uav3, "[V2]");

  const uav3StateA = (await form.uavs(uav3.address)).state;
  log(`UAV3 state: ${UAV_STATE_NAMES[Number(uav3StateA)]} (expected: OUT_OF_FORMATION)`);

  await voteRecovery(form, uav1, uav2, uav3, "[R1]");

  const uav3StateAfterA = (await form.uavs(uav3.address)).state;
  log(`UAV3 state after recovery: ${UAV_STATE_NAMES[Number(uav3StateAfterA)]} (expected: OK)`);

  await printScoreBoard(form);
  log("✔ Scenario A: expected score=93 | violations=2 | recoveries=1");

  await resetAndVerify(form, deployer);

  sep("SCENARIO B — 4 consecutive violations → score=80; reset → 100");

  await setupAndStart(form, deployer, uav1, uav2, uav3);
  log(`Initial score: ${await form.formationScore()}`);

  for (let r = 1; r <= 4; r++) {
    const uav3S = (await form.uavs(uav3.address)).state;
    if (Number(uav3S) === 3) {
      log(`[V${r}] UAV3 inactive — stopping votes`);
      break;
    }

    await voteViolation(form, uav1, uav2, uav3, `[V${r}]`);
  }

  await printScoreBoard(form);
  log(`Final score: ${await form.formationScore()} (expected: ~80 = 100 - 4x5)`);
  log("Resetting mission → score returns to 100...");

  await resetAndVerify(form, deployer);
  log("✔ Scenario B: 4 violations → score≈80; reset → score=100");

  sep("SCENARIO C — Dynamic score: violate×3 (-15) + recover×2 (+6) + violate×2 (-10)");

  await setupAndStart(form, deployer, uav1, uav2, uav3);
  log(`Initial score: ${await form.formationScore()}`);

  log("\n--- Phase 1: 3 violations ---");
  for (let r = 1; r <= 3; r++) {
    const uav3S = (await form.uavs(uav3.address)).state;
    if (Number(uav3S) === 3) { log(`[V${r}] UAV3 inactive — stop`); break; }
    await voteViolation(form, uav1, uav2, uav3, `[V${r}]`);
  }

  log("\n--- Phase 2: 2 recoveries ---");
  for (let r = 1; r <= 2; r++) {
    const uav3S = (await form.uavs(uav3.address)).state;
    if (Number(uav3S) !== 2) {
      log(`[R${r}] UAV3 is not OUT_OF_FORMATION (${UAV_STATE_NAMES[Number(uav3S)]}) — forcing a new violation into OUT_OF_FORMATION`);
      await voteViolation(form, uav1, uav2, uav3, "[V-extra]");
    }
    await voteRecovery(form, uav1, uav2, uav3, `[R${r}]`);
  }

  log("\n--- Phase 3: 2 violations ---");
  for (let r = 1; r <= 2; r++) {
    const uav3S = (await form.uavs(uav3.address)).state;
    if (Number(uav3S) === 3) { log(`[V${r}] UAV3 inactive — stop`); break; }
    await voteViolation(form, uav1, uav2, uav3, `[V${r}]`);
  }

  await printScoreBoard(form);
  const finalScore = await form.formationScore();
  log(`Final score: ${finalScore}`);
  log(`totalViolations: ${await form.totalViolationsConfirmed()} | totalRecoveries: ${await form.totalRecoveriesConfirmed()}`);
  log("✔ Scenario C complete: dynamic score demonstrated");

  await resetAndVerify(form, deployer);

  sep("Simulation V2 complete");
  log("All 3 scenarios executed successfully.");
  log(`Final state: ${await getState(form)} | formationScore=${await form.formationScore()}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
