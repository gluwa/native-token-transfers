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

    event DeliveryRequested(
        address indexed sourceContract, uint16 indexed targetChain, uint64 indexed sequence, uint256 payment
    );

    event DefaultDeliveryFeeSet(uint256 fee);

    event DeliveryFeeSet(uint16 chainId, uint256 fee);

    event FeeRecipientSet(address indexed recipient);

    function setUp() public {
        relayer = new SpecialRelayer();
        relayer.setSourceChainId(SRC_CHAIN_ID);
        quoter = new PenguinBridgeExecutionQuoter();
    }

    function testDefaultFeeUsedWhenNoPerChainFeeSet() public {
        relayer.setDefaultDeliveryFee(1 ether);

        uint256 quote = relayer.quoteDeliveryPrice(address(0x1234), CHAIN_ID, 0);
        assertEq(quote, 1 ether);
    }

    function testPerChainFeeOverridesDefault() public {
        relayer.setDefaultDeliveryFee(1 ether);
        relayer.setDeliveryFee(CHAIN_ID, 2 ether);

        uint256 quote = relayer.quoteDeliveryPrice(address(0x1234), CHAIN_ID, 0);
        assertEq(quote, 2 ether);
    }

    function testSetDeliveryFeesBatchUpdatesAll() public {
        uint16[] memory chainIds = new uint16[](2);
        chainIds[0] = 1;
        chainIds[1] = 2;

        uint256[] memory fees = new uint256[](2);
        fees[0] = 10;
        fees[1] = 20;

        relayer.setDeliveryFees(chainIds, fees);

        assertEq(relayer.deliveryFeePerChain(1), 10);
        assertEq(relayer.deliveryFeePerChain(2), 20);
    }

    function testSetDeliveryFeesLengthMismatchReverts() public {
        uint16[] memory chainIds = new uint16[](1);
        chainIds[0] = 1;

        uint256[] memory fees = new uint256[](2);
        fees[0] = 10;
        fees[1] = 20;

        vm.expectRevert(SpecialRelayer.LengthMismatch.selector);
        relayer.setDeliveryFees(chainIds, fees);
    }

    function testRequestDeliveryRevertsOnInsufficientPayment() public {
        relayer.setDefaultDeliveryFee(1 ether);
        uint256 required = relayer.quoteDeliveryPrice(address(this), CHAIN_ID, 0);

        address user = address(0xBEEF);
        vm.deal(user, required - 1);

        vm.startPrank(user);
        vm.expectRevert(abi.encodeWithSelector(SpecialRelayer.InsufficientPayment.selector, required, required - 1));
        relayer.requestDelivery{value: required - 1}(address(this), CHAIN_ID, 0, 42);
        vm.stopPrank();
    }

    function testRequestDeliveryEmitsEventAndAccumulatesBalance() public {
        relayer.setDefaultDeliveryFee(1 ether);
        uint256 required = relayer.quoteDeliveryPrice(address(this), CHAIN_ID, 0);
        uint256 extra = 0.1 ether;
        uint256 value = required + extra;

        address user = address(0xCAFE);
        vm.deal(user, value);

        vm.expectEmit(true, true, true, true);
        emit DeliveryRequested(address(this), CHAIN_ID, 7, value);

        vm.prank(user);
        relayer.requestDelivery{value: value}(address(this), CHAIN_ID, 0, 7);

        assertEq(address(relayer).balance, value);
    }

    function testQuoteDeliveryPriceUsesExecutionQuoterWhenConfigured() public {
        address oracle = address(0xA0A);
        quoter.setOracleService(oracle);

        IPenguinBridgeExecutionQuoter.PricingData memory price = IPenguinBridgeExecutionQuoter.PricingData({
            dstPrice: uint64(1_000 * 10 ** 10), dstGasPrice: 20 gwei, priceBuffer: 1_000, baseFee: 0.001 ether
        });

        vm.prank(oracle);
        quoter.priceUpdate(uint64(2_000 * 10 ** 10), CHAIN_ID, price);
        relayer.setExecutionQuoter(address(quoter));

        uint256 quote = relayer.quoteDeliveryPrice(
            address(this), CHAIN_ID, 2 ether, bytes32(uint256(uint160(address(0xCAFE)))), abi.encode(uint256(500_000))
        );

        assertEq(quote, 1 ether + 0.0066 ether);
    }

    function testRequestDeliveryWithSignedQuotePaysUniversalPayee() public {
        address signer = vm.addr(QUOTER_PRIVATE_KEY);
        address payee = address(0xFEE1);
        uint256 required = 0.25 ether;
        bytes memory signedQuote = _signedQuote(signer, payee, CHAIN_ID, required, 1 hours);

        quoter.addQuoter(signer);
        relayer.setExecutionQuoter(address(quoter));

        address user = address(0xCAFE);
        vm.deal(user, required);
        uint256 payeeBalanceBefore = payee.balance;

        vm.expectEmit(true, true, true, true);
        emit DeliveryRequested(address(this), CHAIN_ID, 7, required);

        vm.prank(user);
        relayer.requestDelivery{value: required}(address(this), CHAIN_ID, 0, 7, signedQuote);

        assertEq(payee.balance, payeeBalanceBefore + required);
        assertEq(address(relayer).balance, 0);
    }

    function testRequestDeliveryWithSignedQuoteRevertsWhenQuoteMissing() public {
        relayer.setExecutionQuoter(address(quoter));

        vm.expectRevert(SpecialRelayer.SignedQuoteRequired.selector);
        relayer.requestDelivery{value: 1 ether}(address(this), CHAIN_ID, 0, 7);
    }

    function testRequestDeliveryWithSignedQuoteRevertsWhenExpired() public {
        address signer = vm.addr(QUOTER_PRIVATE_KEY);
        bytes memory signedQuote = _signedQuote(signer, address(0xFEE1), CHAIN_ID, 0.25 ether, 1 hours);

        quoter.addQuoter(signer);
        relayer.setExecutionQuoter(address(quoter));
        vm.warp(block.timestamp + 2 hours);

        vm.expectRevert();
        relayer.requestDelivery{value: 0.25 ether}(address(this), CHAIN_ID, 0, 7, signedQuote);
    }

    function testRequestDeliveryWithSignedQuoteRevertsWhenSignerUnauthorized() public {
        address signer = vm.addr(QUOTER_PRIVATE_KEY);
        bytes memory signedQuote = _signedQuote(signer, address(0xFEE1), CHAIN_ID, 0.25 ether, 1 hours);

        relayer.setExecutionQuoter(address(quoter));

        vm.expectRevert(abi.encodeWithSelector(SpecialRelayer.InvalidQuoteSigner.selector, signer));
        relayer.requestDelivery{value: 0.25 ether}(address(this), CHAIN_ID, 0, 7, signedQuote);
    }

    function testRequestDeliveryWithSignedQuoteRevertsOnWrongSourceChain() public {
        address signer = vm.addr(QUOTER_PRIVATE_KEY);
        // Quote signed for a different source chain than this relayer is deployed on.
        uint16 wrongSrcChain = SRC_CHAIN_ID + 1;
        bytes memory signedQuote =
            _signedQuoteWithSrc(signer, address(0xFEE1), wrongSrcChain, CHAIN_ID, 0.25 ether, 1 hours);

        quoter.addQuoter(signer);
        relayer.setExecutionQuoter(address(quoter));

        vm.expectRevert(
            abi.encodeWithSelector(SpecialRelayer.InvalidQuoteSourceChain.selector, SRC_CHAIN_ID, wrongSrcChain)
        );
        relayer.requestDelivery{value: 0.25 ether}(address(this), CHAIN_ID, 0, 7, signedQuote);
    }

    function testRequestDeliveryWithSignedQuoteRevertsWhenSourceChainIdNotSet() public {
        // Fresh relayer with no source chain id configured.
        SpecialRelayer freshRelayer = new SpecialRelayer();
        freshRelayer.setExecutionQuoter(address(quoter));

        address signer = vm.addr(QUOTER_PRIVATE_KEY);
        bytes memory signedQuote = _signedQuote(signer, address(0xFEE1), CHAIN_ID, 0.25 ether, 1 hours);

        vm.expectRevert(SpecialRelayer.SourceChainIdNotSet.selector);
        freshRelayer.requestDelivery{value: 0.25 ether}(address(this), CHAIN_ID, 0, 7, signedQuote);
    }

    function testWithdrawSendsBalanceToOwnerWhenNoFeeRecipient() public {
        uint256 amount = 1 ether;
        vm.deal(address(relayer), amount);

        address ownerEOA = address(0xABCD);
        relayer.transferOwnership(ownerEOA);

        uint256 beforeOwnerBalance = ownerEOA.balance;

        vm.prank(ownerEOA);
        relayer.withdraw();

        assertEq(ownerEOA.balance, beforeOwnerBalance + amount);
        assertEq(address(relayer).balance, 0);
    }

    function testWithdrawSendsBalanceToFeeRecipientWhenSet() public {
        uint256 amount = 1 ether;
        vm.deal(address(relayer), amount);

        address feeRecipient = address(0xD00D);
        relayer.setFeeRecipient(feeRecipient);

        address owner = relayer.owner();
        uint256 beforeOwnerBalance = owner.balance;
        uint256 beforeRecipientBalance = feeRecipient.balance;

        relayer.withdraw();

        assertEq(feeRecipient.balance, beforeRecipientBalance + amount);
        assertEq(owner.balance, beforeOwnerBalance);
        assertEq(address(relayer).balance, 0);
    }

    function testSetFeeRecipientEmitsEvent() public {
        address feeRecipient = address(0xFEE1);

        vm.expectEmit(true, false, false, true);
        emit FeeRecipientSet(feeRecipient);

        relayer.setFeeRecipient(feeRecipient);
    }

    function testSetDefaultDeliveryFeeEmitsEvent() public {
        uint256 fee = 1 ether;

        vm.expectEmit(false, false, false, true);
        emit DefaultDeliveryFeeSet(fee);

        relayer.setDefaultDeliveryFee(fee);
    }

    function testSetDeliveryFeeEmitsEvent() public {
        uint16 chainId = CHAIN_ID;
        uint256 fee = 1 ether;

        vm.expectEmit(false, false, false, true);
        emit DeliveryFeeSet(chainId, fee);

        relayer.setDeliveryFee(chainId, fee);
    }

    function testSetDefaultDeliveryFeeRevertsWhenBelowMinimum() public {
        vm.expectRevert(abi.encodeWithSelector(SpecialRelayer.FeeBelowMinimum.selector, 0, 1));
        relayer.setDefaultDeliveryFee(0);
    }

    function testSetDeliveryFeeAllowsZeroForFallback() public {
        relayer.setDeliveryFee(CHAIN_ID, 0);
        assertEq(relayer.deliveryFeePerChain(CHAIN_ID), 0);
    }

    function testSetDeliveryFeeAcceptsMinimumFee() public {
        relayer.setDeliveryFee(CHAIN_ID, 1);
        assertEq(relayer.deliveryFeePerChain(CHAIN_ID), 1);
    }

    function testMinimumFeeConstant() public {
        assertEq(relayer.MINIMUM_FEE(), 1);
    }

    function _signedQuote(address signer, address payee, uint16 dstChain, uint256 requiredPayment, uint64 expiresIn)
        internal
        view
        returns (bytes memory)
    {
        return _signedQuoteWithSrc(signer, payee, SRC_CHAIN_ID, dstChain, requiredPayment, expiresIn);
    }

    function _signedQuoteWithSrc(
        address signer,
        address payee,
        uint16 srcChain,
        uint16 dstChain,
        uint256 requiredPayment,
        uint64 expiresIn
    ) internal view returns (bytes memory) {
        bytes memory body = abi.encodePacked(
            SIGNED_QUOTE_PREFIX,
            signer,
            bytes32(uint256(uint160(payee))),
            srcChain,
            dstChain,
            uint64(block.timestamp) + expiresIn,
            requiredPayment
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(QUOTER_PRIVATE_KEY, keccak256(body));
        return bytes.concat(body, abi.encodePacked(r, s, v));
    }
}
