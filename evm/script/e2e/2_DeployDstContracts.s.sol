// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import {console2} from "forge-std/Script.sol";

import {DeployWormholeNttBase} from "../helpers/DeployWormholeNttBase.sol";
import {DummyToken, DummyTokenMintAndBurn} from "../../src/mocks/DummyToken.sol";
import {IManagerBase} from "../../src/interfaces/IManagerBase.sol";
import "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";

import "./helpers/E2EConfig.sol";

/// @notice Step 2 (destination chain): deploy NTT stack (burning mode, no SpecialRelayer).
///
/// Run against the **destination** RPC with `--broadcast`.
///
/// Required env:
///   RELEASE_CORE_BRIDGE_ADDRESS, RELEASE_WORMHOLE_RELAYER_ADDRESS
///   RELEASE_WORMHOLE_CHAIN_ID, RELEASE_CONSISTENCY_LEVEL, RELEASE_GAS_LIMIT
///
/// Optional env:
///   RELEASE_TOKEN_ADDRESS              — existing burnable ERC20. If unset and
///                                        E2E_DEPLOY_MOCK_TOKEN=true, deploys DummyTokenMintAndBurn.
///   RELEASE_DECIMALS                   — defaults to 18 when deploying mock token
///
/// Prints deployed addresses as `export E2E_DST_*=...` lines for later steps.
contract DeployDstContracts is Script, DeployWormholeNttBase, E2EConfig {
    function run() public {
        uint16 dstChainId = wormholeChainIdFromEnv();

        vm.startBroadcast();

        address token = vm.envOr("RELEASE_TOKEN_ADDRESS", address(0));
        if (token == address(0)) {
            require(
                vm.envOr("E2E_DEPLOY_MOCK_TOKEN", false),
                "Set RELEASE_TOKEN_ADDRESS or E2E_DEPLOY_MOCK_TOKEN=true"
            );
            token = address(new DummyTokenMintAndBurn());
        }
        console2.log("Token:", token);

        uint8 decimals = uint8(vm.envOr("RELEASE_DECIMALS", uint256(18)));
        _mockTokenDecimalsIfNeeded(token, decimals);

        DeploymentParams memory params = DeploymentParams({
            token: token,
            mode: IManagerBase.Mode.BURNING,
            wormholeChainId: dstChainId,
            rateLimitDuration: 86400,
            shouldSkipRatelimiter: false,
            wormholeCoreBridge: vm.envAddress("RELEASE_CORE_BRIDGE_ADDRESS"),
            wormholeRelayerAddr: vm.envAddress("RELEASE_WORMHOLE_RELAYER_ADDRESS"),
            specialRelayerAddr: address(0),
            consistencyLevel: uint8(vm.envUint("RELEASE_CONSISTENCY_LEVEL")),
            gasLimit: vm.envOr("RELEASE_GAS_LIMIT", E2E_DEFAULT_GAS_LIMIT),
            outboundLimit: type(uint64).max * _tokenScale(decimals)
        });

        address manager = deployNttManager(params, vm.envOr("MANAGER_VARIANT", string("standard")));
        console2.log("NttManager (proxy):", manager);

        address transceiver = deployWormholeTransceiver(params, manager);
        console2.log("WormholeTransceiver (proxy):", transceiver);

        configureNttManager(
            manager, transceiver, params.outboundLimit, params.shouldSkipRatelimiter
        );

        logDstDeployment(
            ChainDeployment({
                wormholeChainId: dstChainId,
                token: token,
                quoter: address(0),
                specialRelayer: address(0),
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
