// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import {console2} from "forge-std/Script.sol";

import {INttManager} from "../../src/interfaces/INttManager.sol";
import {ITransceiver} from "../../src/interfaces/ITransceiver.sol";
import {IWormholeTransceiver} from "../../src/interfaces/IWormholeTransceiver.sol";
import "../../src/libraries/TransceiverStructs.sol";
import {DummyToken} from "../../src/mocks/DummyToken.sol";
import "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import "wormhole-solidity-sdk/Utils.sol";

import "./helpers/E2EConfig.sol";

/// @notice Step 5 (source chain): submit NTT transfer with the signed special-relay quote.
///
/// Run against the **source** RPC with `--broadcast`.
///
/// Required env:
///   E2E_SENDER_PRIVATE_KEY               — account that holds tokens and pays delivery fee
///
/// Optional env:
///   E2E_TRANSFER_AMOUNT                — token amount in wei (defaults to 5e18)
///   E2E_RECIPIENT_ADDRESS                — destination recipient (defaults to sender)
///
/// Requires `E2E_SIGNED_QUOTE_BYTES` from step 4 (or quoter-service).
contract Transfer is Script, E2EConfig {
    function run() public {
        ChainDeployment memory src = readChainDeployment("src");
        ChainDeployment memory dst = readChainDeployment("dst");
        TransferArtifacts memory art = readTransferArtifacts();

        require(art.signedQuoteBytes.length > 0, "Set E2E_SIGNED_QUOTE_BYTES from step 4");
        require(src.nttManager != address(0), "Source NTT not deployed");

        validateSrcDeployment(src);

        uint256 senderKey = vm.envUint("E2E_SENDER_PRIVATE_KEY");
        address sender = vm.addr(senderKey);
        address recipient = vm.envOr("E2E_RECIPIENT_ADDRESS", sender);
        uint256 amount = vm.envOr("E2E_TRANSFER_AMOUNT", uint256(5 ether));

        IWormholeTransceiver transceiver = IWormholeTransceiver(src.wormholeTransceiver);
        (bytes memory instructions, TransceiverStructs.TransceiverInstruction memory quoteInstruction) =
            encodeSpecialRelayInstructions(transceiver, art.signedQuoteBytes);

        uint256 deliveryFee =
            ITransceiver(address(transceiver)).quoteDeliveryPrice(dst.wormholeChainId, quoteInstruction);
        console2.log("Delivery fee (wei):", deliveryFee);

        vm.startBroadcast(senderKey);

        IERC20(src.token).approve(src.nttManager, amount);
        INttManager(src.nttManager).transfer{value: deliveryFee}(
            amount,
            dst.wormholeChainId,
            toWormholeFormat(recipient),
            toWormholeFormat(sender),
            false,
            instructions
        );

        vm.stopBroadcast();

        console2.log("Transfer broadcast complete.");
        console2.log("Next: node script/e2e/fetch_e2e_vaa.cjs <TX_HASH>");
        console2.log("Expected VAA emitter chain (must match E2E_SRC_WORMHOLE_CHAIN_ID):", src.wormholeChainId);
        console2.log("Then run 6_ReceiveMessage with E2E_SIGNED_VAA set.");
    }
}
