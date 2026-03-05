// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "openzeppelin-contracts/contracts/access/Ownable.sol";

import "../interfaces/ISpecialRelayer.sol";

/// @title SpecialRelayer
/// @notice NTT special relayer that quotes a configurable fee and accepts delivery requests.
///         A backend service listens for DeliveryRequested events and relays VAAs to the
///         destination chain by calling the transceiver's receiveMessage(bytes).
///
/// @dev Deploy one per source chain. Set this contract's address as the WormholeTransceiver's
///      specialRelayer at deploy time, then enable special relaying per destination chain via
///      transceiver.setIsSpecialRelayingEnabled(chainId, true).
contract SpecialRelayer is ISpecialRelayer, Ownable {
    /// @notice Default delivery fee in wei when no per-chain fee is set.
    uint256 public defaultDeliveryFee;

    /// @notice Per-chain delivery fee override (target chain id => fee in wei).
    ///         If zero for a chain, defaultDeliveryFee is used.
    mapping(uint16 => uint256) public deliveryFeePerChain;

    /// @notice Address that receives withdrawn fees. If zero, withdraw sends to owner().
    address public feeRecipient;

    /// @notice Emitted when a delivery is requested. The relayer backend should watch this,
    ///         fetch the VAA for the given sequence from the Wormhole core (emitter = source
    ///         chain's WormholeTransceiver), then call transceiver.receiveMessage(vaa) on the
    ///         target chain.
    /// @param sourceContract NTT manager token address (as passed by the transceiver).
    /// @param targetChain Wormhole chain id of the destination.
    /// @param sequence Wormhole message sequence; use with source chain id to fetch the VAA.
    /// @param payment Value received for this delivery (relayer fee).
    event DeliveryRequested(
        address indexed sourceContract,
        uint16 indexed targetChain,
        uint64 indexed sequence,
        uint256 payment
    );

    /// @notice Emitted when the default delivery fee is updated.
    event DefaultDeliveryFeeSet(uint256 fee);

    /// @notice Emitted when a per-chain delivery fee is set.
    event DeliveryFeeSet(uint16 chainId, uint256 fee);

    /// @notice Emitted when the fee recipient is updated.
    event FeeRecipientSet(address indexed recipient);

    error InsufficientPayment(uint256 required, uint256 received);
    error LengthMismatch();

    constructor() Ownable() {}

    /// @inheritdoc ISpecialRelayer
    function quoteDeliveryPrice(
        address /* sourceContract */,
        uint16 targetChain,
        uint256 /* additionalValue */
    ) external view returns (uint256 nativePriceQuote) {
        uint256 fee = deliveryFeePerChain[targetChain];
        if (fee == 0) {
            fee = defaultDeliveryFee;
        }
        return fee;
    }

    /// @inheritdoc ISpecialRelayer
    function requestDelivery(
        address sourceContract,
        uint16 targetChain,
        uint256 /* additionalValue */,
        uint64 sequence
    ) external payable {
        uint256 required = this.quoteDeliveryPrice(sourceContract, targetChain, 0);
        if (msg.value < required) {
            revert InsufficientPayment(required, msg.value);
        }

        emit DeliveryRequested(sourceContract, targetChain, sequence, msg.value);
        // Any excess value stays in the contract and can be withdrawn by owner.
    }

    /// @notice Set the default delivery fee (used when no per-chain fee is set).
    function setDefaultDeliveryFee(uint256 fee) external onlyOwner {
        defaultDeliveryFee = fee;
        emit DefaultDeliveryFeeSet(fee);
    }

    /// @notice Set the delivery fee for a specific target chain. Use 0 to fall back to default.
    function setDeliveryFee(uint16 chainId, uint256 fee) external onlyOwner {
        deliveryFeePerChain[chainId] = fee;
        emit DeliveryFeeSet(chainId, fee);
    }

    /// @notice Set delivery fees for multiple target chains in one call. Use 0 for a fee to fall back to default.
    function setDeliveryFees(uint16[] calldata chainIds, uint256[] calldata fees) external onlyOwner {
        if (chainIds.length != fees.length) revert LengthMismatch();
        for (uint256 i = 0; i < chainIds.length; i++) {
            deliveryFeePerChain[chainIds[i]] = fees[i];
            emit DeliveryFeeSet(chainIds[i], fees[i]);
        }
    }

    /// @notice Set the address that receives withdrawn fees. Pass address(0) to use owner().
    function setFeeRecipient(address recipient) external onlyOwner {
        feeRecipient = recipient;
        emit FeeRecipientSet(recipient);
    }

    /// @notice Withdraw native balance to the fee recipient, or to the owner if fee recipient is not set.
    function withdraw() external {
        address to = feeRecipient != address(0) ? feeRecipient : owner();
        (bool ok,) = to.call{value: address(this).balance}("");
        require(ok, "SpecialRelayer: withdraw failed");
    }

    /// @notice Allow the contract to receive native token.
    receive() external payable {}
}
