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

    function testRequestDeliveryWithoutSignedQuoteReverts() public {
        vm.expectRevert(SpecialRelayer.SignedQuoteRequired.selector);
        relayer.requestDelivery{value: 1 ether}(address(this), CHAIN_ID, 0, 7);
    }

    function testQuoteDeliveryPriceUsesExecutionQuoterWhenConfigured() public {
        address oracle = address(0xA0A);
        quoter.setOracleService(oracle);

        IPenguinBridgeExecutionQuoter.PricingData memory price = IPenguinBridgeExecutionQuoter.PricingData({
            dstPrice: uint64(1_000 * 10 ** 10), dstGasPrice: 20 gwei, priceBuffer: 1_000, baseFee: 0.001 ether
        });

        vm.prank(oracle);
        quoter.priceUpdate(uint64(2_000 * 10 ** 10), CHAIN_ID, price);

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
        vm.expectRevert(SpecialRelayer.SignedQuoteRequired.selector);
        relayer.requestDelivery{value: 1 ether}(address(this), CHAIN_ID, 0, 7);
    }

    function testRequestDeliveryWithSignedQuoteRevertsWhenExecutionQuoterUnset() public {
        SpecialRelayer freshRelayer = new SpecialRelayer();
        freshRelayer.setSourceChainId(SRC_CHAIN_ID);

        address signer = vm.addr(QUOTER_PRIVATE_KEY);
        bytes memory signedQuote = _signedQuote(signer, address(0xFEE1), CHAIN_ID, 0.25 ether, 1 hours);

        vm.expectRevert(SpecialRelayer.ExecutionQuoterNotSet.selector);
        freshRelayer.requestDelivery{value: 0.25 ether}(address(this), CHAIN_ID, 0, 7, signedQuote);
    }

    function testRequestDeliveryWithSignedQuoteRevertsWhenExpired() public {
        address signer = vm.addr(QUOTER_PRIVATE_KEY);
        bytes memory signedQuote = _signedQuote(signer, address(0xFEE1), CHAIN_ID, 0.25 ether, 1 hours);

        quoter.addQuoter(signer);
        vm.warp(block.timestamp + 2 hours);

        vm.expectRevert();
        relayer.requestDelivery{value: 0.25 ether}(address(this), CHAIN_ID, 0, 7, signedQuote);
    }

    function testRequestDeliveryWithSignedQuoteRevertsWhenSignerUnauthorized() public {
        address signer = vm.addr(QUOTER_PRIVATE_KEY);
        bytes memory signedQuote = _signedQuote(signer, address(0xFEE1), CHAIN_ID, 0.25 ether, 1 hours);

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

    function testRequestDeliveryWithSignedQuoteRefundsExcessToCaller() public {
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

        // The emitted payment should reflect the quoted amount, not msg.value.
        vm.expectEmit(true, true, true, true);
        emit DeliveryRequested(address(this), CHAIN_ID, 7, required);

        vm.prank(user);
        relayer.requestDelivery{value: sent}(address(this), CHAIN_ID, 0, 7, signedQuote);

        assertEq(payee.balance, payeeBalanceBefore + required, "payee receives only the quoted amount");
        assertEq(user.balance, overpay, "caller is refunded the excess");
        assertEq(address(relayer).balance, 0, "relayer holds nothing");
    }

    function testRequestDeliveryWithSignedQuoteRevertsOnInvalidPayeeAddress() public {
        address signer = vm.addr(QUOTER_PRIVATE_KEY);
        // Payee with non-zero high bits — not a valid EVM address.
        bytes32 invalidPayee = bytes32(uint256(1 << 200) | uint256(uint160(address(0xFEE1))));
        uint256 required = 0.25 ether;
        bytes memory signedQuote = _signedQuoteRawPayee(signer, invalidPayee, SRC_CHAIN_ID, CHAIN_ID, required, 1 hours);

        quoter.addQuoter(signer);

        address user = address(0xCAFE);
        vm.deal(user, required);

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(SpecialRelayer.InvalidPayeeAddress.selector, invalidPayee));
        relayer.requestDelivery{value: required}(address(this), CHAIN_ID, 0, 7, signedQuote);
    }

    function testRequestDeliveryWithZeroPayeeFallsBackToOwner() public {
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
        relayer.requestDelivery{value: required}(address(this), CHAIN_ID, 0, 7, signedQuote);

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
            SIGNED_QUOTE_PREFIX, signer, payee, srcChain, dstChain, uint64(block.timestamp) + expiresIn, requiredPayment
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(QUOTER_PRIVATE_KEY, keccak256(body));
        return bytes.concat(body, abi.encodePacked(r, s, v));
    }
}
