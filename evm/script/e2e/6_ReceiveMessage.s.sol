// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import {console2} from "forge-std/Script.sol";

import {IWormholeTransceiver} from "../../src/interfaces/IWormholeTransceiver.sol";

import "./helpers/E2EConfig.sol";

/// @notice Step 6 (destination chain): deliver the transfer via `WormholeTransceiver.receiveMessage`.
///
/// Run against the **destination** RPC with `--broadcast`.
///
/// Required env:
///   E2E_SIGNED_VAA=0x...                    — guardian-signed VAA hex
///   E2E_DST_WORMHOLE_TRANSCEIVER=0x...      — from step 2
///
/// After step 5, set `E2E_SIGNED_VAA` to the guardian-signed VAA whose emitter chain
/// equals `E2E_SRC_WORMHOLE_CHAIN_ID`.
contract ReceiveMessage is Script, E2EConfig {
    function run() public {
        ChainDeployment memory src = readChainDeployment("src");
        ChainDeployment memory dst = readChainDeployment("dst");
        require(dst.wormholeTransceiver != address(0), "Destination transceiver not deployed");

        validateDstDeployment(dst);

        bytes memory signedVaa = _loadSignedVaa();
        assertSignedVaaMatchesSrc(signedVaa, src);
        validateDstAcceptsSrcVaa(src, dst);

        console2.log("VAA emitter chain matches E2E_SRC_WORMHOLE_CHAIN_ID:", src.wormholeChainId);

        vm.startBroadcast();

        IWormholeTransceiver(dst.wormholeTransceiver).receiveMessage(signedVaa);
        console2.log("receiveMessage submitted on", dst.wormholeTransceiver);

        vm.stopBroadcast();
    }

    function _loadSignedVaa() internal view returns (bytes memory) {
        TransferArtifacts memory art = readTransferArtifacts();
        return art.signedVaa;
    }
}
