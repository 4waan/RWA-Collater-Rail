// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockHtsToken {
    int64 public constant SUCCESS = 22;

    int32 public decimals = 6;
    bool public deleted;
    bool public defaultKycStatus;
    bool public paused;
    uint256 public fixedFees;
    uint256 public fractionalFees;
    uint256 public royaltyFees;
    int64 public associateResponse = SUCCESS;
    int64 public metadataResponse = SUCCESS;
    int64 public feeResponse = SUCCESS;
    int64 public allowanceResponse = SUCCESS;
    int64 public frozenResponse = SUCCESS;
    int64 public kycResponse = SUCCESS;
    int64 public transferFromResponse = SUCCESS;
    int64 public transferResponse = SUCCESS;
    int256 public inboundDeltaAdjustment;
    int256 public outboundDeltaAdjustment;

    mapping(address account => uint256 amount) public balanceOf;
    mapping(address owner => mapping(address spender => uint256 amount)) public allowance;
    mapping(address account => bool status) public frozen;
    mapping(address account => bool status) public kyc;

    function setMetadata(int32 decimals_, bool deleted_, bool defaultKycStatus_, bool paused_) external {
        decimals = decimals_;
        deleted = deleted_;
        defaultKycStatus = defaultKycStatus_;
        paused = paused_;
    }

    function setFeeCounts(uint256 fixedFees_, uint256 fractionalFees_, uint256 royaltyFees_) external {
        fixedFees = fixedFees_;
        fractionalFees = fractionalFees_;
        royaltyFees = royaltyFees_;
    }

    function setResponses(
        int64 associateResponse_,
        int64 allowanceResponse_,
        int64 frozenResponse_,
        int64 kycResponse_,
        int64 transferFromResponse_,
        int64 transferResponse_
    ) external {
        associateResponse = associateResponse_;
        allowanceResponse = allowanceResponse_;
        frozenResponse = frozenResponse_;
        kycResponse = kycResponse_;
        transferFromResponse = transferFromResponse_;
        transferResponse = transferResponse_;
    }

    function setQueryResponses(int64 metadataResponse_, int64 feeResponse_) external {
        metadataResponse = metadataResponse_;
        feeResponse = feeResponse_;
    }

    function setBalance(address account, uint256 amount) external {
        balanceOf[account] = amount;
    }

    function setAllowance(address account, address spender, uint256 amount) external {
        allowance[account][spender] = amount;
    }

    function setFrozen(address account, bool status) external {
        frozen[account] = status;
    }

    function setKyc(address account, bool status) external {
        kyc[account] = status;
    }

    function setDeltaAdjustments(int256 inbound, int256 outbound) external {
        inboundDeltaAdjustment = inbound;
        outboundDeltaAdjustment = outbound;
    }

    function transferFromFor(address caller, address from, address to, uint256 amount) external returns (int64) {
        if (transferFromResponse != SUCCESS) return transferFromResponse;
        uint256 actualAmount = _adjust(amount, inboundDeltaAdjustment);
        if (allowance[from][caller] < amount || balanceOf[from] < actualAmount) return 1;
        allowance[from][caller] -= amount;
        balanceOf[from] -= actualAmount;
        balanceOf[to] += actualAmount;
        return SUCCESS;
    }

    function transferFor(address from, address to, uint256 amount) external returns (int64) {
        if (transferResponse != SUCCESS) return transferResponse;
        uint256 actualAmount = _adjust(amount, outboundDeltaAdjustment);
        if (balanceOf[from] < actualAmount) return 1;
        balanceOf[from] -= actualAmount;
        balanceOf[to] += actualAmount;
        return SUCCESS;
    }

    function _adjust(uint256 amount, int256 adjustment) internal pure returns (uint256) {
        if (adjustment >= 0) return amount + uint256(adjustment);
        uint256 reduction = uint256(-adjustment);
        return reduction > amount ? 0 : amount - reduction;
    }
}
