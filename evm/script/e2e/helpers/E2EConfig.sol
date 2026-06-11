// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import {Script, console2} from "forge-std/Script.sol";

import "../../../src/interfaces/IPenguinBridgeExecutionQuoter.sol";
import "../../../src/interfaces/IWormholeTransceiver.sol";
import "../../../src/interfaces/IWormholeTransceiverState.sol";
import "../../../src/SpecialRelayer/PenguinBridgeExecutionQuoter.sol";
import "../../../src/libraries/TransceiverStructs.sol";
import "../../../src/Transceiver/WormholeTransceiver/WormholeTransceiverState.sol";
import "wormhole-solidity-sdk/Utils.sol";

interface IOwnable {
    function owner() external view returns (address);
}

interface IWormholeCore {
    function chainId() external view returns (uint16);
}

/// @notice Shared constants, env-based deployment state, and quoter-service helpers for e2e scripts.
abstract contract E2EConfig is Script {
    uint64 internal constant E2E_SRC_PRICE = uint64(2_000 * 10 ** 10);
    bytes4 internal constant E2E_SIGNED_QUOTE_PREFIX = 0x50513031;
    uint256 internal constant E2E_DEFAULT_GAS_LIMIT = 200_000;

    struct ChainDeployment {
        uint16 wormholeChainId;
        address token;
        address quoter;
        address specialRelayer;
        address nttManager;
        address wormholeTransceiver;
    }

    struct TransferArtifacts {
        bytes signedQuoteBytes;
        uint256 requiredPayment;
        uint256 deliveryFee;
        bytes32 transferTxHash;
        bytes signedVaa;
    }

    function defaultPricingData()
        internal
        pure
        returns (IPenguinBridgeExecutionQuoter.PricingData memory)
    {
        return IPenguinBridgeExecutionQuoter.PricingData({
            dstPrice: uint64(1_000 * 10 ** 10),
            dstGasPrice: 20 gwei,
            priceBuffer: 1_000,
            baseFee: 0.001 ether
        });
    }

    function pushDefaultQuoterPrice(
        PenguinBridgeExecutionQuoter quoter,
        uint16 dstWormholeChainId
    ) internal {
        quoter.priceUpdate(E2E_SRC_PRICE, dstWormholeChainId, defaultPricingData());
    }

    /// @dev Mirrors quoter-service PQ01 signing for SpecialRelayer.
    function signExecutionQuote(
        uint256 quoterPrivateKey,
        address signer,
        address payee,
        uint16 srcChain,
        uint16 dstChain,
        uint256 requiredPayment,
        uint256 gasLimit,
        uint64 validitySeconds
    ) internal view returns (bytes memory) {
        bytes memory body = abi.encodePacked(
            E2E_SIGNED_QUOTE_PREFIX,
            signer,
            bytes32(uint256(uint160(payee))),
            srcChain,
            dstChain,
            uint64(block.timestamp) + validitySeconds,
            gasLimit,
            requiredPayment
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(quoterPrivateKey, keccak256(body));
        return bytes.concat(body, abi.encodePacked(r, s, v));
    }

    function encodeSpecialRelayInstructions(IWormholeTransceiver transceiver, bytes memory signedQuote)
        internal
        view
        returns (bytes memory encoded, TransceiverStructs.TransceiverInstruction memory instruction)
    {
        IWormholeTransceiver.WormholeTransceiverInstruction memory wormholeInstruction =
            IWormholeTransceiver.WormholeTransceiverInstruction({
                shouldSkipRelayerSend: false, signedQuoteBytes: signedQuote
            });

        instruction = TransceiverStructs.TransceiverInstruction({
            index: 0,
            payload: transceiver.encodeWormholeTransceiverInstruction(wormholeInstruction)
        });

        TransceiverStructs.TransceiverInstruction[] memory instructions =
            new TransceiverStructs.TransceiverInstruction[](1);
        instructions[0] = instruction;
        encoded = TransceiverStructs.encodeTransceiverInstructions(instructions);
    }

    function readChainDeployment(string memory chainKey) internal view returns (ChainDeployment memory dep) {
        if (keccak256(bytes(chainKey)) == keccak256(bytes("src"))) {
            dep.wormholeChainId = uint16(vm.envUint("E2E_SRC_WORMHOLE_CHAIN_ID"));
            dep.token = vm.envAddress("E2E_SRC_TOKEN");
            dep.quoter = vm.envAddress("E2E_SRC_QUOTER");
            dep.specialRelayer = vm.envAddress("E2E_SRC_SPECIAL_RELAYER");
            dep.nttManager = vm.envAddress("E2E_SRC_NTT_MANAGER");
            dep.wormholeTransceiver = vm.envAddress("E2E_SRC_WORMHOLE_TRANSCEIVER");
            return dep;
        }

        dep.wormholeChainId = uint16(vm.envUint("E2E_DST_WORMHOLE_CHAIN_ID"));
        dep.token = vm.envAddress("E2E_DST_TOKEN");
        dep.nttManager = vm.envAddress("E2E_DST_NTT_MANAGER");
        dep.wormholeTransceiver = vm.envAddress("E2E_DST_WORMHOLE_TRANSCEIVER");
    }

    function readTransferArtifacts() internal view returns (TransferArtifacts memory art) {
        string memory quoteHex = vm.envOr("E2E_SIGNED_QUOTE_BYTES", string(""));
        if (bytes(quoteHex).length > 0) {
            art.signedQuoteBytes = vm.parseBytes(quoteHex);
        }
        art.requiredPayment = vm.envOr("E2E_REQUIRED_PAYMENT", uint256(0));
        art.deliveryFee = vm.envOr("E2E_DELIVERY_FEE", uint256(0));

        string memory vaaHex = vm.envOr("E2E_SIGNED_VAA", string(""));
        if (bytes(vaaHex).length > 0) {
            art.signedVaa = vm.parseBytes(vaaHex);
        }
    }

    string private constant SRC_EXPORTS_FILE = "script/e2e/cfg/src_exports.sh";
    string private constant DST_EXPORTS_FILE = "script/e2e/cfg/dst_exports.sh";

    function _exportLine(string memory name, string memory value) private pure {
        console2.log(string.concat("export ", name, "=", value));
    }

    function _formatSrcExports(ChainDeployment memory dep) private view returns (string memory) {
        return string.concat(
            "# Generated by DeploySrcContracts - load with: source script/e2e/cfg/src_exports.sh\n",
            "export E2E_SRC_WORMHOLE_CHAIN_ID=",
            vm.toString(dep.wormholeChainId),
            "\nexport E2E_SRC_TOKEN=",
            vm.toString(dep.token),
            "\nexport E2E_SRC_QUOTER=",
            vm.toString(dep.quoter),
            "\nexport E2E_SRC_SPECIAL_RELAYER=",
            vm.toString(dep.specialRelayer),
            "\nexport E2E_SRC_NTT_MANAGER=",
            vm.toString(dep.nttManager),
            "\nexport E2E_SRC_WORMHOLE_TRANSCEIVER=",
            vm.toString(dep.wormholeTransceiver),
            "\n"
        );
    }

    function _formatDstExports(ChainDeployment memory dep) private view returns (string memory) {
        return string.concat(
            "# Generated by DeployDstContracts - load with: source script/e2e/cfg/dst_exports.sh\n",
            "export E2E_DST_WORMHOLE_CHAIN_ID=",
            vm.toString(dep.wormholeChainId),
            "\nexport E2E_DST_TOKEN=",
            vm.toString(dep.token),
            "\nexport E2E_DST_NTT_MANAGER=",
            vm.toString(dep.nttManager),
            "\nexport E2E_DST_WORMHOLE_TRANSCEIVER=",
            vm.toString(dep.wormholeTransceiver),
            "\n"
        );
    }

    function persistSrcDeployment(ChainDeployment memory dep) internal {
        logSrcDeployment(dep);
        vm.writeFile(SRC_EXPORTS_FILE, _formatSrcExports(dep));
        console2.log("");
        console2.log("Exports saved to script/e2e/cfg/src_exports.sh");
        console2.log("Run: source script/e2e/cfg/src_exports.sh");
    }

    function persistDstDeployment(ChainDeployment memory dep) internal {
        logDstDeployment(dep);
        vm.writeFile(DST_EXPORTS_FILE, _formatDstExports(dep));
        console2.log("");
        console2.log("Exports saved to script/e2e/cfg/dst_exports.sh");
        console2.log("Run: source script/e2e/cfg/dst_exports.sh");
    }

    function logSrcDeployment(ChainDeployment memory dep) internal view {
        console2.log("=== E2E SRC DEPLOYMENT ===");
        console2.log("Token:", dep.token);
        console2.log("Quoter:", dep.quoter);
        console2.log("SpecialRelayer:", dep.specialRelayer);
        console2.log("NttManager:", dep.nttManager);
        console2.log("WormholeTransceiver:", dep.wormholeTransceiver);
        console2.log("");
        console2.log("=== Copy/paste exports (bash) ===");
        _exportLine("E2E_SRC_WORMHOLE_CHAIN_ID", vm.toString(dep.wormholeChainId));
        _exportLine("E2E_SRC_TOKEN", vm.toString(dep.token));
        _exportLine("E2E_SRC_QUOTER", vm.toString(dep.quoter));
        _exportLine("E2E_SRC_SPECIAL_RELAYER", vm.toString(dep.specialRelayer));
        _exportLine("E2E_SRC_NTT_MANAGER", vm.toString(dep.nttManager));
        _exportLine("E2E_SRC_WORMHOLE_TRANSCEIVER", vm.toString(dep.wormholeTransceiver));
    }

    function logDstDeployment(ChainDeployment memory dep) internal view {
        console2.log("=== E2E DST DEPLOYMENT ===");
        console2.log("Wormhole chain id:", dep.wormholeChainId);
        console2.log("Token:", dep.token);
        console2.log("NttManager:", dep.nttManager);
        console2.log("WormholeTransceiver:", dep.wormholeTransceiver);
        console2.log("");
        console2.log("=== Copy/paste exports (bash) ===");
        _exportLine("E2E_DST_WORMHOLE_CHAIN_ID", vm.toString(dep.wormholeChainId));
        _exportLine("E2E_DST_TOKEN", vm.toString(dep.token));
        _exportLine("E2E_DST_NTT_MANAGER", vm.toString(dep.nttManager));
        _exportLine("E2E_DST_WORMHOLE_TRANSCEIVER", vm.toString(dep.wormholeTransceiver));
    }

    function logQuoteArtifacts(bytes memory signedQuoteBytes, uint256 requiredPayment) internal view {
        console2.log("=== E2E QUOTE ===");
        console2.log("Required payment:", requiredPayment);
        console2.log("");
        console2.log("=== Copy/paste exports (bash) ===");
        _exportLine("E2E_REQUIRED_PAYMENT", vm.toString(requiredPayment));
        console2.log("Set E2E_SIGNED_QUOTE_BYTES to the hex below (include 0x prefix):");
        console2.logBytes(signedQuoteBytes);
    }

    function wormholeChainIdFromEnv() internal view returns (uint16) {
        uint256 chainId = vm.envUint("RELEASE_WORMHOLE_CHAIN_ID");
        require(chainId != 0 && chainId <= type(uint16).max, "Invalid RELEASE_WORMHOLE_CHAIN_ID");
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint16(chainId);
    }

    function payeeFromEnv() internal view returns (address) {
        address configured = vm.envOr("E2E_PAYEE_ADDRESS", address(0));
        if (configured != address(0)) {
            return configured;
        }
        return vm.addr(vm.envUint("E2E_QUOTE_SIGNER_PRIVATE_KEY"));
    }

    /// @dev Offset to the VAA body (timestamp) after the signature section.
    function _vaaBodyOffset(bytes memory vaa) private pure returns (uint256 offset) {
        require(vaa.length >= 6, "VAA too short");
        uint256 numSigs = uint256(uint8(vaa[5]));
        offset = 6 + numSigs * 66;
        require(vaa.length >= offset + 10, "VAA body too short");
    }

    /// @dev Parse Wormhole emitter chain id from a signed VAA (big-endian uint16).
    function parseVaaEmitterChainId(bytes memory vaa) internal pure returns (uint16) {
        uint256 offset = _vaaBodyOffset(vaa);
        offset += 8; // timestamp + nonce
        return (uint16(uint8(vaa[offset])) << 8) | uint16(uint8(vaa[offset + 1]));
    }

    /// @dev Parse Wormhole emitter address from a signed VAA (32-byte wormhole format).
    function parseVaaEmitterAddress(bytes memory vaa) internal pure returns (bytes32) {
        uint256 offset = _vaaBodyOffset(vaa);
        offset += 10; // timestamp + nonce + emitterChainId
        bytes32 emitter;
        assembly {
            emitter := mload(add(add(vaa, 32), offset))
        }
        return emitter;
    }

    function assertReleaseChainIdMatches(uint16 expectedChainId) internal view {
        uint16 releaseChainId = wormholeChainIdFromEnv();
        require(releaseChainId == expectedChainId, "RELEASE_WORMHOLE_CHAIN_ID mismatch for this step");
    }

    /// @dev Proxy contracts are ownable; implementation contracts used directly have owner=0.
    function assertOwnableProxy(address contractAddr, string memory label) internal view {
        address owner = IOwnable(contractAddr).owner();
        require(owner != address(0), string.concat(label, " is not a proxy (owner is zero)"));
    }

    function assertWormholeCoreChainId(address wormholeCore, uint16 expectedChainId) internal view {
        uint16 coreChainId = IWormholeCore(wormholeCore).chainId();
        require(
            coreChainId == expectedChainId,
            string.concat(
                "Wormhole core chainId ",
                vm.toString(coreChainId),
                " != configured ",
                vm.toString(expectedChainId)
            )
        );
    }

    function validateSrcDeployment(ChainDeployment memory src) internal view {
        require(src.wormholeChainId != 0, "E2E_SRC_WORMHOLE_CHAIN_ID required");
        require(src.nttManager != address(0), "E2E_SRC_NTT_MANAGER required");
        require(src.wormholeTransceiver != address(0), "E2E_SRC_WORMHOLE_TRANSCEIVER required");

        assertOwnableProxy(src.nttManager, "E2E_SRC_NTT_MANAGER");
        assertOwnableProxy(src.wormholeTransceiver, "E2E_SRC_WORMHOLE_TRANSCEIVER");

        address wormholeCore =
            address(WormholeTransceiverState(src.wormholeTransceiver).wormhole());
        assertWormholeCoreChainId(wormholeCore, src.wormholeChainId);
    }

    function validateDstDeployment(ChainDeployment memory dst) internal view {
        require(dst.wormholeChainId != 0, "E2E_DST_WORMHOLE_CHAIN_ID required");
        require(dst.nttManager != address(0), "E2E_DST_NTT_MANAGER required");
        require(dst.wormholeTransceiver != address(0), "E2E_DST_WORMHOLE_TRANSCEIVER required");

        assertOwnableProxy(dst.nttManager, "E2E_DST_NTT_MANAGER");
        assertOwnableProxy(dst.wormholeTransceiver, "E2E_DST_WORMHOLE_TRANSCEIVER");

        address wormholeCore =
            address(WormholeTransceiverState(dst.wormholeTransceiver).wormhole());
        assertWormholeCoreChainId(wormholeCore, dst.wormholeChainId);
    }

    function validateDstAcceptsSrcVaa(ChainDeployment memory src, ChainDeployment memory dst)
        internal
        view
    {
        bytes32 expectedPeer = toWormholeFormat(src.wormholeTransceiver);
        bytes32 configuredPeer =
            IWormholeTransceiverState(dst.wormholeTransceiver).getWormholePeer(src.wormholeChainId);
        if (configuredPeer == expectedPeer) {
            return;
        }

        console2.log("Expected source transceiver peer:", uint256(expectedPeer));
        console2.log("Configured getWormholePeer for chain", src.wormholeChainId);
        console2.logBytes32(configuredPeer);

        // Common mistake: E2E_SRC_WORMHOLE_CHAIN_ID=2 while peers were set for Sepolia (10002).
        if (src.wormholeChainId == 2) {
            bytes32 sepoliaPeer =
                IWormholeTransceiverState(dst.wormholeTransceiver).getWormholePeer(10002);
            if (sepoliaPeer == expectedPeer) {
                console2.log("Peers are configured for Wormhole chain 10002 (Sepolia), not 2.");
                console2.log("Set E2E_SRC_WORMHOLE_CHAIN_ID=10002 and re-fetch VAA:");
                console2.log("  node script/e2e/fetch_e2e_vaa.cjs <TX_HASH>");
            }
        }

        revert("Destination wormhole peer missing or wrong for E2E_SRC_WORMHOLE_CHAIN_ID");
    }

    /// @dev Reject duplicate wormholescan VAAs whose emitter chain does not match config.
    function assertSignedVaaMatchesSrc(bytes memory signedVaa, ChainDeployment memory src)
        internal
        view
    {
        require(signedVaa.length > 0, "E2E_SIGNED_VAA required");

        uint16 emitterChain = parseVaaEmitterChainId(signedVaa);
        if (emitterChain != src.wormholeChainId) {
            console2.log("VAA emitter chain:", emitterChain);
            console2.log("E2E_SRC_WORMHOLE_CHAIN_ID:", src.wormholeChainId);
            if (emitterChain == 2 && src.wormholeChainId == 10002) {
                console2.log("You have the wormholescan duplicate VAA (chain 2).");
                console2.log("Re-fetch with: node script/e2e/fetch_e2e_vaa.cjs <TX_HASH>");
                console2.log("Then: source script/e2e/cfg/vaa_export.sh");
            }
            revert("VAA emitter chain != E2E_SRC_WORMHOLE_CHAIN_ID");
        }

        bytes32 emitter = parseVaaEmitterAddress(signedVaa);
        require(
            emitter == toWormholeFormat(src.wormholeTransceiver),
            "VAA emitter != E2E_SRC_WORMHOLE_TRANSCEIVER"
        );
    }
}
