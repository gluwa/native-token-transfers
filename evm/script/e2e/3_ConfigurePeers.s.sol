// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import {console2} from "forge-std/Script.sol";

import {INttManager} from "../../src/interfaces/INttManager.sol";
import {IWormholeTransceiver} from "../../src/interfaces/IWormholeTransceiver.sol";
import {
    WormholeTransceiverState
} from "../../src/Transceiver/WormholeTransceiver/WormholeTransceiverState.sol";
import "wormhole-solidity-sdk/Utils.sol";

import "./helpers/E2EConfig.sol";

/// @notice Step 3: wire NTT + transceiver peers and enable special relaying on the source chain.
///
/// Run **twice** with `--broadcast` — once on the source RPC, once on the destination RPC.
/// `RELEASE_WORMHOLE_CHAIN_ID` must match the chain you are configuring.
///
/// Reads addresses from `E2E_SRC_*` and `E2E_DST_*` env vars (printed by steps 1 and 2).
contract ConfigurePeers is Script, E2EConfig {
    function run() public {
        ChainDeployment memory src = readChainDeployment("src");
        ChainDeployment memory dst = readChainDeployment("dst");
        uint16 thisChain = wormholeChainIdFromEnv();

        require(src.wormholeChainId != 0 && dst.wormholeChainId != 0, "Run deploy scripts first");
        require(
            thisChain == src.wormholeChainId || thisChain == dst.wormholeChainId,
            "Chain id mismatch"
        );

        if (thisChain == src.wormholeChainId) {
            assertReleaseChainIdMatches(src.wormholeChainId);
            validateSrcDeployment(src);
        } else {
            assertReleaseChainIdMatches(dst.wormholeChainId);
            validateDstDeployment(dst);
        }

        vm.startBroadcast();

        if (thisChain == src.wormholeChainId) {
            _configureSource(src, dst);
        } else {
            _configureDestination(src, dst);
        }

        vm.stopBroadcast();
    }

    function _configureSource(
        ChainDeployment memory src,
        ChainDeployment memory dst
    ) internal {
        INttManager manager = INttManager(src.nttManager);
        IWormholeTransceiver transceiver = IWormholeTransceiver(src.wormholeTransceiver);

        manager.setPeer(dst.wormholeChainId, toWormholeFormat(dst.nttManager), 18, type(uint64).max);
        console2.log("Source NttManager peer set for chain", dst.wormholeChainId);

        uint256 messageFee = WormholeTransceiverState(address(transceiver)).wormhole().messageFee();
        transceiver.setWormholePeer{value: messageFee}(
            dst.wormholeChainId, toWormholeFormat(dst.wormholeTransceiver)
        );
        console2.log("Source WormholeTransceiver peer set for chain", dst.wormholeChainId);

        transceiver.setIsWormholeEvmChain(dst.wormholeChainId, true);
        transceiver.setIsSpecialRelayingEnabled(dst.wormholeChainId, true);
        console2.log("Special relaying enabled on source for chain", dst.wormholeChainId);

        manager.setInboundLimit(type(uint64).max, dst.wormholeChainId);
    }

    function _configureDestination(
        ChainDeployment memory src,
        ChainDeployment memory dst
    ) internal {
        INttManager manager = INttManager(dst.nttManager);
        IWormholeTransceiver transceiver = IWormholeTransceiver(dst.wormholeTransceiver);

        manager.setPeer(src.wormholeChainId, toWormholeFormat(src.nttManager), 18, type(uint64).max);
        console2.log("Destination NttManager peer set for chain", src.wormholeChainId);

        uint256 messageFee = WormholeTransceiverState(address(transceiver)).wormhole().messageFee();
        transceiver.setWormholePeer{value: messageFee}(
            src.wormholeChainId, toWormholeFormat(src.wormholeTransceiver)
        );
        console2.log("Destination WormholeTransceiver peer set for chain", src.wormholeChainId);

        transceiver.setIsWormholeEvmChain(src.wormholeChainId, true);

        manager.setInboundLimit(type(uint64).max, src.wormholeChainId);

        validateDstAcceptsSrcVaa(src, dst);
        console2.log("Verified destination wormhole peer for source chain", src.wormholeChainId);
    }
}
