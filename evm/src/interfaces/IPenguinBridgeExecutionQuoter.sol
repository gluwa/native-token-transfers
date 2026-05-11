// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

interface IPenguinBridgeExecutionQuoter {
    /// @notice Per-destination-chain pricing data.
    /// @dev All four uint64 fields pack into a single 32-byte storage slot, so a per-chain
    ///      update writes one SSTORE.
    /// @param dstPrice    USD price of destination chain native token, scaled by 1e10.
    /// @param dstGasPrice Current gas price on destination chain, in wei.
    /// @param priceBuffer Per-chain upward adjustment in basis points to absorb gas-price
    ///                    drift between quote issuance and destination execution.
    /// @param baseFee     Flat fee in source chain native currency to perform execution, in wei.
    struct PricingData {
        uint64 dstPrice;
        uint64 dstGasPrice;
        uint64 priceBuffer;
        uint64 baseFee;
    }

    /// @notice Compute the required source-chain payment for executing a delivery on `dstChain`.
    /// @dev `requestBytes` is `abi.encode(uint256 msgValue)` — the amount to forward on the
    ///      destination chain, denominated in destination native token.
    ///      `relayInstructions` is `abi.encode(uint256 gasLimit)` — the gas limit for the
    ///      destination-side execution. `dstAddr` and `refundAddr` are accepted for
    ///      WormholeSDK ABI compatibility but are not used in the fee computation.
    function requestQuote(
        uint16 dstChain,
        bytes32 dstAddr,
        address refundAddr,
        bytes calldata requestBytes,
        bytes calldata relayInstructions
    ) external view returns (uint256);

    function requestExecutionQuote(
        uint16 dstChain,
        bytes32 dstAddr,
        address refundAddr,
        bytes calldata requestBytes,
        bytes calldata relayInstructions
    ) external returns (uint256, bytes32, bytes32);

    function isAuthorizedQuoter(address quoter) external view returns (bool);
}
