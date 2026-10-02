// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title FirstProof — an append-only learning ledger, not a trusted timestamp service.
/// @notice Stores only a SHA-256 digest. The original text never enters this contract.
/// @dev Everyone can append. There is intentionally no update or delete operation.
contract FirstProof {
    struct Record {
        bytes32 digest;
        address author;
        uint256 timestamp;
    }

    uint256 public recordCount;
    mapping(uint256 => Record) private records;

    event RecordAdded(uint256 indexed id, bytes32 digest, address indexed author, uint256 timestamp);

    function append(bytes32 digest) external returns (uint256 id) {
        require(digest != bytes32(0), "Empty digest");
        id = ++recordCount;
        records[id] = Record(digest, msg.sender, block.timestamp);
        emit RecordAdded(id, digest, msg.sender, block.timestamp);
    }

    function getRecord(uint256 id) external view returns (Record memory) {
        require(id > 0 && id <= recordCount, "Record not found");
        return records[id];
    }
}
