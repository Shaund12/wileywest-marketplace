// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IMkt {
    function buy(uint256 listingId, uint256 buyQuantity) external payable;
    function updateListingPrice(uint256 listingId, uint256 newPricePerUnit) external;
    function cancelListing(uint256 listingId) external;
}

/// Malicious seller: on receiving sale proceeds, re-enters the marketplace
/// through a DIFFERENT function than buy(). nonReentrant on buy() does not
/// stop this, because cancelListing/updateListingPrice carry their own guard.
contract ReentrantSeller {
    IMkt public mkt;
    uint256 public listingId;
    bool public fired;
    bool public reenterSucceeded;

    function set(address _mkt, uint256 _id) external { mkt = IMkt(_mkt); listingId = _id; }

    receive() external payable {
        if (!fired) {
            fired = true;
            // Re-enter mid-buy, before buy() has marked the listing inactive.
            try mkt.updateListingPrice(listingId, 1 ether) {
                reenterSucceeded = true;
            } catch {}
        }
    }
}
