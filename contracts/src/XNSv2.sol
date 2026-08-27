// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IDETH} from "./interfaces/IDETH.sol";
import {IOwnableContract} from "./interfaces/IOwnableContract.sol";
import {IGetOwnerContract} from "./interfaces/IGetOwnerContract.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

//////////////////////////////
//                          //
//    __   ___   _  _____   //
//   \ \ / / \ | |/ ____|   //
//    \ V /|  \| | (___     //
//     > < | . ` |\___ \    //
//    / . \| |\  |____) |   //
//   /_/ \_\_| \_|_____/    //
//                          //
//////////////////////////////

/// @title XNSv2
/// @author Wladimir Weinbender (DIVA Technologies AG)
/// @notice An Ethereum-native name registry that maps human-readable names to Ethereum addresses.
/// Names are **permanent, immutable, and non-transferable**.
///
/// Name format: "label" + @ + "namespace"
///
/// ### String rules
/// Label and namespace string requirements:
/// - Must be 1–20 characters long
/// - Must consist only of [a-z0-9-] (lowercase letters, digits, and hyphens)
/// - Cannot start or end with '-'
/// - Cannot contain consecutive hyphens ('--')
///
/// ### Namespaces
/// - Anyone can register new namespaces by paying a one-time fee.
/// - XNS features two types of namespaces: public and private.
/// - **Public namespaces (50 ETH):**
///   - Open to everyone after a 7-day exclusivity period post namespace registration.
///   - During exclusivity, only the namespace owner can register or sponsor names (via `registerNameWithAuthorization`
///     or `batchRegisterNameWithAuthorization`).
///   - After exclusivity, anyone can register or sponsor names (via `registerName`
///     or `batchRegisterNameWithAuthorization`).
///   - Namespace owners receive 10% of all name registration fees in perpetuity.
/// - **Private namespaces (10 ETH):**
///   - Only the namespace owner can register names (via `registerNameWithAuthorization`
///     or `batchRegisterNameWithAuthorization`).
///   - Namespace owners do not receive fees; all fees go to the XNS contract owner.
/// - During the onboarding period (154 days after XNSv2 contract deployment, 1 year after v1 deployment),
///   the contract owner can register namespaces for others at no cost.
/// - During the migration period (14 days after deployment, or until `endMigrationPeriod`), the contract owner
///   can mint existing v1 names onto v2 addresses via `registerNameFor` at no cost.
///
/// ### Name Registration
/// - Users can register names in public namespaces after the 7-day exclusivity period using `registerName`.
/// - Each address can own at most one name.
/// - Registration fees vary by namespace.
/// - Smart-contract owners can register a name directly for an owned contract in a public namespace after
///   the exclusivity period using `registerNameForOwnedContract`.
///
/// ### Authorized Name Registration
/// - XNS features authorized name registration via EIP-712 signatures.
/// - Allows sponsors to pay registration fees on behalf of recipients who authorize it via signature.
/// - Supports both EOA signatures and EIP-1271 contract wallet signatures.
///
/// ### ETH Burn and Fee Distribution
/// - 80% of ETH sent is burnt via DETH.
/// - 20% is credited as fees:
///   - Public namespaces: 10% to namespace owner, 10% to XNS contract owner
///   - Private namespaces: 20% to XNS owner
contract XNSv2 is EIP712, Ownable2Step, ReentrancyGuard {
    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------

    /// @dev Data structure to store namespace metadata.
    struct NamespaceData {
        uint256 pricePerName;
        address owner;
        uint64 createdAt;
        bool isPrivate;
    }

    /// @dev Data structure to store a name (label, namespace) associated with an address.
    struct Name {
        string label;
        string namespace;
    }

    /// @dev Argument for `registerNameWithAuthorization` function (EIP-712 based).
    /// `validUntil` is a unix timestamp; the authorization is invalid after that time.
    struct RegisterNameAuth {
        address recipient;
        string label;
        string namespace;
        uint256 validUntil;
    }

    // -------------------------------------------------------------------------
    // Storage (private, accessed via getters)
    // -------------------------------------------------------------------------

    // Mapping from address to name (label, namespace). If label is empty, the address has no name.
    mapping(address => Name) private _addressToName;

    // Mapping from `keccak256(label, "@", namespace)` to name owner address.
    mapping(bytes32 => address) private _nameHashToAddress;

    // Mapping from `keccak256(namespace)` to namespace metadata.
    mapping(bytes32 => NamespaceData) private _namespaces;

    // Mapping from address to pending fees that can be claimed.
    mapping(address => uint256) private _pendingFees;

    // Mapping from namespace hash to pending namespace owner address.
    mapping(bytes32 => address) private _pendingNamespaceOwner;

    /// @dev Whether the one-off v1 name migration window has been permanently ended by the owner.
    /// Starts `false`; set to `true` via `endMigrationPeriod()` (one-way). Query via `isMigrationOpen()`.
    bool private _migrationEnded;

    // EIP-712 struct type hash for `RegisterNameAuth`.
    bytes32 private constant _REGISTER_NAME_AUTH_TYPEHASH =
        keccak256("RegisterNameAuth(address recipient,string label,string namespace,uint256 validUntil)");


    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    /// @notice XNS contract deployment timestamp.
    uint64 public immutable DEPLOYED_AT;

    /// @notice Fee to register a public namespace.
    uint256 public constant PUBLIC_NAMESPACE_REGISTRATION_FEE = 50 ether;

    /// @notice Fee to register a private namespace.
    uint256 public constant PRIVATE_NAMESPACE_REGISTRATION_FEE = 10 ether;

    /// @notice Duration of the exclusive namespace-owner window for paid registrations
    /// (relevant for public namespace registrations only).
    uint256 public constant EXCLUSIVITY_PERIOD = 7 days;

    /// @notice Period after contract deployment during which the owner can use `registerPublicNamespaceFor` and
    /// `registerPrivateNamespaceFor` to bootstrap namespaces for participants at no cost. After this period, all
    /// namespace registrations (including by the owner) require standard fees via `registerPublicNamespace` or
    /// `registerPrivateNamespace`.
    uint256 public constant ONBOARDING_PERIOD = 154 days;

    /// @dev Period after contract deployment during which the owner can mint existing v1 names onto v2 via
    /// `registerNameFor` at no cost (no exclusivity check, no payment). Can be terminated early via
    /// `endMigrationPeriod()`. Use `isMigrationOpen()` to check whether the window is still open.
    uint256 private constant _MIGRATION_PERIOD = 14 days;

    /// @notice Unit price step (0.001 ETH).
    uint256 public constant PRICE_STEP = 0.001 ether;

    /// @notice Minimum price per name for public namespaces (0.001 ETH).
    uint256 public constant PUBLIC_NAMESPACE_MIN_PRICE = 0.001 ether;

    /// @notice Minimum price per name for private namespaces (0.005 ETH = 5x public minimum).
    uint256 public constant PRIVATE_NAMESPACE_MIN_PRICE = 0.005 ether;

    /// @notice Address of the DETH contract used to burn ETH and credit the recipient.
    address public constant DETH = 0xE46861C9f28c46F27949fb471986d59B256500a7;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    /// @dev Emitted in name registration functions.
    event NameRegistered(bytes32 indexed nameHash, string label, string namespace, address indexed owner);

    /// @dev Emitted in namespace registration functions.
    event NamespaceRegistered(
        bytes32 indexed namespaceHash,
        string namespace,
        uint256 pricePerName,
        address indexed owner,
        bool isPrivate
    );

    /// @dev Emitted in fee claiming functions.
    event FeesClaimed(address indexed recipient, uint256 amount);

    /// @dev Emitted when a namespace owner starts a transfer to a new namespace owner (address that shall receive the nsOwnerFee).
    /// When `newOwner` is `address(0)`, this indicates cancellation of a pending transfer.
    event NamespaceOwnerTransferStarted(
        bytes32 indexed namespaceHash,
        string namespace,
        address indexed oldOwner,
        address indexed newOwner
    );

    /// @dev Emitted when a pending namespace owner accepts the transfer.
    event NamespaceOwnerTransferAccepted(bytes32 indexed namespaceHash, string namespace, address indexed newOwner);

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    /// @dev Initializes the contract by setting the XNS contract owner (via OpenZeppelin's `Ownable` contract)
    /// and the deployment timestamp.
    /// @param initialOwner Address that will own the contract and receive protocol fees (should not be `address(0)`).
    constructor(address initialOwner) EIP712("XNSv2", "1") Ownable(initialOwner) {
        // Zero address check on `initialOwner` is performed in OpenZeppelin's `Ownable` contract.

        DEPLOYED_AT = uint64(block.timestamp);
    }

    /// @dev Disables OpenZeppelin's `renounceOwnership` so the protocol cannot trap protocol fees.
    /// Unconditional revert for all callers; `onlyOwner` would only obscure that this action is permanently disabled.
    function renounceOwnership() public pure override {
        revert("XNS: renounce disabled");
    }

    // =========================================================================
    // STATE-MODIFYING FUNCTIONS
    // =========================================================================

    /// @notice Function to register a paid name for `msg.sender`.
    /// This function only works for public namespaces after the exclusivity period (7 days) has ended.
    ///
    /// **Requirements:**
    /// - Label must be valid (non-empty, length 1–20, only lowercase letters, digits, and hyphens,
    ///   cannot start or end with '-', cannot contain consecutive hyphens ('--')).
    /// - Namespace must exist and be public.
    /// - `msg.value` must be >= the namespace's registered price (excess will be refunded).
    /// - Namespace must be past the exclusivity period (7 days after creation).
    /// - Caller must not already have a name.
    /// - Name must not already be registered.
    ///
    /// **Fee Distribution:**
    /// - 80% of ETH is permanently burned via DETH.
    /// - 10% is credited to the contract owner.
    /// - 10% is credited to the namespace owner.
    ///
    /// **Note:**
    /// - During the exclusivity period or for private namespaces, namespace owners must use
    ///   `registerNameWithAuthorization` even for their own registrations.
    /// - Due to block reorganization risks, users should wait for a few blocks and verify
    ///   the name resolves correctly using the `getAddress` or `getName` function before sharing it publicly.
    ///
    /// @param label The label part of the name to register.
    /// @param namespace The namespace part of the name to register.
    function registerName(string calldata label, string calldata namespace) external payable nonReentrant {
        _registerName(msg.sender, label, namespace);
    }

    /// @notice Register a paid name for a smart contract controlled by `msg.sender`.
    /// Authorization is checked via the recipient's `owner()` or, if that call fails, `getOwner()`.
    /// If `owner()` succeeds, its return value alone is used (including `address(0)`); `getOwner()` is not tried.
    /// This function is only available for public namespaces after the exclusivity period.
    ///
    /// The ownership check is performed exclusively against the contract deployed at `recipient` on Ethereum.
    /// XNS does not verify ownership of contracts at the same address on other chains.
    /// Subsequent changes to the contract's `owner()` or `getOwner()` do not affect the registered XNS name.
    ///
    /// **Requirements:**
    /// - `recipient` must contain contract code.
    /// - `recipient.owner()` must equal `msg.sender` when that call succeeds; otherwise `recipient.getOwner()`
    ///   must equal `msg.sender` when that call succeeds.
    /// - Otherwise, same requirements, fee distribution, and notes as `registerName` (name assigned to
    ///   `recipient` instead of `msg.sender`).
    ///
    /// @param recipient The Ethereum smart contract that will receive the XNS name.
    /// @param label The label part of the name.
    /// @param namespace The namespace part of the name.
    function registerNameForOwnedContract(
        address recipient,
        string calldata label,
        string calldata namespace
    ) external payable nonReentrant {
        require(recipient.code.length > 0, "XNS: recipient not contract");
        require(_isOwnerOf(recipient, msg.sender), "XNS: not authorized");

        _registerName(recipient, label, namespace);
    }

    /// @dev Shared body for `registerName` and `registerNameForOwnedContract`: public namespace, post-exclusivity,
    /// paid registration assigning `nameOwner` as the name holder.
    function _registerName(
        address nameOwner,
        string calldata label,
        string calldata namespace
    ) private {
        require(_isValidLabelOrNamespace(label), "XNS: invalid label");

        NamespaceData memory ns = _namespaces[keccak256(bytes(namespace))];
        require(ns.owner != address(0), "XNS: namespace not found");
        require(!ns.isPrivate, "XNS: only for public namespaces");

        require(msg.value >= ns.pricePerName, "XNS: insufficient payment");

        require(block.timestamp > ns.createdAt + EXCLUSIVITY_PERIOD, "XNS: in exclusivity period");

        require(bytes(_addressToName[nameOwner].label).length == 0, "XNS: address already has a name");

        bytes32 key = keccak256(abi.encodePacked(label, "@", namespace));
        require(_nameHashToAddress[key] == address(0), "XNS: name already registered");

        _nameHashToAddress[key] = nameOwner;
        _addressToName[nameOwner] = Name({label: label, namespace: namespace});

        emit NameRegistered(key, label, namespace, nameOwner);

        // Process payment: burn 80%, credit fees, and refund excess.
        _processETHPayment(ns.pricePerName, ns.owner);
    }

    /// @notice Function to sponsor a paid name registration for `recipient` who explicitly authorized it via
    /// an EIP-712 signature.
    ///
    /// This function is **required** for:
    /// - All registrations in public namespaces during the exclusivity period (only namespace owner).
    /// - All sponsored registrations in public namespaces after the exclusivity period (anyone).
    /// - All registrations in private namespaces.
    ///
    /// Supports both EOA signatures and EIP-1271 contract wallet signatures.
    ///
    /// **Requirements:**
    /// - Label must be valid (non-empty, length 1–20, only lowercase letters, digits, and hyphens,
    ///   cannot start or end with '-', cannot contain consecutive hyphens ('--')).
    /// - `recipient` must not be the zero address.
    /// - Namespace must exist.
    /// - `msg.value` must be >= the namespace's registered price (excess will be refunded).
    /// - For private namespaces: `msg.sender` must be the namespace owner.
    /// - For public namespaces during the exclusivity period: `msg.sender` must be the namespace owner.
    ///   After exclusivity, anyone may sponsor.
    /// - Recipient must not already have a name.
    /// - Name must not already be registered.
    /// - `block.timestamp` must be <= `registerNameAuth.validUntil`.
    /// - Signature must be valid EIP-712 signature from `recipient` (EOA) or EIP-1271 contract signature.
    ///
    /// **Fee Distribution:**
    /// - 80% of ETH is permanently burned via DETH.
    /// - For public namespaces: 10% is credited to the namespace owner and 10% to the contract owner.
    /// - For private namespaces: 20% is credited to the contract owner.
    ///
    /// **Note:**
    /// - If the recipient is an EIP-7702 delegated account, their delegated implementation must implement ERC-1271
    ///   for signature validation.
    /// - Due to block reorganization risks, users should wait for a few blocks and verify
    /// the name resolves correctly using the `getAddress` or `getName` function before sharing it publicly.
    /// 
    /// @param registerNameAuth The argument for the function, including recipient, label, namespace, and validUntil.
    /// @param signature EIP-712 signature by `recipient` (EOA) or EIP-1271 contract signature.
    function registerNameWithAuthorization(
        RegisterNameAuth calldata registerNameAuth,
        bytes calldata signature
    ) external payable nonReentrant {
        require(_isValidLabelOrNamespace(registerNameAuth.label), "XNS: invalid label");
        require(registerNameAuth.recipient != address(0), "XNS: 0x recipient");

        bytes32 nsHash = keccak256(bytes(registerNameAuth.namespace));
        NamespaceData memory ns = _namespaces[nsHash];
        require(ns.owner != address(0), "XNS: namespace not found");

        require(msg.value >= ns.pricePerName, "XNS: insufficient payment");

        if (ns.isPrivate) {
            require(msg.sender == ns.owner, "XNS: not namespace owner (private)");
        } else if (block.timestamp <= ns.createdAt + EXCLUSIVITY_PERIOD) {
            require(msg.sender == ns.owner, "XNS: not namespace owner (exclusivity period)");
        }

        require(
            bytes(_addressToName[registerNameAuth.recipient].label).length == 0,
            "XNS: recipient already has a name"
        );

        bytes32 key = keccak256(abi.encodePacked(registerNameAuth.label, "@", registerNameAuth.namespace));
        require(_nameHashToAddress[key] == address(0), "XNS: name already registered");

        require(block.timestamp <= registerNameAuth.validUntil, "XNS: authorization expired");
        require(_isValidAuthSignature(registerNameAuth, signature), "XNS: bad authorization");

        _nameHashToAddress[key] = registerNameAuth.recipient;
        _addressToName[registerNameAuth.recipient] = Name({
            label: registerNameAuth.label,
            namespace: registerNameAuth.namespace
        });

        emit NameRegistered(key, registerNameAuth.label, registerNameAuth.namespace, registerNameAuth.recipient);

        // Process payment: burn 80%, credit fees, and refund excess.
        address nsOwnerFeeRecipient = ns.isPrivate ? owner() : ns.owner;
        _processETHPayment(ns.pricePerName, nsOwnerFeeRecipient);
    }

    /// @notice Batch version of `registerNameWithAuthorization` to register multiple names with a single transaction.
    /// All registrations must be in the same namespace. Skips registrations (i.e. does not revert) where the recipient already has
    /// a name or the name is already registered (griefing protection). Skipped items are not charged; excess payment is refunded.
    ///
    /// **Requirements:**
    /// - Array arguments must have equal length and be non-empty.
    /// - All registrations must be in the same namespace.
    /// - `msg.value` must be >= `pricePerName * successfulCount` (excess will be refunded).
    /// - All individual requirements from `registerNameWithAuthorization` apply to each registration.
    ///
    /// **Fee Distribution:**
    /// - 80% of ETH is permanently burned via DETH.
    /// - For public namespaces: 10% is credited to the namespace owner and 10% to the contract owner.
    /// - For private namespaces: 20% is credited to the contract owner.
    ///
    /// **Note:** Input validation errors (invalid label, zero recipient, namespace mismatch) cause the entire batch
    /// to revert. Expired authorizations and invalid signatures revert only for otherwise eligible registrations —
    /// they are not evaluated for entries skipped because the recipient already has a name or the name is already
    /// registered. Those state-based conflicts are skipped (batch does not revert) for griefing protection.
    ///
    /// @param registerNameAuths Array of `RegisterNameAuth` structs, each including recipient, label, namespace, and validUntil.
    /// @param signatures Array of EIP-712 signatures by recipients (EOA) or EIP-1271 contract signatures.
    /// @return successfulCount The number of names successfully registered.
    function batchRegisterNameWithAuthorization(
        RegisterNameAuth[] calldata registerNameAuths,
        bytes[] calldata signatures
    ) external payable nonReentrant returns (uint256 successfulCount) {
        require(registerNameAuths.length == signatures.length, "XNS: length mismatch");
        require(registerNameAuths.length > 0, "XNS: empty array");

        bytes32 firstNsHash = keccak256(bytes(registerNameAuths[0].namespace));
        NamespaceData memory ns = _namespaces[firstNsHash];
        require(ns.owner != address(0), "XNS: namespace not found");

        if (ns.isPrivate) {
            require(msg.sender == ns.owner, "XNS: not namespace owner (private)");
        } else if (block.timestamp <= ns.createdAt + EXCLUSIVITY_PERIOD) {
            require(msg.sender == ns.owner, "XNS: not namespace owner (exclusivity period)");
        }

        // Validate and register all names, skipping where the recipient already has a name
        // or the name is already registered.
        uint256 successful = 0;
        for (uint256 i = 0; i < registerNameAuths.length; i++) {
            RegisterNameAuth calldata auth = registerNameAuths[i];

            require(_isValidLabelOrNamespace(auth.label), "XNS: invalid label");
            require(auth.recipient != address(0), "XNS: 0x recipient");

            bytes32 nsHash = keccak256(bytes(auth.namespace));
            require(nsHash == firstNsHash, "XNS: namespace mismatch");

            // Skip if recipient already has a name (protection against griefing attacks).
            if (bytes(_addressToName[auth.recipient].label).length > 0) {
                continue;
            }

            bytes32 key = keccak256(abi.encodePacked(auth.label, "@", auth.namespace));

            // Skip if name is already registered (protection against griefing attacks).
            if (_nameHashToAddress[key] != address(0)) {
                continue;
            }

            require(block.timestamp <= auth.validUntil, "XNS: authorization expired");
            require(_isValidAuthSignature(auth, signatures[i]), "XNS: bad authorization");

            _nameHashToAddress[key] = auth.recipient;
            _addressToName[auth.recipient] = Name({
                label: auth.label,
                namespace: auth.namespace
            });

            emit NameRegistered(key, auth.label, auth.namespace, auth.recipient);
            successful++;
        }

        if (successful > 0) {
            uint256 actualTotal = ns.pricePerName * successful;
            require(msg.value >= actualTotal, "XNS: insufficient payment");
            address nsOwnerFeeRecipient = ns.isPrivate ? owner() : ns.owner;

            // Process payment: burn 80%, credit fees, and refund excess.
            _processETHPayment(actualTotal, nsOwnerFeeRecipient);
            return successful;
        }

        // If no registrations succeeded, refund all payment and return 0.
        if (msg.value > 0) {
            (bool ok, ) = msg.sender.call{value: msg.value}("");
            require(ok, "XNS: refund failed");
        }
        return 0;
    }

    /// @notice Register a new public namespace.
    ///
    /// **Requirements:**
    /// - `msg.value` must be >= 50 ETH (excess refunded).
    /// - Namespace must be valid (non-empty, length 1–20, only lowercase letters, digits, and hyphens,
    ///   cannot start or end with '-', cannot contain consecutive hyphens ('--')).
    /// - Namespace must not already exist.
    /// - `pricePerName` must be >= 0.001 ETH and a multiple of 0.001 ETH (0.001, 0.002, 0.003, etc.).
    ///
    /// **Note:**
    /// - During the onboarding period (154 days following contract deployment), the contract owner can
    ///   register namespaces for free (via `registerPublicNamespaceFor`) to foster adoption.
    /// - For the avoidance of doubt, anyone can register a new namespace during the onboarding period
    ///   by paying the standard 50 ETH registration fee.
    ///
    /// @param namespace The namespace to register.
    /// @param pricePerName The price per name for the namespace.
    function registerPublicNamespace(string calldata namespace, uint256 pricePerName) external payable nonReentrant {
        require(msg.value >= PUBLIC_NAMESPACE_REGISTRATION_FEE, "XNS: insufficient namespace fee");

        _registerNamespace(namespace, pricePerName, msg.sender, false);

        _processETHPayment(PUBLIC_NAMESPACE_REGISTRATION_FEE, owner());
    }

    /// @notice Register a new private namespace.
    ///
    /// **Requirements:**
    /// - `msg.value` must be >= 10 ETH (excess refunded).
    /// - Namespace must be valid (non-empty, length 1–20, only lowercase letters, digits, and hyphens,
    ///   cannot start or end with '-', cannot contain consecutive hyphens ('--')).
    /// - Namespace must not already exist.
    /// - `pricePerName` must be >= 0.005 ETH and a multiple of 0.001 ETH (0.005, 0.006, 0.007, etc.).
    ///
    /// **Note:**
    /// - During the onboarding period (154 days following contract deployment), the contract owner can
    ///   register namespaces for free (via `registerPrivateNamespaceFor`) to foster adoption.
    /// - For the avoidance of doubt, anyone can register a new namespace during the onboarding period
    ///   by paying the standard 10 ETH registration fee.
    ///
    /// @param namespace The namespace to register.
    /// @param pricePerName The price per name for the namespace.
    function registerPrivateNamespace(string calldata namespace, uint256 pricePerName) external payable nonReentrant {
        require(msg.value >= PRIVATE_NAMESPACE_REGISTRATION_FEE, "XNS: insufficient namespace fee");

        _registerNamespace(namespace, pricePerName, msg.sender, true);

        _processETHPayment(PRIVATE_NAMESPACE_REGISTRATION_FEE, owner());
    }

    /// @notice Contract owner-only function to register a public namespace for another address during the onboarding period.
    /// This function allows the contract owner to register namespaces for free during the onboarding period to
    /// foster adoption. No ETH is processed (function is non-payable) and no fees are charged.
    ///
    /// **Requirements:**
    /// - `msg.sender` must be the contract owner.
    /// - Must be called during the onboarding period.
    /// - `nsOwner` must not be the zero address.
    /// - No ETH should be sent (function is non-payable).
    /// - All validation requirements from `registerPublicNamespace` apply.
    ///
    /// @param nsOwner The address that will be assigned as the namespace owner
    /// (the account that shall receive namespace registration fees).
    /// @param namespace The namespace to register.
    /// @param pricePerName The price per name for the namespace.
    function registerPublicNamespaceFor(address nsOwner, string calldata namespace, uint256 pricePerName) external {
        require(msg.sender == owner(), "XNS: not contract owner");
        require(block.timestamp <= DEPLOYED_AT + ONBOARDING_PERIOD, "XNS: onboarding over");
        require(nsOwner != address(0), "XNS: 0x nsOwner");

        _registerNamespace(namespace, pricePerName, nsOwner, false);
    }

    /// @notice Contract owner-only function to register a private namespace for another address during the onboarding period.
    /// This function allows the contract owner to register namespaces for free during the onboarding period to
    /// foster adoption. No ETH is processed (function is non-payable) and no fees are charged.
    ///
    /// **Requirements:**
    /// - `msg.sender` must be the contract owner.
    /// - Must be called during the onboarding period.
    /// - `nsOwner` must not be the zero address.
    /// - No ETH should be sent (function is non-payable).
    /// - All validation requirements from `registerPrivateNamespace` apply.
    ///
    /// @param nsOwner The address that will be assigned as the namespace owner.
    /// @param namespace The namespace to register.
    /// @param pricePerName The price per name for the namespace.
    function registerPrivateNamespaceFor(address nsOwner, string calldata namespace, uint256 pricePerName) external {
        require(msg.sender == owner(), "XNS: not contract owner");
        require(block.timestamp <= DEPLOYED_AT + ONBOARDING_PERIOD, "XNS: onboarding over");
        require(nsOwner != address(0), "XNS: 0x nsOwner");

        _registerNamespace(namespace, pricePerName, nsOwner, true);
    }

    /// @notice Contract owner-only function to mint a name for `recipient` during the v1→v2 migration window.
    /// No payment and no exclusivity check. Used to re-create existing v1 names on v2 addresses.
    ///
    /// **Requirements:**
    /// - `msg.sender` must be the contract owner.
    /// - Migration must still be open (`isMigrationOpen()`).
    /// - `recipient` must not be the zero address and must not already have a name.
    /// - Label must be valid; namespace must exist; name must not already be registered.
    ///
    /// @param recipient The address that will own the name.
    /// @param label The label part of the name.
    /// @param namespace The namespace part of the name.
    function registerNameFor(address recipient, string calldata label, string calldata namespace) external {
        require(msg.sender == owner(), "XNS: not contract owner");
        require(isMigrationOpen(), "XNS: migration ended");
        require(recipient != address(0), "XNS: 0x recipient");
        require(_isValidLabelOrNamespace(label), "XNS: invalid label");
        require(_namespaces[keccak256(bytes(namespace))].owner != address(0), "XNS: namespace not found");
        require(bytes(_addressToName[recipient].label).length == 0, "XNS: address already has a name");

        bytes32 key = keccak256(abi.encodePacked(label, "@", namespace));
        require(_nameHashToAddress[key] == address(0), "XNS: name already registered");

        _nameHashToAddress[key] = recipient;
        _addressToName[recipient] = Name({label: label, namespace: namespace});

        emit NameRegistered(key, label, namespace, recipient);
    }

    /// @notice Permanently ends the name migration window early. One-way; cannot be re-opened.
    /// **Requirements:** `msg.sender` must be the contract owner; migration must still be open (`isMigrationOpen()`).
    function endMigrationPeriod() external {
        require(msg.sender == owner(), "XNS: not contract owner");
        require(isMigrationOpen(), "XNS: migration ended");
        _migrationEnded = true;
    }

    /// @dev Helper function to register a namespace (used in namespace registration functions):
    /// - Validates namespace and pricePerName
    /// - Checks namespace doesn't exist
    /// - Writes namespace data to storage
    /// - Emits `NamespaceRegistered` event
    /// @param namespace The namespace to register.
    /// @param pricePerName The price per name for the namespace. Must be >= 0.001 ETH for public namespaces,
    /// >= 0.005 ETH for private namespaces, and a multiple of 0.001 ETH.
    /// @param owner The address that will be assigned as the namespace owner.
    /// @param isPrivate Whether the namespace is private.
    function _registerNamespace(string calldata namespace, uint256 pricePerName, address owner, bool isPrivate) private {
        require(_isValidLabelOrNamespace(namespace), "XNS: invalid namespace");

        bytes32 nsHash = keccak256(bytes(namespace));

        require(_namespaces[nsHash].owner == address(0), "XNS: namespace already exists");

        // Check minimum price based on namespace type (public namespaces are more common, check first)
        if (!isPrivate) {
            require(pricePerName >= PUBLIC_NAMESPACE_MIN_PRICE, "XNS: pricePerName too low");
        } else {
            require(pricePerName >= PRIVATE_NAMESPACE_MIN_PRICE, "XNS: pricePerName too low");
        }
        require(pricePerName % PRICE_STEP == 0, "XNS: price not multiple of 0.001 ETH");

        _namespaces[nsHash] = NamespaceData({
            pricePerName: pricePerName,
            owner: owner,
            createdAt: uint64(block.timestamp),
            isPrivate: isPrivate
        });

        emit NamespaceRegistered(nsHash, namespace, pricePerName, owner, isPrivate);
    }

    /// @notice Function to claim accumulated fees for `msg.sender` and send to `recipient`.
    /// Withdraws all pending fees. Partial claims are not possible.
    ///
    /// **Requirements:**
    /// - `recipient` must not be the zero address.
    /// - `msg.sender` must have pending fees to claim.
    ///
    /// @param recipient The address that will receive the claimed fees.
    function claimFees(address recipient) external nonReentrant {
        require(recipient != address(0), "XNS: zero recipient");
        _claimFees(recipient);
    }

    /// @notice Function to claim accumulated fees for `msg.sender` and send to `msg.sender`.
    /// Withdraws all pending fees. Partial claims are not possible.
    function claimFeesToSelf() external nonReentrant {
        _claimFees(msg.sender);
    }

    /// @dev Helper function for `claimFees` and `claimFeesToSelf`.
    /// @param recipient The address that will receive the claimed fees.
    function _claimFees(address recipient) private {
        uint256 amount = _pendingFees[msg.sender];
        require(amount > 0, "XNS: no fees to claim");

        _pendingFees[msg.sender] = 0;

        (bool success, ) = recipient.call{value: amount}("");
        require(success, "XNS: fee transfer failed");

        emit FeesClaimed(recipient, amount);
    }

    /// @notice Start a 2-step transfer of namespace ownership to a new address.
    /// The new namespace owner must call `acceptNamespaceOwnership` to complete the transfer.
    ///
    /// Setting `newOwner` to the zero address is allowed; this can be used to cancel an initiated transfer.
    /// Alternatively, a pending transfer can be overwritten by calling this function again with a different address.
    ///
    /// **Requirements:**
    /// - `msg.sender` must be the current namespace owner.
    /// - Namespace must exist.
    ///
    /// **Fee Accounting Note:** Ownership transfers do **not** migrate already-accrued `_pendingFees`.
    /// Any fees accumulated before `acceptNamespaceOwnership()` remain claimable by the previous namespace owner address.
    /// Only fees accrued **after** acceptance are credited to the new namespace owner address.
    ///
    /// @param namespace The namespace to transfer ownership for.
    /// @param newOwner The address that will become the new namespace owner, or `address(0)` to cancel a pending transfer.
    function transferNamespaceOwnership(string calldata namespace, address newOwner) external {
        bytes32 nsHash = keccak256(bytes(namespace));
        NamespaceData storage ns = _namespaces[nsHash];
        require(ns.owner != address(0), "XNS: namespace not found");
        require(msg.sender == ns.owner, "XNS: not namespace owner");

        _pendingNamespaceOwner[nsHash] = newOwner;
        emit NamespaceOwnerTransferStarted(nsHash, namespace, ns.owner, newOwner);
    }

    /// @notice Accept a pending namespace ownership transfer.
    /// Completes the 2-step transfer process started by `transferNamespaceOwnership`.
    ///
    /// **Requirements:**
    /// - Namespace must exist.
    /// - There must be a pending namespace owner transfer.
    /// - `msg.sender` must be the pending namespace owner.
    ///
    /// @param namespace The namespace to accept ownership for.
    function acceptNamespaceOwnership(string calldata namespace) external {
        bytes32 nsHash = keccak256(bytes(namespace));
        NamespaceData storage ns = _namespaces[nsHash];
        require(ns.owner != address(0), "XNS: namespace not found");

        address pending = _pendingNamespaceOwner[nsHash];
        require(pending != address(0), "XNS: no pending owner");
        require(msg.sender == pending, "XNS: not pending owner");

        ns.owner = pending;
        delete _pendingNamespaceOwner[nsHash];

        emit NamespaceOwnerTransferAccepted(nsHash, namespace, pending);
    }

    // =========================================================================
    // GETTER / VIEW FUNCTIONS
    // =========================================================================

    /// @notice Function to resolve a name string including the @ sign to an address.
    /// Returns `address(0)` for anything not registered or malformed.
    /// Provided strings without an @ sign are invalid and return `address(0)`.
    ///
    /// @param fullName The name string to resolve.
    /// @return addr The address associated with the name, or `address(0)` if not registered.
    function getAddress(string calldata fullName) external view returns (address addr) {
        bytes memory b = bytes(fullName);
        uint256 len = b.length;
        if (len == 0) return address(0);

        // Find the last '@' by scanning from the end (handles both public and private namespaces).
        uint256 atIndex = type(uint256).max; // Sentinel: no @ found
        for (uint256 i = len; i > 0; i--) {
            if (b[i - 1] == 0x40) { // '@'
                atIndex = i - 1;
                break;
            }
        }

        if (atIndex == type(uint256).max) {
            return address(0);
        }

        // Extract label and namespace.
        bytes memory labelBytes = new bytes(atIndex);
        for (uint256 j = 0; j < atIndex; j++) labelBytes[j] = b[j];

        uint256 nsLen = len - atIndex - 1;
        bytes memory nsBytes = new bytes(nsLen);
        for (uint256 j = 0; j < nsLen; j++) nsBytes[j] = b[atIndex + 1 + j];

        return _getAddress(string(labelBytes), string(nsBytes));
    }

    /// @notice Function to resolve a name to an address taking separate label and namespace parameters.
    /// This version is more gas efficient than `getAddress(string calldata fullName)` as it does not
    /// require string splitting. Returns `address(0)` if not registered.
    /// @param label The label part of the name.
    /// @param namespace The namespace part of the name.
    /// @return addr The address associated with the name, or `address(0)` if not registered.
    function getAddress(string calldata label, string calldata namespace) external view returns (address addr) {
        return _getAddress(label, namespace);
    }

    /// @dev Helper function for `getAddress(fullName)` and `getAddress(label, namespace)`.
    function _getAddress(string memory label, string memory namespace) private view returns (address addr) {
        bytes32 key = keccak256(abi.encodePacked(label, "@", namespace));
        return _nameHashToAddress[key];
    }

    /// @notice Function to lookup the XNS name for an address.
    /// Returns an empty string if the address has no name. Otherwise returns the full name
    /// in format "label" + @ + "namespace".
    /// @param addr The address to lookup the XNS name for.
    /// @return name The XNS name for the address, or empty string if the address has no name.
    function getName(address addr) external view returns (string memory) {
        Name memory n = _addressToName[addr];

        if (bytes(n.label).length == 0) {
            return "";
        }

        return string.concat(n.label, "@", n.namespace);
    }

    /// @notice Function to retrieve the namespace metadata associated with `namespace`.
    /// @param namespace The namespace to retrieve the metadata for.
    /// @return pricePerName The price per name for the namespace.
    /// @return owner The namespace owner of the namespace.
    /// @return createdAt The timestamp when the namespace was created.
    /// @return isPrivate Whether the namespace is private.
    function getNamespaceInfo(
        string calldata namespace
    ) external view returns (uint256 pricePerName, address owner, uint64 createdAt, bool isPrivate) {
        NamespaceData memory ns = _namespaces[keccak256(bytes(namespace))];
        require(ns.owner != address(0), "XNS: namespace not found");
        return (ns.pricePerName, ns.owner, ns.createdAt, ns.isPrivate);
    }

    /// @notice Function to retrieve only the price per name for a given namespace.
    /// More gas efficient than `getNamespaceInfo` if only the price is needed.
    /// @param namespace The namespace to retrieve the price for.
    /// @return pricePerName The price per name for the namespace.
    function getNamespacePrice(string calldata namespace) external view returns (uint256 pricePerName) {
        NamespaceData memory ns = _namespaces[keccak256(bytes(namespace))];
        require(ns.owner != address(0), "XNS: namespace not found");
        return ns.pricePerName;
    }

    /// @notice Function to check if a namespace is currently within its exclusivity period.
    /// Returns `true` if `block.timestamp <= createdAt + EXCLUSIVITY_PERIOD`, `false` otherwise.
    /// For private namespaces, this function will return `false` after the exclusivity period, but private namespaces
    /// remain namespace-owner-only forever regardless of this value.
    /// @param namespace The namespace to check.
    /// @return inExclusivityPeriod `true` if the namespace is within its exclusivity period, `false` otherwise.
    function isInExclusivityPeriod(string calldata namespace) external view returns (bool inExclusivityPeriod) {
        NamespaceData memory ns = _namespaces[keccak256(bytes(namespace))];
        require(ns.owner != address(0), "XNS: namespace not found");
        return block.timestamp <= ns.createdAt + EXCLUSIVITY_PERIOD;
    }

    /// @notice Function to check if a label or namespace is valid (returns bool, does not revert).
    ///
    /// **Requirements:**
    /// - Must be 1–20 characters long
    /// - Must consist only of [a-z0-9-] (lowercase letters, digits, and hyphens)
    /// - Cannot start or end with '-'
    /// - Cannot contain consecutive hyphens ('--')
    /// @param labelOrNamespace The label or namespace to check if is valid.
    /// @return isValid True if the labelOrNamespace is valid, false otherwise.
    function isValidLabelOrNamespace(string calldata labelOrNamespace) external pure returns (bool isValid) {
        return _isValidLabelOrNamespace(labelOrNamespace);
    }


    /// @notice Returns whether a `RegisterNameAuth` authorization is currently usable:
    /// cryptographically valid and not past `validUntil`. Intended for integrations validating
    /// a signed registration authorization.
    /// @param registerNameAuth The struct containing recipient, label, namespace, and validUntil.
    /// @param signature The signature to check.
    /// @return isValid True if the authorization is currently usable, false otherwise.
    function isValidSignature(
        RegisterNameAuth calldata registerNameAuth,
        bytes calldata signature
    ) external view returns (bool isValid) {
        if (block.timestamp > registerNameAuth.validUntil) {
            return false;
        }
        return _isValidAuthSignature(registerNameAuth, signature);
    }

    /// @notice Function to retrieve the amount of pending fees that can be claimed by an address.
    /// @param recipient The address to retrieve the pending fees for.
    /// @return amount The amount of pending fees that can be claimed by the address.
    function getPendingFees(address recipient) external view returns (uint256 amount) {
        return _pendingFees[recipient];
    }

    /// @notice Get the pending namespace owner for a given namespace.
    /// Returns `address(0)` if there is no pending transfer.
    /// @param namespace The namespace to check for pending namespace owner.
    /// @return pendingOwner The address of the pending namespace owner, or `address(0)` if none.
    function getPendingNamespaceOwner(string calldata namespace) external view returns (address pendingOwner) {
        return _pendingNamespaceOwner[keccak256(bytes(namespace))];
    }

    /// @notice Returns whether the v1→v2 name migration window is still open.
    /// True only if the owner has not called `endMigrationPeriod()` and `block.timestamp` is still within
    /// the private migration period.
    function isMigrationOpen() public view returns (bool) {
        return !_migrationEnded && block.timestamp <= DEPLOYED_AT + _MIGRATION_PERIOD;
    }


    // =========================================================================
    // INTERNAL MULTI-USE HELPER FUNCTIONS
    // =========================================================================

    /// @dev Helper function to process ETH payment (used in `_registerName`, `registerNameWithAuthorization`,
    /// `batchRegisterNameWithAuthorization`, `registerPublicNamespace`, and `registerPrivateNamespace`):
    /// - Burn 80% via DETH (credits `msg.sender` with DETH)
    /// - Credit fees: 10% to `nsOwnerFeeRecipient` and 10% to contract owner
    /// - Refund any excess payment
    /// @param requiredAmount The required amount of ETH for the operation (excess will be refunded).
    /// @param nsOwnerFeeRecipient The address that shall receive the 10% nsOwnerFee.
    function _processETHPayment(uint256 requiredAmount, address nsOwnerFeeRecipient) private {
        uint256 burnAmount = (requiredAmount * 80) / 100;
        uint256 nsOwnerFee = (requiredAmount * 10) / 100;
        uint256 ownerFee = requiredAmount - burnAmount - nsOwnerFee;

        // Burn 80% via DETH contract and credit `msg.sender` (payer/sponsor) with DETH.
        IDETH(DETH).burn{value: burnAmount}(msg.sender);

        // Credit fees: 10% to `nsOwnerFeeRecipient`, 10% to contract owner.
        // If `nsOwnerFeeRecipient` == contract owner, contract owner effectively gets the full 20%
        // (credited twice into the same mapping slot).
        _pendingFees[nsOwnerFeeRecipient] += nsOwnerFee;
        _pendingFees[owner()] += ownerFee;

        // Refund excess payment.
        uint256 excess = msg.value - requiredAmount;
        if (excess > 0) {
            (bool success, ) = msg.sender.call{value: excess}("");
            require(success, "XNS: refund failed");
        }
    }

    /// @dev Helper function to check if a label or namespace is valid (same rules for both).
    /// Used in name and namespace registration functions as well as in `isValidLabelOrNamespace` function.
    /// @param labelOrNamespace The label or namespace string to validate.
    /// @return isValid True if the labelOrNamespace is valid, false otherwise.
    function _isValidLabelOrNamespace(string calldata labelOrNamespace) private pure returns (bool isValid) {
        bytes memory b = bytes(labelOrNamespace);
        uint256 len = b.length;
        if (len == 0 || len > 20) return false;

        for (uint256 i = 0; i < len; i++) {
            bytes1 c = b[i];
            bool isLowercaseLetter = (c >= 0x61 && c <= 0x7A); // 'a'..'z'
            bool isDigit = (c >= 0x30 && c <= 0x39); // '0'..'9'
            bool isHyphen = (c == 0x2D); // '-'
            if (!(isLowercaseLetter || isDigit || isHyphen)) return false;

            // Disallow consecutive hyphens
            if (isHyphen && i > 0 && b[i - 1] == 0x2D) return false;
        }

        if (b[0] == 0x2D || b[len - 1] == 0x2D) return false; // no leading/trailing '-'
        return true;
    }

    /// @dev Returns whether `caller` controls `target` via `owner()` or `getOwner()` on Ethereum.
    /// If `owner()` succeeds, its return value is authoritative (including `address(0)`); `getOwner()` is
    /// only tried when the `owner()` call reverts or is absent. Target reverts do not bubble up.
    function _isOwnerOf(address target, address caller) private view returns (bool) {
        try IOwnableContract(target).owner() returns (address contractOwner) {
            return contractOwner == caller;
        } catch {}

        try IGetOwnerContract(target).getOwner() returns (address contractOwner) {
            return contractOwner == caller;
        } catch {}

        return false;
    }


    /// @dev Cryptographic EIP-712 / EIP-1271 check for `RegisterNameAuth` (does not enforce `validUntil`).
    /// @param registerNameAuth The struct containing recipient, label, namespace, and validUntil.
    /// @param signature The signature to verify.
    /// @return isValid True if the signature is cryptographically valid, false otherwise.
    function _isValidAuthSignature(
        RegisterNameAuth calldata registerNameAuth,
        bytes calldata signature
    ) private view returns (bool isValid) {
        bytes32 digest = _hashTypedDataV4(_getRegisterNameAuthHash(registerNameAuth));
        return SignatureChecker.isValidSignatureNow(registerNameAuth.recipient, digest, signature);
    }

    /// @dev Helper function to return hash of `RegisterNameAuth` details.
    /// @param registerNameAuth The struct containing recipient, label, namespace, and validUntil.
    /// @return registerNameAuthHash The keccak256 hash of the `RegisterNameAuth` struct.
    function _getRegisterNameAuthHash(
        RegisterNameAuth calldata registerNameAuth
    ) private pure returns (bytes32 registerNameAuthHash) {
        registerNameAuthHash = keccak256(
            abi.encode(
                _REGISTER_NAME_AUTH_TYPEHASH,
                registerNameAuth.recipient,
                keccak256(bytes(registerNameAuth.label)),
                keccak256(bytes(registerNameAuth.namespace)),
                registerNameAuth.validUntil
            )
        );
    }
}
