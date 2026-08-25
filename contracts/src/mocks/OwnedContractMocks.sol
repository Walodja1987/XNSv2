// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IOwnableContract} from "../interfaces/IOwnableContract.sol";

/// @dev Target with OpenZeppelin-style `owner()` (public getter).
contract MockOwnableTarget {
    address public owner;

    constructor(address owner_) {
        owner = owner_;
    }
}

/// @dev Target with `getOwner()` only (no `owner()`).
contract MockGetOwnerTarget {
    address private immutable _owner;

    constructor(address owner_) {
        _owner = owner_;
    }

    function getOwner() external view returns (address) {
        return _owner;
    }
}

/// @dev Target where `owner()` reverts and `getOwner()` succeeds.
contract MockOwnerRevertsTarget {
    address private immutable _owner;

    constructor(address owner_) {
        _owner = owner_;
    }

    function owner() external pure {
        revert("MockOwnerRevertsTarget: owner reverts");
    }

    function getOwner() external view returns (address) {
        return _owner;
    }
}

/// @dev Target with neither `owner()` nor `getOwner()`.
contract MockNoOwnerTarget {
    receive() external payable {}
}

/// @dev Implementation holding `owner()` for proxy-style tests.
contract MockOwnableImplementation {
    address public owner;

    constructor(address owner_) {
        owner = owner_;
    }
}

/// @dev Proxy that exposes `owner()` by reading the implementation (common delegate/static pattern).
contract MockOwnableProxy {
    address public immutable implementation;

    constructor(address implementation_) {
        implementation = implementation_;
    }

    function owner() external view returns (address) {
        return IOwnableContract(implementation).owner();
    }
}
