// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title MissionReconV2 — UUPS upgrade adding mission scoring and leader performance
/// @notice Adds a 0-100 missionScore computed on submitReport() and a
///         per-leader performance history on top of V1's leader-election
///         recon behavior.
/// @dev New state variables only append after V1's layout (slots 15-16).
import "./MissionReconV1.sol";

contract MissionReconV2 is MissionReconV1 {

    struct LeaderRecord {
        uint256 missionCount;
        uint256 cumulativeScore;
        uint256 lastScore;
    }

    // NEW V2 STATE VARIABLES

    uint256 public missionScore;
    mapping(address => LeaderRecord) public leaderPerformance;

    // NEW V2 EVENTS

    event MissionScoreUpdated(uint256 score, ReportResult result, uint256 reelections);
    event LeaderPerformanceRecorded(address indexed leader, uint256 score, uint256 totalMissions);

    // OVERRIDES

    function version() external pure override returns (string memory) {
        return "MissionRecon-V2";
    }

    function submitReport(ReportResult _result, bytes32 _evidenceHash)
        external override onlyLeader
    {
        require(missionState == MissionState.ASSIGNED, "Mission not assigned");

        missionState      = MissionState.REPORTING;
        finalReport       = _result;
        finalEvidenceHash = _evidenceHash;
        emit ReportSubmitted(msg.sender, _result, _evidenceHash);

        if (_result == ReportResult.TARGET_DETECTED) {
            uint256 score = _computeScore(100, 10);
            _recordLeaderPerformance(msg.sender, score);
            missionState = MissionState.COMPLETED;
            emit MissionCompleted(msg.sender, _result);
            return;
        }

        if (_result == ReportResult.NOTHING_FOUND) {
            uint256 score = _computeScore(75, 5);
            _recordLeaderPerformance(msg.sender, score);
            missionState = MissionState.COMPLETED;
            emit MissionCompleted(msg.sender, _result);
            return;
        }

        if (_result == ReportResult.INCONCLUSIVE) {
            _triggerReelectionOrFailV2("Inconclusive report");
        }
    }

    function resetMission() public override onlyOwner {
        require(missionState != MissionState.IDLE, "Already idle");

        for (uint256 i = 0; i < registeredUAVList.length; i++) {
            address uav = registeredUAVList[i];
            uavs[uav].registered = false;
            uavs[uav].hasStatus  = false;
            uavs[uav].ineligible = false;
            uavs[uav].battery    = 0;
            uavs[uav].speed      = 0;
            uavs[uav].score      = 0;
        }
        for (uint256 i = 0; i < permittedUAVList.length; i++) {
            uavs[permittedUAVList[i]].permitted = false;
        }
        delete registeredUAVList;
        delete permittedUAVList;

        missionState      = MissionState.IDLE;
        missionZone       = "";
        electedLeader     = address(0);
        finalReport       = ReportResult.NONE;
        finalEvidenceHash = bytes32(0);
        reelectionCount   = 0;
        electionTimestamp = 0;
        missionScore      = 0;

        emit MissionReset(block.timestamp);
    }

    // NEW V2 FUNCTIONS

    function getMissionScore() external view returns (uint256) {
        return missionScore;
    }

    function getLeaderRecord(address _leader)
        external view
        returns (uint256 missionCount, uint256 avgScore, uint256 lastScore)
    {
        LeaderRecord memory rec = leaderPerformance[_leader];
        missionCount = rec.missionCount;
        lastScore    = rec.lastScore;
        avgScore     = rec.missionCount > 0
            ? rec.cumulativeScore / rec.missionCount
            : 0;
    }

    function getMissionSummaryV2()
        external view
        returns (
            MissionState  state,
            string memory zone,
            address       leader,
            uint256       reelections,
            ReportResult  report,
            uint256       score,
            uint256       leaderAvgScore
        )
    {
        LeaderRecord memory rec = leaderPerformance[electedLeader];
        uint256 avg = rec.missionCount > 0 ? rec.cumulativeScore / rec.missionCount : 0;
        return (
            missionState, missionZone, electedLeader,
            reelectionCount, finalReport, missionScore, avg
        );
    }

    // INTERNAL V2

    function _computeScore(uint256 base, uint256 penaltyPerReelection)
        internal view returns (uint256)
    {
        uint256 deduction = reelectionCount * penaltyPerReelection;
        if (deduction >= base) return 20;
        uint256 score = base - deduction;
        return score < 20 ? 20 : score;
    }

    function _recordLeaderPerformance(address leader, uint256 score) internal {
        missionScore = score;
        emit MissionScoreUpdated(score, finalReport, reelectionCount);

        LeaderRecord storage rec = leaderPerformance[leader];
        rec.missionCount    += 1;
        rec.cumulativeScore += score;
        rec.lastScore        = score;
        emit LeaderPerformanceRecorded(leader, score, rec.missionCount);
    }

    function _triggerReelectionOrFailV2(string memory reason) internal {
        if (electedLeader != address(0)) {
            uavs[electedLeader].ineligible = true;
        }
        if (reelectionCount < maxReelections) {
            reelectionCount += 1;
            missionState     = MissionState.ELECTION;
            emit ReelectionTriggered(reelectionCount);
            _electLeader();
        } else {
            missionScore = 20;
            emit MissionScoreUpdated(20, ReportResult.INCONCLUSIVE, reelectionCount);
            missionState = MissionState.FAILED;
            emit MissionFailed(reason);
        }
    }
}
