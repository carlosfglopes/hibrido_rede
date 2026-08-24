// scripts/deploy_missionformation.js
// Deploys MissionFormationV1 + ERC1967 proxy.
//
// Usage:
//   npx hardhat run scripts/deploy_missionformation.js --network rede-hibrido

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("─".repeat(60));
  console.log("  MissionFormation — Deploy V1 + Proxy");
  console.log("─".repeat(60));
  console.log(`  Deployer : ${deployer.address}`);
  console.log(`  Balance  : ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);
  console.log();

  console.log("1) Deploying MissionFormationV1 (implementation)...");
  const V1Factory = await ethers.getContractFactory("MissionFormationV1", deployer);
  const impl = await V1Factory.deploy();
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();
  console.log(`   Implementation V1: ${implAddr}`);

  const initData = V1Factory.interface.encodeFunctionData("initialize", [
    deployer.address,
    10,
    2,
    1,
    8,
    2,
    1,
    100,
    10000,
    50000,
  ]);

  console.log("2) Deploying ERC1967Proxy...");
  const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy", deployer);
  const proxy = await ProxyFactory.deploy(implAddr, initData);
  await proxy.waitForDeployment();
  const proxyAddr = await proxy.getAddress();
  console.log(`   Proxy: ${proxyAddr}`);

  const form = await ethers.getContractAt("MissionFormationV1", proxyAddr, deployer);
  const ver  = await form.version();
  console.log();
  console.log("3) Verification via proxy:");
  console.log(`   version()         : ${ver}`);
  console.log(`   owner()           : ${await form.owner()}`);
  console.log(`   missionState()    : ${await form.missionState()} (0 = SETUP)`);
  console.log(`   quorum()          : ${await form.quorum()}`);
  console.log(`   maxViolations()   : ${await form.maxViolations()}`);
  console.log(`   degradedThreshold : ${await form.degradedThreshold()}`);
  console.log(`   toleranceWindow   : ${await form.toleranceWindow()}`);
  const cf = await form.currentFormation();
  console.log(`   formation #${cf.formationId}: dMinSq=${cf.dMinSq} dMaxSq=${cf.dMaxSq} rMaxSq=${cf.rMaxSq}`);

  const out = {
    network:    "rede-hibrido",
    deployedAt: new Date().toISOString(),
    implV1:     implAddr,
    proxy:      proxyAddr,
    version:    ver,
  };
  const outPath = path.join(__dirname, "..", "formation_addresses.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log();
  console.log(`4) Addresses saved to formation_addresses.json`);
  console.log();
  console.log("─".repeat(60));
  console.log("  Deploy completed successfully!");
  console.log("─".repeat(60));
}

main().catch((e) => { console.error(e); process.exit(1); });
