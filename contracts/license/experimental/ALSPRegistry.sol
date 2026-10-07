// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ALSPRegistry
/// @notice Experimental state-machine snippet for Agent License Session Protocol.
/// @dev This contract does NOT verify x402 payments by itself. A configured payment
///      attestor is trusted to call openSession/settleCheckout only after validating
///      the bound payment operation. Do not use with real funds without a full audit.
contract ALSPRegistry {
    enum AccessState { None, Active, Ended }
    enum SettlementState { None, Open, Payable, Settled, Overdue, Disputed }

    struct Session {
        address provider;
        address buyer;
        bytes32 termsHash;
        bytes32 headHash;
        uint64 openedAt;
        uint64 accessExpiry;
        uint64 settlementDue;
        uint64 seq;
        uint256 maxLiability;
        uint256 finalAmount;
        AccessState accessState;
        SettlementState settlementState;
    }

    address public immutable admin;
    mapping(address => bool) public paymentAttestor;
    mapping(bytes32 => Session) public sessions;
    mapping(address => mapping(address => uint256)) public providerBuyerOverdues;

    event PaymentAttestorSet(address indexed attestor, bool allowed);
    event SessionOpened(bytes32 indexed sessionId, address indexed provider, address indexed buyer, bytes32 termsHash);
    event Checkpointed(bytes32 indexed sessionId, uint64 seq, bytes32 headHash);
    event AccessEnded(bytes32 indexed sessionId);
    event CheckoutQuoted(bytes32 indexed sessionId, uint256 finalAmount, bytes32 quoteHash);
    event SessionSettled(bytes32 indexed sessionId, bytes32 paymentId, bytes32 finalHeadHash);
    event SessionOverdue(bytes32 indexed sessionId);

    error Unauthorized();
    error BadState();
    error InvalidInput();
    error LiabilityExceeded();

    constructor() {
        admin = msg.sender;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert Unauthorized();
        _;
    }

    modifier onlyPaymentAttestor() {
        if (!paymentAttestor[msg.sender]) revert Unauthorized();
        _;
    }

    modifier onlyProvider(bytes32 sessionId) {
        if (sessions[sessionId].provider != msg.sender) revert Unauthorized();
        _;
    }

    function setPaymentAttestor(address attestor, bool allowed) external onlyAdmin {
        if (attestor == address(0)) revert InvalidInput();
        paymentAttestor[attestor] = allowed;
        emit PaymentAttestorSet(attestor, allowed);
    }

    /// @notice Open only after the check-in payment has been independently confirmed.
    function openSession(
        bytes32 sessionId,
        address provider,
        address buyer,
        bytes32 termsHash,
        uint64 accessExpiry,
        uint64 settlementDue,
        uint256 maxLiability
    ) external onlyPaymentAttestor {
        if (
            sessionId == bytes32(0) ||
            provider == address(0) ||
            buyer == address(0) ||
            termsHash == bytes32(0) ||
            accessExpiry <= block.timestamp ||
            settlementDue <= accessExpiry ||
            sessions[sessionId].provider != address(0)
        ) revert InvalidInput();

        sessions[sessionId] = Session({
            provider: provider,
            buyer: buyer,
            termsHash: termsHash,
            headHash: termsHash,
            openedAt: uint64(block.timestamp),
            accessExpiry: accessExpiry,
            settlementDue: settlementDue,
            seq: 0,
            maxLiability: maxLiability,
            finalAmount: 0,
            accessState: AccessState.Active,
            settlementState: SettlementState.Open
        });

        emit SessionOpened(sessionId, provider, buyer, termsHash);
    }

    /// @notice Advance the hash-linked evidence head.
    /// @dev The reference gateway must validate the underlying signed usage receipt
    ///      before the provider submits this checkpoint.
    function checkpoint(
        bytes32 sessionId,
        uint64 expectedSeq,
        bytes32 expectedHead,
        bytes32 newHeadHash
    ) external onlyProvider(sessionId) {
        Session storage s = sessions[sessionId];
        if (s.settlementState != SettlementState.Open) revert BadState();
        if (s.seq != expectedSeq || s.headHash != expectedHead || newHeadHash == bytes32(0)) revert InvalidInput();

        unchecked { s.seq += 1; }
        s.headHash = newHeadHash;
        emit Checkpointed(sessionId, s.seq, newHeadHash);
    }

    function endAccess(bytes32 sessionId) external {
        Session storage s = sessions[sessionId];
        if (msg.sender != s.provider && msg.sender != s.buyer) revert Unauthorized();
        if (s.accessState != AccessState.Active) revert BadState();
        s.accessState = AccessState.Ended;
        emit AccessEnded(sessionId);
    }

    /// @notice Freeze the checkout amount under the original liability cap.
    function quoteCheckout(
        bytes32 sessionId,
        uint256 finalAmount,
        bytes32 quoteHash
    ) external onlyProvider(sessionId) {
        Session storage s = sessions[sessionId];
        if (s.settlementState != SettlementState.Open) revert BadState();
        if (finalAmount > s.maxLiability || quoteHash == bytes32(0)) revert LiabilityExceeded();

        s.finalAmount = finalAmount;
        s.settlementState = finalAmount == 0 ? SettlementState.Settled : SettlementState.Payable;
        s.accessState = AccessState.Ended;
        emit CheckoutQuoted(sessionId, finalAmount, quoteHash);
    }

    /// @notice Close after a checkout payment bound to this session has been confirmed.
    function settleCheckout(
        bytes32 sessionId,
        bytes32 paymentId,
        bytes32 finalHeadHash
    ) external onlyPaymentAttestor {
        Session storage s = sessions[sessionId];
        if (
            s.settlementState != SettlementState.Payable &&
            s.settlementState != SettlementState.Overdue
        ) revert BadState();
        if (paymentId == bytes32(0) || finalHeadHash == bytes32(0)) revert InvalidInput();

        if (s.settlementState == SettlementState.Overdue) {
            uint256 n = providerBuyerOverdues[s.provider][s.buyer];
            if (n > 0) providerBuyerOverdues[s.provider][s.buyer] = n - 1;
        }

        s.headHash = finalHeadHash;
        s.settlementState = SettlementState.Settled;
        s.accessState = AccessState.Ended;

        emit SessionSettled(sessionId, paymentId, finalHeadHash);
    }

    /// @notice Anyone may materialize overdue state after the agreed due time.
    function markOverdue(bytes32 sessionId) external {
        Session storage s = sessions[sessionId];
        if (s.settlementState != SettlementState.Payable) revert BadState();
        if (block.timestamp <= s.settlementDue) revert BadState();

        s.settlementState = SettlementState.Overdue;
        providerBuyerOverdues[s.provider][s.buyer] += 1;
        emit SessionOverdue(sessionId);
    }

    /// @notice Provider-local gate for opening a fresh license session.
    function canOpenNewSession(address provider, address buyer) external view returns (bool) {
        return providerBuyerOverdues[provider][buyer] == 0;
    }

    /// @notice Access expiry is a derived predicate; expiry alone is not default.
    function canAccess(bytes32 sessionId) external view returns (bool) {
        Session storage s = sessions[sessionId];
        return
            s.accessState == AccessState.Active &&
            block.timestamp < s.accessExpiry &&
            s.settlementState == SettlementState.Open;
    }
}
