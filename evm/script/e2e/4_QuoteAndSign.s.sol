// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import {console2} from "forge-std/Script.sol";

import {
    PenguinBridgeExecutionQuoter
} from "../../src/SpecialRelayer/PenguinBridgeExecutionQuoter.sol";
import "wormhole-solidity-sdk/Utils.sol";

import "./helpers/E2EConfig.sol";

/// @notice Step 4 (source chain): read on-chain fee from PenguinBridgeExecutionQuoter and sign PQ01.
///
/// Mirrors the off-chain quoter-service (`POST /quote`) using the same on-chain price source.
/// No on-chain transactions are broadcast; prints quote env vars for step 5.
///
/// Required env:
///   E2E_QUOTE_SIGNER_PRIVATE_KEY
///
/// Optional env:
///   E2E_PAYEE_ADDRESS
///   E2E_GAS_LIMIT                        — defaults to 200_000
///   E2E_QUOTE_VALIDITY_SECONDS           — defaults to 3600
///
/// Run (no `--broadcast` required):
///   forge script script/e2e/4_QuoteAndSign.s.sol --rpc-url $SRC_RPC
contract QuoteAndSign is Script, E2EConfig {
    function run() public {
        ChainDeployment memory src = readChainDeployment("src");
        ChainDeployment memory dst = readChainDeployment("dst");
        require(src.quoter != address(0), "Source quoter not deployed");

        validateSrcDeployment(src);

        uint256 quoteSignerKey = vm.envUint("E2E_QUOTE_SIGNER_PRIVATE_KEY");
        address quoteSigner = vm.addr(quoteSignerKey);
        address payee = payeeFromEnv();
        uint256 gasLimit = vm.envOr("E2E_GAS_LIMIT", E2E_DEFAULT_GAS_LIMIT);
        uint64 validity = uint64(vm.envOr("E2E_QUOTE_VALIDITY_SECONDS", uint256(3600)));

        bytes32 dstTransceiver = toWormholeFormat(dst.wormholeTransceiver);
        PenguinBridgeExecutionQuoter quoter = PenguinBridgeExecutionQuoter(src.quoter);

        (uint256 requiredPayment,,) = quoter.requestExecutionQuote(
            dst.wormholeChainId,
            dstTransceiver,
            address(0),
            abi.encode(uint256(0)),
            abi.encode(gasLimit)
        );

        bytes memory signedQuote = signExecutionQuote(
            quoteSignerKey,
            quoteSigner,
            payee,
            src.wormholeChainId,
            dst.wormholeChainId,
            requiredPayment,
            gasLimit,
            validity
        );

        logQuoteArtifacts(signedQuote, requiredPayment);

        console2.log("Quoter:", src.quoter);
        console2.log("Signer:", quoteSigner);
        console2.log("Required payment (wei):", requiredPayment);
        console2.log("Signed quote length:", signedQuote.length);
    }
}
