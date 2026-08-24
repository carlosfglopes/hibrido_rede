#!/usr/bin/env python3
"""
Autonomous UAV agent — MissionFail (Model 3: Hybrid FSM + UUPS Proxy).
Runs independently on each RPi. Connects to the local ERC1967 proxy via
web3.py. Same dual FSM as Model 1 (mission-level SETUP->ACTIVE->
UNDER_CONFIRMATION->RECONFIGURING->ACTIVE_RECONFIGURED/DEGRADED->
ABORTED/COMPLETED, UAV-level ACTIVE->SUSPECT->CONFIRMED_FAILED/
BYZANTINE->REMOVED), but the contract address is an upgradeable proxy.
UAV registration is done by the authority (registerUAV is onlyOwner, as
in Model 1) — the agent only reacts: sends heartbeat and votes on
suspects.

Usage:
    UAV_ID=UAV1 PRIVATE_KEY=0x... CONTRACT_ADDRESS=0x... python3 agent_missionfail.py

Environment variables:
    RPC_URL          (default: http://127.0.0.1:8545)
    PRIVATE_KEY      (required)
    CONTRACT_ADDRESS (required — PROXY address)
    UAV_ID           (default: UAV1)
"""

import os
import sys
import time
from web3 import Web3

# Configuration
RPC_URL          = os.getenv("RPC_URL", "http://127.0.0.1:8545")
PRIVATE_KEY      = os.getenv("PRIVATE_KEY")
CONTRACT_ADDRESS = os.getenv("CONTRACT_ADDRESS")
UAV_ID           = os.getenv("UAV_ID", "UAV1")
POLL_INTERVAL      = 2
HEARTBEAT_INTERVAL = 8

# States
MISSION_STATES = {
    0: "SETUP", 1: "ACTIVE", 2: "UNDER_CONFIRMATION",
    3: "RECONFIGURING", 4: "ACTIVE_RECONFIGURED", 5: "DEGRADED", 6: "ABORTED",
    7: "COMPLETED"
}
UAV_STATES = {
    0: "UNREGISTERED", 1: "ACTIVE", 2: "SUSPECT",
    3: "CONFIRMED_FAILED", 4: "CONFIRMED_BYZANTINE", 5: "REMOVED"
}
OPERATIONAL_STATES = {1, 4, 5}
TERMINAL_STATES     = {6, 7}

# ABI
ABI = [
    {"inputs": [], "name": "missionState",
     "outputs": [{"type": "uint8"}], "stateMutability": "view", "type": "function"},
    {"inputs": [{"type": "address"}], "name": "uavs",
     "outputs": [
         {"name": "registered",    "type": "bool"},
         {"name": "state",         "type": "uint8"},
         {"name": "lastHeartbeat", "type": "uint256"},
         {"name": "capacityMax",   "type": "uint256"},
         {"name": "loadCurrent",   "type": "uint256"},
     ], "stateMutability": "view", "type": "function"},
    {"inputs": [], "name": "suspectUav",
     "outputs": [{"type": "address"}], "stateMutability": "view", "type": "function"},
    {"inputs": [{"type": "address"}], "name": "hasVotedOnCurrentIncident",
     "outputs": [{"type": "bool"}], "stateMutability": "view", "type": "function"},
    {"inputs": [], "name": "heartbeat",
     "outputs": [], "stateMutability": "nonpayable", "type": "function"},
    {"inputs": [{"name": "vote", "type": "uint8"}], "name": "voteOnSuspect",
     "outputs": [], "stateMutability": "nonpayable", "type": "function"},
    {"inputs": [], "name": "getMissionSummary",
     "outputs": [
         {"name": "state",       "type": "uint8"},
         {"name": "formation",   "type": "uint8"},
         {"name": "failures",    "type": "uint256"},
         {"name": "activeUAVs",  "type": "uint256"},
         {"name": "activeTasks", "type": "uint256"},
         {"name": "suspect",     "type": "address"},
         {"name": "reason",      "type": "uint8"},
         {"name": "vFailed",     "type": "uint256"},
         {"name": "vByzantine",  "type": "uint256"},
         {"name": "vReject",     "type": "uint256"},
     ], "stateMutability": "view", "type": "function"},
]

# Helpers

def log(msg):
    ts = time.strftime("%H:%M:%S")
    print(f"[{ts}] [{UAV_ID}] {msg}", flush=True)


def send_tx(w3, account, fn):
    tx = fn.build_transaction({
        "from":                 account.address,
        "nonce":                w3.eth.get_transaction_count(account.address),
        "gas":                  300000,
        "maxFeePerGas":         w3.to_wei("10", "gwei"),
        "maxPriorityFeePerGas": w3.to_wei("5", "gwei"),
    })
    signed  = account.sign_transaction(tx)
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
    return w3.eth.wait_for_transaction_receipt(tx_hash)

# Main

def main():
    if not PRIVATE_KEY:
        print("ERROR: set PRIVATE_KEY"); sys.exit(1)
    if not CONTRACT_ADDRESS:
        print("ERROR: set CONTRACT_ADDRESS"); sys.exit(1)

    w3 = Web3(Web3.HTTPProvider(RPC_URL))
    try:
        w3.eth.block_number
    except Exception as e:
        print(f"ERROR: cannot connect to {RPC_URL} ({e})"); sys.exit(1)

    account  = w3.eth.account.from_key(PRIVATE_KEY)
    contract = w3.eth.contract(address=Web3.to_checksum_address(CONTRACT_ADDRESS), abi=ABI)

    log(f"Connected to {RPC_URL} (proxy {CONTRACT_ADDRESS})")
    log(f"Address: {account.address}")

    last_heartbeat = 0

    while True:
        try:
            summary = contract.functions.getMissionSummary().call()
            state       = summary[0]
            failures    = summary[2]
            active_uavs = summary[3]
            suspect     = summary[5]

            state_name = MISSION_STATES.get(state, str(state))
            uav_data   = contract.functions.uavs(account.address).call()
            uav_state  = UAV_STATES.get(uav_data[1], str(uav_data[1]))

            log(f"Mission: {state_name} | UAV: {uav_state} | Failures: {failures} | Active UAVs: {active_uavs}")

            if state in TERMINAL_STATES:
                log(f"Mission {state_name}. Agent terminating.")
                break

            if state in OPERATIONAL_STATES:
                if uav_data[0] and uav_data[1] == 1:
                    now = time.time()
                    if now - last_heartbeat >= HEARTBEAT_INTERVAL:
                        log("Sending heartbeat...")
                        r = send_tx(w3, account, contract.functions.heartbeat())
                        log(f"Heartbeat sent! Block #{r.blockNumber}")
                        last_heartbeat = now
                elif not uav_data[0]:
                    log("Waiting for registration by the authority...")
                else:
                    log(f"UAV state: {uav_state} — no heartbeat")

            elif state == 2:
                if suspect and suspect.lower() != account.address.lower():
                    already_voted = contract.functions.hasVotedOnCurrentIncident(account.address).call()
                    if not already_voted:
                        log(f"Suspect: {suspect[:10]}... Voting CONFIRM_FAILED...")
                        r = send_tx(w3, account, contract.functions.voteOnSuspect(1))
                        log(f"Vote recorded! Block #{r.blockNumber}")
                    else:
                        log(f"Already voted. Votes — Failed:{summary[7]} Byzantine:{summary[8]} Reject:{summary[9]}")
                else:
                    log("I am the suspect — cannot vote")

        except Exception as e:
            log(f"Error: {e}")

        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
