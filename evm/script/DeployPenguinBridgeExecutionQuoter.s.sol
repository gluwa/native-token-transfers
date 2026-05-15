// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import {Script, console2} from "forge-std/Script.sol";

import {PenguinBridgeExecutionQuoter} from "../src/SpecialRelayer/PenguinBridgeExecutionQuoter.sol";

/// @notice Deploys the Penguin Bridge execution quoter used by SpecialRelayer.
///
/// Environment (optional):
///   EXECUTION_QUOTER_ORACLE_SERVICE - address allowed to push price updates
///   EXECUTION_QUOTER_PAYEE_ADDRESS - universal bytes32 address that receives fees
///   EXECUTION_QUOTER_SIGNER - initial authorized quoter signer
///   EXECUTION_QUOTER_OWNER - address to transfer ownership to (default: keep deployer)
contract DeployPenguinBridgeExecutionQuoter is Script {
    function run() public {
        vm.startBroadcast();

        PenguinBridgeExecutionQuoter quoter = new PenguinBridgeExecutionQuoter();
        console2.log("PenguinBridgeExecutionQuoter:", address(quoter));

        address oracleService = vm.envOr("EXECUTION_QUOTER_ORACLE_SERVICE", address(0));
        if (oracleService != address(0)) {
            quoter.setOracleService(oracleService);
            console2.log("Oracle service set:", oracleService);
        }

        bytes32 payeeAddress = vm.envOr("EXECUTION_QUOTER_PAYEE_ADDRESS", bytes32(0));
        if (payeeAddress != bytes32(0)) {
            quoter.setPayeeAddress(payeeAddress);
            console2.logBytes32(payeeAddress);
        }

        address signer = vm.envOr("EXECUTION_QUOTER_SIGNER", address(0));
        if (signer != address(0)) {
            quoter.addQuoter(signer);
            console2.log("Authorized quoter set:", signer);
        }

        address newOwner = vm.envOr("EXECUTION_QUOTER_OWNER", address(0));
        if (newOwner != address(0)) {
            quoter.transferOwnership(newOwner);
            console2.log("Ownership transfer started to:", newOwner);
        }

        vm.stopBroadcast();
    }
}
