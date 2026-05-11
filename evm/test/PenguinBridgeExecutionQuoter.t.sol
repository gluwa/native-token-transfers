// SPDX-License-Identifier: Apache 2

pragma solidity 0.8.19;

import "forge-std/Test.sol";

import "../src/interfaces/IPenguinBridgeExecutionQuoter.sol";
import "../src/SpecialRelayer/PenguinBridgeExecutionQuoter.sol";

contract PenguinBridgeExecutionQuoterTest is Test {
    PenguinBridgeExecutionQuoter quoter;

    address oracle = address(0xA0A);
    address payee = address(0xCAFE);
    address randomCaller = address(0xBEEF);

    uint16 constant DST_CHAIN = 5;
    uint16 constant DST_CHAIN_2 = 10;
    uint64 constant SRC_PRICE = uint64(2_000 * 10 ** 10);

    event PriceUpdated(
        uint64 sourcePrice, uint16 indexed chainId, IPenguinBridgeExecutionQuoter.PricingData price
    );
    event ExecutionQuoteRequested(uint16 indexed dstChain, uint256 requiredPayment);
    event QuoterAdded(address indexed quoter);
    event QuoterRemoved(address indexed quoter);

    function setUp() public {
        quoter = new PenguinBridgeExecutionQuoter();
        quoter.setOracleService(oracle);
    }

    function _defaultPrice()
        internal
        pure
        returns (IPenguinBridgeExecutionQuoter.PricingData memory)
    {
        return IPenguinBridgeExecutionQuoter.PricingData({
            dstPrice: uint64(1_000 * 10 ** 10),
            dstGasPrice: 20 gwei,
            priceBuffer: 1_000, // 10%
            baseFee: 0.001 ether
        });
    }

    function _pushDefaultPrice() internal {
        vm.prank(oracle);
        quoter.priceUpdate(SRC_PRICE, DST_CHAIN, _defaultPrice());
    }

    // ============================================================
    // requestExecutionQuote — non-view variant returns payment + payee
    // ============================================================

    function testRequestExecutionQuoteReturnsPaymentAndPayee() public {
        bytes32 universalPayee = bytes32(uint256(uint160(payee)));
        quoter.setPayeeAddress(universalPayee);
        _pushDefaultPrice();

        uint256 msgValue = 0.5 ether;
        uint256 gasLimit = 300_000;

        // Expected fee:
        // convertedMsgValue = 0.5e18 * 1000e10 / 2000e10 = 0.25 ether
        // convertedGas      = 300_000 * 20e9 * 1000e10 / 2000e10 = 0.003 ether
        // transactionFee    = 0.001 + 0.003 = 0.004 ether
        // bufferedFee       = 0.004 * 1.1 = 0.0044 ether
        // total             = 0.25 + 0.0044 = 0.2544 ether
        uint256 expected = 0.2544 ether;

        vm.expectEmit(true, false, false, true);
        emit ExecutionQuoteRequested(DST_CHAIN, expected);

        (uint256 payment, bytes32 returnedPayee, bytes32 quoteBody) = quoter.requestExecutionQuote(
            DST_CHAIN, bytes32(0), address(0), abi.encode(msgValue), abi.encode(gasLimit)
        );

        assertEq(payment, expected, "payment mismatch");
        assertEq(returnedPayee, universalPayee, "payee mismatch");
        assertEq(quoteBody, bytes32(0), "quote body should be zero placeholder");
    }

    function testRequestExecutionQuoteReturnsZeroPayeeWhenUnset() public {
        _pushDefaultPrice();

        (, bytes32 returnedPayee,) = quoter.requestExecutionQuote(
            DST_CHAIN, bytes32(0), address(0), abi.encode(uint256(0)), abi.encode(uint256(100_000))
        );

        assertEq(returnedPayee, bytes32(0));
    }

    // ============================================================
    // batchPriceUpdate — updates multiple chains in one call
    // ============================================================

    function testBatchPriceUpdateWritesAllChains() public {
        uint16[] memory chains = new uint16[](2);
        chains[0] = DST_CHAIN;
        chains[1] = DST_CHAIN_2;

        IPenguinBridgeExecutionQuoter.PricingData[] memory prices =
            new IPenguinBridgeExecutionQuoter.PricingData[](2);
        prices[0] = _defaultPrice();
        prices[1] = IPenguinBridgeExecutionQuoter.PricingData({
            dstPrice: uint64(500 * 10 ** 10),
            dstGasPrice: 50 gwei,
            priceBuffer: 500,
            baseFee: 0.002 ether
        });

        vm.expectEmit(true, false, false, true);
        emit PriceUpdated(SRC_PRICE, DST_CHAIN, prices[0]);
        vm.expectEmit(true, false, false, true);
        emit PriceUpdated(SRC_PRICE, DST_CHAIN_2, prices[1]);

        vm.prank(oracle);
        quoter.batchPriceUpdate(SRC_PRICE, chains, prices);

        assertEq(quoter.sourcePrice(), SRC_PRICE);

        // Verify both chains can be quoted with their distinct configs.
        uint256 fee1 = quoter.requestQuote(
            DST_CHAIN, bytes32(0), address(0), abi.encode(uint256(0)), abi.encode(uint256(100_000))
        );
        uint256 fee2 = quoter.requestQuote(
            DST_CHAIN_2,
            bytes32(0),
            address(0),
            abi.encode(uint256(0)),
            abi.encode(uint256(100_000))
        );

        // Chain 1: gas = 100_000 * 20e9 * 0.5 = 1e15; total = (1e15 + 1e15) * 1.1 = 2.2e15
        assertEq(fee1, 0.0022 ether, "chain 1 fee");
        // Chain 2: gas = 100_000 * 50e9 * 500e10/2000e10 = 1.25e15; total = (2e15 + 1.25e15) * 1.05
        assertEq(fee2, 0.0034125 ether, "chain 2 fee");
    }

    function testBatchPriceUpdateRevertsOnLengthMismatch() public {
        uint16[] memory chains = new uint16[](2);
        chains[0] = DST_CHAIN;
        chains[1] = DST_CHAIN_2;

        IPenguinBridgeExecutionQuoter.PricingData[] memory prices =
            new IPenguinBridgeExecutionQuoter.PricingData[](1);
        prices[0] = _defaultPrice();

        vm.prank(oracle);
        vm.expectRevert(PenguinBridgeExecutionQuoter.LengthMismatch.selector);
        quoter.batchPriceUpdate(SRC_PRICE, chains, prices);
    }

    function testBatchPriceUpdateRevertsForNonOracleCaller() public {
        uint16[] memory chains = new uint16[](1);
        chains[0] = DST_CHAIN;
        IPenguinBridgeExecutionQuoter.PricingData[] memory prices =
            new IPenguinBridgeExecutionQuoter.PricingData[](1);
        prices[0] = _defaultPrice();

        vm.prank(randomCaller);
        vm.expectRevert(
            abi.encodeWithSelector(
                PenguinBridgeExecutionQuoter.CallerNotOracleService.selector, randomCaller
            )
        );
        quoter.batchPriceUpdate(SRC_PRICE, chains, prices);
    }

    function testPriceUpdateRevertsForNonOracleCaller() public {
        vm.prank(randomCaller);
        vm.expectRevert(
            abi.encodeWithSelector(
                PenguinBridgeExecutionQuoter.CallerNotOracleService.selector, randomCaller
            )
        );
        quoter.priceUpdate(SRC_PRICE, DST_CHAIN, _defaultPrice());
    }

    // ============================================================
    // _quote — pricing edge cases
    // ============================================================

    function testQuoteRevertsWhenSourcePriceUnset() public {
        // Push prices but with srcPrice = 0
        vm.prank(oracle);
        quoter.priceUpdate(0, DST_CHAIN, _defaultPrice());

        vm.expectRevert(PenguinBridgeExecutionQuoter.SourcePriceNotSet.selector);
        quoter.requestQuote(
            DST_CHAIN, bytes32(0), address(0), abi.encode(uint256(0)), abi.encode(uint256(100_000))
        );
    }

    function testQuoteWithZeroMsgValueReturnsFeesOnly() public {
        _pushDefaultPrice();

        // gasLimit = 200_000 → convertedGas = 200_000 * 20e9 * 0.5 = 2e15
        // transactionFee = 1e15 + 2e15 = 3e15
        // bufferedFee    = 3e15 * 1.1 = 3.3e15
        uint256 fee = quoter.requestQuote(
            DST_CHAIN, bytes32(0), address(0), abi.encode(uint256(0)), abi.encode(uint256(200_000))
        );

        assertEq(fee, 0.0033 ether);
    }

    function testQuoteWithZeroGasLimitReturnsBaseAndConvertedMsgValue() public {
        _pushDefaultPrice();

        // msgValue = 1 ether → convertedMsgValue = 1e18 * 0.5 = 0.5 ether
        // transactionFee = baseFee only = 1e15
        // bufferedFee    = 1e15 * 1.1 = 1.1e15
        // total          = 0.5 + 0.0011 = 0.5011 ether
        uint256 fee = quoter.requestQuote(
            DST_CHAIN, bytes32(0), address(0), abi.encode(uint256(1 ether)), abi.encode(uint256(0))
        );

        assertEq(fee, 0.5011 ether);
    }

    function testQuoteWithZeroPriceBufferAppliesNoBuffer() public {
        IPenguinBridgeExecutionQuoter.PricingData memory price = _defaultPrice();
        price.priceBuffer = 0;

        vm.prank(oracle);
        quoter.priceUpdate(SRC_PRICE, DST_CHAIN, price);

        // gasLimit = 100_000 → convertedGas = 1e15
        // transactionFee = 1e15 + 1e15 = 2e15
        // bufferedFee    = 2e15 * 1.0 = 2e15 (no buffer)
        uint256 fee = quoter.requestQuote(
            DST_CHAIN, bytes32(0), address(0), abi.encode(uint256(0)), abi.encode(uint256(100_000))
        );

        assertEq(fee, 0.002 ether);
    }

    function testQuoteReturnsZeroWhenAllInputsAreZero() public {
        // priceBuffer 0, baseFee 0, gasLimit 0, msgValue 0 → fee = 0
        IPenguinBridgeExecutionQuoter.PricingData memory price =
            IPenguinBridgeExecutionQuoter.PricingData({
                dstPrice: uint64(1_000 * 10 ** 10), dstGasPrice: 20 gwei, priceBuffer: 0, baseFee: 0
            });

        vm.prank(oracle);
        quoter.priceUpdate(SRC_PRICE, DST_CHAIN, price);

        uint256 fee = quoter.requestQuote(
            DST_CHAIN, bytes32(0), address(0), abi.encode(uint256(0)), abi.encode(uint256(0))
        );

        assertEq(fee, 0);
    }

    function testQuoteShortInputsDecodeAsZero() public {
        _pushDefaultPrice();

        // Empty requestBytes and relayInstructions → both decoded as 0 → fees only
        // transactionFee = baseFee only = 1e15
        // bufferedFee    = 1e15 * 1.1 = 1.1e15
        uint256 fee =
            quoter.requestQuote(DST_CHAIN, bytes32(0), address(0), new bytes(0), new bytes(0));

        assertEq(fee, 0.0011 ether);
    }

    // ============================================================
    // Quoter signer registry
    // ============================================================

    function testAddAndRemoveQuoterTogglesAuthorization() public {
        address signer = address(0xD00D);

        assertFalse(quoter.isAuthorizedQuoter(signer));

        vm.expectEmit(true, false, false, false);
        emit QuoterAdded(signer);
        quoter.addQuoter(signer);
        assertTrue(quoter.isAuthorizedQuoter(signer));

        vm.expectEmit(true, false, false, false);
        emit QuoterRemoved(signer);
        quoter.removeQuoter(signer);
        assertFalse(quoter.isAuthorizedQuoter(signer));
    }

    function testAddQuoterRevertsForNonOwner() public {
        vm.prank(randomCaller);
        vm.expectRevert("Ownable: caller is not the owner");
        quoter.addQuoter(address(0xD00D));
    }

    function testRemoveQuoterRevertsForNonOwner() public {
        quoter.addQuoter(address(0xD00D));

        vm.prank(randomCaller);
        vm.expectRevert("Ownable: caller is not the owner");
        quoter.removeQuoter(address(0xD00D));
    }

    function testSetOracleServiceRevertsForNonOwner() public {
        vm.prank(randomCaller);
        vm.expectRevert("Ownable: caller is not the owner");
        quoter.setOracleService(address(0xFEED));
    }

    function testSetPayeeAddressRevertsForNonOwner() public {
        vm.prank(randomCaller);
        vm.expectRevert("Ownable: caller is not the owner");
        quoter.setPayeeAddress(bytes32(uint256(uint160(address(0xFEED)))));
    }
}
