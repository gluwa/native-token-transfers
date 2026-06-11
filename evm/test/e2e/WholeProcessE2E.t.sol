// SPDX-License-Identifier: Apache 2
pragma solidity 0.8.19;

import "forge-std/Test.sol";

import "../../src/interfaces/IPenguinBridgeExecutionQuoter.sol";
import "../../src/interfaces/IWormholeTransceiver.sol";
import "../../src/interfaces/INttManager.sol";
import "../../src/interfaces/IManagerBase.sol";
import "../../src/SpecialRelayer/PenguinBridgeExecutionQuoter.sol";
import "../../src/SpecialRelayer/SpecialRelayer.sol";
import "../../src/NttManager/NttManager.sol";
import "../../src/Transceiver/WormholeTransceiver/WormholeTransceiver.sol";
import "../../src/libraries/TransceiverStructs.sol";
import "../../src/mocks/DummyToken.sol";
import "../mocks/MockNttManager.sol";
import "../mocks/MockTransceivers.sol";

import "openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "wormhole-solidity-sdk/interfaces/IWormhole.sol";
import "wormhole-solidity-sdk/testing/helpers/WormholeSimulator.sol";
import "wormhole-solidity-sdk/Utils.sol";

/// @notice End-to-end: PenguinBridgeExecutionQuoter → quoter-service signing → SpecialRelayer → receiveMessage.
contract WholeProcessE2ETest is Test {
    PenguinBridgeExecutionQuoter quoter;
    SpecialRelayer specialRelayer;
    WormholeSimulator guardian;

    NttManager nttManagerChain1;
    NttManager nttManagerChain2;
    WormholeTransceiver wormholeTransceiverChain1;
    WormholeTransceiver wormholeTransceiverChain2;

    IWormhole wormhole = IWormhole(0x68605AD7b15c732a30b1BbC62BE8F2A509D74b4D);

    uint16 constant CHAIN_ID_1 = 4;
    uint16 constant CHAIN_ID_2 = 5;
    uint64 constant SRC_PRICE = uint64(2_000 * 10 ** 10);
    uint8 constant FAST_CONSISTENCY_LEVEL = 200;
    uint256 constant GAS_LIMIT = 200_000;
    uint256 constant QUOTER_PRIVATE_KEY = 0xA11CE;
    bytes4 constant SIGNED_QUOTE_PREFIX = 0x50513031;

    uint256 constant DEVNET_GUARDIAN_PK =
        0xcfb12303a19cde580bb4dd771639b0d26bc68353645571a8cff516ab2ee113a0;

    address payee = address(0xCAFE);
    address userA = address(0x123);
    address userB = address(0x456);
    address wormholeRelayerAddr = address(0x80aC94316391752A193C1c47E27D382b507c93F3);

    event ReceivedMessage(bytes32 hash, uint16 emitterChainId, bytes32 emitterAddress, uint64 sequence);

    function setUp() public {
        vm.createSelectFork("https://bsc-testnet-rpc.publicnode.com");
        guardian = new WormholeSimulator(address(wormhole), DEVNET_GUARDIAN_PK);

        quoter = new PenguinBridgeExecutionQuoter();
        quoter.setOracleService(address(this));
        quoter.setPayeeAddress(bytes32(uint256(uint160(payee))));
        IPenguinBridgeExecutionQuoter.PricingData memory defaultPrice = IPenguinBridgeExecutionQuoter.PricingData({
            dstPrice: uint64(1_000 * 10 ** 10),
            dstGasPrice: 20 gwei,
            priceBuffer: 1_000, // 10%
            baseFee: 0.001 ether
        });
        quoter.priceUpdate(SRC_PRICE, CHAIN_ID_2, defaultPrice);

        quoter.addQuoter(vm.addr(QUOTER_PRIVATE_KEY));

        specialRelayer = new SpecialRelayer();
        specialRelayer.setSourceChainId(CHAIN_ID_1);
        specialRelayer.setExecutionQuoter(address(quoter));

        _deployChain1Stack();
        _deployChain2Stack();
        _wirePeers();
    }

    function test_e2e_quoterServiceSpecialRelayerReceiveMessage() public {
        vm.chainId(CHAIN_ID_1);

        DummyToken token1 = DummyToken(nttManagerChain1.token());
        DummyToken token2 = DummyTokenMintAndBurn(nttManagerChain2.token());

        uint256 sendingAmount = 5 * 10 ** token1.decimals();
        token1.mintDummy(userA, sendingAmount);

        bytes32 dstTransceiver = toWormholeFormat(address(wormholeTransceiverChain2));
        (bytes memory signedQuote, uint256 requiredPayment) =
            _simulateQuoterService(CHAIN_ID_2, dstTransceiver, 0, GAS_LIMIT);

        (bytes memory instructions, TransceiverStructs.TransceiverInstruction memory quoteInstruction) =
            _encodeSpecialRelayInstructions(signedQuote);
        uint256 deliveryFee =
            wormholeTransceiverChain1.quoteDeliveryPrice(CHAIN_ID_2, quoteInstruction);

        assertEq(
            requiredPayment,
            quoter.requestQuote(
                CHAIN_ID_2, dstTransceiver, address(0), abi.encode(uint256(0)), abi.encode(GAS_LIMIT)
            ),
            "signed payment must match on-chain quote"
        );

        vm.deal(userA, deliveryFee);
        uint256 payeeBalanceBefore = payee.balance;

        vm.startPrank(userA);
        token1.approve(address(nttManagerChain1), sendingAmount);
        vm.recordLogs();
        nttManagerChain1.transfer{value: deliveryFee}(
            sendingAmount,
            CHAIN_ID_2,
            toWormholeFormat(userB),
            toWormholeFormat(userA),
            false,
            instructions
        );
        vm.stopPrank();

        assertEq(payee.balance, payeeBalanceBefore + requiredPayment, "payee receives quoted execution fee");

        Vm.Log[] memory wormholeLogs = guardian.fetchWormholeMessageFromLog(vm.getRecordedLogs());
        assertEq(wormholeLogs.length, 1, "transfer should publish one wormhole message");

        bytes memory encodedVm = guardian.fetchSignedMessageFromLogs(wormholeLogs[0], CHAIN_ID_1);

        vm.chainId(CHAIN_ID_2);
        uint256 supplyBefore = token2.totalSupply();

        vm.expectEmit(false, false, false, false);
        emit ReceivedMessage(bytes32(0), CHAIN_ID_1, bytes32(0), 0);
        wormholeTransceiverChain2.receiveMessage(encodedVm);

        assertEq(token2.totalSupply(), supplyBefore + sendingAmount, "destination supply increases");
        assertEq(token2.balanceOf(userB), sendingAmount, "recipient receives minted tokens");
        assertEq(token1.balanceOf(address(nttManagerChain1)), sendingAmount, "source manager locks tokens");
    }

    function test_e2e_quoterServiceSignedQuoteAcceptedBySpecialRelayer() public {
        bytes32 dstTransceiver = toWormholeFormat(address(wormholeTransceiverChain2));
        (bytes memory signedQuote, uint256 requiredPayment) =
            _simulateQuoterService(CHAIN_ID_2, dstTransceiver, 0, GAS_LIMIT);

        bytes memory requestBytes = hex"deadbeef";
        bytes memory relayInstructions = abi.encode(GAS_LIMIT);
        uint256 payeeBalanceBefore = payee.balance;

        vm.deal(address(this), requiredPayment);
        specialRelayer.requestExecution{value: requiredPayment}(
            CHAIN_ID_2, dstTransceiver, address(0), signedQuote, requestBytes, relayInstructions
        );

        assertEq(payee.balance, payeeBalanceBefore + requiredPayment);
        assertEq(address(specialRelayer).balance, 0);
    }

    /// @dev Mirrors quoter-service PQ01 signing; body layout matches SpecialRelayer._parseSignedQuote.
    function _signQuote(
        address signer,
        address payeeAddr,
        uint16 srcChain,
        uint16 dstChain,
        uint256 requiredPayment,
        uint256 gasLimit,
        uint64 expiresIn
    ) internal view returns (bytes memory) {
        bytes memory body = abi.encodePacked(
            SIGNED_QUOTE_PREFIX,
            signer,
            bytes32(uint256(uint160(payeeAddr))),
            srcChain,
            dstChain,
            uint64(block.timestamp) + expiresIn,
            gasLimit,
            requiredPayment
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(QUOTER_PRIVATE_KEY, keccak256(body));
        return bytes.concat(body, abi.encodePacked(r, s, v));
    }

    /// @dev read on-chain price, then sign PQ01 for SpecialRelayer.
    function _simulateQuoterService(uint16 dstChain, bytes32 dstAddr, uint256 msgValue, uint256 gasLimit)
        internal
        returns (bytes memory signedQuote, uint256 requiredPayment)
    {
        (requiredPayment,,) = quoter.requestExecutionQuote(
            dstChain, dstAddr, address(0), abi.encode(msgValue), abi.encode(gasLimit)
        );

        signedQuote = _signQuote(
            vm.addr(QUOTER_PRIVATE_KEY), payee, CHAIN_ID_1, dstChain, requiredPayment, gasLimit, 1 hours
        );
    }

    function _deployChain1Stack() internal {
        vm.chainId(CHAIN_ID_1);

        DummyToken token1 = new DummyToken();
        NttManager implementation = new MockNttManagerContract(
            address(token1), IManagerBase.Mode.LOCKING, CHAIN_ID_1, 1 days, false
        );
        nttManagerChain1 =
            MockNttManagerContract(address(new ERC1967Proxy(address(implementation), "")));
        nttManagerChain1.initialize();

        WormholeTransceiver implementationTransceiver = new MockWormholeTransceiverContract(
            address(nttManagerChain1),
            address(wormhole),
            wormholeRelayerAddr,
            address(specialRelayer),
            FAST_CONSISTENCY_LEVEL,
            GAS_LIMIT
        );
        wormholeTransceiverChain1 = WormholeTransceiver(
            address(new ERC1967Proxy(address(implementationTransceiver), ""))
        );
        wormholeTransceiverChain1.initialize();

        nttManagerChain1.setTransceiver(address(wormholeTransceiverChain1));
        nttManagerChain1.setOutboundLimit(type(uint64).max);
        nttManagerChain1.setInboundLimit(type(uint64).max, CHAIN_ID_2);
        nttManagerChain1.setThreshold(1);
    }

    function _deployChain2Stack() internal {
        vm.chainId(CHAIN_ID_2);

        DummyToken token2 = new DummyTokenMintAndBurn();
        NttManager implementation = new MockNttManagerContract(
            address(token2), IManagerBase.Mode.BURNING, CHAIN_ID_2, 1 days, false
        );
        nttManagerChain2 =
            MockNttManagerContract(address(new ERC1967Proxy(address(implementation), "")));
        nttManagerChain2.initialize();

        WormholeTransceiver implementationTransceiver = new MockWormholeTransceiverContract(
            address(nttManagerChain2),
            address(wormhole),
            wormholeRelayerAddr,
            address(0),
            FAST_CONSISTENCY_LEVEL,
            GAS_LIMIT
        );
        wormholeTransceiverChain2 = WormholeTransceiver(
            address(new ERC1967Proxy(address(implementationTransceiver), ""))
        );
        wormholeTransceiverChain2.initialize();

        nttManagerChain2.setTransceiver(address(wormholeTransceiverChain2));
        nttManagerChain2.setOutboundLimit(type(uint64).max);
        nttManagerChain2.setInboundLimit(type(uint64).max, CHAIN_ID_1);
        nttManagerChain2.setThreshold(1);
    }

    function _wirePeers() internal {
        vm.chainId(CHAIN_ID_1);
        nttManagerChain1.setPeer(
            CHAIN_ID_2, toWormholeFormat(address(nttManagerChain2)), 9, type(uint64).max
        );
        wormholeTransceiverChain1.setWormholePeer(
            CHAIN_ID_2, toWormholeFormat(address(wormholeTransceiverChain2))
        );
        wormholeTransceiverChain1.setIsWormholeEvmChain(CHAIN_ID_2, true);
        wormholeTransceiverChain1.setIsSpecialRelayingEnabled(CHAIN_ID_2, true);

        vm.chainId(CHAIN_ID_2);
        nttManagerChain2.setPeer(
            CHAIN_ID_1, toWormholeFormat(address(nttManagerChain1)), 7, type(uint64).max
        );
        wormholeTransceiverChain2.setWormholePeer(
            CHAIN_ID_1, toWormholeFormat(address(wormholeTransceiverChain1))
        );
        wormholeTransceiverChain2.setIsWormholeEvmChain(CHAIN_ID_1, true);
        vm.chainId(CHAIN_ID_1);
    }

    function _encodeSpecialRelayInstructions(bytes memory signedQuote)
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
            payload: wormholeTransceiverChain1.encodeWormholeTransceiverInstruction(wormholeInstruction)
        });

        TransceiverStructs.TransceiverInstruction[] memory instructions =
            new TransceiverStructs.TransceiverInstruction[](1);
        instructions[0] = instruction;
        encoded = TransceiverStructs.encodeTransceiverInstructions(instructions);
    }
}
