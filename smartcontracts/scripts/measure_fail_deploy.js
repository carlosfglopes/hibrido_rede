// scripts/measure_fail_deploy.js
// The "real" Fail proxy (fail_addresses.json) was already deployed before
// metrics.js existed, so no deploy cost was recorded. This script does a
// DISPOSABLE V1 deploy, just to measure the real gas cost, without touching
// the proxy in use or fail_addresses.json.
//
// Usage:
//   npx hardhat run scripts/measure_fail_deploy.js --network rede-hibrido

const { ethers } = require("hardhat");
const { trackAuthorityTx, finishAndSaveMetrics } = require("./lib/metrics");

async function main() {
  const [deployer] = await ethers.getSigners();
  const fromBlock = await ethers.provider.getBlockNumber();

  console.log("─".repeat(60));
  console.log("  MEASUREMENT — MissionFail Deploy V1 (disposable)");
  console.log("─".repeat(60));
  console.log(`  Deployer : ${deployer.address}`);

  console.log("1) Deploying MissionFailV1 (implementation)...");
  const V1Factory = await ethers.getContractFactory("MissionFailV1", deployer);
  const implV1 = await V1Factory.deploy();
  await implV1.waitForDeployment();
  const implV1Addr = await implV1.getAddress();
  console.log(`   Implementation V1: ${implV1Addr}`);
  trackAuthorityTx(await implV1.deploymentTransaction().wait(), "deployV1Implementation");

  const initData = V1Factory.interface.encodeFunctionData("initialize", [
    deployer.address, 15, 2, 3, 5, 0,
  ]);

  console.log("2) Deploying ERC1967Proxy...");
  const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy", deployer);
  const proxy = await ProxyFactory.deploy(implV1Addr, initData);
  await proxy.waitForDeployment();
  const proxyAddr = await proxy.getAddress();
  console.log(`   Proxy (disposable): ${proxyAddr}`);
  trackAuthorityTx(await proxy.deploymentTransaction().wait(), "deployProxy");

  const fail = await ethers.getContractAt("MissionFailV1", proxyAddr, deployer);
  console.log(`   version(): ${await fail.version()}`);

  await finishAndSaveMetrics({
    provider: ethers.provider, proxyAddress: proxyAddr, iface: fail.interface,
    fromBlock, model: "Modelo3-Hibrido", scenario: "Fail-Deploy", log: console.log,
  });

  console.log("─".repeat(60));
  console.log("  Measurement complete (disposable proxy, not saved to any file)");
  console.log("─".repeat(60));
}

main().catch((e) => { console.error(e); process.exit(1); });
