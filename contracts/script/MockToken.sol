// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/**
 * A throwaway ERC20 for demonstrating a second pair on a testnet.
 *
 * Base Sepolia does not have a bridged cbBTC or DEGEN the way Base mainnet
 * does, so a second real pair is not available to test against without a
 * mainnet fork. This stands in for one: fixed supply-less, mint is open to
 * anyone, because the only thing it needs to prove is that Bone Dry's pool
 * and hook do not care which two tokens they are handed. It is not meant to
 * be, and must never be treated as, anything other than a Sepolia fixture.
 */
contract MockToken {
    string public name;
    string public symbol;
    uint8 public immutable decimals;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory _name, string memory _symbol, uint8 _decimals) {
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
    }

    /// @dev Open on purpose: this is a Sepolia demo fixture, not a real asset.
    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}
