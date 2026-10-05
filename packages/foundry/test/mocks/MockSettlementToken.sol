// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockSettlementToken {
    uint8 public constant decimals = 6;
    enum Mode {
        SUCCESS,
        FALSE_VALUE,
        REVERT_CALL,
        EMPTY_RETURN,
        SHORT_DELTA
    }

    mapping(address account => uint256 amount) public balanceOf;
    mapping(address owner => mapping(address spender => uint256 amount)) public allowance;
    Mode public mode;

    error MockTransferReverted();
    error InsufficientBalance();
    error InsufficientAllowance();

    function mint(address account, uint256 amount) external {
        balanceOf[account] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function setMode(Mode mode_) external {
        mode = mode_;
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        return _transfer(msg.sender, recipient, amount);
    }

    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool) {
        uint256 available = allowance[sender][msg.sender];
        if (available < amount) revert InsufficientAllowance();
        allowance[sender][msg.sender] = available - amount;
        return _transfer(sender, recipient, amount);
    }

    function _transfer(address sender, address recipient, uint256 amount) private returns (bool) {
        if (mode == Mode.REVERT_CALL) revert MockTransferReverted();
        if (mode == Mode.FALSE_VALUE) return false;
        if (mode == Mode.EMPTY_RETURN) {
            assembly {
                return(0, 0)
            }
        }
        uint256 debit = mode == Mode.SHORT_DELTA && amount > 1 ? amount - 1 : amount;
        if (balanceOf[sender] < debit) revert InsufficientBalance();
        balanceOf[sender] -= debit;
        balanceOf[recipient] += debit;
        return true;
    }
}
