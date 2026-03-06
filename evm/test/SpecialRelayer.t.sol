// SPDX-License-Identifier: Apache 2

pragma solidity >=0.8.26 <0.9.0;

import "forge-std/Test.sol";

import "../src/SpecialRelayer/SpecialRelayer.sol";

contract SpecialRelayerTest is Test {
    SpecialRelayer relayer;
    uint16 constant CHAIN_ID = 5;

    event DeliveryRequested(
        address indexed sourceContract,
        uint16 indexed targetChain,
        uint64 indexed sequence,
        uint256 payment
    );

    event DefaultDeliveryFeeSet(uint256 fee);

    event DeliveryFeeSet(uint16 chainId, uint256 fee);

    event FeeRecipientSet(address indexed recipient);

    function setUp() public {
        relayer = new SpecialRelayer();
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
        vm.expectRevert(
            abi.encodeWithSelector(
                SpecialRelayer.InsufficientPayment.selector, required, required - 1
            )
        );
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
        vm.expectRevert(
            abi.encodeWithSelector(SpecialRelayer.FeeBelowMinimum.selector, 0, 1)
        );
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
}

