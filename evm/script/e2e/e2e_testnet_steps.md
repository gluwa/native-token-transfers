# NTT E2E: Sepolia → CC3

Run from `native-token-transfers/evm` in **Git Bash** (`$VAR`, `\` continuations).

Scripts validate addresses and chain IDs automatically:

- **Proxy check** — `E2E_*_NTT_MANAGER` / `E2E_*_WORMHOLE_TRANSCEIVER` must be `ERC1967Proxy` (owner ≠ 0).
- **Wormhole core chain** — must match `E2E_*_WORMHOLE_CHAIN_ID` / `RELEASE_WORMHOLE_CHAIN_ID`.
- **VAA emitter chain** — must equal `E2E_SRC_WORMHOLE_CHAIN_ID` (not the wormholescan chain-`2` duplicate).

Always load exports from the helper scripts below — do not copy implementation addresses from forge logs.

---

## 0. One-time setup

```bash
cd /d/User/Ethereum/gluwa/native-token-transfers/evm

export FOUNDRY_PROFILE=prod
export PRIVATE_KEY="0xYOUR_DEPLOYER_KEY"
export SRC_RPC="https://sepolia.infura.io/v3/YOUR_KEY"
export DST_RPC="https://rpc.cc3-testnet.creditcoin.network"

export E2E_QUOTE_SIGNER_PRIVATE_KEY=$PRIVATE_KEY
export E2E_SENDER_PRIVATE_KEY=$PRIVATE_KEY
export E2E_TRANSFER_AMOUNT=5000000000000000000

export RELEASE_CONSISTENCY_LEVEL=200
export RELEASE_GAS_LIMIT=200000
export E2E_DEPLOY_MOCK_TOKEN=true

# Wormhole chain IDs (must stay consistent for all steps)
export E2E_SRC_WORMHOLE_CHAIN_ID=10002   # Sepolia
export E2E_DST_WORMHOLE_CHAIN_ID=59      # CC3
```

### 0b. Plain EOA payee (required if deployer is EIP-7702)

```bash
cast wallet new
export E2E_PAYEE_ADDRESS=0xYourPlainEOAAddress
cast code $E2E_PAYEE_ADDRESS --rpc-url "$SRC_RPC"   # must be 0x
```

---

## 1. Deploy source (Sepolia)

```bash
export RELEASE_WORMHOLE_CHAIN_ID=$E2E_SRC_WORMHOLE_CHAIN_ID
export E2E_DST_WORMHOLE_CHAIN_ID=59
export RELEASE_CORE_BRIDGE_ADDRESS=0x4a8bc80Ed5a4067f1CCf107057b8270E0cC11A78
export RELEASE_WORMHOLE_RELAYER_ADDRESS=0x7B1bD7a6b4E61c2a123AC6BC2cbfC614437D0470

forge script script/e2e/1_DeploySrcContracts.s.sol \
  --rpc-url "$SRC_RPC" \
  --private-key "$PRIVATE_KEY" \
  --broadcast \
  --slow
```

Load **proxy** addresses (required):

Verify proxy ownership:

```bash
cast call $E2E_SRC_NTT_MANAGER "owner()(address)" --rpc-url "$SRC_RPC"
```

---

## 2. Deploy destination (CC3)

```bash
export RELEASE_WORMHOLE_CHAIN_ID=$E2E_DST_WORMHOLE_CHAIN_ID
export RELEASE_CORE_BRIDGE_ADDRESS=0xaBf89de706B583424328B54dD05a8fC986750Da8
export RELEASE_WORMHOLE_RELAYER_ADDRESS=0x0000000000000000000000000000000000000000

forge script script/e2e/2_DeployDstContracts.s.sol \
  --rpc-url "$DST_RPC" \
  --private-key "$PRIVATE_KEY" \
  --broadcast \
  --slow \
  --gas-estimate-multiplier 400
```

---

## 3. Configure peers (both chains)

`RELEASE_WORMHOLE_CHAIN_ID` must match the chain you are configuring. Scripts validate proxy addresses and wormhole core `chainId()`.

### 3a. Sepolia

```bash
export RELEASE_WORMHOLE_CHAIN_ID=$E2E_SRC_WORMHOLE_CHAIN_ID

forge script script/e2e/3_ConfigurePeers.s.sol \
  --rpc-url "$SRC_RPC" \
  --private-key "$PRIVATE_KEY" \
  --broadcast \
  --slow
```

### 3b. CC3

```bash
export RELEASE_WORMHOLE_CHAIN_ID=$E2E_DST_WORMHOLE_CHAIN_ID

forge script script/e2e/3_ConfigurePeers.s.sol \
  --rpc-url "$DST_RPC" \
  --private-key "$PRIVATE_KEY" \
  --broadcast \
  --slow \
  --gas-estimate-multiplier 400
```

After 3b, the script verifies the destination wormhole peer for `E2E_SRC_WORMHOLE_CHAIN_ID`.

Manual check:

```bash
cast call $E2E_DST_WORMHOLE_TRANSCEIVER \
  "getWormholePeer(uint16)(bytes32)" $E2E_SRC_WORMHOLE_CHAIN_ID \
  --rpc-url "$DST_RPC"
# must equal 0x000... + E2E_SRC_WORMHOLE_TRANSCEIVER (without 0x, zero-padded to 32 bytes)
```

---

## 4. Quote + sign (Sepolia, no broadcast)

```bash
# once, if payee was not set at deploy
cast send $E2E_SRC_QUOTER \
  "setPayeeAddress(bytes32)" \
  $(cast --to-uint256 $E2E_PAYEE_ADDRESS) \
  --rpc-url "$SRC_RPC" \
  --private-key "$PRIVATE_KEY"

forge script script/e2e/4_QuoteAndSign.s.sol --rpc-url "$SRC_RPC"
```

Export from output:

```bash
export E2E_REQUIRED_PAYMENT=...
export E2E_SIGNED_QUOTE_BYTES=0x...
```

---

## 4b. Mint mock tokens (Sepolia)

```bash
SENDER=$(cast wallet address --private-key "$PRIVATE_KEY")

cast send "$E2E_SRC_TOKEN" \
  "mintDummy(address,uint256)" \
  "$SENDER" \
  100000000000000000000 \
  --rpc-url "$SRC_RPC" \
  --private-key "$PRIVATE_KEY"
```

---

## 5. Transfer (Sepolia)

```bash
forge script script/e2e/5_Transfer.s.sol \
  --rpc-url "$SRC_RPC" \
  --private-key "$E2E_SENDER_PRIVATE_KEY" \
  --broadcast \
  --slow
```

Copy the **tx hash** from forge output.

---

## 6. receive (CC3)

```bash
export E2E_SIGNED_VAA=0x...  # convert VAA Base64 to hex 

forge script script/e2e/6_ReceiveMessage.s.sol \
  --rpc-url "$DST_RPC" \
  --private-key "$PRIVATE_KEY" \
  --broadcast \
  --slow \
  --gas-estimate-multiplier 400
```

Step 6 re-validates in Solidity:

- VAA `emitterChain` == `E2E_SRC_WORMHOLE_CHAIN_ID`
- VAA emitter == `E2E_SRC_WORMHOLE_TRANSCEIVER`
- Destination `getWormholePeer(E2E_SRC_WORMHOLE_CHAIN_ID)` is configured