// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title MissionFailV2 — UUPS upgrade adding mission scoring and reputation
/// @notice Adds a missionScore and per-UAV reputation tracking on top of V1's
///         failure-detection/voting behavior.
/// @dev New state variables only append after V1's layout (slots 19-20).
import "./MissionFailV1.sol";

contract MissionFailV2 is MissionFailV1 {

    // NEW V2 STATE VARIABLES

    uint256 public missionScore;
    mapping(address => uint256) public reputationScores;

    // NEW V2 EVENTS

    event MissionScoreUpdated(uint256 score, MissionState finalState);
    event UAVReputationPenalized(address indexed uav, uint256 newScore, string reason);
    event UAVReputationInitialized(address indexed uav);


    // OVERRIDES

    function version() external pure override returns (string memory) {
        return "MissionFail-V2";
    }

    function triggerReconfiguration()
        external override onlyOwner inMissionState(MissionState.RECONFIGURING)
    {
        require(
            uavs[suspectUav].state == UAVState.CONFIRMED_FAILED ||
            uavs[suspectUav].state == UAVState.CONFIRMED_BYZANTINE,
            "Suspect not confirmed"
        );

        address suspect = suspectUav;
        _penalizeReputation(suspect);

        _removeUAVAndReassignTasks(suspect);
        failureCount += 1;

        if (failureCount >= abortFailureThreshold) {
            missionState = MissionState.ABORTED;
            _updateScore(0);
            emit MissionAborted("Failure threshold exceeded");
            emit MissionStateChanged(missionState);
            _clearIncident();
            return;
        }

        if (_totalResidualCapacity() == 0 && _hasUnassignedTasks()) {
            missionState = MissionState.ABORTED;
            _updateScore(0);
            emit MissionAborted("No residual capacity to continue");
            emit MissionStateChanged(missionState);
            _clearIncident();
            return;
        }

        if (_currentOperationalCapacity() >= degradedCapacityThreshold && !_hasUnassignedTasks()) {
            missionState = MissionState.ACTIVE_RECONFIGURED;
            _updateScore(85);
        } else {
            missionState = MissionState.DEGRADED;
            _updateScore(50);
            emit MissionDegraded(formationMode);
        }

        emit MissionStateChanged(missionState);
        _clearIncident();
    }

    function _clearUAVData(address uav) internal override {
        super._clearUAVData(uav);
        reputationScores[uav] = 0;
    }

    function resetMission() public override onlyOwner {
        super.resetMission();
        missionScore = 0;
    }


    // NEW V2 FUNCTIONS

    function initUAVReputation(address _uav) external onlyOwner {
        require(uavs[_uav].registered, "UAV not registered");
        require(reputationScores[_uav] == 0, "Reputation already initialized");
        reputationScores[_uav] = 100;
        emit UAVReputationInitialized(_uav);
    }

    function setMissionScore(uint256 _score) external onlyOwner {
        require(_score <= 100, "Score must be 0-100");
        missionScore = _score;
        emit MissionScoreUpdated(_score, missionState);
    }

    function getReputationScore(address _uav) external view returns (uint256) {
        return reputationScores[_uav];
    }

    function getMissionSummaryV2()
        external view
        returns (
            MissionState  state,
            FormationMode formation,
            uint256       failures,
            uint256       activeUAVs,
            uint256       activeTasks,
            address       suspect,
            uint256       score,
            uint256       lowRepUAVs
        )
    {
        uint256 uavCnt;
        uint256 lowRep;
        for (uint256 i = 0; i < uavList.length; i++) {
            address u = uavList[i];
            if (uavs[u].state == UAVState.ACTIVE) {
                uavCnt++;
                if (reputationScores[u] > 0 && reputationScores[u] < 50) lowRep++;
            }
        }
        uint256 taskCnt;
        for (uint256 i = 0; i < activeTaskIds.length; i++) {
            if (tasks[activeTaskIds[i]].active) taskCnt++;
        }
        return (
            missionState, formationMode, failureCount,
            uavCnt, taskCnt, suspectUav,
            missionScore, lowRep
        );
    }


    // INTERNAL V2

    function _updateScore(uint256 _score) internal {
        missionScore = _score;
        emit MissionScoreUpdated(_score, missionState);
    }


    function _penalizeReputation(address _uav) internal {
        if (reputationScores[_uav] == 0) reputationScores[_uav] = 100;

        UAVState state_ = uavs[_uav].state;
        uint256  penalty;
        string memory reason;

        if (state_ == UAVState.CONFIRMED_FAILED) {
            penalty = 30;
            reason  = "CONFIRMED_FAILED";
        } else if (state_ == UAVState.CONFIRMED_BYZANTINE) {
            penalty = 50;
            reason  = "CONFIRMED_BYZANTINE";
        } else {
            return;
        }

        uint256 current = reputationScores[_uav];
        reputationScores[_uav] = current > penalty ? current - penalty : 0;
        emit UAVReputationPenalized(_uav, reputationScores[_uav], reason);
    }
}
