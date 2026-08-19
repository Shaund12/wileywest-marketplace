// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
// v5 moved ReentrancyGuard from security/ to utils/
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";

import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";

interface IVibeFeeProcessor {
    function convertHeldERC20ToVTRUAndForward(address tokenIn, uint256 amountIn)
        external
        returns (uint256 outWVTRU, uint256 outNative);

    function forwardNative() external payable returns (uint256 amountForwarded);
}

contract VTRUNFTMarketplace is ReentrancyGuard, Ownable, IERC721Receiver, IERC1155Receiver {
    using SafeERC20 for IERC20;

    // ---------- Fees ----------
    uint256 public platformFeeBps = 250;     // 2.5%
    uint16  public vibeShareBps   = 10_000;  // 100% to VIBE by default
    address public feeRecipient;

    IVibeFeeProcessor public feeProcessor;

    // ---------- Listings ----------
    uint256 private _nextListingId;
    struct Listing {
        address seller;
        address nftContract;
        uint256 tokenId;
        uint256 quantity;
        uint256 pricePerUnit;
        address paymentToken; // address(0) = native
        bool isERC1155;
        bool active;
    }
    mapping(uint256 => Listing) public listings;

    // ---------- Auctions ----------
    uint256 private _nextAuctionId;
    struct Auction {
        address seller;
        address nftContract;
        uint256 tokenId;
        uint256 quantity;
        bool    isERC1155;
        address paymentToken;     // address(0) = native
        uint256 reservePrice;
        uint256 startPrice;
        uint256 highestBid;
        address highestBidder;
        uint64  startTime;
        uint64  endTime;
        uint32  minIncrementBps;  // e.g., 500=5%
        uint32  antiSnipeWindow;  // seconds
        bool    settled;
        bool    started;
    }
    // ✅ fixed: removed stray '>'
    mapping(uint256 => Auction) public auctions;

    // ---------- Events (sales/auctions/fees) ----------
    event ListingCreated(
        uint256 indexed listingId,
        address indexed seller,
        address indexed nftContract,
        uint256 tokenId,
        uint256 quantity,
        uint256 pricePerUnit,
        address paymentToken,
        bool isERC1155
    );
    event ListingUpdated(uint256 indexed listingId, uint256 newPricePerUnit);
    event ListingCanceled(uint256 indexed listingId);
    event NFTPurchased(
        uint256 indexed listingId,
        address indexed buyer,
        uint256 quantity,
        uint256 totalPrice,
        address paymentToken
    );

    event SaleBreakdown(
        uint256 indexed listingId,
        address indexed buyer,
        address indexed seller,
        address nftContract,
        uint256 tokenId,
        bool isERC1155,
        uint256 quantity,
        address paymentToken,
        bool isNative,
        uint256 unitPrice,
        uint256 totalPrice,
        uint256 platformFeeBps,
        uint16  vibeShareBps,
        uint256 platformFeeTotal,
        uint256 vibePortionInPayment,
        uint256 feeRecipientPortionInPayment,
        uint256 royaltyAmount,
        address royaltyReceiver,
        uint256 sellerProceeds,
        uint256 vibeOutWVTRU,
        uint256 vibeOutNative
    );

    event RoyaltyPaid(
        address indexed nftContract,
        uint256 indexed tokenId,
        address indexed receiver,
        address paymentToken,
        bool isNative,
        uint256 amount
    );

    event AuctionCreated(
        uint256 indexed auctionId,
        address indexed seller,
        address indexed nftContract,
        uint256 tokenId,
        uint256 quantity,
        address paymentToken,
        uint256 reservePrice,
        uint256 startPrice,
        uint64  startTime,
        uint64  endTime,
        uint32  minIncrementBps,
        uint32  antiSnipeWindow
    );
    event AuctionBid(uint256 indexed auctionId, address indexed bidder, uint256 amount, uint64 newEndTimeIfExtended);
    event AuctionBidPlaced(
        uint256 indexed auctionId,
        address indexed bidder,
        address paymentToken,
        bool isNative,
        uint256 amount,
        uint256 previousBidRefunded,
        uint64  newEndTime
    );
    event AuctionCanceled(uint256 indexed auctionId);
    event AuctionSettled(uint256 indexed auctionId, address indexed winner, uint256 finalPrice, address paymentToken);

    event AuctionBreakdown(
        uint256 indexed auctionId,
        address indexed winner,
        address indexed seller,
        address nftContract,
        uint256 tokenId,
        bool isERC1155,
        uint256 quantity,
        address paymentToken,
        bool isNative,
        uint256 finalPrice,
        uint256 platformFeeBps,
        uint16  vibeShareBps,
        uint256 platformFeeTotal,
        uint256 vibePortionInPayment,
        uint256 feeRecipientPortionInPayment,
        uint256 royaltyAmount,
        address royaltyReceiver,
        uint256 sellerProceeds,
        uint256 vibeOutWVTRU,
        uint256 vibeOutNative
    );

    event PlatformFeeUpdated(uint256 newBps);
    event FeeRecipientUpdated(address newRecipient);
    event VibeShareUpdated(uint16 newBps);
    event FeeProcessorUpdated(address processor);
    event Withdrawn(address to, address token, uint256 amount);

    constructor(address _feeRecipient, address _feeProcessor) Ownable(msg.sender) {
        require(_feeRecipient != address(0) && _feeProcessor != address(0), "zero");
        feeRecipient = _feeRecipient;
        feeProcessor = IVibeFeeProcessor(_feeProcessor);
        _nextListingId = 1;
        _nextAuctionId = 1;
    }

    // ---------- Admin ----------
    function setPlatformFeeBps(uint256 bps) external onlyOwner {
        require(bps <= 1000, "fee too high");
        platformFeeBps = bps;
        emit PlatformFeeUpdated(bps);
    }
    function setVibeShareBps(uint16 bps) external onlyOwner {
        require(bps <= 10_000, "bad bps");
        vibeShareBps = bps;
        emit VibeShareUpdated(bps);
    }
    function setFeeRecipient(address recipient) external onlyOwner {
        require(recipient != address(0), "zero");
        feeRecipient = recipient;
        emit FeeRecipientUpdated(recipient);
    }
    function setFeeProcessor(address processor) external onlyOwner {
        require(processor != address(0), "zero");
        feeProcessor = IVibeFeeProcessor(processor);
        emit FeeProcessorUpdated(processor);
    }

    // ---------- Listings ----------
    function createListing(
        address nftContract,
        uint256 tokenId,
        uint256 quantity,
        uint256 pricePerUnit,
        address paymentToken
    ) external nonReentrant returns (uint256) {
        require(pricePerUnit > 0, "price zero");
        bool isERC1155 = ERC165Checker.supportsInterface(nftContract, type(IERC1155).interfaceId);
        bool isERC721 = ERC165Checker.supportsInterface(nftContract, type(IERC721).interfaceId);
        require(isERC1155 || isERC721, "not NFT");

        if (isERC721) {
            require(quantity == 1, "ERC721 qty 1");
            require(IERC721(nftContract).ownerOf(tokenId) == msg.sender, "not owner");
        } else {
            uint256 bal = IERC1155(nftContract).balanceOf(msg.sender, tokenId);
            require(quantity > 0 && quantity <= bal, "invalid qty");
        }

        uint256 listingId = _nextListingId++;
        listings[listingId] = Listing({
            seller: msg.sender,
            nftContract: nftContract,
            tokenId: tokenId,
            quantity: (isERC1155 ? quantity : 1),
            pricePerUnit: pricePerUnit,
            paymentToken: paymentToken,
            isERC1155: isERC1155,
            active: true
        });

        emit ListingCreated(
            listingId,
            msg.sender,
            nftContract,
            tokenId,
            (isERC1155 ? quantity : 1),
            pricePerUnit,
            paymentToken,
            isERC1155
        );
        return listingId;
    }

    function updateListingPrice(uint256 listingId, uint256 newPricePerUnit) external nonReentrant {
        Listing storage l = listings[listingId];
        require(l.active, "inactive");
        require(l.seller == msg.sender, "not seller");
        require(newPricePerUnit > 0, "zero price");
        l.pricePerUnit = newPricePerUnit;
        emit ListingUpdated(listingId, newPricePerUnit);
    }

    function cancelListing(uint256 listingId) external nonReentrant {
        Listing storage l = listings[listingId];
        require(l.active, "already inactive");
        require(l.seller == msg.sender, "not seller");
        l.active = false;
        emit ListingCanceled(listingId);
    }

    // ---------- Purchases ----------
    struct FeeCtx {
        uint256 platformFee;
        address royaltyReceiver;
        uint256 royaltyAmount;
        uint256 sellerProceeds;
    }

    function _royaltyInfo(address nft, uint256 tokenId, uint256 salePrice) private view returns (address receiver, uint256 amount) {
        if (ERC165Checker.supportsInterface(nft, type(IERC2981).interfaceId)) {
            try IERC2981(nft).royaltyInfo(tokenId, salePrice) returns (address _r, uint256 _a) {
                if (_r != address(0) && _a > 0) return (_r, _a);
            } catch {}
        }
        return (address(0), 0);
    }

    function buy(uint256 listingId, uint256 buyQuantity) external payable nonReentrant {
        Listing storage l = listings[listingId];
        require(l.active, "inactive");
        require(buyQuantity > 0, "zero qty");
        if (l.isERC1155) require(buyQuantity <= l.quantity, "not enough");
        else require(buyQuantity == 1, "721 qty=1");

        uint256 totalPrice = l.pricePerUnit * buyQuantity;

        FeeCtx memory f;
        f.platformFee = (totalPrice * platformFeeBps) / 10_000;
        (f.royaltyReceiver, f.royaltyAmount) = _royaltyInfo(l.nftContract, l.tokenId, totalPrice);
        f.sellerProceeds = totalPrice - f.platformFee - f.royaltyAmount;

        uint256 toVibe  = (f.platformFee * vibeShareBps) / 10_000;
        uint256 toRecip = f.platformFee - toVibe;

        uint256 vibeOutWVTRU = 0;
        uint256 vibeOutNative = 0;

        if (l.paymentToken == address(0)) {
            require(msg.value == totalPrice, "wrong msg.value");

            // forward VIBE portion (native)
            if (toVibe > 0) {
                uint256 forwarded = feeProcessor.forwardNative{value: toVibe}();
                vibeOutWVTRU = forwarded; // numerically same as native amount
                vibeOutNative = forwarded;
            }
            if (toRecip > 0) _sendNative(payable(feeRecipient), toRecip);

            if (f.royaltyAmount > 0) {
                _sendNative(payable(f.royaltyReceiver), f.royaltyAmount);
                emit RoyaltyPaid(l.nftContract, l.tokenId, f.royaltyReceiver, address(0), true, f.royaltyAmount);
            }
            _sendNative(payable(l.seller), f.sellerProceeds);
        } else {
            IERC20 pay = IERC20(l.paymentToken);
            pay.safeTransferFrom(msg.sender, address(this), totalPrice);

            // VIBE portion: send to processor then convert+forward
            if (toVibe > 0) {
                pay.safeTransfer(address(feeProcessor), toVibe);
                (vibeOutWVTRU, vibeOutNative) = feeProcessor.convertHeldERC20ToVTRUAndForward(l.paymentToken, toVibe);
            }
            if (toRecip > 0) pay.safeTransfer(feeRecipient, toRecip);

            if (f.royaltyAmount > 0) {
                pay.safeTransfer(f.royaltyReceiver, f.royaltyAmount);
                emit RoyaltyPaid(l.nftContract, l.tokenId, f.royaltyReceiver, l.paymentToken, false, f.royaltyAmount);
            }
            pay.safeTransfer(l.seller, f.sellerProceeds);
        }

        // Transfer NFT
        if (l.isERC1155) {
            IERC1155(l.nftContract).safeTransferFrom(l.seller, msg.sender, l.tokenId, buyQuantity, "");
            l.quantity -= buyQuantity;
            if (l.quantity == 0) l.active = false;
        } else {
            IERC721(l.nftContract).safeTransferFrom(l.seller, msg.sender, l.tokenId);
            l.active = false;
        }

        emit NFTPurchased(listingId, msg.sender, buyQuantity, totalPrice, l.paymentToken);
        emit SaleBreakdown(
            listingId,
            msg.sender,
            l.seller,
            l.nftContract,
            l.tokenId,
            l.isERC1155,
            buyQuantity,
            l.paymentToken,
            l.paymentToken == address(0),
            l.pricePerUnit,
            totalPrice,
            platformFeeBps,
            vibeShareBps,
            f.platformFee,
            toVibe,
            toRecip,
            f.royaltyAmount,
            f.royaltyReceiver,
            f.sellerProceeds,
            vibeOutWVTRU,
            vibeOutNative
        );
    }

    // ---------- Auctions ----------
    function createAuction(
        address nftContract,
        uint256 tokenId,
        uint256 quantity,
        bool    isERC1155,
        address paymentToken,
        uint256 reservePrice,
        uint256 startPrice,
        uint64  startTime,
        uint64  endTime,
        uint32  minIncrementBps,
        uint32  antiSnipeWindow
    ) external nonReentrant returns (uint256 auctionId) {
        require(endTime > startTime, "bad times");
        require(startPrice > 0, "zero start");
        require(minIncrementBps <= 10_000, "bad minInc");
        require(nftContract != address(0), "nft zero");

        if (isERC1155) {
            require(quantity > 0, "qty zero");
            IERC1155(nftContract).safeTransferFrom(msg.sender, address(this), tokenId, quantity, "");
        } else {
            require(quantity == 1, "721 qty=1");
            IERC721(nftContract).safeTransferFrom(msg.sender, address(this), tokenId);
        }

        auctionId = _nextAuctionId++;
        auctions[auctionId] = Auction({
            seller: msg.sender,
            nftContract: nftContract,
            tokenId: tokenId,
            quantity: (isERC1155 ? quantity : 1),
            isERC1155: isERC1155,
            paymentToken: paymentToken,
            reservePrice: reservePrice,
            startPrice: startPrice,
            highestBid: 0,
            highestBidder: address(0),
            startTime: startTime,
            endTime: endTime,
            minIncrementBps: minIncrementBps,
            antiSnipeWindow: antiSnipeWindow,
            settled: false,
            started: false
        });

        emit AuctionCreated(
            auctionId, msg.sender, nftContract, tokenId, (isERC1155 ? quantity : 1),
            paymentToken, reservePrice, startPrice, startTime, endTime, minIncrementBps, antiSnipeWindow
        );
    }

    function bid(uint256 auctionId, uint256 amount) external payable nonReentrant {
        Auction storage a = auctions[auctionId];
        require(a.seller != address(0), "no auction");
        require(block.timestamp >= a.startTime, "not started");
        require(block.timestamp < a.endTime, "ended");
        if (!a.started) a.started = true;

        uint256 minAllowed = a.highestBid == 0
            ? a.startPrice
            : a.highestBid + (a.highestBid * a.minIncrementBps) / 10_000;

        uint256 prevRefund = 0;
        uint64 newEndTime = 0;

        if (a.paymentToken == address(0)) {
            require(amount == 0, "amount unused");
            require(msg.value >= minAllowed, "bid too low");
            if (a.highestBidder != address(0)) {
                prevRefund = a.highestBid;
                _sendNative(payable(a.highestBidder), a.highestBid);
            }
            a.highestBidder = msg.sender;
            a.highestBid = msg.value;
        } else {
            require(msg.value == 0, "no native");
            require(amount >= minAllowed, "bid too low");
            IERC20 t = IERC20(a.paymentToken);
            t.safeTransferFrom(msg.sender, address(this), amount);
            if (a.highestBidder != address(0) && a.highestBid > 0) {
                prevRefund = a.highestBid;
                t.safeTransfer(a.highestBidder, a.highestBid);
            }
            a.highestBidder = msg.sender;
            a.highestBid = amount;
        }

        if (a.antiSnipeWindow > 0 && a.endTime - block.timestamp <= a.antiSnipeWindow) {
            a.endTime = uint64(block.timestamp + a.antiSnipeWindow);
            newEndTime = a.endTime;
        }

        emit AuctionBid(auctionId, msg.sender, a.highestBid, newEndTime);
        emit AuctionBidPlaced(auctionId, msg.sender, a.paymentToken, a.paymentToken == address(0), a.highestBid, prevRefund, newEndTime);
    }

    function cancelAuction(uint256 auctionId) external nonReentrant {
        Auction storage a = auctions[auctionId];
        require(a.seller != address(0), "no auction");
        require(a.seller == msg.sender, "not seller");
        require(a.highestBidder == address(0), "already bid");
        require(!a.settled, "settled");
        if (a.isERC1155) {
            IERC1155(a.nftContract).safeTransferFrom(address(this), a.seller, a.tokenId, a.quantity, "");
        } else {
            IERC721(a.nftContract).safeTransferFrom(address(this), a.seller, a.tokenId);
        }
        delete auctions[auctionId];
        emit AuctionCanceled(auctionId);
    }

    function settleAuction(uint256 auctionId) external nonReentrant {
        Auction storage a = auctions[auctionId];
        require(a.seller != address(0), "no auction");
        require(block.timestamp >= a.endTime, "not ended");
        require(!a.settled, "settled");
        a.settled = true;

        address winner = a.highestBidder;
        uint256 finalPrice = a.highestBid;

        if (winner == address(0) || finalPrice < a.reservePrice) {
            if (a.isERC1155) IERC1155(a.nftContract).safeTransferFrom(address(this), a.seller, a.tokenId, a.quantity, "");
            else IERC721(a.nftContract).safeTransferFrom(address(this), a.seller, a.tokenId);
            emit AuctionSettled(auctionId, address(0), 0, a.paymentToken);
            delete auctions[auctionId];
            return;
        }

        // fees/royalties
        uint256 platformFee = (finalPrice * platformFeeBps) / 10_000;
        (address royaltyReceiver, uint256 royaltyAmount) = _royaltyInfo(a.nftContract, a.tokenId, finalPrice);
        uint256 sellerProceeds = finalPrice - platformFee - royaltyAmount;

        uint256 toVibe  = (platformFee * vibeShareBps) / 10_000;
        uint256 toRecip = platformFee - toVibe;

        uint256 vibeOutWVTRU = 0;
        uint256 vibeOutNative = 0;

        if (a.paymentToken == address(0)) {
            if (toVibe > 0) {
                uint256 fwd = feeProcessor.forwardNative{value: toVibe}();
                vibeOutWVTRU = fwd;
                vibeOutNative = fwd;
            }
            if (toRecip > 0) _sendNative(payable(feeRecipient), toRecip);
            if (royaltyAmount > 0) {
                _sendNative(payable(royaltyReceiver), royaltyAmount);
                emit RoyaltyPaid(a.nftContract, a.tokenId, royaltyReceiver, address(0), true, royaltyAmount);
            }
            _sendNative(payable(a.seller), sellerProceeds);
        } else {
            IERC20 t = IERC20(a.paymentToken);
            if (toVibe > 0) {
                t.safeTransfer(address(feeProcessor), toVibe);
                (vibeOutWVTRU, vibeOutNative) = feeProcessor.convertHeldERC20ToVTRUAndForward(a.paymentToken, toVibe);
            }
            if (toRecip > 0) t.safeTransfer(feeRecipient, toRecip);
            if (royaltyAmount > 0) {
                t.safeTransfer(royaltyReceiver, royaltyAmount);
                emit RoyaltyPaid(a.nftContract, a.tokenId, royaltyReceiver, a.paymentToken, false, royaltyAmount);
            }
            t.safeTransfer(a.seller, sellerProceeds);
        }

        // deliver NFT
        if (a.isERC1155) IERC1155(a.nftContract).safeTransferFrom(address(this), winner, a.tokenId, a.quantity, "");
        else IERC721(a.nftContract).safeTransferFrom(address(this), winner, a.tokenId);

        emit AuctionSettled(auctionId, winner, finalPrice, a.paymentToken);
        emit AuctionBreakdown(
            auctionId,
            winner,
            a.seller,
            a.nftContract,
            a.tokenId,
            a.isERC1155,
            a.quantity,
            a.paymentToken,
            a.paymentToken == address(0),
            finalPrice,
            platformFeeBps,
            vibeShareBps,
            platformFee,
            toVibe,
            toRecip,
            royaltyAmount,
            royaltyReceiver,
            sellerProceeds,
            vibeOutWVTRU,
            vibeOutNative
        );

        delete auctions[auctionId];
    }

    // ---------- Utils / Withdraw ----------
    receive() external payable {}
    fallback() external payable {}

    function _sendNative(address payable to, uint256 amount) private {
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "native send fail");
    }

    function withdraw(address token, uint256 amount, address to) external onlyOwner {
        require(to != address(0), "zero");
        if (token == address(0)) {
            (bool ok, ) = payable(to).call{value: amount}("");
            require(ok, "native withdraw failed");
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
        emit Withdrawn(to, token, amount);
    }

    // Receivers
    function onERC721Received(address, address, uint256, bytes calldata) external pure override returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
    function onERC1155Received(address, address, uint256, uint256, bytes calldata)
        external pure override returns (bytes4)
    { return IERC1155Receiver.onERC1155Received.selector; }
    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external pure override returns (bytes4)
    { return IERC1155Receiver.onERC1155BatchReceived.selector; }

    function supportsInterface(bytes4 interfaceId) public pure returns (bool) {
        return
            interfaceId == type(IERC165).interfaceId ||
            interfaceId == type(IERC721Receiver).interfaceId ||
            interfaceId == type(IERC1155Receiver).interfaceId;
    }
}
