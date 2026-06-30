// SPDX-License-Identifier: Apache 2
pragma solidity 0.8.19;

import "forge-std/Test.sol";
import "wormhole-solidity-sdk/testing/helpers/WormholeSimulator.sol";
import "./libraries/IntegrationHelpers.sol";
import "../src/NttManager/NttManagerWethUnwrap.sol";
import "./mocks/MockNttManager.sol";
import "./mocks/MockTransceivers.sol";
import "./mocks/MockWETH9.sol";
import "../src/mocks/DummyToken.sol";
import "openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @notice End-to-end NTT “bridge” suite that includes Wormhole message signing (VAA)
///         and unwrap-to-native on the destination manager.
///
/// What this is testing
/// - A source NTT Manager produces a Wormhole message (via WormholeTransceiver).
/// - A dev guardian (WormholeSimulator) signs that message into an encoded VM (“VAA”).
/// - The destination transceiver delivers the message to the destination manager.
/// - The destination manager unlocks WCTC (WETH-like) and unwraps to native ETH (CTC) for the user.
///
/// How “two chains” are simulated
/// - This file uses a *single* RPC fork, but toggles `vm.chainId(...)` before deploying/calling
///   contracts to emulate two EVM chains in one test process (same approach as IntegrationManual).
/// - Wormhole Core’s emitter chain id is *not* `block.chainid`; it is baked into the deployed
///   Wormhole Core contract on the fork. That’s why `chainIdBridged` must match the fork’s real
///   Wormhole chain id for published messages to pass peer checks.
///
/// Important limitation
/// - The happy-path delivery uses `receiveWormholeMessages(...)` (the relayer delivery entrypoint).
///   That entrypoint assumes the relayer already verified the VAA on-chain. We still generate/sign
///   the VM to get the exact payload + hash used for replay protection, but we do not exercise
///   Wormhole Core verification here.
/// - See `test_unwrap_endToEnd_bridgeWithVaa_receiveMessage()` for the manual-delivery path that
///   submits the encoded VM to `receiveMessage(vmBytes)` (which performs Wormhole Core VAA verification).
contract IntegrationUnwrap is IntegrationHelpers, IRateLimiterEvents {
    using TrimmedAmountLib for uint256;
    using TrimmedAmountLib for TrimmedAmount;

    // IMPORTANT: On a single fork, Wormhole Core's `emitterChainId` is the *real* Wormhole chain id
    // of the forked network. For BSC testnet (this file's fork), that is 4.
    // So the *source* side must use chain id 4 for NTT peers, and the destination must be the "other" id.
    uint16 constant chainIdBridged = 4; // source (matches Wormhole Core chainId on the fork)
    uint16 constant chainIdWctc = 5; // destination (simulated other chain)
    uint8 constant FAST_CONSISTENCY_LEVEL = 200;
    uint256 constant GAS_LIMIT = 500000;

    uint256 constant DEVNET_GUARDIAN_PK =
        0xcfb12303a19cde580bb4dd771639b0d26bc68353645571a8cff516ab2ee113a0;
    WormholeSimulator guardian;
    IWormhole wormhole = IWormhole(0x68605AD7b15c732a30b1BbC62BE8F2A509D74b4D);

    // Managers / tokens
    NttManagerWethUnwrap wctcManager;
    MockNttManagerContract bridgedManager;
    MockWETH9 weth;
    DummyTokenMintAndBurn bridgedToken;

    address relayer = address(0x80aC94316391752A193C1c47E27D382b507c93F3);
    address userSender = address(0xAA01);
    address userRecipient = address(0xBB02);

    function setUp() public {
        // Single fork; emulate two chains by switching vm.chainId.
        // We fork BSC testnet purely because Wormhole Core is deployed there at a known address.
        string memory url = "https://bsc-testnet-rpc.publicnode.com";
        vm.createSelectFork(url);

        // Override the fork’s guardian set to a 1-of-1 dev key so we can sign messages in tests.
        guardian = new WormholeSimulator(address(wormhole), DEVNET_GUARDIAN_PK);

        // Destination side (WCTC): LOCKING manager that *unwraps* WCTC (WETH-like) on redemption.
        // This matches the “burn bridged token -> unlock WCTC -> withdraw -> pay native” flow.
        vm.chainId(chainIdWctc);
        weth = new MockWETH9();
        {
            NttManagerWethUnwrap impl = new NttManagerWethUnwrap(
                address(weth), IManagerBase.Mode.LOCKING, chainIdWctc, 1 days, false
            );
            wctcManager =
                NttManagerWethUnwrap(payable(address(new ERC1967Proxy(address(impl), ""))));
            wctcManager.initialize();

            wormholeTransceiverChain1 = MockWormholeTransceiverContract(
                address(
                    new ERC1967Proxy(
                        address(
                            new MockWormholeTransceiverContract(
                                address(wctcManager),
                                address(wormhole),
                                relayer,
                                address(0),
                                FAST_CONSISTENCY_LEVEL,
                                GAS_LIMIT
                            )
                        ),
                        ""
                    )
                )
            );
            wormholeTransceiverChain1.initialize();

            // Register the transceiver with the manager and set permissive limits for tests.
            wctcManager.setTransceiver(address(wormholeTransceiverChain1));
            wctcManager.setOutboundLimit(
                packTrimmedAmount(type(uint64).max, 8).untrim(weth.decimals())
            );
            wctcManager.setInboundLimit(
                packTrimmedAmount(type(uint64).max, 8).untrim(weth.decimals()), chainIdBridged
            );
        }

        // Source side (Bridged token): BURNING manager with a mint/burn token to simulate a
        // “bridged representation” (e.g. Bridged-WCTC). Outbound burns, inbound mints.
        vm.chainId(chainIdBridged);
        bridgedToken = new DummyTokenMintAndBurn();
        {
            MockNttManagerContract impl = new MockNttManagerContract(
                address(bridgedToken), IManagerBase.Mode.BURNING, chainIdBridged, 1 days, false
            );
            bridgedManager = MockNttManagerContract(address(new ERC1967Proxy(address(impl), "")));
            bridgedManager.initialize();

            wormholeTransceiverChain2 = MockWormholeTransceiverContract(
                address(
                    new ERC1967Proxy(
                        address(
                            new MockWormholeTransceiverContract(
                                address(bridgedManager),
                                address(wormhole),
                                relayer,
                                address(0),
                                FAST_CONSISTENCY_LEVEL,
                                GAS_LIMIT
                            )
                        ),
                        ""
                    )
                )
            );
            wormholeTransceiverChain2.initialize();

            // Register the transceiver with the manager and set permissive limits for tests.
            bridgedManager.setTransceiver(address(wormholeTransceiverChain2));
            bridgedManager.setOutboundLimit(
                packTrimmedAmount(type(uint64).max, 8).untrim(bridgedToken.decimals())
            );
            bridgedManager.setInboundLimit(
                packTrimmedAmount(type(uint64).max, 8).untrim(bridgedToken.decimals()), chainIdWctc
            );
        }

        // Register manager peers (NTT layer).
        // - Destination (WCTC) must accept messages from the bridged manager on chainIdBridged.
        // - Source (Bridged) must accept messages from the WCTC manager on chainIdWctc.
        vm.chainId(chainIdWctc);
        wctcManager.setPeer(
            chainIdBridged,
            toWormholeFormat(address(bridgedManager)),
            bridgedToken.decimals(),
            type(uint64).max
        );
        vm.chainId(chainIdBridged);
        bridgedManager.setPeer(
            chainIdWctc, toWormholeFormat(address(wctcManager)), weth.decimals(), type(uint64).max
        );

        // Register transceiver peers (Wormhole layer).
        // This is required for receive-side validation: the destination transceiver checks that
        // `sourceChain` maps to an expected peer transceiver address.
        _setTransceiverPeers(
            [wormholeTransceiverChain1, wormholeTransceiverChain2],
            [wormholeTransceiverChain2, wormholeTransceiverChain1],
            [chainIdBridged, chainIdWctc]
        );
    }

    /// @notice Full bridge: bridged (burn) -> WCTC (unlock+unwrap) with guardian-signed VAA.
    function test_unwrap_endToEnd_bridgeWithVaa() public {
        // Prefund the destination manager with WCTC inventory (WETH-like).
        // In LOCKING mode, redemption “unlocks” from the manager’s balance; then this impl unwraps.
        vm.chainId(chainIdWctc);
        uint256 amount = 1 ether;
        vm.deal(address(this), amount);
        weth.deposit{value: amount}();
        weth.transfer(address(wctcManager), amount);

        // Initiate the transfer on the source chain:
        // - User mints bridged tokens, approves the manager, and pays the transceiver delivery quote.
        // - Transceiver emits `LogMessagePublished` via Wormhole Core.
        vm.recordLogs();
        vm.chainId(chainIdBridged);
        _prepareTransfer(bridgedToken, userSender, address(bridgedManager), amount);
        vm.deal(userSender, 1 ether);
        WormholeTransceiver[] memory transceivers = new WormholeTransceiver[](1);
        transceivers[0] = wormholeTransceiverChain2;
        transferToken(
            userRecipient, userSender, bridgedManager, amount, chainIdWctc, transceivers, false
        );

        // Capture and sign the emitted Wormhole message into an encoded VM (“VAA”).
        // NOTE: This uses a dev guardian key via WormholeSimulator.
        vm.chainId(chainIdWctc);
        bytes[] memory encodedVMs =
            _getWormholeMessage(guardian, vm.getRecordedLogs(), chainIdBridged);
        IWormhole.VM memory vaa = wormhole.parseVM(encodedVMs[0]);

        uint256 recipientEthBefore = userRecipient.balance;
        uint256 managerWethBefore = weth.balanceOf(address(wctcManager));

        // Deliver to the destination transceiver *as the relayer*.
        // This hits `receiveWormholeMessages(...)`, which uses `vaa.hash` as replay protection.
        bytes[] memory a;
        vm.startPrank(relayer);
        wormholeTransceiverChain1.receiveWormholeMessages(
            vaa.payload,
            a,
            toWormholeFormat(address(wormholeTransceiverChain2)),
            vaa.emitterChainId,
            vaa.hash
        );
        vm.stopPrank();

        // Assertions:
        // - user receives native ETH (unwrapped)
        // - manager WETH decreases
        // - user does NOT receive WETH
        // - manager does not retain ETH after forwarding
        assertEq(
            userRecipient.balance, recipientEthBefore + amount, "recipient native not received"
        );
        assertEq(
            weth.balanceOf(address(wctcManager)),
            managerWethBefore - amount,
            "manager WETH not debited"
        );
        assertEq(weth.balanceOf(userRecipient), 0, "recipient should not get WETH");
        assertEq(address(wctcManager).balance, 0, "manager should not retain ETH");

        // Replay should fail (deliveryHash already consumed by the transceiver).
        vm.startPrank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(IWormholeTransceiver.TransferAlreadyCompleted.selector, vaa.hash)
        );
        wormholeTransceiverChain1.receiveWormholeMessages(
            vaa.payload,
            a,
            toWormholeFormat(address(wormholeTransceiverChain2)),
            vaa.emitterChainId,
            vaa.hash
        );
        vm.stopPrank();
    }

    /// @notice Same as `test_unwrap_endToEnd_bridgeWithVaa`, but exercises Wormhole Core verification
    ///         by submitting the signed VAA via `receiveMessage(encodedVm)`.
    function test_unwrap_endToEnd_bridgeWithVaa_receiveMessage() public {
        // Prefund the destination manager with WCTC inventory (WETH-like).
        vm.chainId(chainIdWctc);
        uint256 amount = 1 ether;
        vm.deal(address(this), amount);
        weth.deposit{value: amount}();
        weth.transfer(address(wctcManager), amount);

        // Initiate the transfer on the source chain, but skip the relayer send so that the source
        // transceiver publishes a Wormhole message directly (manual delivery path).
        vm.recordLogs();
        vm.chainId(chainIdBridged);
        _prepareTransfer(bridgedToken, userSender, address(bridgedManager), amount);
        vm.deal(userSender, 1 ether);
        WormholeTransceiver[] memory transceivers = new WormholeTransceiver[](1);
        transceivers[0] = wormholeTransceiverChain2;
        transferToken(
            userRecipient, userSender, bridgedManager, amount, chainIdWctc, transceivers, true
        );

        // Capture and sign the emitted Wormhole message into an encoded VM (“VAA”).
        vm.chainId(chainIdWctc);
        bytes[] memory encodedVMs =
            _getWormholeMessage(guardian, vm.getRecordedLogs(), chainIdBridged);
        IWormhole.VM memory vaa = wormhole.parseVM(encodedVMs[0]);

        uint256 recipientEthBefore = userRecipient.balance;
        uint256 managerWethBefore = weth.balanceOf(address(wctcManager));

        // Deliver to the destination transceiver via the manual entrypoint. This verifies the VAA
        // on-chain via Wormhole Core (`parseAndVerifyVM`) and then routes the payload to the manager.
        wormholeTransceiverChain1.receiveMessage(encodedVMs[0]);

        // Assertions (same as relayer path):
        assertEq(
            userRecipient.balance, recipientEthBefore + amount, "recipient native not received"
        );
        assertEq(
            weth.balanceOf(address(wctcManager)),
            managerWethBefore - amount,
            "manager WETH not debited"
        );
        assertEq(weth.balanceOf(userRecipient), 0, "recipient should not get WETH");
        assertEq(address(wctcManager).balance, 0, "manager should not retain ETH");

        // Replay should fail (VAA hash already consumed by the transceiver).
        vm.expectRevert(
            abi.encodeWithSelector(IWormholeTransceiver.TransferAlreadyCompleted.selector, vaa.hash)
        );
        wormholeTransceiverChain1.receiveMessage(encodedVMs[0]);
    }

    /// @notice Unwrap fails if manager lacks WETH inventory.
    function test_unwrap_revertsWithoutInventory() public {
        // Same as happy path, but we *do not* prefund WCTC inventory on the destination manager.
        // The redemption will revert when the unwrap manager attempts to withdraw/unlock.
        vm.recordLogs();
        vm.chainId(chainIdBridged);
        uint256 amount = 1 ether;
        _prepareTransfer(bridgedToken, userSender, address(bridgedManager), amount);
        vm.deal(userSender, 1 ether);
        WormholeTransceiver[] memory transceivers = new WormholeTransceiver[](1);
        transceivers[0] = wormholeTransceiverChain2;
        transferToken(
            userRecipient, userSender, bridgedManager, amount, chainIdWctc, transceivers, false
        );

        vm.chainId(chainIdWctc);
        bytes[] memory encodedVMs =
            _getWormholeMessage(guardian, vm.getRecordedLogs(), chainIdBridged);
        IWormhole.VM memory vaa = wormhole.parseVM(encodedVMs[0]);

        bytes[] memory a;
        vm.startPrank(relayer);
        vm.expectRevert(); // MockWETH withdraw/transfer will revert due to zero balance
        wormholeTransceiverChain1.receiveWormholeMessages(
            vaa.payload,
            a,
            toWormholeFormat(address(wormholeTransceiverChain2)),
            vaa.emitterChainId,
            vaa.hash
        );
        vm.stopPrank();
    }

    /// @notice Recipient revert bubbles up and aborts unwrap.
    function test_unwrap_recipientRejectsEth() public {
        // Prefund destination inventory so we isolate the failure to the ETH send to recipient.
        // Prefund manager with WETH
        vm.chainId(chainIdWctc);
        uint256 amount = 0.5 ether;
        vm.deal(address(this), amount);
        weth.deposit{value: amount}();
        weth.transfer(address(wctcManager), amount);

        // Build message targeting a reverting recipient
        vm.recordLogs();
        vm.chainId(chainIdBridged);
        RevertingReceiver recipient = new RevertingReceiver();
        _prepareTransfer(bridgedToken, userSender, address(bridgedManager), amount);
        vm.deal(userSender, 1 ether);
        WormholeTransceiver[] memory transceivers = new WormholeTransceiver[](1);
        transceivers[0] = wormholeTransceiverChain2;
        transferToken(
            address(recipient), userSender, bridgedManager, amount, chainIdWctc, transceivers, false
        );

        vm.chainId(chainIdWctc);
        bytes[] memory encodedVMs =
            _getWormholeMessage(guardian, vm.getRecordedLogs(), chainIdBridged);
        IWormhole.VM memory vaa = wormhole.parseVM(encodedVMs[0]);

        bytes[] memory a;
        vm.startPrank(relayer);
        // NttManagerWethUnwrap uses a low-level call to forward ETH and reverts on failure.
        vm.expectRevert("Failed to transfer to recipient");
        wormholeTransceiverChain1.receiveWormholeMessages(
            vaa.payload,
            a,
            toWormholeFormat(address(wormholeTransceiverChain2)),
            vaa.emitterChainId,
            vaa.hash
        );
        vm.stopPrank();
    }
}

/// @dev Minimal recipient that rejects native ETH, for unwrap failure path.
contract RevertingReceiver {
    receive() external payable {
        revert("reject");
    }
}

