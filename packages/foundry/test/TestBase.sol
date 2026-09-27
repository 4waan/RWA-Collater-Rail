// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface Vm {
    function deal(address account, uint256 newBalance) external;
    function prank(address sender) external;
    function startPrank(address sender) external;
    function stopPrank() external;
    function warp(uint256 newTimestamp) external;
    function expectRevert(bytes4 selector) external;
    function expectRevert(bytes calldata revertData) external;
    function expectRevert() external;
    function mockCall(address callee, bytes calldata data, bytes calldata returnData) external;
}

abstract contract TestBase {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    error AssertionFailed();
    error AssertionEqUint(uint256 left, uint256 right);
    error AssertionEqAddress(address left, address right);
    error AssertionEqBytes32(bytes32 left, bytes32 right);

    function assertTrue(bool condition) internal pure {
        if (!condition) revert AssertionFailed();
    }

    function assertFalse(bool condition) internal pure {
        if (condition) revert AssertionFailed();
    }

    function assertEq(uint256 left, uint256 right) internal pure {
        if (left != right) revert AssertionEqUint(left, right);
    }

    function assertEq(address left, address right) internal pure {
        if (left != right) revert AssertionEqAddress(left, right);
    }

    function assertEq(bytes32 left, bytes32 right) internal pure {
        if (left != right) revert AssertionEqBytes32(left, right);
    }
}

abstract contract StdInvariantBase {
    struct FuzzSelector {
        address addr;
        bytes4[] selectors;
    }

    struct FuzzArtifactSelector {
        string artifact;
        bytes4[] selectors;
    }

    struct FuzzInterface {
        address addr;
        string[] artifacts;
    }

    address[] private _excludedContracts;
    address[] private _excludedSenders;
    address[] private _targetedContracts;
    address[] private _targetedSenders;

    string[] private _excludedArtifacts;
    string[] private _targetedArtifacts;

    FuzzArtifactSelector[] private _targetedArtifactSelectors;
    FuzzSelector[] private _excludedSelectors;
    FuzzSelector[] private _targetedSelectors;
    FuzzInterface[] private _targetedInterfaces;

    function targetContract(address target) internal {
        _targetedContracts.push(target);
    }

    function targetSelector(FuzzSelector memory selector) internal {
        _targetedSelectors.push(selector);
    }

    function targetContracts() public view returns (address[] memory) {
        return _targetedContracts;
    }

    function excludeContracts() public view returns (address[] memory) {
        return _excludedContracts;
    }

    function excludeSenders() public view returns (address[] memory) {
        return _excludedSenders;
    }

    function targetSenders() public view returns (address[] memory) {
        return _targetedSenders;
    }

    function excludeArtifacts() public view returns (string[] memory) {
        return _excludedArtifacts;
    }

    function targetArtifacts() public view returns (string[] memory) {
        return _targetedArtifacts;
    }

    function targetArtifactSelectors() public view returns (FuzzArtifactSelector[] memory) {
        return _targetedArtifactSelectors;
    }

    function excludeSelectors() public view returns (FuzzSelector[] memory) {
        return _excludedSelectors;
    }

    function targetSelectors() public view returns (FuzzSelector[] memory) {
        return _targetedSelectors;
    }

    function targetInterfaces() public view returns (FuzzInterface[] memory) {
        return _targetedInterfaces;
    }
}
