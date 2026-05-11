// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.19 <0.9.0;

import "openzeppelin-contracts/contracts/access/Ownable.sol";
import "openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol";

import "../interfaces/IPenguinBridgeExecutionQuoter.sol";
import "../interfaces/ISpecialRelayer.sol";

/// @title SpecialRelayer
/// @notice NTT special relayer that quotes dynamic quoter fees and accepts delivery requests.
///         A backend service listens for DeliveryRequested events and relays VAAs to the
///         destination chain by calling the transceiver's receiveMessage(bytes).
///
/// @dev Deploy one per source chain. Set this contract's address as the WormholeTransceiver's
///      specialRelayer at deploy time, then enable special relaying per destination chain via
///      transceiver.setIsSpecialRelayingEnabled(chainId, true).
contract SpecialRelayer is ISpecialRelayer, Ownable {
    using ECDSA for bytes32;

    /// @notice Minimum fee that can be set. Deploy a new relayer to change this.
    uint256 public constant MINIMUM_FEE = 1;

    bytes4 public constant SIGNED_QUOTE_PREFIX = 0x50513031; // "PQ01"
    uint256 public constant SIGNED_QUOTE_BODY_LENGTH = 100;
    uint256 public constant SIGNED_QUOTE_LENGTH = SIGNED_QUOTE_BODY_LENGTH + 65;

    /// @notice Default delivery fee in wei when no per-chain fee is set.
    uint256 public defaultDeliveryFee;

    /// @notice Per-chain delivery fee override (target chain id => fee in wei).
    ///         If zero for a chain, defaultDeliveryFee is used.
    mapping(uint16 => uint256) public deliveryFeePerChain;

    /// @notice Address that receives withdrawn fees. If zero, withdraw sends to owner().
    address public feeRecipient;

    /// @notice Canonical execution pricing source and quote signer registry.
    IPenguinBridgeExecutionQuoter public penguinBridgeExecutionQuoter;

    /// @notice Wormhole chain id of the chain this relayer is deployed on.
    ///         Signed quotes must encode a matching srcChain or they are rejected,
    ///         preventing cross-chain replay of quotes signed for a different source.
    ///         Must be set before signed-quote delivery is accepted.
    uint16 public sourceChainId;

    /// @notice Emitted when a delivery is requested. The relayer backend should watch this,
    ///         fetch the VAA for the given sequence from the Wormhole core (emitter = source
    ///         chain's WormholeTransceiver), then call transceiver.receiveMessage(vaa) on the
    ///         target chain.
    /// @param sourceContract NTT manager token address (as passed by the transceiver).
    /// @param targetChain Wormhole chain id of the destination.
    /// @param sequence Wormhole message sequence; use with source chain id to fetch the VAA.
    /// @param payment Value received for this delivery (relayer fee).
    event DeliveryRequested(
        address indexed sourceContract, uint16 indexed targetChain, uint64 indexed sequence, uint256 payment
    );

    /// @notice Emitted when the default delivery fee is updated.
    event DefaultDeliveryFeeSet(uint256 fee);

    /// @notice Emitted when a per-chain delivery fee is set.
    event DeliveryFeeSet(uint16 chainId, uint256 fee);

    /// @notice Emitted when the fee recipient is updated.
    event FeeRecipientSet(address indexed recipient);

    /// @notice Emitted when the execution quoter is updated.
    event ExecutionQuoterSet(address indexed executionQuoter);

    /// @notice Emitted when the source chain id is set.
    event SourceChainIdSet(uint16 sourceChainId);

    /// @dev Decoded fields from a signed quote payload.
    struct ParsedQuote {
        bytes4 prefix;
        address quotedQuoter;
        bytes32 universalPayeeAddress;
        uint16 signedSourceChain;
        uint16 signedTargetChain;
        uint64 expiryTime;
        uint256 requiredPayment;
    }

    error InsufficientPayment(uint256 required, uint256 received);
    error FeeBelowMinimum(uint256 fee, uint256 minimum);
    error LengthMismatch();
    error InvalidQuoteLength(uint256 length);
    error InvalidQuotePrefix(bytes4 prefix);
    error InvalidQuoteSourceChain(uint16 expected, uint16 actual);
    error InvalidQuoteTargetChain(uint16 expected, uint16 actual);
    error QuoteExpired(uint64 expiryTime);
    error InvalidQuoteSigner(address signer);
    error InvalidPayeeAddress(bytes32 payeeAddress);
    error QuotePaymentFailed(address payee, uint256 payment);
    error SignedQuoteRequired();
    error SourceChainIdNotSet();
    error WithdrawFailed();

    constructor() Ownable() {}

    /// @inheritdoc ISpecialRelayer
    function quoteDeliveryPrice(
        address,
        /* sourceContract */
        uint16 targetChain,
        uint256 /* additionalValue */
    )
        external
        view
        returns (uint256 nativePriceQuote)
    {
        return _quoteDeliveryPrice(targetChain, 0, bytes32(0), new bytes(0));
    }

    /// @inheritdoc ISpecialRelayer
    function quoteDeliveryPrice(
        address,
        /* sourceContract */
        uint16 targetChain,
        uint256 additionalValue,
        bytes32 dstAddr,
        bytes calldata relayInstructions
    ) external view returns (uint256 nativePriceQuote) {
        return _quoteDeliveryPrice(targetChain, additionalValue, dstAddr, relayInstructions);
    }

    function _quoteDeliveryPrice(
        uint16 targetChain,
        uint256 additionalValue,
        bytes32 dstAddr,
        bytes memory relayInstructions
    ) internal view returns (uint256 nativePriceQuote) {
        IPenguinBridgeExecutionQuoter executionQuoter = penguinBridgeExecutionQuoter;
        if (address(executionQuoter) != address(0)) {
            return executionQuoter.requestQuote(
                targetChain, dstAddr, address(0), abi.encode(additionalValue), relayInstructions
            );
        }

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
        uint256,
        /* additionalValue */
        uint64 sequence
    )
        external
        payable
    {
        _requestDelivery(sourceContract, targetChain, sequence, new bytes(0));
    }

    /// @inheritdoc ISpecialRelayer
    function requestDelivery(
        address sourceContract,
        uint16 targetChain,
        uint256,
        /* additionalValue */
        uint64 sequence,
        bytes calldata signedQuoteBytes
    ) external payable {
        _requestDelivery(sourceContract, targetChain, sequence, signedQuoteBytes);
    }

    function _requestDelivery(
        address sourceContract,
        uint16 targetChain,
        uint64 sequence,
        bytes memory signedQuoteBytes
    ) internal {
        IPenguinBridgeExecutionQuoter executionQuoter = penguinBridgeExecutionQuoter;
        if (address(executionQuoter) == address(0)) {
            uint256 fallbackRequired = this.quoteDeliveryPrice(sourceContract, targetChain, 0);
            if (msg.value < fallbackRequired) {
                revert InsufficientPayment(fallbackRequired, msg.value);
            }

            emit DeliveryRequested(sourceContract, targetChain, sequence, msg.value);
            // Any excess value stays in the contract and can be withdrawn by owner.
            return;
        }

        if (signedQuoteBytes.length == 0) {
            revert SignedQuoteRequired();
        }

        uint16 expectedSrcChain = sourceChainId;
        if (expectedSrcChain == 0) {
            revert SourceChainIdNotSet();
        }

        ParsedQuote memory q = _parseSignedQuote(signedQuoteBytes);

        if (q.prefix != SIGNED_QUOTE_PREFIX) {
            revert InvalidQuotePrefix(q.prefix);
        }
        if (q.signedSourceChain != expectedSrcChain) {
            revert InvalidQuoteSourceChain(expectedSrcChain, q.signedSourceChain);
        }
        if (q.signedTargetChain != targetChain) {
            revert InvalidQuoteTargetChain(targetChain, q.signedTargetChain);
        }
        if (block.timestamp > q.expiryTime) {
            revert QuoteExpired(q.expiryTime);
        }
        if (msg.value < q.requiredPayment) {
            revert InsufficientPayment(q.requiredPayment, msg.value);
        }

        address signer = _recoverQuoteSigner(signedQuoteBytes);
        if (signer != q.quotedQuoter || !executionQuoter.isAuthorizedQuoter(signer)) {
            revert InvalidQuoteSigner(signer);
        }

        if (uint256(q.universalPayeeAddress) > type(uint160).max) {
            revert InvalidPayeeAddress(q.universalPayeeAddress);
        }
        address payee = address(uint160(uint256(q.universalPayeeAddress)));
        (bool ok,) = payable(payee).call{value: msg.value}("");
        if (!ok) {
            revert QuotePaymentFailed(payee, msg.value);
        }

        emit DeliveryRequested(sourceContract, targetChain, sequence, msg.value);
    }

    function _parseSignedQuote(bytes memory signedQuoteBytes) internal pure returns (ParsedQuote memory q) {
        if (signedQuoteBytes.length != SIGNED_QUOTE_LENGTH) {
            revert InvalidQuoteLength(signedQuoteBytes.length);
        }

        bytes4 prefix;
        uint160 quotedQuoterRaw;
        bytes32 universalPayeeAddress;
        uint16 signedSourceChain;
        uint16 signedTargetChain;
        uint64 expiryTime;
        uint256 requiredPayment;
        assembly {
            let data := add(signedQuoteBytes, 32)
            prefix := mload(data)
            quotedQuoterRaw := shr(96, mload(add(data, 4)))
            universalPayeeAddress := mload(add(data, 24))
            signedSourceChain := shr(240, mload(add(data, 56)))
            signedTargetChain := shr(240, mload(add(data, 58)))
            expiryTime := shr(192, mload(add(data, 60)))
            requiredPayment := mload(add(data, 68))
        }
        q.prefix = prefix;
        q.quotedQuoter = address(quotedQuoterRaw);
        q.universalPayeeAddress = universalPayeeAddress;
        q.signedSourceChain = signedSourceChain;
        q.signedTargetChain = signedTargetChain;
        q.expiryTime = expiryTime;
        q.requiredPayment = requiredPayment;
    }

    function _recoverQuoteSigner(bytes memory signedQuoteBytes) internal pure returns (address) {
        bytes32 hash;
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            let data := add(signedQuoteBytes, 32)
            hash := keccak256(data, SIGNED_QUOTE_BODY_LENGTH)
            r := mload(add(data, SIGNED_QUOTE_BODY_LENGTH))
            s := mload(add(data, add(SIGNED_QUOTE_BODY_LENGTH, 32)))
            v := byte(0, mload(add(data, add(SIGNED_QUOTE_BODY_LENGTH, 64))))
        }
        return hash.recover(v, r, s);
    }

    /// @notice Set the execution quoter. Pass address(0) to use fixed-fee fallback mode.
    function setExecutionQuoter(address executionQuoter) external onlyOwner {
        penguinBridgeExecutionQuoter = IPenguinBridgeExecutionQuoter(executionQuoter);
        emit ExecutionQuoterSet(executionQuoter);
    }

    /// @notice Set the Wormhole chain id of the chain this relayer is deployed on.
    ///         Required before signed-quote delivery requests will be accepted, since
    ///         the signed quote's srcChain must match this value.
    function setSourceChainId(uint16 chainId) external onlyOwner {
        sourceChainId = chainId;
        emit SourceChainIdSet(chainId);
    }

    /// @notice Set the default delivery fee (used when no per-chain fee is set).
    function setDefaultDeliveryFee(uint256 fee) external onlyOwner {
        if (fee < MINIMUM_FEE) {
            revert FeeBelowMinimum(fee, MINIMUM_FEE);
        }
        defaultDeliveryFee = fee;
        emit DefaultDeliveryFeeSet(fee);
    }

    /// @notice Set the delivery fee for a specific target chain. Use 0 to fall back to default.
    function setDeliveryFee(uint16 chainId, uint256 fee) external onlyOwner {
        if (fee != 0 && fee < MINIMUM_FEE) {
            revert FeeBelowMinimum(fee, MINIMUM_FEE);
        }
        deliveryFeePerChain[chainId] = fee;
        emit DeliveryFeeSet(chainId, fee);
    }

    /// @notice Set delivery fees for multiple target chains in one call. Use 0 for a fee to fall back to default.
    function setDeliveryFees(uint16[] calldata chainIds, uint256[] calldata fees) external onlyOwner {
        if (chainIds.length != fees.length) {
            revert LengthMismatch();
        }
        for (uint256 i = 0; i < chainIds.length; i++) {
            if (fees[i] != 0 && fees[i] < MINIMUM_FEE) {
                revert FeeBelowMinimum(fees[i], MINIMUM_FEE);
            }
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
        if (!ok) {
            revert WithdrawFailed();
        }
    }

    /// @notice Allow the contract to receive native token.
    receive() external payable {}
}
