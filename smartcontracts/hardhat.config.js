require("@nomicfoundation/hardhat-ethers");
require("dotenv").config();

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.22",
    settings: {
      viaIR: true,
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },

  networks: {
    hardhat: {
      mining: {
        auto: true,
        interval: 0,
      },
    },

    // Rede Hyperledger Besu — rede-hibrido (Fase 3: Modelo Híbrido FSM + Proxy)
    // hibrido1 expõe a porta 8745 no host
    // gasPrice fixo: evita eth_feeHistory (não suportada pelo Besu IBFT2)
    "rede-hibrido": {
      url: process.env.RPC_URL || "http://127.0.0.1:8745",
      // signers[0] = deployer/authority  (tem ETH no genesis: fe3b557...)
      // signers[1] = UAV1  (0xf39Fd6e...)
      // signers[2] = UAV2  (0x70997970...)
      // signers[3] = UAV3  (0x3C44Cddd...)
      accounts: [
        "0x8f2a55949038a9610f50fb23b5883af3b4ecb3c3bb792cbcefbd1542c692be63", // deployer
        "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // UAV1
        "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", // UAV2
        "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // UAV3
      ],
      chainId: 1341,
      timeout: 60000,
      gas: 4_000_000,
      gasPrice: 1_000_000_000,
    },
  },

  gasReporter: {
    enabled: false,
  },
};

