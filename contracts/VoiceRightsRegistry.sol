// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract VoiceRightsRegistry {
    enum Decision { Pending, Approved, Rejected }

    struct Authorization {
        address voiceActor;
        address producer;
        bytes32 scopeHash;
        uint64 validUntil;
        bool revoked;
    }

    struct Submission {
        bytes32 authorizationId;
        bytes32 fileHash;
        address producer;
    }

    struct Review {
        address reviewer;
        Decision decision;
        uint64 decidedAt;
    }

    address public immutable administrator;
    mapping(address => bool) public reviewers;
    mapping(bytes32 => Authorization) public authorizations;
    mapping(bytes32 => Submission) public submissions;
    mapping(bytes32 => Review) public reviews;

    event ReviewerSet(address indexed reviewer, bool allowed);
    event AuthorizationRegistered(bytes32 indexed authorizationId, address indexed voiceActor, address indexed producer);
    event AuthorizationRevoked(bytes32 indexed authorizationId);
    event SubmissionRegistered(bytes32 indexed submissionId, bytes32 indexed authorizationId, bytes32 fileHash);
    event ReviewRecorded(bytes32 indexed submissionId, address indexed reviewer, Decision decision);

    constructor(address initialReviewer) {
        require(initialReviewer != address(0), "invalid reviewer");
        administrator = msg.sender;
        reviewers[initialReviewer] = true;
        emit ReviewerSet(initialReviewer, true);
    }

    function setReviewer(address reviewer, bool allowed) external {
        require(msg.sender == administrator, "administrator only");
        require(reviewer != address(0), "invalid reviewer");
        reviewers[reviewer] = allowed;
        emit ReviewerSet(reviewer, allowed);
    }

    function registerAuthorization(
        bytes32 authorizationId,
        address producer,
        bytes32 scopeHash,
        uint64 validUntil
    ) external {
        require(authorizationId != bytes32(0) && scopeHash != bytes32(0), "invalid authorization");
        require(authorizations[authorizationId].voiceActor == address(0), "authorization exists");
        require(producer != address(0), "invalid producer");
        require(validUntil > block.timestamp, "authorization expired");
        authorizations[authorizationId] = Authorization(msg.sender, producer, scopeHash, validUntil, false);
        emit AuthorizationRegistered(authorizationId, msg.sender, producer);
    }

    function revokeAuthorization(bytes32 authorizationId) external {
        Authorization storage authorization = authorizations[authorizationId];
        require(msg.sender == authorization.voiceActor, "voice actor only");
        require(!authorization.revoked, "already revoked");
        authorization.revoked = true;
        emit AuthorizationRevoked(authorizationId);
    }

    function registerSubmission(
        bytes32 submissionId,
        bytes32 authorizationId,
        bytes32 scopeHash,
        bytes32 fileHash
    ) external {
        require(submissionId != bytes32(0) && fileHash != bytes32(0), "invalid submission");
        require(submissions[submissionId].producer == address(0), "submission exists");
        Authorization storage authorization = activeAuthorization(authorizationId);
        require(msg.sender == authorization.producer, "producer mismatch");
        require(scopeHash == authorization.scopeHash, "scope mismatch");
        submissions[submissionId] = Submission(authorizationId, fileHash, msg.sender);
        emit SubmissionRegistered(submissionId, authorizationId, fileHash);
    }

    function recordReview(bytes32 submissionId, Decision decision) external {
        require(reviewers[msg.sender], "reviewer not allowed");
        require(decision != Decision.Pending, "invalid decision");
        require(reviews[submissionId].decision == Decision.Pending, "already reviewed");
        Submission storage submission = submissions[submissionId];
        require(submission.producer != address(0), "submission missing");
        if (decision == Decision.Approved) activeAuthorization(submission.authorizationId);
        reviews[submissionId] = Review(msg.sender, decision, uint64(block.timestamp));
        emit ReviewRecorded(submissionId, msg.sender, decision);
    }

    function activeAuthorization(bytes32 authorizationId) private view returns (Authorization storage authorization) {
        authorization = authorizations[authorizationId];
        require(authorization.voiceActor != address(0), "authorization missing");
        require(!authorization.revoked, "authorization revoked");
        require(authorization.validUntil >= block.timestamp, "authorization expired");
    }
}
