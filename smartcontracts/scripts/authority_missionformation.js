// scripts/authority_missionformation.js
// Authority — MissionFormation (Model 3: Hybrid FSM + UUPS Proxy). Runs on
// the PC. Registers 4 UAVs in a small-scale SQUARE formation (matching the
// init parameters: dMinSq=100, dMaxSq=10000, rMaxSq=50000 → distances
// between ~10 and ~100 units), starts the mission and monitors it by
// calling checkLateUAVs() periodically. The agents (agent_missionformation.py,
// one per RPi) handle self service: they report their own position and
// vote on peer violations/recoveries.
//
// Usage:
//   npx hardhat run scripts/authority_missionformation.js --network rede-hibrido

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");
const { trackAuthorityTx, finishAndSaveMetrics } = require("./lib/metrics");

const UAVS = [
  { addr: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", x: 0,  y: 0  },
  { addr: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", x: 50, y: 0  },
  { addr: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", x: 50, y: 50 },
  { addr: "0x90F79bf6EB2c4f870365E785982E1f101E93b906", x: 0,  y: 50 },
];

const MONITOR_ROUNDS       = 15;
const MONITOR_INTERVAL     = 3000;
const CHECK_LATE_INTERVAL  = 10000;
const GAS = { gasLimit: 500_000 };

const MISSION_STATES = {0:"SETUP",1:"ACTIVE",2:"RECONFIGURING_FORMATION",3:"DEGRADED",4:"COMPLETED",5:"ABORTED"};

// HELPERS

function sep(label) {
  console.log(`\n${"─".repeat(50)}`);
  if (label) console.log(`  ${label}`);
  console.log("─".repeat(50));
}
function log(msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] [AUTHORITY] ${msg}`);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function sendTx(promise, label) {
  const tx = await promise;
  const receipt = await tx.wait();
  log(`[${label}] gas: ${receipt.gasUsed.toString()} | block: ${receipt.blockNumber}`);
  trackAuthorityTx(receipt, label);
  return receipt;
}

// MAIN

async function main() {
  const addrPath = path.join(__dirname, "..", "formation_addresses.json");
  if (!fs.existsSync(addrPath)) throw new Error("formation_addresses.json not found — run deploy_missionformation.js first.");
  const addresses = JSON.parse(fs.readFileSync(addrPath, "utf8"));

  const [authority] = await hre.ethers.getSigners();
  const proxy = await hre.ethers.getContractAt("MissionFormationV1", addresses.proxy);
  const fromBlock = await hre.ethers.provider.getBlockNumber();

  sep("AUTHORITY — MissionFormation (Model 3)");
  log(`Network   : ${hre.network.name}`);
  log(`Authority : ${authority.address}`);
  log(`Proxy     : ${addresses.proxy}`);

  sep("STEP 1 — Register UAVs (SQUARE formation)");
  for (let i = 0; i < UAVS.length; i++) {
    const data = await proxy.uavs(UAVS[i].addr);
    if (data.registered) {
      log(`UAV${i + 1} already registered.`);
      continue;
    }
    await sendTx(
      proxy.connect(authority).registerUAV(UAVS[i].addr, UAVS[i].x, UAVS[i].y, GAS),
      `registerUAV UAV${i + 1} (${UAVS[i].x},${UAVS[i].y})`
    );
  }

  sep("STEP 2 — Start Mission");
  const state0 = Number(await proxy.missionState());
  if (state0 === 0) {
    await sendTx(proxy.connect(authority).startMission(GAS), "startMission");
  } else {
    log(`Mission already in state: ${MISSION_STATES[state0]}`);
  }

  sep(`STEP 3 — Monitor (${MONITOR_ROUNDS} rounds)`);
  let lastCheckLate = 0;
  for (let round = 1; round <= MONITOR_ROUNDS; round++) {
    const s = await proxy.getSwarmSummary();
    const c = await proxy.getSwarmCounts();
    const state = Number(s.state);

    log(
      `Round ${round}/${MONITOR_ROUNDS} | state=${MISSION_STATES[state]} | ` +
      `centroid=(${s.cx},${s.cy}) | OK=${c.okCount} LATE=${c.lateCount} ` +
      `OUT=${c.outOfFormationCount} INACTIVE=${c.inactiveCount}`
    );

    const now = Date.now();
    if (now - lastCheckLate >= CHECK_LATE_INTERVAL && [1, 2, 3].includes(state)) {
      await sendTx(proxy.connect(authority).checkLateUAVs(GAS), "checkLateUAVs");
      lastCheckLate = now;
    }

    if (state === 4 || state === 5) {
      log("Mission already ended on its own.");
      break;
    }
    await sleep(MONITOR_INTERVAL);
  }

  sep("STEP 4 — Close Mission");
  const sFinal = await proxy.getSwarmSummary();
  const stateFinal = Number(sFinal.state);
  if (stateFinal === 1 || stateFinal === 3) {
    await sendTx(proxy.connect(authority).completeMission(GAS), "completeMission");
    log("Mission closed successfully (COMPLETED).");
  } else {
    log(`Mission was already finished: ${MISSION_STATES[stateFinal]}`);
  }

  sep("METRICS");
  await finishAndSaveMetrics({
    provider: hre.ethers.provider, proxyAddress: addresses.proxy, iface: proxy.interface,
    fromBlock, model: "Modelo3-Hibrido", scenario: "Formation", log,
  });

  sep("END");
}

main().catch((err) => {
  console.error("✘ Error:", err.message);
  process.exitCode = 1;
});
