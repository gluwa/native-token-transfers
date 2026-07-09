// SPDX-License-Identifier: Apache 2

pragma solidity 0.8.19;

import "forge-std/Test.sol";

import "../src/interfaces/IPenguinBridgeExecutionQuoter.sol";
import "../src/SpecialRelayer/PenguinBridgeExecutionQuoter.sol";
import "../src/SpecialRelayer/SpecialRelayer.sol";

contract SpecialRelayerTest is Test {
    SpecialRelayer relayer;
    PenguinBridgeExecutionQuoter quoter;
    uint16 constant CHAIN_ID = 5;
    uint16 constant SRC_CHAIN_ID = 2;
    uint256 constant QUOTER_PRIVATE_KEY = 0xA11CE;
    bytes4 constant SIGNED_QUOTE_PREFIX = 0x50513031;
    uint256 constant DEFAULT_GAS_LIMIT = 200_000;
    bytes32 constant DST_ADDR = bytes32(uint256(uint160(address(0xDD57))));

    event ExecutionRequested(
        uint16 indexed dstChain,
        bytes32 indexed dstAddr,
        bytes requestBytes,
        bytes relayInstructions
    );

    function setUp() public {
        relayer = new SpecialRelayer();
        relayer.setSourceChainId(SRC_CHAIN_ID);
        quoter = new PenguinBridgeExecutionQuoter();
        relayer.setExecutionQuoter(address(quoter));
    }

    function testQuoteRevertsWhenExecutionQuoterUnset() public {
        SpecialRelayer freshRelayer = new SpecialRelayer();

        vm.expectRevert(SpecialRelayer.ExecutionQuoterNotSet.selector);
        freshRelayer.quoteDeliveryPrice(address(0x1234), CHAIN_ID, 0);
    }

    function testQuoteDeliveryPriceUsesExecutionQuoterWhenConfigured() public {
        address oracle = address(0xA0A);
        quoter.setOracleService(oracle);

        IPenguinBridgeExecutionQuoter.PricingData memory price =
            IPenguinBridgeExecutionQuoter.PricingData({
                dstPrice: uint64(1_000 * 10 ** 10),
                dstGasPrice: 20 gwei,
                priceBuffer: 1_000,
                baseFee: 0.001 ether
            });

        vm.prank(oracle);
        quoter.priceUpdate(uint64(2_000 * 10 ** 10), CHAIN_ID, price);

        uint256 quote = relayer.quoteDeliveryPrice(
            address(this),
            CHAIN_ID,
            2 ether,
            bytes32(uint256(uint160(address(0xCAFE)))),
            abi.encode(uint256(500_000))
        );

        assertEq(quote, 1 ether + 0.0066 ether);
    }

    function testRequestExecutionPaysUniversalPayee() public {
        address signer = vm.addr(QUOTER_PRIVATE_KEY);
        address payee = address(0xFEE1);
        uint256 required = 0.25 ether;
        bytes memory signedQuote = _signedQuote(signer, payee, CHAIN_ID, required, 1 hours);

        quoter.addQuoter(signer);

        address user = address(0xCAFE);
        vm.deal(user, required);
        uint256 payeeBalanceBefore = payee.balance;

        bytes memory requestBytes = hex"deadbeef";
        bytes memory relayInstructions = abi.encode(DEFAULT_GAS_LIMIT);

        vm.expectEmit(true, true, false, true);
        emit ExecutionRequested(CHAIN_ID, DST_ADDR, requestBytes, relayInstructions);

        vm.prank(user);
        relayer.requestExecution{value: required}(
            CHAIN_ID, DST_ADDR, address(0), signedQuote, requestBytes, relayInstructions
        );

        assertEq(payee.balance, payeeBalanceBefore + required);
        assertEq(address(relayer).balance, 0);
    }

    function testRequestExecutionRevertsOnEmptySignedQuote() public {
        vm.expectRevert(abi.encodeWithSelector(SpecialRelayer.InvalidQuoteLength.selector, 0));
        relayer.requestExecution{value: 1 ether}(
            CHAIN_ID, DST_ADDR, address(0), bytes(""), bytes(""), abi.encode(DEFAULT_GAS_LIMIT)
        );
    }

    function testRequestExecutionRevertsWhenExecutionQuoterUnset() public {
        SpecialRelayer freshRelayer = new SpecialRelayer();
        freshRelayer.setSourceChainId(SRC_CHAIN_ID);

        address signer = vm.addr(QUOTER_PRIVATE_KEY);
        bytes memory signedQuote =
            _signedQuote(signer, address(0xFEE1), CHAIN_ID, 0.25 ether, 1 hours);

        vm.expectRevert(SpecialRelayer.ExecutionQuoterNotSet.selector);
        freshRelayer.requestExecution{value: 0.25 ether}(
            CHAIN_ID, DST_ADDR, address(0), signedQuote, bytes(""), abi.encode(DEFAULT_GAS_LIMIT)
        );
    }

    function testRequestExecutionRevertsWhenExpired() public {
        address signer = vm.addr(QUOTER_PRIVATE_KEY);
        bytes memory signedQuote =
            _signedQuote(signer, address(0xFEE1), CHAIN_ID, 0.25 ether, 1 hours);

        quoter.addQuoter(signer);
        vm.warp(block.timestamp + 2 hours);

        vm.expectRevert();
        relayer.requestExecution{value: 0.25 ether}(
            CHAIN_ID, DST_ADDR, address(0), signedQuote, bytes(""), abi.encode(DEFAULT_GAS_LIMIT)
        );
    }

    function testRequestExecutionRevertsWhenSignerUnauthorized() public {
        address signer = vm.addr(QUOTER_PRIVATE_KEY);
        bytes memory signedQuote =
            _signedQuote(signer, address(0xFEE1), CHAIN_ID, 0.25 ether, 1 hours);

        vm.expectRevert(abi.encodeWithSelector(SpecialRelayer.InvalidQuoteSigner.selector, signer));
        relayer.requestExecution{value: 0.25 ether}(
            CHAIN_ID, DST_ADDR, address(0), signedQuote, bytes(""), abi.encode(DEFAULT_GAS_LIMIT)
        );
    }

    function testRequestExecutionRevertsOnWrongSourceChain() public {
        address signer = vm.addr(QUOTER_PRIVATE_KEY);
        // Quote signed for a different source chain than this relayer is deployed on.
        uint16 wrongSrcChain = SRC_CHAIN_ID + 1;
        bytes memory signedQuote = _signedQuoteWithSrc(
            signer, address(0xFEE1), wrongSrcChain, CHAIN_ID, 0.25 ether, 1 hours
        );

        quoter.addQuoter(signer);

        vm.expectRevert(
            abi.encodeWithSelector(
                SpecialRelayer.InvalidQuoteSourceChain.selector, SRC_CHAIN_ID, wrongSrcChain
            )
        );
        relayer.requestExecution{value: 0.25 ether}(
            CHAIN_ID, DST_ADDR, address(0), signedQuote, bytes(""), abi.encode(DEFAULT_GAS_LIMIT)
        );
    }

    function testRequestExecutionRevertsOnWrongDestinationChain() public {
        address signer = vm.addr(QUOTER_PRIVATE_KEY);
        bytes memory signedQuote =
            _signedQuote(signer, address(0xFEE1), CHAIN_ID, 0.25 ether, 1 hours);

        quoter.addQuoter(signer);

        uint16 paramDstChain = CHAIN_ID + 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                SpecialRelayer.InvalidQuoteTargetChain.selector, paramDstChain, CHAIN_ID
            )
        );
        relayer.requestExecution{value: 0.25 ether}(
            paramDstChain,
            DST_ADDR,
            address(0),
            signedQuote,
            bytes(""),
            abi.encode(DEFAULT_GAS_LIMIT)
        );
    }

    function testRequestExecutionRevertsWhenSourceChainIdNotSet() public {
        // Fresh relayer with no source chain id configured.
        SpecialRelayer freshRelayer = new SpecialRelayer();
        freshRelayer.setExecutionQuoter(address(quoter));

        address signer = vm.addr(QUOTER_PRIVATE_KEY);
        bytes memory signedQuote =
            _signedQuote(signer, address(0xFEE1), CHAIN_ID, 0.25 ether, 1 hours);

        vm.expectRevert(SpecialRelayer.SourceChainIdNotSet.selector);
        freshRelayer.requestExecution{value: 0.25 ether}(
            CHAIN_ID, DST_ADDR, address(0), signedQuote, bytes(""), abi.encode(DEFAULT_GAS_LIMIT)
        );
    }

    function testRequestExecutionRevertsOnGasLimitMismatch() public {
        address signer = vm.addr(QUOTER_PRIVATE_KEY);
        bytes memory signedQuote =
            _signedQuote(signer, address(0xFEE1), CHAIN_ID, 0.25 ether, 1 hours);
        quoter.addQuoter(signer);

        uint256 wrongGasLimit = DEFAULT_GAS_LIMIT + 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                SpecialRelayer.RelayInstructionsGasLimitMismatch.selector,
                DEFAULT_GAS_LIMIT,
                wrongGasLimit
            )
        );
        relayer.requestExecution{value: 0.25 ether}(
            CHAIN_ID, DST_ADDR, address(0), signedQuote, bytes(""), abi.encode(wrongGasLimit)
        );
    }

    function testRequestExecutionRefundsExcessToCaller() public {
        address signer = vm.addr(QUOTER_PRIVATE_KEY);
        address payee = address(0xFEE1);
        uint256 required = 0.25 ether;
        uint256 overpay = 0.1 ether;
        uint256 sent = required + overpay;
        bytes memory signedQuote = _signedQuote(signer, payee, CHAIN_ID, required, 1 hours);

        quoter.addQuoter(signer);

        address user = address(0xCAFE);
        vm.deal(user, sent);
        uint256 payeeBalanceBefore = payee.balance;

        vm.prank(user);
        relayer.requestExecution{value: sent}(
            CHAIN_ID, DST_ADDR, address(0), signedQuote, bytes(""), abi.encode(DEFAULT_GAS_LIMIT)
        );

        assertEq(
            payee.balance, payeeBalanceBefore + required, "payee receives only the quoted amount"
        );
        assertEq(user.balance, overpay, "caller is refunded the excess");
        assertEq(address(relayer).balance, 0, "relayer holds nothing");
    }

    function testRequestExecutionRevertsOnInvalidPayeeAddress() public {
        address signer = vm.addr(QUOTER_PRIVATE_KEY);
        // Payee with non-zero high bits — not a valid EVM address.
        bytes32 invalidPayee = bytes32(uint256(1 << 200) | uint256(uint160(address(0xFEE1))));
        uint256 required = 0.25 ether;
        bytes memory signedQuote =
            _signedQuoteRawPayee(signer, invalidPayee, SRC_CHAIN_ID, CHAIN_ID, required, 1 hours);

        quoter.addQuoter(signer);

        address user = address(0xCAFE);
        vm.deal(user, required);

        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(SpecialRelayer.InvalidPayeeAddress.selector, invalidPayee)
        );
        relayer.requestExecution{value: required}(
            CHAIN_ID, DST_ADDR, address(0), signedQuote, bytes(""), abi.encode(DEFAULT_GAS_LIMIT)
        );
    }

    function testRequestExecutionWithZeroPayeeFallsBackToOwner() public {
        // Move ownership to a plain EOA so the contract can forward ETH to it.
        address newOwner = address(0xABCD);
        relayer.transferOwnership(newOwner);
        vm.prank(newOwner);
        relayer.acceptOwnership();

        address signer = vm.addr(QUOTER_PRIVATE_KEY);
        uint256 required = 0.25 ether;
        // Sign a quote with universalPayeeAddress = bytes32(0).
        bytes memory signedQuote =
            _signedQuoteRawPayee(signer, bytes32(0), SRC_CHAIN_ID, CHAIN_ID, required, 1 hours);

        quoter.addQuoter(signer);

        address user = address(0xCAFE);
        vm.deal(user, required);

        uint256 ownerBalanceBefore = newOwner.balance;

        vm.prank(user);
        relayer.requestExecution{value: required}(
            CHAIN_ID, DST_ADDR, address(0), signedQuote, bytes(""), abi.encode(DEFAULT_GAS_LIMIT)
        );

        assertEq(newOwner.balance, ownerBalanceBefore + required, "owner receives the fee");
        assertEq(address(relayer).balance, 0);
    }

    function testWithdrawSendsBalanceToOwner() public {
        uint256 amount = 1 ether;
        vm.deal(address(relayer), amount);

        // Move ownership to a plain EOA so the contract can forward ETH to it.
        address newOwner = address(0xABCD);
        relayer.transferOwnership(newOwner);
        vm.prank(newOwner);
        relayer.acceptOwnership();

        uint256 beforeOwnerBalance = newOwner.balance;

        relayer.withdraw();

        assertEq(newOwner.balance, beforeOwnerBalance + amount);
        assertEq(address(relayer).balance, 0);
    }

    function _signedQuote(
        address signer,
        address payee,
        uint16 dstChain,
        uint256 requiredPayment,
        uint64 expiresIn
    ) internal view returns (bytes memory) {
        return
            _signedQuoteWithSrc(signer, payee, SRC_CHAIN_ID, dstChain, requiredPayment, expiresIn);
    }

    function _signedQuoteWithSrc(
        address signer,
        address payee,
        uint16 srcChain,
        uint16 dstChain,
        uint256 requiredPayment,
        uint64 expiresIn
    ) internal view returns (bytes memory) {
        return _signedQuoteRawPayee(
            signer, bytes32(uint256(uint160(payee))), srcChain, dstChain, requiredPayment, expiresIn
        );
    }

    function _signedQuoteRawPayee(
        address signer,
        bytes32 payee,
        uint16 srcChain,
        uint16 dstChain,
        uint256 requiredPayment,
        uint64 expiresIn
    ) internal view returns (bytes memory) {
        bytes memory body = abi.encodePacked(
            SIGNED_QUOTE_PREFIX,
            signer,
            payee,
            srcChain,
            dstChain,
            uint64(block.timestamp) + expiresIn,
            DEFAULT_GAS_LIMIT,
            requiredPayment
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(QUOTER_PRIVATE_KEY, keccak256(body));
        return bytes.concat(body, abi.encodePacked(r, s, v));
    }
}
