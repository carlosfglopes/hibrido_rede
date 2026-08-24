// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title MissionReconV1 — upgradeable UUPS UAV reconnaissance contract
/// @notice Model 3 (hybrid) counterpart: leader-election-based recon FSM
///         (IDLE → ACTIVE → ELECTION → ASSIGNED → REPORTING → terminal),
///         upgraded via UUPS instead of an FSM proxy swap.
/// @dev Storage layout is fixed from this version on — never reorder, remove, or
///      retype existing state variables in V2+, only append new ones.
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

contract MissionReconV1 is Initializable, OwnableUpgradeable, UUPSUpgradeable {

    // ENUMS

    enum MissionState {
        IDLE,
        ACTIVE,
        ELECTION,
        ASSIGNED,
        REPORTING,
        COMPLETED,
        FAILED,
        TERMINATED
    }

    enum ReportResult {
        NONE,
        TARGET_DETECTED,
        NOTHING_FOUND,
        INCONCLUSIVE
    }

    // STRUCTS

    struct UAVStatus {
        bool    permitted;
        bool    registered;
        bool    hasStatus;
        bool    ineligible;
        uint256 battery;
        uint256 speed;
        uint256 score;
    }

    // STATE VARIABLES

    MissionState public missionState;
    uint256      public minUAVsForElection;
    uint256      public reportTimeoutSec;
    uint256      public maxReelections;
    uint256      public weightBattery;
    uint256      public weightSpeed;
    uint256      public reelectionCount;
    uint256      public electionTimestamp;
    string       public missionZone;
    address      public electedLeader;
    ReportResult public finalReport;
    bytes32      public finalEvidenceHash;

    mapping(address => UAVStatus) public uavs;
    address[] public permittedUAVList;
    address[] public registeredUAVList;

    // EVENTS

    event UAVPermitted(address indexed uav);
    event MissionActivated(string zone);
    event UAVRegistered(address indexed uav);
    event StatusPublished(address indexed uav, uint256 battery, uint256 speed, uint256 score);
    event ElectionStarted(uint256 timestamp);
    event LeaderElected(address indexed leader, uint256 score);
    event ReportSubmitted(address indexed leader, ReportResult result, bytes32 evidenceHash);
    event ReelectionTriggered(uint256 count);
    event MissionCompleted(address indexed leader, ReportResult result);
    event MissionFailed(string reason);
    event MissionTerminated();
    event MissionReset(uint256 timestamp);
    event ContractUpgraded(address indexed newImpl, uint256 timestamp);

    // MODIFIERS

    modifier onlyPermittedUAV() {
        require(uavs[msg.sender].permitted, "UAV not permitted");
        _;
    }

    modifier onlyRegisteredUAV() {
        require(uavs[msg.sender].registered, "UAV not registered");
        _;
    }

    modifier onlyLeader() {
        require(msg.sender == electedLeader, "Only elected leader");
        _;
    }

    modifier onlyWhileIdle() {
        require(missionState == MissionState.IDLE, "Cannot permit after mission started");
        _;
    }

    // CONSTRUCTOR + INITIALIZER

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _authority,
        uint256 _minUAVsForElection,
        uint256 _reportTimeoutSec,
        uint256 _maxReelections,
        uint256 _weightBattery,
        uint256 _weightSpeed
    ) public initializer {
        require(_authority != address(0),             "Invalid authority");
        require(_minUAVsForElection > 0,              "Invalid min UAVs");
        require(_weightBattery + _weightSpeed == 100, "Weights must sum to 100");

        __Ownable_init(_authority);

        minUAVsForElection = _minUAVsForElection;
        reportTimeoutSec   = _reportTimeoutSec;
        maxReelections     = _maxReelections;
        weightBattery      = _weightBattery;
        weightSpeed        = _weightSpeed;
        missionState       = MissionState.IDLE;
    }

    // AUTHORITY FUNCTIONS

    function permitUAV(address _uav) external onlyOwner onlyWhileIdle {
        require(_uav != address(0),        "Invalid UAV");
        require(!uavs[_uav].permitted,     "Already permitted");
        uavs[_uav].permitted = true;
        permittedUAVList.push(_uav);
        emit UAVPermitted(_uav);
    }

    function activateMission(string calldata _zone) external onlyOwner {
        require(missionState == MissionState.IDLE, "Mission not idle");
        missionZone  = _zone;
        missionState = MissionState.ACTIVE;
        emit MissionActivated(_zone);
    }

    function startElection() external onlyOwner {
        require(missionState == MissionState.ACTIVE,              "Mission not active");
        require(registeredUAVList.length >= minUAVsForElection,   "Not enough UAVs");
        for (uint256 i = 0; i < registeredUAVList.length; i++) {
            require(uavs[registeredUAVList[i]].hasStatus, "Missing UAV status");
        }
        missionState      = MissionState.ELECTION;
        electionTimestamp = block.timestamp;
        emit ElectionStarted(block.timestamp);
        _electLeader();
    }

    function terminateMission() external onlyOwner {
        require(
            missionState != MissionState.COMPLETED &&
            missionState != MissionState.FAILED &&
            missionState != MissionState.TERMINATED,
            "Already in terminal state"
        );
        missionState = MissionState.TERMINATED;
        emit MissionTerminated();
    }

    function resetMission() public virtual onlyOwner {
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

        emit MissionReset(block.timestamp);
    }

    // UAV FUNCTIONS

    function registerUAV() external onlyPermittedUAV {
        require(missionState == MissionState.ACTIVE, "Mission not active");
        require(!uavs[msg.sender].registered,        "Already registered");
        uavs[msg.sender].registered = true;
        registeredUAVList.push(msg.sender);
        emit UAVRegistered(msg.sender);
    }

    function publishStatus(uint256 _battery, uint256 _speed)
        external onlyPermittedUAV onlyRegisteredUAV
    {
        require(
            missionState == MissionState.ACTIVE ||
            missionState == MissionState.ELECTION,
            "Invalid mission state"
        );
        uint256 score = (_battery * weightBattery) + (_speed * weightSpeed);
        uavs[msg.sender].battery   = _battery;
        uavs[msg.sender].speed     = _speed;
        uavs[msg.sender].score     = score;
        uavs[msg.sender].hasStatus = true;
        emit StatusPublished(msg.sender, _battery, _speed, score);
    }

    function submitReport(ReportResult _result, bytes32 _evidenceHash)
        external virtual onlyLeader
    {
        require(missionState == MissionState.ASSIGNED, "Mission not assigned");

        missionState      = MissionState.REPORTING;
        finalReport       = _result;
        finalEvidenceHash = _evidenceHash;
        emit ReportSubmitted(msg.sender, _result, _evidenceHash);

        if (_result == ReportResult.TARGET_DETECTED || _result == ReportResult.NOTHING_FOUND) {
            missionState = MissionState.COMPLETED;
            emit MissionCompleted(msg.sender, _result);
            return;
        }
        if (_result == ReportResult.INCONCLUSIVE) {
            _triggerReelectionOrFail("Inconclusive report");
        }
    }

    function checkTimeout() external {
        require(missionState == MissionState.ASSIGNED, "Mission not assigned");
        require(
            block.timestamp > electionTimestamp + reportTimeoutSec,
            "Timeout not reached"
        );
        _triggerReelectionOrFail("Leader timeout");
    }

    // VIEW FUNCTIONS

    function version() external pure virtual returns (string memory) {
        return "MissionRecon-V1";
    }

    function getPermittedUAVCount() external view returns (uint256) {
        return permittedUAVList.length;
    }

    function getRegisteredUAVCount() external view returns (uint256) {
        return registeredUAVList.length;
    }

    function getMissionSummary()
        external view
        returns (
            MissionState  state,
            string memory zone,
            address       leader,
            uint256       reelections,
            ReportResult  report,
            bytes32       evidenceHash
        )
    {
        return (missionState, missionZone, electedLeader, reelectionCount, finalReport, finalEvidenceHash);
    }

    // INTERNAL

    function _electLeader() internal {
        address bestUAV   = address(0);
        uint256 bestScore = 0;
        for (uint256 i = 0; i < registeredUAVList.length; i++) {
            address candidate = registeredUAVList[i];
            if (uavs[candidate].ineligible) continue;
            uint256 candidateScore = uavs[candidate].score;
            if (candidateScore > bestScore) {
                bestScore = candidateScore;
                bestUAV   = candidate;
            }
        }
        require(bestUAV != address(0), "No eligible leader found");
        electedLeader     = bestUAV;
        missionState      = MissionState.ASSIGNED;
        electionTimestamp = block.timestamp;
        emit LeaderElected(bestUAV, bestScore);
    }

    function _triggerReelectionOrFail(string memory reason) internal {
        if (electedLeader != address(0)) {
            uavs[electedLeader].ineligible = true;
        }
        if (reelectionCount < maxReelections) {
            reelectionCount += 1;
            missionState     = MissionState.ELECTION;
            emit ReelectionTriggered(reelectionCount);
            _electLeader();
        } else {
            missionState = MissionState.FAILED;
            emit MissionFailed(reason);
        }
    }

    // UUPS

    function _authorizeUpgrade(address newImpl)
        internal override onlyOwner
    {
        emit ContractUpgraded(newImpl, block.timestamp);
    }
}
