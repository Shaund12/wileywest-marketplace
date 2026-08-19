// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

contract MockNFT is ERC721, IERC2981 {
    uint256 public next = 1;
    address public royaltyReceiver;
    uint96 public royaltyBps;

    constructor() ERC721("Mock", "MOCK") {}

    function mint(address to) external returns (uint256 id) {
        id = next++;
        _mint(to, id);
    }

    function setRoyalty(address r, uint96 bps) external {
        royaltyReceiver = r;
        royaltyBps = bps;
    }

    function royaltyInfo(uint256, uint256 salePrice)
        external view override returns (address, uint256)
    {
        if (royaltyReceiver == address(0)) return (address(0), 0);
        return (royaltyReceiver, (salePrice * royaltyBps) / 10_000);
    }

    function supportsInterface(bytes4 id) public view override(ERC721, IERC165) returns (bool) {
        return id == type(IERC2981).interfaceId || super.supportsInterface(id);
    }
}

contract MockERC20 is ERC20 {
    constructor() ERC20("Mock", "MTK") {}
    function mint(address to, uint256 amt) external { _mint(to, amt); }
}

/// Stands in for the Vibe processor; just accepts and keeps whatever it gets.
contract MockFeeProcessor {
    function forwardNative() external payable returns (uint256) { return msg.value; }
    function convertHeldERC20ToVTRUAndForward(address, uint256 amountIn)
        external pure returns (uint256, uint256) { return (amountIn, amountIn); }
}
