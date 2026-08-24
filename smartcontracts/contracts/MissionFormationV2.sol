// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title MissionFormationV2 — UUPS upgrade adding a formation-quality score
/// @notice Adds formationScore, configurable violation penalties/recovery
///         bonuses, and confirmed-event counters on top of V1's
///         formation-tolerance/consensus behavior.
/// @dev New state variables only append after V1's layout (slots 18-22).
import "./MissionFormationV1.sol";

contract MissionFormationV2 is MissionFormationV1 {

    // NEW V2 STATE VARIABLES

    uint256 public formationScore;
    uint256 public penaltyPerViolation;
    uint256 public bonusPerRecovery;
    uint256 public totalViolationsConfirmed;
    uint256 public totalRecoveriesConfirmed;

    // NEW V2 EVENTS

    event FormationScoreUpdated(uint256 score, int256 delta, string reason);
    event FormationScoreConfigured(uint256 penalty, uint256 bonus);


    // NEW V2 LOGIC

    function initializeV2(uint256 _penaltyPerViolation, uint256 _bonusPerRecovery)
        external reinitializer(2) onlyOwner
    {
        require(_penaltyPerViolation <= 20, "Penalty too high (max 20)");
        require(_bonusPerRecovery    <= 10, "Bonus too high (max 10)");

        penaltyPerViolation = _penaltyPerViolation;
        bonusPerRecovery    = _bonusPerRecovery;
        formationScore      = 100;

        emit FormationScoreConfigured(_penaltyPerViolation, _bonusPerRecovery);
    }


    // OVERRIDES

    function version() external pure override returns (string memory) {
        return "MissionFormation-V2";
    }

    function reportViolation(address _violator)
        external override onlyRegisteredActiveUAV inOperationalState
    {
        require(uavs[_violator].registered,                "Violator not registered");
        require(uavs[_violator].state != UAVState.INACTIVE, "Violator is inactive");
        require(_violator != msg.sender,                   "Cannot report yourself");
        require(!hasVoted[msg.sender][_violator],          "Already voted this round");

        hasVoted[msg.sender][_violator] = true;
        violationVotes[_violator]++;
        emit ViolationReported(msg.sender, _violator, violationVotes[_violator], quorum);

        if (violationVotes[_violator] >= quorum) {
            _clearViolationVotes(_violator);
            UAVData storage accused = uavs[_violator];
            accused.violationCount++;
            emit ViolationConfirmed(_violator, accused.violationCount);
            totalViolationsConfirmed++;

            _applyScorePenalty();

            if (accused.violationCount >= maxViolations &&
                accused.state != UAVState.OUT_OF_FORMATION) {
                UAVState old  = accused.state;
                accused.state = UAVState.OUT_OF_FORMATION;
                emit UAVStateChanged(_violator, old, UAVState.OUT_OF_FORMATION);
                emit FormationViolation(_violator, "Consensus: quorum violation confirmed");
            }
            _checkSwarmHealth();
        }
    }

    function reportRecovery(address _uav)
        external override onlyRegisteredActiveUAV inOperationalState
    {
        require(uavs[_uav].registered,                          "UAV not registered");
        require(uavs[_uav].state == UAVState.OUT_OF_FORMATION,  "UAV not OUT_OF_FORMATION");
        require(_uav != msg.sender,                             "Cannot report yourself");
        require(!hasVotedRecovery[msg.sender][_uav],            "Already voted recovery");

        hasVotedRecovery[msg.sender][_uav] = true;
        recoveryVotes[_uav]++;
        emit RecoveryReported(msg.sender, _uav, recoveryVotes[_uav], quorum);

        if (recoveryVotes[_uav] >= quorum) {
            _clearRecoveryVotes(_uav);
            UAVData storage uav = uavs[_uav];
            UAVState old  = uav.state;
            uav.state     = UAVState.OK;
            uav.violationCount = 0;
            totalRecoveriesConfirmed++;

            _applyScoreBonus();

            emit RecoveryConfirmed(_uav);
            emit UAVStateChanged(_uav, old, UAVState.OK);
            _checkSwarmHealth();
        }
    }

    function resetMission() public override onlyOwner {
        require(missionState != MissionState.SETUP, "Already in setup");

        for (uint256 i = 0; i < uavList.length; i++) {
            address u = uavList[i];
            _clearAllVotes(u);
            delete uavs[u];
        }
        delete uavList;

        centroidX        = 0;
        centroidY        = 0;
        transitionEnd    = 0;
        pendingFormation = FormationParams(0, 0, 0, 0);
        missionState     = MissionState.SETUP;

        formationScore            = 100;
        totalViolationsConfirmed  = 0;
        totalRecoveriesConfirmed  = 0;

        emit MissionReset(block.timestamp);
        emit FormationScoreUpdated(100, 0, "reset");
    }


    // NEW V2 FUNCTIONS

    function configureScoring(uint256 _penalty, uint256 _bonus) external onlyOwner {
        require(_penalty <= 20, "Penalty too high (max 20)");
        require(_bonus    <= 10, "Bonus too high (max 10)");
        penaltyPerViolation = _penalty;
        bonusPerRecovery    = _bonus;
        emit FormationScoreConfigured(_penalty, _bonus);
    }

    function getSwarmSummaryV2()
        external view
        returns (
            MissionState state,
            uint256      formationId,
            int256       cx,
            int256       cy,
            uint256      totalUAVs,
            uint256      score,
            uint256      totalViolations,
            uint256      totalRecoveries
        )
    {
        return (
            missionState,
            currentFormation.formationId,
            centroidX,
            centroidY,
            uavList.length,
            formationScore,
            totalViolationsConfirmed,
            totalRecoveriesConfirmed
        );
    }


    // INTERNAL V2

    function _applyScorePenalty() internal {
        if (penaltyPerViolation == 0) return;
        uint256 penalty = penaltyPerViolation;
        uint256 current = formationScore;
        uint256 newScore = current > penalty ? current - penalty : 0;
        int256  delta    = int256(newScore) - int256(current);
        formationScore   = newScore;
        emit FormationScoreUpdated(newScore, delta, "violation_confirmed");
    }

    function _applyScoreBonus() internal {
        if (bonusPerRecovery == 0) return;
        uint256 bonus    = bonusPerRecovery;
        uint256 current  = formationScore;
        uint256 newScore = current + bonus > 100 ? 100 : current + bonus;
        int256  delta    = int256(newScore) - int256(current);
        formationScore   = newScore;
        emit FormationScoreUpdated(newScore, delta, "recovery_confirmed");
    }
}
