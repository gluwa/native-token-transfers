// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import {Script, console2} from "forge-std/Script.sol";

import {SpecialRelayer} from "../src/SpecialRelayer/SpecialRelayer.sol";

/// @notice Deploys the NTT Special Relayer contract.
///
/// Environment (optional):
///   SPECIAL_RELAYER_DEFAULT_FEE - default delivery fee in wei (default: 0)
///   SPECIAL_RELAYER_EXECUTION_QUOTER - PenguinBridgeExecutionQuoter address for dynamic fees (default: unset)
///   SPECIAL_RELAYER_SOURCE_CHAIN_ID - Wormhole chain id of this chain; required for signed-quote flow
///   SPECIAL_RELAYER_FEE_RECIPIENT - address that receives withdrawn fees (default: unset, withdraw goes to owner)
///   SPECIAL_RELAYER_OWNER       - address to transfer ownership to (default: keep deployer)
///
/// After deployment, set RELEASE_SPECIAL_RELAYER_ADDRESS to this contract when deploying
/// or upgrading the Wormhole NTT. Then enable special relaying per chain via
/// transceiver.setIsSpecialRelayingEnabled(chainId, true).
contract DeploySpecialRelayer is Script {
    function run() public {
        vm.startBroadcast();

        SpecialRelayer relayer = new SpecialRelayer();
        console2.log("SpecialRelayer:", address(relayer));

        uint256 defaultFee = vm.envOr("SPECIAL_RELAYER_DEFAULT_FEE", uint256(0));
        if (defaultFee > 0) {
            relayer.setDefaultDeliveryFee(defaultFee);
            console2.log("Default delivery fee set:", defaultFee);
        }

        address executionQuoter = vm.envOr("SPECIAL_RELAYER_EXECUTION_QUOTER", address(0));
        if (executionQuoter != address(0)) {
            relayer.setExecutionQuoter(executionQuoter);
            console2.log("Execution quoter set:", executionQuoter);
        }

        uint256 srcChainIdUint = vm.envOr("SPECIAL_RELAYER_SOURCE_CHAIN_ID", uint256(0));
        if (srcChainIdUint != 0) {
            require(srcChainIdUint <= type(uint16).max, "Invalid source chain id");
            // forge-lint: disable-next-line(unsafe-typecast)
            uint16 srcChainId = uint16(srcChainIdUint);
            relayer.setSourceChainId(srcChainId);
            console2.log("Source chain id set:", srcChainId);
        }

        address feeRecipient = vm.envOr("SPECIAL_RELAYER_FEE_RECIPIENT", address(0));
        if (feeRecipient != address(0)) {
            relayer.setFeeRecipient(feeRecipient);
            console2.log("Fee recipient set:", feeRecipient);
        }

        address newOwner = vm.envOr("SPECIAL_RELAYER_OWNER", address(0));
        if (newOwner != address(0)) {
            relayer.transferOwnership(newOwner);
            console2.log("Ownership transferred to:", newOwner);
        }

        vm.stopBroadcast();
    }
}
