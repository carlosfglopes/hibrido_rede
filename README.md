# hibrido_rede — Model 3: Hybrid (FSM + UUPS Proxy)

Part of the MSc dissertation *"Dynamic Smart Contracts for Autonomous Agent Coordination."* This repo implements **Model 3**: the same three mission scenarios (failure response, formation-keeping, reconnaissance leader election) combining an explicit on-chain FSM (as in Model 1) with UUPS upgradeability behind an ERC1967 proxy (as in Model 2), split into V1/V2 pairs.

- Model 1 (fully decentralized FSM): [`fsm_rede`](https://github.com/carlosfglopes/fsm_rede)
- Model 2 (proxy/UUPS upgradeability): [`proxy_rede`](https://github.com/carlosfglopes/proxy_rede)

## Setup

```bash
cd rede_uav && docker compose up -d      # starts the physical Besu (IBFT2) network
cd ../smartcontracts && npm install
export RPC_URL=http://127.0.0.1:8545     # or the network's actual RPC endpoint
export PRIVATE_KEY=0x...                 # authority account
```

## Contracts (`smartcontracts/contracts/`)

| File | What it does |
|---|---|
| `ERC1967ProxyWrapper.sol` | Compile wrapper so Hardhat compiles OpenZeppelin's `ERC1967Proxy`. |
| `MissionFailV1.sol` | Failure detection FSM logic, upgradeable via UUPS. |
| `MissionFailV2.sol` | Adds a mission/reputation score on top of V1. |
| `MissionFormationV1.sol` | Formation keeping FSM logic (centroid distance, violation/recovery voting), upgradeable via UUPS. |
| `MissionFormationV2.sol` | Adds a formation health score on top of V1. |
| `MissionReconV1.sol` | Reconnaissance leader election FSM logic, upgradeable via UUPS. |
| `MissionReconV2.sol` | Adds a scoring/confirmation layer on top of V1's election and report flow. |

## Scripts (`smartcontracts/scripts/`)

| File | What it does | Command |
|---|---|---|
| `deploy_missionfail.js` | Deploys MissionFailV1 + ERC1967 proxy. | `npx hardhat run scripts/deploy_missionfail.js --network rede-hibrido` |
| `deploy_missionformation.js` | Deploys MissionFormationV1 + ERC1967 proxy. | `npx hardhat run scripts/deploy_missionformation.js --network rede-hibrido` |
| `deploy_missionrecon.js` | Deploys MissionReconV1 + ERC1967 proxy. | `npx hardhat run scripts/deploy_missionrecon.js --network rede-hibrido` |
| `fund_uavs.js` | Funds the 4 standard UAV accounts from the authority account. | `npx hardhat run scripts/fund_uavs.js --network rede-hibrido` |
| `upgrade_missionfail.js` | Upgrades the MissionFail proxy V1 → V2. | `npx hardhat run scripts/upgrade_missionfail.js --network rede-hibrido` |
| `upgrade_missionformation.js` | Upgrades the MissionFormation proxy V1 → V2. | `npx hardhat run scripts/upgrade_missionformation.js --network rede-hibrido` |
| `upgrade_missionrecon.js` | Upgrades the MissionRecon proxy V1 → V2. | `npx hardhat run scripts/upgrade_missionrecon.js --network rede-hibrido` |
| `authority_missionfail.js` | Authority run for MissionFail: registers UAVs, starts the mission, triggers an incident, finalizes. | `npx hardhat run scripts/authority_missionfail.js --network rede-hibrido` |
| `authority_missionformation.js` | Authority run for MissionFormation: registers UAVs in a square formation, starts and monitors the mission. | `npx hardhat run scripts/authority_missionformation.js --network rede-hibrido` |
| `authority_missionrecon.js` | Authority run for MissionRecon: permits UAVs, activates the mission, triggers the election. | `npx hardhat run scripts/authority_missionrecon.js --network rede-hibrido` |
| `simulate_missionfail_v1.js` | Full MissionFail simulation against the deployed V1 proxy (normal mission, heartbeat failure, Byzantine behavior, innocent suspect). | `npx hardhat run scripts/simulate_missionfail_v1.js --network rede-hibrido` |
| `simulate_missionfail_v2.js` | Full MissionFail simulation against the deployed V2 proxy (adds mission/reputation scoring). Requires `upgrade_missionfail.js` first. | `npx hardhat run scripts/simulate_missionfail_v2.js --network rede-hibrido` |
| `simulate_missionformation_v1.js` | Full MissionFormation simulation against V1 (normal mission, violation/recovery, formation change, UAV late). | `npx hardhat run scripts/simulate_missionformation_v1.js --network rede-hibrido` |
| `simulate_missionformation_v2.js` | Full MissionFormation simulation against V2 (health scoring). Requires `upgrade_missionformation.js` first. | `npx hardhat run scripts/simulate_missionformation_v2.js --network rede-hibrido` |
| `simulate_missionrecon_v1.js` | Full MissionRecon simulation against V1 (target detected, nothing found, inconclusive, timeout). | `npx hardhat run scripts/simulate_missionrecon_v1.js --network rede-hibrido` |
| `simulate_missionrecon_v2.js` | Full MissionRecon simulation against V2 (adds scoring). Requires `upgrade_missionrecon.js` first. | `npx hardhat run scripts/simulate_missionrecon_v2.js --network rede-hibrido` |
| `reset_missionfail.js` | Resets the MissionFail proxy back to its initial state. | `npx hardhat run scripts/reset_missionfail.js --network rede-hibrido` |
| `reset_missionformation.js` | Resets the MissionFormation proxy back to its initial state. | `npx hardhat run scripts/reset_missionformation.js --network rede-hibrido` |
| `reset_missionrecon.js` | Resets the MissionRecon proxy back to its initial state. | `npx hardhat run scripts/reset_missionrecon.js --network rede-hibrido` |
| `measure_fail_deploy.js` | Disposable V1 deploy of MissionFail, solely to measure real deploy gas cost. | `npx hardhat run scripts/measure_fail_deploy.js --network rede-hibrido` |
| `measure_formation_deploy.js` | Disposable V1 deploy of MissionFormation, solely to measure real deploy gas cost. | `npx hardhat run scripts/measure_formation_deploy.js --network rede-hibrido` |
| `measure_formation_upgrade.js` | Disposable V1 deploy + V2 upgrade of MissionFormation, solely to measure the real cost of the V1→V2 upgrade. | `npx hardhat run scripts/measure_formation_upgrade.js --network rede-hibrido` |
| `measure_recon_deploy.js` | Disposable V1 deploy of MissionRecon, solely to measure real deploy gas cost. | `npx hardhat run scripts/measure_recon_deploy.js --network rede-hibrido` |
| `lib/metrics.js` | Shared gas/latency metrics-collection module (imported, not run directly). | — |

## Agent scripts (Python)

| File | What it does | Command |
|---|---|---|
| `agent_missionfail.py` | Autonomous UAV agent for MissionFail, one instance per Raspberry Pi: heartbeats and votes. | `UAV_ID=UAV1 PRIVATE_KEY=0x... CONTRACT_ADDRESS=0x... python3 agent_missionfail.py` |
| `agent_missionformation.py` | Autonomous UAV agent for MissionFormation: reports its own position, votes on peer violations/recoveries. | `UAV_ID=UAV1 PRIVATE_KEY=0x... CONTRACT_ADDRESS=0x... python3 agent_missionformation.py` |
| `agent_missionrecon.py` | Autonomous UAV agent for MissionRecon: registers, publishes status, submits the report if elected leader. | `UAV_ID=UAV1 PRIVATE_KEY=0x... CONTRACT_ADDRESS=0x... python3 agent_missionrecon.py` |

## Citation

If you use this code, please cite the dissertation this repository accompanies (Carlos Gollwitzer Lopes, *"Dynamic Smart Contracts for Autonomous Agent Coordination,"* Escola Naval).
