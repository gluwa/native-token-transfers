// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.19 <0.9.0;

import "openzeppelin-contracts/contracts/access/Ownable2Step.sol";

import "../interfaces/IPenguinBridgeExecutionQuoter.sol";

/// @title PenguinBridgeExecutionQuoter
/// @notice On-chain execution price source for SpecialRelayer delivery quotes.
contract PenguinBridgeExecutionQuoter is IPenguinBridgeExecutionQuoter, Ownable2Step {
    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Source chain native token USD price, scaled by 1e10.
    uint64 public sourcePrice;

    /// @notice Address allowed to push price updates.
    address public oracleService;

    /// @notice Universal source-chain address that receives execution payments.
    ///         If unset, payments fall back to the contract owner.
    bytes32 public payeeAddress;

    mapping(uint16 => PricingData) public pricingData;
    mapping(address => bool) public authorizedQuoters;

    event OracleServiceSet(address indexed oracleService);
    event PayeeAddressSet(bytes32 indexed payeeAddress);
    event PriceUpdated(uint64 sourcePrice, uint16 indexed chainId, PricingData price);
    event ExecutionQuoteRequested(uint16 indexed dstChain, uint256 requiredPayment);
    event QuoterAdded(address indexed quoter);
    event QuoterRemoved(address indexed quoter);

    error CallerNotOracleService(address caller);
    error LengthMismatch();
    error SourcePriceNotSet();

    modifier onlyOracleService() {
        if (msg.sender != oracleService) {
            revert CallerNotOracleService(msg.sender);
        }
        _;
    }

    constructor() Ownable() {}

    function setOracleService(
        address newOracleService
    ) external onlyOwner {
        oracleService = newOracleService;
        emit OracleServiceSet(newOracleService);
    }

    function setPayeeAddress(
        bytes32 newPayeeAddress
    ) external onlyOwner {
        payeeAddress = newPayeeAddress;
        emit PayeeAddressSet(newPayeeAddress);
    }

    function addQuoter(
        address quoter
    ) external onlyOwner {
        authorizedQuoters[quoter] = true;
        emit QuoterAdded(quoter);
    }

    function removeQuoter(
        address quoter
    ) external onlyOwner {
        authorizedQuoters[quoter] = false;
        emit QuoterRemoved(quoter);
    }

    function isAuthorizedQuoter(
        address quoter
    ) external view returns (bool) {
        return authorizedQuoters[quoter];
    }

    function priceUpdate(
        uint64 newSourcePrice,
        uint16 chainId,
        PricingData calldata price
    ) external onlyOracleService {
        sourcePrice = newSourcePrice;
        pricingData[chainId] = price;
        emit PriceUpdated(newSourcePrice, chainId, price);
    }

    function batchPriceUpdate(
        uint64 newSourcePrice,
        uint16[] calldata chainIds,
        PricingData[] calldata prices
    ) external onlyOracleService {
        if (chainIds.length != prices.length) {
            revert LengthMismatch();
        }

        sourcePrice = newSourcePrice;
        for (uint256 i = 0; i < chainIds.length; i++) {
            pricingData[chainIds[i]] = prices[i];
            emit PriceUpdated(newSourcePrice, chainIds[i], prices[i]);
        }
    }

    function requestQuote(
        uint16 dstChain,
        bytes32,
        address,
        bytes calldata requestBytes,
        bytes calldata relayInstructions
    ) external view returns (uint256) {
        return _quote(dstChain, _decodeUint256(requestBytes), _decodeUint256(relayInstructions));
    }

    function requestExecutionQuote(
        uint16 dstChain,
        bytes32,
        address,
        bytes calldata requestBytes,
        bytes calldata relayInstructions
    ) external returns (uint256, bytes32, bytes32) {
        uint256 requiredPayment =
            _quote(dstChain, _decodeUint256(requestBytes), _decodeUint256(relayInstructions));
        emit ExecutionQuoteRequested(dstChain, requiredPayment);
        bytes32 payee = payeeAddress;
        if (payee == bytes32(0)) {
            payee = bytes32(uint256(uint160(owner())));
        }
        return (requiredPayment, payee, bytes32(0));
    }

    function _quote(
        uint16 dstChain,
        uint256 msgValue,
        uint256 gasLimit
    ) internal view returns (uint256) {
        uint256 srcPrice = sourcePrice;
        if (srcPrice == 0) {
            revert SourcePriceNotSet();
        }
        PricingData memory price = pricingData[dstChain];
        unchecked {
            uint256 fee = price.baseFee + gasLimit * price.dstGasPrice * price.dstPrice / srcPrice;
            return msgValue * price.dstPrice / srcPrice + fee
                * (BPS_DENOMINATOR + price.priceBuffer) / BPS_DENOMINATOR;
        }
    }

    function _decodeUint256(
        bytes calldata encoded
    ) internal pure returns (uint256 value) {
        if (encoded.length < 32) {
            return 0;
        }
        assembly {
            value := calldataload(encoded.offset)
        }
    }
}
