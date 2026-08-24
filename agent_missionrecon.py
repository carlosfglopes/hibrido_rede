#!/usr/bin/env python3
"""
Autonomous UAV agent — MissionRecon (Model 3: Hybrid FSM + UUPS Proxy).
Runs independently on each RPi. Connects to the local ERC1967 proxy via
web3.py and acts with its own key (msg.sender) — same as Model 1 (same
FSM: IDLE->ACTIVE->ELECTION->ASSIGNED->REPORTING->COMPLETED/FAILED/
TERMINATED), but the contract address is an upgradeable proxy.

Usage:
    UAV_ID=UAV1 PRIVATE_KEY=0x... CONTRACT_ADDRESS=0x... \
    BATTERY=90 SPEED=15 python3 agent_missionrecon.py

Environment variables:
    RPC_URL          (default: http://127.0.0.1:8545)
    PRIVATE_KEY      (required)
    CONTRACT_ADDRESS (required — PROXY address)
    UAV_ID           (default: UAV1)
    BATTERY, SPEED   (used for the election score, default: 80, 10)
    REPORT_RESULT    (1=TARGET_DETECTED, 2=NOTHING_FOUND, 3=INCONCLUSIVE; default: 1)
    POLL_INTERVAL    (seconds, default: 2)
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
BATTERY          = int(os.getenv("BATTERY", "80"))
SPEED            = int(os.getenv("SPEED", "10"))
REPORT_RESULT    = int(os.getenv("REPORT_RESULT", "1"))
POLL_INTERVAL    = int(os.getenv("POLL_INTERVAL", "2"))

# States
STATE_NAMES  = {0: "IDLE", 1: "ACTIVE", 2: "ELECTION", 3: "ASSIGNED",
                4: "REPORTING", 5: "COMPLETED", 6: "FAILED", 7: "TERMINATED"}
TERMINAL_STATES = {5, 6, 7}

# ABI
ABI = [
    {"inputs": [], "name": "missionState",
     "outputs": [{"type": "uint8"}], "stateMutability": "view", "type": "function"},
    {"inputs": [{"type": "address"}], "name": "uavs",
     "outputs": [
         {"name": "permitted",  "type": "bool"},
         {"name": "registered", "type": "bool"},
         {"name": "hasStatus",  "type": "bool"},
         {"name": "ineligible", "type": "bool"},
         {"name": "battery",    "type": "uint256"},
         {"name": "speed",      "type": "uint256"},
         {"name": "score",      "type": "uint256"},
     ], "stateMutability": "view", "type": "function"},
    {"inputs": [], "name": "electedLeader",
     "outputs": [{"type": "address"}], "stateMutability": "view", "type": "function"},
    {"inputs": [], "name": "registerUAV",
     "outputs": [], "stateMutability": "nonpayable", "type": "function"},
    {"inputs": [{"name": "_battery", "type": "uint256"}, {"name": "_speed", "type": "uint256"}],
     "name": "publishStatus", "outputs": [], "stateMutability": "nonpayable", "type": "function"},
    {"inputs": [{"name": "_result", "type": "uint8"}, {"name": "_evidenceHash", "type": "bytes32"}],
     "name": "submitReport", "outputs": [], "stateMutability": "nonpayable", "type": "function"},
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
    log(f"Address: {account.address} | Battery={BATTERY} Speed={SPEED}")

    reported = False

    while True:
        try:
            state = contract.functions.missionState().call()
            state_name = STATE_NAMES.get(state, str(state))

            if state in TERMINAL_STATES:
                log(f"Mission {state_name}. Agent terminating.")
                break

            me = contract.functions.uavs(account.address).call()
            permitted, registered, has_status = me[0], me[1], me[2]

            if state == 0:
                log("Waiting for mission activation by the authority...")

            elif state == 1:
                if not permitted:
                    log("Waiting for permission from the authority (permitUAV)...")
                elif not registered:
                    r = send_tx(w3, account, contract.functions.registerUAV())
                    log(f"registerUAV() sent! Block #{r.blockNumber}")
                elif not has_status:
                    r = send_tx(w3, account, contract.functions.publishStatus(BATTERY, SPEED))
                    log(f"publishStatus({BATTERY},{SPEED}) sent! Block #{r.blockNumber}")
                else:
                    log("Registered and status published — waiting for election...")

            elif state in (2, 4):
                log(f"Mission in {state_name}...")

            elif state == 3:
                leader = contract.functions.electedLeader().call()
                if leader.lower() == account.address.lower() and not reported:
                    log("I was elected leader! Submitting report...")
                    evidence = Web3.keccak(text=f"{UAV_ID}-{time.time()}")
                    r = send_tx(w3, account, contract.functions.submitReport(REPORT_RESULT, evidence))
                    log(f"submitReport({REPORT_RESULT}) sent! Block #{r.blockNumber}")
                    reported = True
                else:
                    log(f"Elected leader: {leader[:10]}... (not me)")

        except Exception as e:
            log(f"Error: {e}")

        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
