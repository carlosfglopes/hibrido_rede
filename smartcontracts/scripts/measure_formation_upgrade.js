// scripts/measure_formation_upgrade.js
// The "real" Formation proxy (formation_addresses.json) was already
// upgraded to V2 in a previous session (before metrics.js existed), so
// upgrade_missionformation.js now fails with "Execution reverted" —
// initializeV2() has a reinitializer guard and cannot be called twice.
//
// This script does a DISPOSABLE V1 deploy + V2 upgrade, just to measure
// the real cost of "V1→V2" (V1 deploy gas, V2 deploy gas, upgradeToAndCall)
// without touching the real proxy in use or formation_addresses.json.
//
// Usage:
//   npx hardhat run scripts/measure_formation_upgrade.js --network rede-hibrido

const { ethers } = require("hardhat");
const { trackAuthorityTx, finishAndSaveMetrics } = require("./lib/metrics");

async function main() {
  const [deployer] = await ethers.getSigners();
  const fromBlock = await ethers.provider.getBlockNumber();

  console.log("─".repeat(60));
  console.log("  MEASUREMENT — MissionFormation Deploy V1 + Upgrade V2 (disposable)");
  console.log("─".repeat(60));
  console.log(`  Deployer : ${deployer.address}`);

  console.log("1) Deploying MissionFormationV1 (implementation)...");
  const V1Factory = await ethers.getContractFactory("MissionFormationV1", deployer);
  const implV1 = await V1Factory.deploy();
  await implV1.waitForDeployment();
  const implV1Addr = await implV1.getAddress();
  console.log(`   Implementation V1: ${implV1Addr}`);
  trackAuthorityTx(await implV1.deploymentTransaction().wait(), "deployV1Implementation");

  const initData = V1Factory.interface.encodeFunctionData("initialize", [
    deployer.address, 10, 2, 1, 8, 2, 1, 100, 10000, 50000,
  ]);

  console.log("2) Deploying ERC1967Proxy...");
  const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy", deployer);
  const proxy = await ProxyFactory.deploy(implV1Addr, initData);
  await proxy.waitForDeployment();
  const proxyAddr = await proxy.getAddress();
  console.log(`   Proxy (disposable): ${proxyAddr}`);
  trackAuthorityTx(await proxy.deploymentTransaction().wait(), "deployProxy");

  const formV1 = await ethers.getContractAt("MissionFormationV1", proxyAddr, deployer);
  console.log(`   version() before: ${await formV1.version()}`);

  console.log("3) Deploying MissionFormationV2 (new implementation)...");
  const V2Factory = await ethers.getContractFactory("MissionFormationV2", deployer);
  const implV2 = await V2Factory.deploy();
  await implV2.waitForDeployment();
  const implV2Addr = await implV2.getAddress();
  console.log(`   Implementation V2: ${implV2Addr}`);
  trackAuthorityTx(await implV2.deploymentTransaction().wait(), "deployV2");

  const initV2Data = V2Factory.interface.encodeFunctionData("initializeV2", [5, 3]);

  console.log("4) Calling upgradeToAndCall() + initializeV2(penalty=5, bonus=3)...");
  const tx = await formV1.upgradeToAndCall(implV2Addr, initV2Data);
  const upgradeReceipt = await tx.wait();
  trackAuthorityTx(upgradeReceipt, "upgradeToAndCall");
  console.log(`   Tx: ${tx.hash}`);

  const formV2 = await ethers.getContractAt("MissionFormationV2", proxyAddr, deployer);
  console.log();
  console.log("5) Post-upgrade verification:");
  console.log(`   version()        : ${await formV2.version()}`);
  console.log(`   formationScore() : ${await formV2.formationScore()}`);

  await finishAndSaveMetrics({
    provider: ethers.provider, proxyAddress: proxyAddr, iface: formV2.interface,
    fromBlock, model: "Modelo3-Hibrido", scenario: "Formation-Upgrade", log: console.log,
  });

  console.log("─".repeat(60));
  console.log("  Measurement complete (disposable proxy, not saved to any file)");
  console.log("─".repeat(60));
}

main().catch((e) => { console.error(e); process.exit(1); });
