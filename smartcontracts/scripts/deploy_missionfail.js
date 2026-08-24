// scripts/deploy_missionfail.js
// Deploys MissionFailV1 + ERC1967 proxy.
//
// Usage:
//   npx hardhat run scripts/deploy_missionfail.js --network rede-hibrido

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("─".repeat(60));
  console.log("  MissionFail - Deploy V1 + Proxy");
  console.log("─".repeat(60));
  console.log(`  Deployer : ${deployer.address}`);
  console.log(`  Balance  : ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);
  console.log();

  console.log("1) Deploying MissionFailV1 (implementation)...");
  const V1Factory = await ethers.getContractFactory("MissionFailV1", deployer);
  const impl = await V1Factory.deploy();
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();
  console.log(`   Implementation V1: ${implAddr}`);

  const initData = V1Factory.interface.encodeFunctionData("initialize", [
    deployer.address,
    15,
    2,
    3,
    5,
    0,
  ]);

  console.log("2) Deploying ERC1967Proxy...");
  const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy", deployer);
  const proxy = await ProxyFactory.deploy(implAddr, initData);
  await proxy.waitForDeployment();
  const proxyAddr = await proxy.getAddress();
  console.log(`   Proxy: ${proxyAddr}`);

  const fail = await ethers.getContractAt("MissionFailV1", proxyAddr, deployer);
  const ver   = await fail.version();
  const owner = await fail.owner();
  const state = await fail.missionState();
  console.log();
  console.log("3) Verification via proxy:");
  console.log(`   version()              : ${ver}`);
  console.log(`   owner()               : ${owner}`);
  console.log(`   missionState()        : ${state} (0 = SETUP)`);
  console.log(`   heartbeatTimeoutSec() : ${await fail.heartbeatTimeoutSec()}`);
  console.log(`   quorumThreshold()     : ${await fail.quorumThreshold()}`);
  console.log(`   abortThreshold()      : ${await fail.abortFailureThreshold()}`);
  console.log(`   degradedThreshold()   : ${await fail.degradedCapacityThreshold()}`);

  const out = {
    network:    "rede-hibrido",
    deployedAt: new Date().toISOString(),
    implV1:     implAddr,
    proxy:      proxyAddr,
    version:    ver,
  };

  const outPath = path.join(__dirname, "..", "fail_addresses.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log();
  console.log(`4) Addresses saved to fail_addresses.json`);
  console.log();
  console.log("─".repeat(60));
  console.log("  Deploy completed successfully!");
  console.log("─".repeat(60));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
