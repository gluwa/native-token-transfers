// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import {console2} from "forge-std/Script.sol";

import {DeployWormholeNttBase} from "../helpers/DeployWormholeNttBase.sol";
import {
    PenguinBridgeExecutionQuoter
} from "../../src/SpecialRelayer/PenguinBridgeExecutionQuoter.sol";
import {SpecialRelayer} from "../../src/SpecialRelayer/SpecialRelayer.sol";
import {DummyToken} from "../../src/mocks/DummyToken.sol";
import {IManagerBase} from "../../src/interfaces/IManagerBase.sol";
import "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";

import "./helpers/E2EConfig.sol";

/// @notice Step 1 (source chain): deploy quoter, SpecialRelayer, and NTT stack; seed mock pricing.
///
/// Run against the **source** RPC with `--broadcast`.
///
/// Required env:
///   RELEASE_CORE_BRIDGE_ADDRESS, RELEASE_WORMHOLE_RELAYER_ADDRESS
///   RELEASE_WORMHOLE_CHAIN_ID, RELEASE_CONSISTENCY_LEVEL, RELEASE_GAS_LIMIT
///   E2E_DST_WORMHOLE_CHAIN_ID          — destination Wormhole chain id (for quoter pricing)
///   E2E_QUOTE_SIGNER_PRIVATE_KEY       — key registered in quoter.authorizedQuoters
///
/// Optional env:
///   RELEASE_TOKEN_ADDRESS              — existing ERC20 (locking mode). If unset and
///                                        E2E_DEPLOY_MOCK_TOKEN=true, deploys DummyToken.
///   RELEASE_DECIMALS                   — defaults to 18 when deploying mock token
///   E2E_PAYEE_ADDRESS                  — fee recipient (defaults to quote signer)
///   E2E_ORACLE_SERVICE                 — oracle caller (defaults to broadcaster)
///
/// Prints deployed addresses as `export E2E_SRC_*=...` lines for later steps.
contract DeploySrcContracts is Script, DeployWormholeNttBase, E2EConfig {
    function run() public {
        uint16 srcChainId = wormholeChainIdFromEnv();
        uint16 dstChainId = uint16(vm.envUint("E2E_DST_WORMHOLE_CHAIN_ID"));
        require(dstChainId != 0, "E2E_DST_WORMHOLE_CHAIN_ID required");

        address oracle = vm.envOr("E2E_ORACLE_SERVICE", msg.sender);
        address payee = payeeFromEnv();
        uint256 quoteSignerKey = vm.envUint("E2E_QUOTE_SIGNER_PRIVATE_KEY");
        address quoteSigner = vm.addr(quoteSignerKey);

        vm.startBroadcast();

        address token = vm.envOr("RELEASE_TOKEN_ADDRESS", address(0));
        if (token == address(0)) {
            require(
                vm.envOr("E2E_DEPLOY_MOCK_TOKEN", false),
                "Set RELEASE_TOKEN_ADDRESS or E2E_DEPLOY_MOCK_TOKEN=true"
            );
            token = address(new DummyToken());
        }
        console2.log("Token:", token);

        uint8 decimals = uint8(vm.envOr("RELEASE_DECIMALS", uint256(18)));
        _mockTokenDecimalsIfNeeded(token, decimals);

        PenguinBridgeExecutionQuoter quoter = new PenguinBridgeExecutionQuoter();
        quoter.setOracleService(oracle);
        quoter.setPayeeAddress(bytes32(uint256(uint160(payee))));
        quoter.addQuoter(quoteSigner);
        console2.log("PenguinBridgeExecutionQuoter:", address(quoter));

        vm.stopBroadcast();

        vm.startBroadcast(oracle);
        pushDefaultQuoterPrice(quoter, dstChainId);
        vm.stopBroadcast();

        vm.startBroadcast();

        SpecialRelayer specialRelayer = new SpecialRelayer();
        specialRelayer.setExecutionQuoter(address(quoter));
        specialRelayer.setSourceChainId(srcChainId);
        console2.log("SpecialRelayer:", address(specialRelayer));

        DeploymentParams memory params = DeploymentParams({
            token: token,
            mode: IManagerBase.Mode.LOCKING,
            wormholeChainId: srcChainId,
            rateLimitDuration: 86400,
            shouldSkipRatelimiter: false,
            wormholeCoreBridge: vm.envAddress("RELEASE_CORE_BRIDGE_ADDRESS"),
            wormholeRelayerAddr: vm.envAddress("RELEASE_WORMHOLE_RELAYER_ADDRESS"),
            specialRelayerAddr: address(specialRelayer),
            consistencyLevel: uint8(vm.envUint("RELEASE_CONSISTENCY_LEVEL")),
            gasLimit: vm.envOr("RELEASE_GAS_LIMIT", E2E_DEFAULT_GAS_LIMIT),
            outboundLimit: type(uint64).max * _tokenScale(decimals)
        });

        address manager = deployNttManager(params, vm.envOr("MANAGER_VARIANT", string("standard")));
        address transceiver = deployWormholeTransceiver(params, manager);
        configureNttManager(
            manager, transceiver, params.outboundLimit, params.shouldSkipRatelimiter
        );

        logSrcDeployment(
            ChainDeployment({
                wormholeChainId: srcChainId,
                token: token,
                quoter: address(quoter),
                specialRelayer: address(specialRelayer),
                nttManager: manager,
                wormholeTransceiver: transceiver
            })
        );

        vm.stopBroadcast();
    }

    function _mockTokenDecimalsIfNeeded(
        address token,
        uint8 decimals
    ) internal {
        (bool success,) = token.staticcall(abi.encodeWithSignature("decimals()"));
        if (!success) {
            vm.mockCall(
                token, abi.encodeWithSelector(ERC20.decimals.selector), abi.encode(decimals)
            );
        }
    }

    function _tokenScale(
        uint8 decimals
    ) internal pure returns (uint256) {
        return decimals > TRIMMED_DECIMALS ? uint256(10 ** (decimals - TRIMMED_DECIMALS)) : 1;
    }
}
