// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

interface ISpecialRelayer {
    function quoteDeliveryPrice(address sourceContract, uint16 targetChain, uint256 additionalValue)
        external
        view
        returns (uint256 nativePriceQuote);

    function quoteDeliveryPrice(
        address sourceContract,
        uint16 targetChain,
        uint256 additionalValue,
        bytes32 dstAddr,
        bytes calldata relayInstructions
    ) external view returns (uint256 nativePriceQuote);

    function requestExecution(
        uint16 dstChain,
        bytes32 dstAddr,
        address refundAddr,
        bytes calldata signedQuoteBytes,
        bytes calldata requestBytes,
        bytes calldata relayInstructions
    ) external payable;
}
