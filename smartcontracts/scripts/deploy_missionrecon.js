// scripts/deploy_missionrecon.js
// Deploys MissionReconV1 + ERC1967 proxy.
//
// Usage:
//   npx hardhat run scripts/deploy_missionrecon.js --network rede-hibrido

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("─".repeat(60));
  console.log("  MissionRecon — Deploy V1 + Proxy");
  console.log("─".repeat(60));
  console.log(`  Deployer : ${deployer.address}`);
  console.log(`  Balance  : ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);
  console.log();

  console.log("1) Deploying MissionReconV1 (implementation)...");
  const V1Factory = await ethers.getContractFactory("MissionReconV1", deployer);
  const impl = await V1Factory.deploy();
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();
  console.log(`   Implementation V1: ${implAddr}`);

  const initData = V1Factory.interface.encodeFunctionData("initialize", [
    deployer.address,
    2,
    30,
    2,
    60,
    40,
  ]);

  console.log("2) Deploying ERC1967Proxy...");
  const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy", deployer);
  const proxy = await ProxyFactory.deploy(implAddr, initData);
  await proxy.waitForDeployment();
  const proxyAddr = await proxy.getAddress();
  console.log(`   Proxy: ${proxyAddr}`);

  const recon = await ethers.getContractAt("MissionReconV1", proxyAddr, deployer);
  const ver   = await recon.version();
  const owner = await recon.owner();
  const state = await recon.missionState();
  console.log();
  console.log("3) Verification via proxy:");
  console.log(`   version()      : ${ver}`);
  console.log(`   owner()        : ${owner}`);
  console.log(`   missionState() : ${state} (0 = IDLE)`);

  const out = {
    network:     "rede-hibrido",
    deployedAt:  new Date().toISOString(),
    implV1:      implAddr,
    proxy:       proxyAddr,
    version:     ver,
  };

  const outPath = path.join(__dirname, "..", "recon_addresses.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log();
  console.log(`4) Addresses saved to recon_addresses.json`);
  console.log(`   ${outPath}`);
  console.log();
  console.log("─".repeat(60));
  console.log("  Deploy completed successfully!");
  console.log("─".repeat(60));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
