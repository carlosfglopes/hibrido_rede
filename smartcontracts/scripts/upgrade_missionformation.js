// scripts/upgrade_missionformation.js
// Upgrades the MissionFormation proxy from V1 to V2. Prerequisite:
// deploy_missionformation.js must have already been run.
//
// Usage:
//   npx hardhat run scripts/upgrade_missionformation.js --network rede-hibrido

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { trackAuthorityTx, finishAndSaveMetrics } = require("./lib/metrics");

async function main() {
  const [deployer] = await ethers.getSigners();
  const fromBlock = await ethers.provider.getBlockNumber();
  console.log("─".repeat(60));
  console.log("  MissionFormation — Upgrade V1 → V2");
  console.log("─".repeat(60));
  console.log(`  Deployer : ${deployer.address}`);

  const addrPath = path.join(__dirname, "..", "formation_addresses.json");
  if (!fs.existsSync(addrPath)) {
    throw new Error("formation_addresses.json not found — run deploy_missionformation.js first");
  }
  const addrs = JSON.parse(fs.readFileSync(addrPath, "utf8"));
  const proxyAddr = addrs.proxy;
  console.log(`  Proxy    : ${proxyAddr}`);
  console.log(`  Impl V1  : ${addrs.implV1}`);
  console.log();

  const formV1 = await ethers.getContractAt("MissionFormationV1", proxyAddr, deployer);
  console.log(`1) Version before upgrade: ${await formV1.version()}`);

  console.log("2) Deploying MissionFormationV2 (new implementation)...");
  const V2Factory = await ethers.getContractFactory("MissionFormationV2", deployer);
  const implV2 = await V2Factory.deploy();
  await implV2.waitForDeployment();
  const implV2Addr = await implV2.getAddress();
  console.log(`   Implementation V2: ${implV2Addr}`);
  const deployReceipt = await implV2.deploymentTransaction().wait();
  trackAuthorityTx(deployReceipt, "deployV2");

  const initData = V2Factory.interface.encodeFunctionData("initializeV2", [
    5,
    3,
  ]);

  console.log("3) Calling upgradeToAndCall() + initializeV2(penalty=5, bonus=3)...");
  const tx = await formV1.upgradeToAndCall(implV2Addr, initData);
  const upgradeReceipt = await tx.wait();
  trackAuthorityTx(upgradeReceipt, "upgradeToAndCall");
  console.log(`   Tx: ${tx.hash}`);

  const formV2 = await ethers.getContractAt("MissionFormationV2", proxyAddr, deployer);
  const ver    = await formV2.version();
  const score  = await formV2.formationScore();
  const pen    = await formV2.penaltyPerViolation();
  const bonus  = await formV2.bonusPerRecovery();
  console.log();
  console.log("4) Post-upgrade verification via proxy:");
  console.log(`   version()            : ${ver}`);
  console.log(`   formationScore()     : ${score}  (expected: 100)`);
  console.log(`   penaltyPerViolation  : ${pen}`);
  console.log(`   bonusPerRecovery     : ${bonus}`);

  addrs.implV2     = implV2Addr;
  addrs.version    = ver;
  addrs.upgradedAt = new Date().toISOString();
  fs.writeFileSync(addrPath, JSON.stringify(addrs, null, 2));
  console.log();
  console.log("5) formation_addresses.json updated with implV2.");
  console.log();

  await finishAndSaveMetrics({
    provider: ethers.provider, proxyAddress: proxyAddr, iface: formV2.interface,
    fromBlock, model: "Modelo3-Hibrido", scenario: "Formation-Upgrade", log: console.log,
  });

  console.log("─".repeat(60));
  console.log("  Upgrade completed successfully!");
  console.log("─".repeat(60));
}

main().catch((e) => { console.error(e); process.exit(1); });
