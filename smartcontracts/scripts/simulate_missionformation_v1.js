// scripts/simulate_missionformation_v1.js
// Runs a full simulation against the deployed MissionFormation V1 proxy.
//
// Scenarios:
//   A) Normal mission - updatePosition + completeMission
//   B) Violation - OUT_OF_FORMATION - DEGRADED - Recovery - ACTIVE
//   C) Formation change - RECONFIGURING_FORMATION - finalize
//   D) UAV LATE - DEGRADED - updatePosition - recovery - ACTIVE
//
// Usage:
//   npx hardhat run scripts/simulate_missionformation_v1.js --network rede-hibrido

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
async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function getState(form) {
  const s = await form.missionState();
  return `${STATE_NAMES[Number(s)]} (${s})`;
}

async function fundUAVs(deployer, uavs) {
  log("Funding UAV accounts...");
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
    const tx = await form.connect(deployer).registerUAV(uavs[i].address, x, y);
    await tx.wait();
    log(`registerUAV(UAV${i + 1}: x=${x}, y=${y}) ✔`);
  }
  const tx = await form.connect(deployer).startMission();
  await tx.wait();
  const centroid = await form.getCentroid();
  log(`startMission() → ${await getState(form)}`);
  log(`Centroid: (${centroid.x}, ${centroid.y})`);
}

async function resetAndVerify(form, deployer) {
  const tx = await form.connect(deployer).resetMission();
  await tx.wait();
  log(`resetMission() → ${await getState(form)}`);
}

async function printSwarm(form) {
  const s  = await form.getSwarmSummary();
  const ct = await form.getSwarmCounts();
  log(`State: ${STATE_NAMES[Number(s.state)]} | formation #${s.formationId} | centroid=(${s.cx},${s.cy})`);
  log(`UAVs: OK=${ct.okCount} LATE=${ct.lateCount} OUT_OF_FORMATION=${ct.outOfFormationCount} INACTIVE=${ct.inactiveCount}`);
}

// MAIN

async function main() {
  const signers  = await ethers.getSigners();
  const deployer = signers[0];
  const uav1     = signers[1];
  const uav2     = signers[2];
  const uav3     = signers[3];

  sep("MissionFormation V1 — Full Simulation");
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

  const form = await ethers.getContractAt("MissionFormationV1", proxyAddr, deployer);
  log(`Version  : ${await form.version()}`);

  await fundUAVs(deployer, [uav1, uav2, uav3]);

  if (Number(await form.missionState()) !== 0) {
    log("Resetting previous mission...");
    await resetAndVerify(form, deployer);
  }

  sep("SCENARIO A — Normal mission: positions + completeMission");

  await setupAndStart(form, deployer, uav1, uav2, uav3);

  log("\nUAVs updating positions...");
  const moves = [
    [uav1, "UAV1",  55n,  90n],
    [uav2, "UAV2", -95n,   5n],
    [uav3, "UAV3",  55n, -85n],
  ];
  for (const [uav, name, x, y] of moves) {
    const tx = await form.connect(uav).updatePosition(x, y);
    await tx.wait();
    log(`  updatePosition(${name}: x=${x}, y=${y}) ✔`);
  }

  const centroid = await form.getCentroid();
  log(`Updated centroid: (${centroid.x}, ${centroid.y})`);
  await printSwarm(form);

  log("\nOwner completing mission...");
  await (await form.connect(deployer).completeMission()).wait();
  log(`State: ${await getState(form)}`);
  log("✔ Scenario A complete: COMPLETED");

  await resetAndVerify(form, deployer);

  sep("SCENARIO B — Violation → OUT_OF_FORMATION → DEGRADED → Recovery");

  await setupAndStart(form, deployer, uav1, uav2, uav3);

  await (await form.connect(uav1).updatePosition(55n, 90n)).wait();
  await (await form.connect(uav2).updatePosition(-95n, 5n)).wait();
  log("UAV1 and UAV2 updated position ✔ | UAV3 static");

  log("\n[Round 1] UAV1 and UAV2 report violation of UAV3...");
  await (await form.connect(uav1).reportViolation(uav3.address)).wait();
  log("  UAV1 → reportViolation(UAV3) ✔");
  await (await form.connect(uav2).reportViolation(uav3.address)).wait();
  log("  UAV2 → reportViolation(UAV3) ✔  (quorum reached → violationCount=1)");

  log("\n[Round 2] UAV1 and UAV2 report violation again...");
  await (await form.connect(uav1).reportViolation(uav3.address)).wait();
  log("  UAV1 → reportViolation(UAV3) ✔");
  await (await form.connect(uav2).reportViolation(uav3.address)).wait();
  log("  UAV2 → reportViolation(UAV3) ✔  (violationCount=2 → OUT_OF_FORMATION → DEGRADED)");

  await printSwarm(form);

  const uav3StateB = (await form.uavs(uav3.address)).state;
  log(`\nUAV3 state: ${UAV_STATE_NAMES[Number(uav3StateB)]} (expected: OUT_OF_FORMATION)`);
  log(`Mission state: ${await getState(form)} (expected: DEGRADED)`);

  log("\nUAV1 and UAV2 confirming UAV3 recovery...");
  await (await form.connect(uav1).reportRecovery(uav3.address)).wait();
  log("  UAV1 → reportRecovery(UAV3) ✔");
  await (await form.connect(uav2).reportRecovery(uav3.address)).wait();
  log("  UAV2 → reportRecovery(UAV3) ✔  (quorum → UAV3 OK → ACTIVE)");

  const uav3StateAfter = (await form.uavs(uav3.address)).state;
  log(`\nUAV3 state after recovery: ${UAV_STATE_NAMES[Number(uav3StateAfter)]} (expected: OK)`);
  await printSwarm(form);
  log("✔ Scenario B complete: violation → DEGRADED → recovery → ACTIVE");

  await resetAndVerify(form, deployer);

  sep("SCENARIO C — Formation change → RECONFIGURING → finalize");

  await setupAndStart(form, deployer, uav1, uav2, uav3);

  for (const [uav, x, y] of [[uav1, 55n, 90n], [uav2, -95n, 5n], [uav3, 55n, -85n]]) {
    await (await form.connect(uav).updatePosition(x, y)).wait();
  }
  log("Positions updated ✔");

  log(`\nState before: ${await getState(form)}`);
  log("Owner starting changeFormation(id=2, dMinSq=200, dMaxSq=20000, rMaxSq=100000)...");
  await (await form.connect(deployer).changeFormation(2, 200, 20000, 100000)).wait();
  log(`State: ${await getState(form)} (expected: RECONFIGURING_FORMATION)`);

  const sw = await form.getSwarmSummary();
  log(`Transition time remaining: ${sw.transitionSecsLeft}s`);

  log("Waiting for transitionTime=8s + margin (10s)...");
  await sleep(10_000);

  log("Owner calling finalizeFormationChange()...");
  await (await form.connect(deployer).finalizeFormationChange()).wait();

  const cf = await form.currentFormation();
  log(`Formation applied: id=${cf.formationId} dMinSq=${cf.dMinSq} dMaxSq=${cf.dMaxSq}`);
  log(`State: ${await getState(form)} (expected: ACTIVE)`);
  log("✔ Scenario C complete: formation change applied successfully");

  await resetAndVerify(form, deployer);

  sep("SCENARIO D — UAV LATE → DEGRADED → updatePosition → ACTIVE");

  await setupAndStart(form, deployer, uav1, uav2, uav3);

  await (await form.connect(uav1).updatePosition(55n, 90n)).wait();
  await (await form.connect(uav2).updatePosition(-95n, 5n)).wait();
  log("UAV1 and UAV2 updated position ✔ | UAV3 silent (no updatePosition)");

  log("Waiting for toleranceWindow=10s + margin (13s)...");
  await sleep(13_000);

  log("Owner calling checkLateUAVs()...");
  await (await form.connect(deployer).checkLateUAVs()).wait();

  const uav3StateD = (await form.uavs(uav3.address)).state;
  log(`UAV3 state: ${UAV_STATE_NAMES[Number(uav3StateD)]} (expected: LATE)`);
  log(`Mission state: ${await getState(form)} (expected: DEGRADED)`);

  log("\nUAV3 sending updatePosition (back to formation)...");
  await (await form.connect(uav3).updatePosition(50n, -87n)).wait();

  const uav3StateFinal = (await form.uavs(uav3.address)).state;
  log(`UAV3 state after update: ${UAV_STATE_NAMES[Number(uav3StateFinal)]} (expected: OK)`);
  log(`Mission state: ${await getState(form)} (expected: ACTIVE)`);
  await printSwarm(form);
  log("✔ Scenario D complete: UAV LATE → DEGRADED → automatic recovery → ACTIVE");

  await resetAndVerify(form, deployer);

  sep("Simulation V1 complete");
  log("All 4 scenarios executed successfully.");
  log(`Final state: ${await getState(form)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
