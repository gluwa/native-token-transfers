// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import {Script, console2} from "forge-std/Script.sol";

import {SpecialRelayer} from "../src/SpecialRelayer/SpecialRelayer.sol";

/// @notice Updates configuration on an existing SpecialRelayer.
///
/// Required:
///   SPECIAL_RELAYER_ADDRESS - deployed SpecialRelayer contract address
///
/// Optional (at least one for config updates):
///   SPECIAL_RELAYER_EXECUTION_QUOTER - PenguinBridgeExecutionQuoter address
///   SPECIAL_RELAYER_SOURCE_CHAIN_ID  - Wormhole chain id of this chain (required for signed-quote flow)
///
/// Examples:
///   # Point the relayer at a new execution quoter
///   SPECIAL_RELAYER_ADDRESS=0x... SPECIAL_RELAYER_EXECUTION_QUOTER=0x... forge script script/ConfigureSpecialRelayer.s.sol --rpc-url $RPC --broadcast
contract ConfigureSpecialRelayer is Script {
    function run() public {
        address relayerAddr = vm.envAddress("SPECIAL_RELAYER_ADDRESS");
        SpecialRelayer relayer = SpecialRelayer(payable(relayerAddr));

        vm.startBroadcast();

        // Optional: dynamic execution quoter
        try vm.envAddress("SPECIAL_RELAYER_EXECUTION_QUOTER") returns (address executionQuoter) {
            relayer.setExecutionQuoter(executionQuoter);
            console2.log("Execution quoter set to:", executionQuoter);
        } catch {}

        // Optional: source chain id (Wormhole chain id of this chain)
        uint256 srcChainIdUint = vm.envOr("SPECIAL_RELAYER_SOURCE_CHAIN_ID", uint256(0));
        if (srcChainIdUint != 0) {
            require(srcChainIdUint <= type(uint16).max, "Invalid source chain id");
            // forge-lint: disable-next-line(unsafe-typecast)
            uint16 srcChainId = uint16(srcChainIdUint);
            relayer.setSourceChainId(srcChainId);
            console2.log("Source chain id set to:", srcChainId);
        }

        vm.stopBroadcast();
    }
}
