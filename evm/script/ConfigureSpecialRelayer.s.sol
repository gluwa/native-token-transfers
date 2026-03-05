// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import {Script, console2} from "forge-std/Script.sol";

import {SpecialRelayer} from "../src/SpecialRelayer/SpecialRelayer.sol";

/// @notice Updates fee configuration on an existing SpecialRelayer.
///
/// Required:
///   SPECIAL_RELAYER_ADDRESS - deployed SpecialRelayer contract address
///
/// Optional (at least one for config updates):
///   SPECIAL_RELAYER_DEFAULT_FEE - default delivery fee in wei (set to 0 to fall back to default for all chains)
///   SPECIAL_RELAYER_FEE_CHAIN_ID - target chain id for a per-chain fee
///   SPECIAL_RELAYER_FEE - fee in wei for that chain (used with SPECIAL_RELAYER_FEE_CHAIN_ID)
///   SPECIAL_RELAYER_FEE_RECIPIENT - address that receives withdrawn fees (pass 0x0 to use owner)
///
/// For batch per-chain updates, call setDeliveryFees(chainIds, fees) via cast, e.g.:
///   cast send $SPECIAL_RELAYER "setDeliveryFees(uint16[],uint256[])" "[84532,11155111]" "[1000000000000000,2000000000000000]" --rpc-url $RPC --private-key $PK
///
/// Examples:
///   # Set default fee only
///   SPECIAL_RELAYER_ADDRESS=0x... SPECIAL_RELAYER_DEFAULT_FEE=500000000000000 forge script script/ConfigureSpecialRelayer.s.sol --rpc-url $RPC --broadcast
///   # Set one chain's fee
///   SPECIAL_RELAYER_ADDRESS=0x... SPECIAL_RELAYER_FEE_CHAIN_ID=84532 SPECIAL_RELAYER_FEE=1000000000000000 forge script ... --broadcast
contract ConfigureSpecialRelayer is Script {
    function run() public {
        address relayerAddr = vm.envAddress("SPECIAL_RELAYER_ADDRESS");
        SpecialRelayer relayer = SpecialRelayer(payable(relayerAddr));

        vm.startBroadcast();

        // Optional: update default fee
        try vm.envUint("SPECIAL_RELAYER_DEFAULT_FEE") returns (uint256 defaultFee) {
            relayer.setDefaultDeliveryFee(defaultFee);
            console2.log("Default delivery fee set to:", defaultFee);
        } catch {}

        // Optional: single per-chain fee
        uint256 chainIdUint = vm.envOr("SPECIAL_RELAYER_FEE_CHAIN_ID", uint256(0));
        if (chainIdUint != 0) {
            uint16 chainId = uint16(chainIdUint);
            uint256 fee = vm.envUint("SPECIAL_RELAYER_FEE");
            relayer.setDeliveryFee(chainId, fee);
            console2.log("Delivery fee for chain", chainId, "set to:", fee);
        }

        // Optional: fee recipient (withdraw destination)
        try vm.envAddress("SPECIAL_RELAYER_FEE_RECIPIENT") returns (address recipient) {
            relayer.setFeeRecipient(recipient);
            console2.log("Fee recipient set to:", recipient);
        } catch {}

        vm.stopBroadcast();
    }
}
