// scripts/measure_recon_deploy.js
// The "real" Recon proxy (recon_addresses.json) was already deployed
// before metrics.js existed, so no deploy cost was recorded. This script
// does a DISPOSABLE V1 deploy, just to measure the real gas cost, without
// touching the proxy in use or recon_addresses.json.
//
// Usage:
//   npx hardhat run scripts/measure_recon_deploy.js --network rede-hibrido

const { ethers } = require("hardhat");
const { trackAuthorityTx, finishAndSaveMetrics } = require("./lib/metrics");

async function main() {
  const [deployer] = await ethers.getSigners();
  const fromBlock = await ethers.provider.getBlockNumber();

  console.log("─".repeat(60));
  console.log("  MEASUREMENT — MissionRecon Deploy V1 (disposable)");
  console.log("─".repeat(60));
  console.log(`  Deployer : ${deployer.address}`);

  console.log("1) Deploying MissionReconV1 (implementation)...");
  const V1Factory = await ethers.getContractFactory("MissionReconV1", deployer);
  const implV1 = await V1Factory.deploy();
  await implV1.waitForDeployment();
  const implV1Addr = await implV1.getAddress();
  console.log(`   Implementation V1: ${implV1Addr}`);
  trackAuthorityTx(await implV1.deploymentTransaction().wait(), "deployV1Implementation");

  const initData = V1Factory.interface.encodeFunctionData("initialize", [
    deployer.address, 2, 30, 2, 60, 40,
  ]);

  console.log("2) Deploying ERC1967Proxy...");
  const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy", deployer);
  const proxy = await ProxyFactory.deploy(implV1Addr, initData);
  await proxy.waitForDeployment();
  const proxyAddr = await proxy.getAddress();
  console.log(`   Proxy (disposable): ${proxyAddr}`);
  trackAuthorityTx(await proxy.deploymentTransaction().wait(), "deployProxy");

  const recon = await ethers.getContractAt("MissionReconV1", proxyAddr, deployer);
  console.log(`   version(): ${await recon.version()}`);

  await finishAndSaveMetrics({
    provider: ethers.provider, proxyAddress: proxyAddr, iface: recon.interface,
    fromBlock, model: "Modelo3-Hibrido", scenario: "Recon-Deploy", log: console.log,
  });

  console.log("─".repeat(60));
  console.log("  Measurement complete (disposable proxy, not saved to any file)");
  console.log("─".repeat(60));
}

main().catch((e) => { console.error(e); process.exit(1); });
