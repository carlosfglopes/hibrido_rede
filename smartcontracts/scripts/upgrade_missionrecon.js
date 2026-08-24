// scripts/upgrade_missionrecon.js
// Upgrades the MissionRecon proxy from V1 to V2. Prerequisite:
// deploy_missionrecon.js must have already been run.
//
// Usage:
//   npx hardhat run scripts/upgrade_missionrecon.js --network rede-hibrido

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { trackAuthorityTx, finishAndSaveMetrics } = require("./lib/metrics");

async function main() {
  const [deployer] = await ethers.getSigners();
  const fromBlock = await ethers.provider.getBlockNumber();
  console.log("─".repeat(60));
  console.log("  MissionRecon — Upgrade V1 → V2");
  console.log("─".repeat(60));
  console.log(`  Deployer : ${deployer.address}`);

  const addrPath = path.join(__dirname, "..", "recon_addresses.json");
  if (!fs.existsSync(addrPath)) {
    throw new Error("recon_addresses.json not found — run deploy_missionrecon.js first");
  }
  const addrs = JSON.parse(fs.readFileSync(addrPath, "utf8"));
  const proxyAddr = addrs.proxy;
  console.log(`  Proxy    : ${proxyAddr}`);
  console.log(`  Impl V1  : ${addrs.implV1}`);
  console.log();

  const reconV1 = await ethers.getContractAt("MissionReconV1", proxyAddr, deployer);
  console.log(`1) Version before upgrade: ${await reconV1.version()}`);

  console.log("2) Deploying MissionReconV2 (new implementation)...");
  const V2Factory = await ethers.getContractFactory("MissionReconV2", deployer);
  const implV2 = await V2Factory.deploy();
  await implV2.waitForDeployment();
  const implV2Addr = await implV2.getAddress();
  console.log(`   Implementation V2: ${implV2Addr}`);
  const deployReceipt = await implV2.deploymentTransaction().wait();
  trackAuthorityTx(deployReceipt, "deployV2");

  console.log("3) Calling upgradeToAndCall() on the proxy...");
  const tx = await reconV1.upgradeToAndCall(implV2Addr, "0x");
  const upgradeReceipt = await tx.wait();
  trackAuthorityTx(upgradeReceipt, "upgradeToAndCall");
  console.log(`   Tx: ${tx.hash}`);

  const reconV2 = await ethers.getContractAt("MissionReconV2", proxyAddr, deployer);
  const ver     = await reconV2.version();
  const state   = await reconV2.missionState();
  const score   = await reconV2.missionScore();
  console.log();
  console.log("4) Post-upgrade verification via proxy:");
  console.log(`   version()      : ${ver}`);
  console.log(`   missionState() : ${state} (expected: previous state preserved)`);
  console.log(`   missionScore() : ${score}`);

  addrs.implV2      = implV2Addr;
  addrs.version     = ver;
  addrs.upgradedAt  = new Date().toISOString();
  fs.writeFileSync(addrPath, JSON.stringify(addrs, null, 2));
  console.log();
  console.log("5) recon_addresses.json updated with implV2.");
  console.log();

  await finishAndSaveMetrics({
    provider: ethers.provider, proxyAddress: proxyAddr, iface: reconV2.interface,
    fromBlock, model: "Modelo3-Hibrido", scenario: "Recon-Upgrade", log: console.log,
  });

  console.log("─".repeat(60));
  console.log("  Upgrade completed successfully!");
  console.log("─".repeat(60));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
