// scripts/authority_missionrecon.js
// Authority — MissionRecon (Model 3: Hybrid FSM + UUPS Proxy). Runs on the
// PC. Permits the UAVs, activates the mission, waits for registration/status
// (done by the self-service agents) and starts the election. The rest
// (reporting, conclusion) is handled automatically by the agents/FSM.
//
// Usage:
//   npx hardhat run scripts/authority_missionrecon.js --network rede-hibrido

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");
const { trackAuthorityTx, finishAndSaveMetrics } = require("./lib/metrics");

const UAV_ADDRESSES = [
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
];

const MISSION_ZONE = "Zone-Alpha";
const POLL_INTERVAL = 2000;
const GAS = { gasLimit: 500_000 };

const STATE_NAMES = {0:"IDLE",1:"ACTIVE",2:"ELECTION",3:"ASSIGNED",4:"REPORTING",5:"COMPLETED",6:"FAILED",7:"TERMINATED"};

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
  const addrPath = path.join(__dirname, "..", "recon_addresses.json");
  if (!fs.existsSync(addrPath)) throw new Error("recon_addresses.json not found — run deploy_missionrecon.js first.");
  const addresses = JSON.parse(fs.readFileSync(addrPath, "utf8"));

  const [authority] = await hre.ethers.getSigners();
  const proxy = await hre.ethers.getContractAt("MissionReconV1", addresses.proxy);
  const fromBlock = await hre.ethers.provider.getBlockNumber();

  sep("AUTHORITY — MissionRecon (Model 3)");
  log(`Network   : ${hre.network.name}`);
  log(`Authority : ${authority.address}`);
  log(`Proxy     : ${addresses.proxy}`);

  sep("STEP 1 — Permit UAVs");
  for (let i = 0; i < UAV_ADDRESSES.length; i++) {
    const data = await proxy.uavs(UAV_ADDRESSES[i]);
    if (data.permitted) {
      log(`UAV${i + 1} already permitted.`);
      continue;
    }
    await sendTx(proxy.connect(authority).permitUAV(UAV_ADDRESSES[i], GAS), `permitUAV UAV${i + 1}`);
  }

  sep("STEP 2 — Activate Mission");
  const state0 = await proxy.missionState();
  if (Number(state0) === 0) {
    await sendTx(proxy.connect(authority).activateMission(MISSION_ZONE, GAS), "activateMission");
  } else {
    log(`Mission already in state: ${STATE_NAMES[Number(state0)]}`);
  }

  sep("STEP 3 — Wait for UAV Registration and Status");
  const minUAVs = await proxy.minUAVsForElection();
  log(`Minimum UAVs required: ${minUAVs}`);

  while (true) {
    const state = Number(await proxy.missionState());
    if (state !== 1) break;

    let registered = 0;
    let ready = 0;
    for (const addr of UAV_ADDRESSES) {
      const data = await proxy.uavs(addr);
      if (data.registered) registered++;
      if (data.registered && data.hasStatus) ready++;
    }
    log(`UAVs ready: ${ready}/${UAV_ADDRESSES.length} (registered: ${registered})`);
    if (ready >= Number(minUAVs) && ready === registered) {
      log("Enough UAVs ready (no registered-without-status stragglers)!");
      break;
    }
    await sleep(POLL_INTERVAL);
  }

  sep("STEP 4 — Start Election");
  const state1 = Number(await proxy.missionState());
  if (state1 === 1) {
    await sendTx(proxy.connect(authority).startElection(GAS), "startElection");
    const leader = await proxy.electedLeader();
    log(`Elected leader: ${leader}`);
  } else {
    log(`Unexpected state: ${STATE_NAMES[state1]}`);
  }

  sep("STEP 5 — Monitoring");
  while (true) {
    const s = await proxy.getMissionSummary();
    const state = Number(s.state);
    log(`State: ${STATE_NAMES[state]} | Leader: ${s.leader} | Re-elections: ${s.reelections}`);

    if ([5, 6, 7].includes(state)) {
      sep("FINAL RESULT");
      log(`State       : ${STATE_NAMES[state]}`);
      log(`Leader      : ${s.leader}`);
      log(`Re-elections: ${s.reelections}`);
      break;
    }
    await sleep(POLL_INTERVAL);
  }

  sep("METRICS");
  await finishAndSaveMetrics({
    provider: hre.ethers.provider, proxyAddress: addresses.proxy, iface: proxy.interface,
    fromBlock, model: "Modelo3-Hibrido", scenario: "Recon", log,
  });

  sep("END");
}

main().catch((err) => {
  console.error("✘ Error:", err.message);
  process.exitCode = 1;
});
