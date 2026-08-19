// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

interface IVibeFeeProcessor {
    function convertHeldERC20ToVTRUAndForward(address tokenIn, uint256 amountIn)
        external
        returns (uint256 outWVTRU, uint256 outNative);

    function forwardNative() external payable returns (uint256 amountForwarded);
}

/**
 * @title BlockDustMarketplace
 * @notice Fixed-price NFT marketplace. Successor to VTRUNFTMarketplace.
 *
 * Two deliberate differences from its predecessor:
 *
 * 1. NON-CUSTODIAL BY CONSTRUCTION.
 *    There is no code path by which this contract holds user value.
 *    `buy` settles atomically: the buyer's payment is split to the VIBE
 *    processor, the fee recipient, the royalty receiver, and the seller
 *    inside a single transaction, and the NFT moves seller -> buyer
 *    directly. The seller keeps custody of the NFT until it sells.
 *
 *    The predecessor's auctions escrowed both the NFT (`createAuction`)
 *    and bid funds (`bid`), and it carried an owner `withdraw` that could
 *    sweep any balance. All of that is removed. There is no `withdraw`,
 *    and no payable `receive`/`fallback`: native currency sent outside of
 *    `buy` reverts rather than accumulating an unrecoverable balance.
 *
 * 2. UPGRADEABLE (UUPS).
 *    The predecessor was a plain contract, so fixing anything on-chain
 *    meant a redeploy and a migration. Upgrades here are authorized by
 *    the owner; see docs/upgrade-ownership.md for the multisig plan.
 */
contract BlockDustMarketplace is
    Initializable,
    UUPSUpgradeable,
    OwnableUpgradeable,
    ReentrancyGuardUpgradeable
{
    using SafeERC20 for IERC20;

    // ---------- Fees ----------
    uint256 public platformFeeBps;
    uint16  public vibeShareBps;
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

    /// @dev Storage gap so future versions can add state without colliding
    ///      with anything appended below in an upgrade.
    uint256[45] private __gap;

    // ---------- Events ----------
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
    /// @dev Grouped into a struct: as 21 flat parameters this emit could not
    ///      be compiled without exhausting the EVM stack.
    struct SaleTerms {
        address nftContract;
        uint256 tokenId;
        bool    isERC1155;
        uint256 quantity;
        address paymentToken;
        bool    isNative;
        uint256 pricePerUnit;
        uint256 totalPrice;
        uint256 platformFeeBpsUsed;
        uint16  vibeShareBpsUsed;
        uint256 platformFee;
        uint256 toVibe;
        uint256 toFeeRecipient;
        uint256 royaltyAmount;
        address royaltyReceiver;
        uint256 sellerProceeds;
        uint256 vibeOutWVTRU;
        uint256 vibeOutNative;
    }

    event SaleBreakdown(
        uint256 indexed listingId,
        address indexed buyer,
        address indexed seller,
        SaleTerms terms
    );

    event RoyaltyPaid(
        address indexed nftContract,
        uint256 indexed tokenId,
        address indexed receiver,
        address paymentToken,
        bool isNative,
        uint256 amount
    );
    event PlatformFeeUpdated(uint256 newBps);
    event FeeRecipientUpdated(address newRecipient);
    event VibeShareUpdated(uint16 newBps);
    event FeeProcessorUpdated(address processor);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _feeRecipient, address _feeProcessor) external initializer {
        require(_feeRecipient != address(0) && _feeProcessor != address(0), "zero");

        __UUPSUpgradeable_init();
        __Ownable_init(msg.sender);
        __ReentrancyGuard_init();

        feeRecipient = _feeRecipient;
        feeProcessor = IVibeFeeProcessor(_feeProcessor);

        // Explicit defaults. The predecessor defaulted vibeShareBps to
        // 10_000 and relied on the deploy script to zero it; that ordering
        // is a footgun, so the safe value is set here instead.
        platformFeeBps = 250; // 2.5%
        vibeShareBps = 0;

        _nextListingId = 1;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    /// @notice Version marker; bump on each deployed implementation.
    function version() external pure returns (string memory) {
        return "2.0.0";
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

    function _royaltyInfo(address nft, uint256 tokenId, uint256 salePrice)
        private view returns (address receiver, uint256 amount)
    {
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
        require(f.platformFee + f.royaltyAmount <= totalPrice, "fees exceed price");
        f.sellerProceeds = totalPrice - f.platformFee - f.royaltyAmount;

        uint256 toVibe  = (f.platformFee * vibeShareBps) / 10_000;
        uint256 toRecip = f.platformFee - toVibe;

        uint256 vibeOutWVTRU = 0;
        uint256 vibeOutNative = 0;

        if (l.paymentToken == address(0)) {
            require(msg.value == totalPrice, "wrong msg.value");

            if (toVibe > 0) {
                uint256 forwarded = feeProcessor.forwardNative{value: toVibe}();
                vibeOutWVTRU = forwarded;
                vibeOutNative = forwarded;
            }
            if (toRecip > 0) _sendNative(payable(feeRecipient), toRecip);

            if (f.royaltyAmount > 0) {
                _sendNative(payable(f.royaltyReceiver), f.royaltyAmount);
                emit RoyaltyPaid(l.nftContract, l.tokenId, f.royaltyReceiver, address(0), true, f.royaltyAmount);
            }
            _sendNative(payable(l.seller), f.sellerProceeds);
        } else {
            require(msg.value == 0, "no native");
            IERC20 pay = IERC20(l.paymentToken);

            // Pull only what each leg needs, straight from the buyer, so no
            // balance is ever parked in this contract.
            if (toVibe > 0) {
                pay.safeTransferFrom(msg.sender, address(feeProcessor), toVibe);
                (vibeOutWVTRU, vibeOutNative) =
                    feeProcessor.convertHeldERC20ToVTRUAndForward(l.paymentToken, toVibe);
            }
            if (toRecip > 0) pay.safeTransferFrom(msg.sender, feeRecipient, toRecip);

            if (f.royaltyAmount > 0) {
                pay.safeTransferFrom(msg.sender, f.royaltyReceiver, f.royaltyAmount);
                emit RoyaltyPaid(l.nftContract, l.tokenId, f.royaltyReceiver, l.paymentToken, false, f.royaltyAmount);
            }
            pay.safeTransferFrom(msg.sender, l.seller, f.sellerProceeds);
        }

        // Transfer NFT directly from seller to buyer.
        if (l.isERC1155) {
            IERC1155(l.nftContract).safeTransferFrom(l.seller, msg.sender, l.tokenId, buyQuantity, "");
            l.quantity -= buyQuantity;
            if (l.quantity == 0) l.active = false;
        } else {
            IERC721(l.nftContract).safeTransferFrom(l.seller, msg.sender, l.tokenId);
            l.active = false;
        }

        emit NFTPurchased(listingId, msg.sender, buyQuantity, totalPrice, l.paymentToken);
        SaleTerms memory terms;
        terms.nftContract = l.nftContract;
        terms.tokenId = l.tokenId;
        terms.isERC1155 = l.isERC1155;
        terms.quantity = buyQuantity;
        terms.paymentToken = l.paymentToken;
        terms.isNative = l.paymentToken == address(0);
        terms.pricePerUnit = l.pricePerUnit;
        terms.totalPrice = totalPrice;
        terms.platformFeeBpsUsed = platformFeeBps;
        terms.vibeShareBpsUsed = vibeShareBps;
        terms.platformFee = f.platformFee;
        terms.toVibe = toVibe;
        terms.toFeeRecipient = toRecip;
        terms.royaltyAmount = f.royaltyAmount;
        terms.royaltyReceiver = f.royaltyReceiver;
        terms.sellerProceeds = f.sellerProceeds;
        terms.vibeOutWVTRU = vibeOutWVTRU;
        terms.vibeOutNative = vibeOutNative;

        emit SaleBreakdown(listingId, msg.sender, l.seller, terms);
    }

    // ---------- Utils ----------
    // Deliberately NO receive()/fallback() and NO withdraw(): this contract
    // must never hold a balance, so stray native transfers revert instead of
    // creating funds nobody can retrieve.

    function _sendNative(address payable to, uint256 amount) private {
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "native send fail");
    }

    function supportsInterface(bytes4 interfaceId) public pure returns (bool) {
        return interfaceId == type(IERC165).interfaceId;
    }
}
