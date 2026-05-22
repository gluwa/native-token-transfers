// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.19 <0.9.0;

import "openzeppelin-contracts/contracts/access/Ownable2Step.sol";
import "openzeppelin-contracts/contracts/security/ReentrancyGuard.sol";
import "openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol";

import "../interfaces/IPenguinBridgeExecutionQuoter.sol";
import "../interfaces/ISpecialRelayer.sol";

/// @title SpecialRelayer
/// @notice NTT special relayer that quotes dynamic quoter fees and accepts execution requests.
///         A backend service listens for ExecutionRequested events and relays the request to
///         the destination chain.
///
/// @dev Deploy one per source chain. Set this contract's address as the WormholeTransceiver's
///      specialRelayer at deploy time, then enable special relaying per destination chain via
///      transceiver.setIsSpecialRelayingEnabled(chainId, true).
contract SpecialRelayer is ISpecialRelayer, Ownable2Step, ReentrancyGuard {
    using ECDSA for bytes32;

    bytes4 public constant SIGNED_QUOTE_PREFIX = 0x50513031; // "PQ01"
    uint256 public constant SIGNED_QUOTE_BODY_LENGTH = 132;
    uint256 public constant SIGNED_QUOTE_LENGTH = SIGNED_QUOTE_BODY_LENGTH + 65;

    /// @notice Canonical execution pricing source and quote signer registry.
    IPenguinBridgeExecutionQuoter public penguinBridgeExecutionQuoter;

    /// @notice Wormhole chain id of the chain this relayer is deployed on.
    ///         Signed quotes must encode a matching srcChain or they are rejected,
    ///         preventing cross-chain replay of quotes signed for a different source.
    ///         Must be set before signed-quote execution requests are accepted.
    uint16 public sourceChainId;

    /// @notice Emitted when an execution is requested. The relayer backend should watch this
    ///         and submit the request to the destination chain using `relayInstructions` for
    ///         the gas budget. `relayInstructions` is `abi.encode(uint256 gasLimit)` and the
    ///         contract verifies it matches the gasLimit committed in the signed quote, so
    ///         the relayer cannot under-deliver gas after the fee is collected.
    event ExecutionRequested(
        uint16 indexed dstChain, bytes32 indexed dstAddr, bytes requestBytes, bytes relayInstructions
    );

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
        uint256 gasLimit;
        uint256 requiredPayment;
    }

    error InsufficientPayment(uint256 required, uint256 received);
    error RefundFailed(address recipient, uint256 amount);
    error InvalidQuoteLength(uint256 length);
    error InvalidQuotePrefix(bytes4 prefix);
    error InvalidQuoteSourceChain(uint16 expected, uint16 actual);
    error InvalidQuoteTargetChain(uint16 expected, uint16 actual);
    error QuoteExpired(uint64 expiryTime);
    error InvalidQuoteSigner(address signer);
    error InvalidPayeeAddress(bytes32 payeeAddress);
    error QuotePaymentFailed(address payee, uint256 payment);
    error RelayInstructionsGasLimitMismatch(uint256 expected, uint256 actual);
    error SourceChainIdNotSet();
    error ExecutionQuoterNotSet();
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
        if (address(executionQuoter) == address(0)) {
            revert ExecutionQuoterNotSet();
        }
        return executionQuoter.requestQuote(
            targetChain, dstAddr, address(0), abi.encode(additionalValue), relayInstructions
        );
    }

    /// @inheritdoc ISpecialRelayer
    function requestExecution(
        uint16 dstChain,
        bytes32 dstAddr,
        address, /* refundAddr — accepted for WormholeSDK ABI parity, unused */
        bytes calldata signedQuoteBytes,
        bytes calldata requestBytes,
        bytes calldata relayInstructions
    ) external payable nonReentrant {
        _validateAndPay(dstChain, signedQuoteBytes, relayInstructions);
        emit ExecutionRequested(dstChain, dstAddr, requestBytes, relayInstructions);
    }

    function _validateAndPay(uint16 dstChain, bytes calldata signedQuoteBytes, bytes calldata relayInstructions)
        internal
    {
        IPenguinBridgeExecutionQuoter executionQuoter = penguinBridgeExecutionQuoter;
        if (address(executionQuoter) == address(0)) {
            revert ExecutionQuoterNotSet();
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
        if (q.signedTargetChain != dstChain) {
            revert InvalidQuoteTargetChain(dstChain, q.signedTargetChain);
        }
        if (block.timestamp > q.expiryTime) {
            revert QuoteExpired(q.expiryTime);
        }
        if (msg.value < q.requiredPayment) {
            revert InsufficientPayment(q.requiredPayment, msg.value);
        }

        // relayInstructions encodes abi.encode(uint256 gasLimit); verify it matches the
        // gasLimit the quoter signed so the relayer cannot under-deliver gas after the fee
        // is collected.
        uint256 instructedGasLimit = abi.decode(relayInstructions, (uint256));
        if (instructedGasLimit != q.gasLimit) {
            revert RelayInstructionsGasLimitMismatch(q.gasLimit, instructedGasLimit);
        }

        address signer = _recoverQuoteSigner(signedQuoteBytes);
        if (signer != q.quotedQuoter || !executionQuoter.isAuthorizedQuoter(signer)) {
            revert InvalidQuoteSigner(signer);
        }

        if (uint256(q.universalPayeeAddress) > type(uint160).max) {
            revert InvalidPayeeAddress(q.universalPayeeAddress);
        }
        address payee = address(uint160(uint256(q.universalPayeeAddress)));
        // Fall back to the contract owner when the signer leaves the payee unset.
        if (payee == address(0)) {
            payee = owner();
        }

        // Forward exactly the quoted amount to the payee; refund any excess to the
        // caller so users aren't penalized for overpaying.
        (bool paid,) = payable(payee).call{value: q.requiredPayment}("");
        if (!paid) {
            revert QuotePaymentFailed(payee, q.requiredPayment);
        }

        uint256 refund = msg.value - q.requiredPayment;
        if (refund > 0) {
            (bool refunded,) = payable(msg.sender).call{value: refund}("");
            if (!refunded) {
                revert RefundFailed(msg.sender, refund);
            }
        }
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
        uint256 gasLimit;
        uint256 requiredPayment;
        assembly {
            let data := add(signedQuoteBytes, 32)
            prefix := mload(data)
            quotedQuoterRaw := shr(96, mload(add(data, 4)))
            universalPayeeAddress := mload(add(data, 24))
            signedSourceChain := shr(240, mload(add(data, 56)))
            signedTargetChain := shr(240, mload(add(data, 58)))
            expiryTime := shr(192, mload(add(data, 60)))
            gasLimit := mload(add(data, 68))
            requiredPayment := mload(add(data, 100))
        }
        q.prefix = prefix;
        q.quotedQuoter = address(quotedQuoterRaw);
        q.universalPayeeAddress = universalPayeeAddress;
        q.signedSourceChain = signedSourceChain;
        q.signedTargetChain = signedTargetChain;
        q.expiryTime = expiryTime;
        q.gasLimit = gasLimit;
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

    /// @notice Set the canonical execution quoter that signs and prices executions.
    function setExecutionQuoter(address executionQuoter) external onlyOwner {
        penguinBridgeExecutionQuoter = IPenguinBridgeExecutionQuoter(executionQuoter);
        emit ExecutionQuoterSet(executionQuoter);
    }

    /// @notice Set the Wormhole chain id of the chain this relayer is deployed on.
    ///         Required before signed-quote execution requests will be accepted, since
    ///         the signed quote's srcChain must match this value.
    function setSourceChainId(uint16 chainId) external onlyOwner {
        sourceChainId = chainId;
        emit SourceChainIdSet(chainId);
    }

    /// @notice Withdraw native balance to the contract owner.
    function withdraw() external {
        (bool ok,) = owner().call{value: address(this).balance}("");
        if (!ok) {
            revert WithdrawFailed();
        }
    }

    /// @notice Allow the contract to receive native token.
    receive() external payable {}
}
