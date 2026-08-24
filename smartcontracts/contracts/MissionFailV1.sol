// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title MissionFailV1 — upgradeable UUPS UAV failure-detection contract
/// @notice Model 3 (hybrid) counterpart: same failure-detection/voting behavior,
///         upgraded via UUPS instead of an FSM.
/// @dev Storage layout is fixed from this version on — never reorder, remove, or
///      retype existing state variables in V2+, only append new ones.
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

contract MissionFailV1 is Initializable, OwnableUpgradeable, UUPSUpgradeable {

   
    // ENUMS

    enum MissionState {
        SETUP,
        ACTIVE,
        UNDER_CONFIRMATION,
        RECONFIGURING,
        ACTIVE_RECONFIGURED,
        DEGRADED,
        ABORTED,
        COMPLETED
    }

    enum UAVState {
        UNREGISTERED,
        ACTIVE,
        SUSPECT,
        CONFIRMED_FAILED,
        CONFIRMED_BYZANTINE,
        REMOVED
    }

    enum ReasonCode {
        NONE,
        NO_HEARTBEAT,
        MALICIOUS_BEHAVIOR
    }

    enum VoteChoice {
        NONE,
        CONFIRM_FAILED,
        CONFIRM_BYZANTINE,
        REJECT
    }

    enum FormationMode {
        FULL,
        REDUCED,
        MINIMAL
    }


    // STRUCTS


    struct UAV {
        bool     registered;
        UAVState state;
        uint256  lastHeartbeat;
        uint256  capacityMax;
        uint256  loadCurrent;
    }

    struct Task {
        uint256 id;
        address assignedTo;
        bool    active;
    }


    // STATE VARIABLES 

    MissionState  public missionState;          
    uint256       public heartbeatTimeoutSec;     
    uint256       public quorumThreshold;         
    uint256       public abortFailureThreshold;   
    uint256       public failureCount;            
    uint256       public degradedCapacityThreshold; 
    FormationMode public formationMode;           

    address[] public uavList;                    
    uint256[] public activeTaskIds;              

    mapping(address => UAV)    public uavs;      
    mapping(uint256 => Task)   public tasks;     

    address    public suspectUav;               
    ReasonCode public currentReason;             
    bytes32    public currentEvidenceHash;       
    uint256    public incidentTimestamp;         
    uint256    public votesForFailed;            
    uint256    public votesForByzantine;         
    uint256    public votesReject;               

    mapping(address => bool) public hasVotedOnCurrentIncident; 


    // EVENTS

    event UAVRegistered(address indexed uav, uint256 capacityMax);
    event MissionStarted();
    event HeartbeatReceived(address indexed uav, uint256 timestamp);
    event TaskCreated(uint256 indexed taskId, address indexed assignedTo);
    event TaskCompleted(uint256 indexed taskId);
    event MissionStateChanged(MissionState newState);
    event FailureDetected(address indexed suspect, ReasonCode reason, bytes32 evidenceHash, uint256 timestamp);
    event VoteCast(address indexed voter, address indexed suspect, VoteChoice vote);
    event SuspectConfirmedFailed(address indexed suspect);
    event SuspectConfirmedByzantine(address indexed suspect);
    event SuspectRejected(address indexed suspect);
    event UAVRemoved(address indexed uav);
    event TaskReassigned(uint256 indexed taskId, address indexed fromUav, address indexed toUav);
    event TaskUnassigned(uint256 indexed taskId);
    event MissionDegraded(FormationMode formationMode);
    event MissionCompleted();
    event MissionAborted(string reason);
    event FormationChanged(FormationMode newFormationMode);
    event MissionReset(uint256 timestamp);
    event ContractUpgraded(address indexed newImpl, uint256 timestamp);


    // MODIFIERS

    modifier onlyRegisteredActiveUAV() {
        require(uavs[msg.sender].registered, "UAV not registered");
        require(uavs[msg.sender].state == UAVState.ACTIVE, "UAV not active");
        _;
    }

    modifier inMissionState(MissionState expected) {
        require(missionState == expected, "Invalid mission state");
        _;
    }

    modifier inOperationalState() {
        require(
            missionState == MissionState.ACTIVE ||
            missionState == MissionState.ACTIVE_RECONFIGURED ||
            missionState == MissionState.DEGRADED,
            "Mission not in operational state"
        );
        _;
    }


    // CONSTRUCTOR + INITIALIZER

    constructor() {
        _disableInitializers();
    }

    function initialize(
        address       _authority,
        uint256       _heartbeatTimeoutSec,
        uint256       _quorumThreshold,
        uint256       _abortFailureThreshold,
        uint256       _degradedCapacityThreshold,
        FormationMode _formationMode
    ) public initializer {
        require(_authority != address(0),       "Invalid authority");
        require(_quorumThreshold > 0,           "Quorum must be > 0");
        require(_abortFailureThreshold > 0,     "Abort threshold must be > 0");

        __Ownable_init(_authority);

        heartbeatTimeoutSec       = _heartbeatTimeoutSec;
        quorumThreshold           = _quorumThreshold;
        abortFailureThreshold     = _abortFailureThreshold;
        degradedCapacityThreshold = _degradedCapacityThreshold;
        formationMode             = _formationMode;
        missionState              = MissionState.SETUP;
    }


    // AUTHORITY SETUP

    function registerUAV(address _uav, uint256 _capacityMax)
        external onlyOwner inMissionState(MissionState.SETUP)
    {
        require(_uav != address(0),          "Invalid UAV");
        require(!uavs[_uav].registered,      "Already registered");
        require(_capacityMax > 0,            "Capacity must be > 0");

        uavs[_uav] = UAV({
            registered    : true,
            state         : UAVState.ACTIVE,
            lastHeartbeat : block.timestamp,
            capacityMax   : _capacityMax,
            loadCurrent   : 0
        });
        uavList.push(_uav);
        emit UAVRegistered(_uav, _capacityMax);
    }

    function createTask(uint256 taskId, address assignedTo)
        external onlyOwner inMissionState(MissionState.SETUP)
    {
        require(uavs[assignedTo].registered,                             "Assigned UAV not registered");
        require(uavs[assignedTo].state == UAVState.ACTIVE,               "Assigned UAV not active");
        require(!tasks[taskId].active,                                   "Task already exists");
        require(uavs[assignedTo].loadCurrent < uavs[assignedTo].capacityMax, "UAV at full capacity");

        tasks[taskId] = Task({ id: taskId, assignedTo: assignedTo, active: true });
        activeTaskIds.push(taskId);
        uavs[assignedTo].loadCurrent += 1;
        emit TaskCreated(taskId, assignedTo);
    }

    function startMission()
        external onlyOwner inMissionState(MissionState.SETUP)
    {
        require(uavList.length > 0,       "No UAVs registered");
        require(activeTaskIds.length > 0, "No tasks created");

        for (uint256 i = 0; i < uavList.length; i++) {
            uavs[uavList[i]].lastHeartbeat = block.timestamp;
        }
        missionState = MissionState.ACTIVE;
        emit MissionStarted();
        emit MissionStateChanged(missionState);
    }

    // AUTHORITY RUNTIME

    function detectMissingHeartbeat(address _suspect, bytes32 _evidenceHash)
        external virtual onlyOwner inOperationalState
    {
        require(uavs[_suspect].registered,                                    "Suspect not registered");
        require(uavs[_suspect].state == UAVState.ACTIVE,                      "Suspect not active");
        require(
            block.timestamp > uavs[_suspect].lastHeartbeat + heartbeatTimeoutSec,
            "Heartbeat timeout not reached"
        );
        _openIncident(_suspect, ReasonCode.NO_HEARTBEAT, _evidenceHash);
    }

    function openBehaviorIncident(address _suspect, bytes32 _evidenceHash)
        external onlyOwner inOperationalState
    {
        require(uavs[_suspect].registered,               "Suspect not registered");
        require(uavs[_suspect].state == UAVState.ACTIVE, "Suspect not active");
        _openIncident(_suspect, ReasonCode.MALICIOUS_BEHAVIOR, _evidenceHash);
    }

    function finalizeIncident()
        external virtual onlyOwner inMissionState(MissionState.UNDER_CONFIRMATION)
    {
        uint256 eligible      = getActiveEligibleVoters();
        bool    quorumPossible = eligible >= quorumThreshold;

        bool decideFailed    = votesForFailed    >= quorumThreshold ||
                               (!quorumPossible && votesForFailed    == eligible && eligible > 0);
        bool decideByzantine = votesForByzantine >= quorumThreshold ||
                               (!quorumPossible && votesForByzantine == eligible && eligible > 0);
        bool decideReject    = votesReject       >= quorumThreshold ||
                               (!quorumPossible && votesReject       == eligible && eligible > 0);

        if (decideFailed) {
            uavs[suspectUav].state = UAVState.CONFIRMED_FAILED;
            missionState           = MissionState.RECONFIGURING;
            emit SuspectConfirmedFailed(suspectUav);
            emit MissionStateChanged(missionState);
        } else if (decideByzantine) {
            uavs[suspectUav].state = UAVState.CONFIRMED_BYZANTINE;
            missionState           = MissionState.RECONFIGURING;
            emit SuspectConfirmedByzantine(suspectUav);
            emit MissionStateChanged(missionState);
        } else if (decideReject) {
            uavs[suspectUav].state = UAVState.ACTIVE;
            emit SuspectRejected(suspectUav);
            _clearIncident();
            missionState = MissionState.ACTIVE;
            emit MissionStateChanged(missionState);
        } else {
            revert("Quorum not reached");
        }
    }

    function triggerReconfiguration()
        external virtual onlyOwner inMissionState(MissionState.RECONFIGURING)
    {
        require(
            uavs[suspectUav].state == UAVState.CONFIRMED_FAILED ||
            uavs[suspectUav].state == UAVState.CONFIRMED_BYZANTINE,
            "Suspect not confirmed"
        );

        _removeUAVAndReassignTasks(suspectUav);
        failureCount += 1;

        if (failureCount >= abortFailureThreshold) {
            missionState = MissionState.ABORTED;
            emit MissionAborted("Failure threshold exceeded");
            emit MissionStateChanged(missionState);
            _clearIncident();
            return;
        }

        if (_totalResidualCapacity() == 0 && _hasUnassignedTasks()) {
            missionState = MissionState.ABORTED;
            emit MissionAborted("No residual capacity to continue");
            emit MissionStateChanged(missionState);
            _clearIncident();
            return;
        }

        if (_currentOperationalCapacity() >= degradedCapacityThreshold && !_hasUnassignedTasks()) {
            missionState = MissionState.ACTIVE_RECONFIGURED;
        } else {
            missionState = MissionState.DEGRADED;
            emit MissionDegraded(formationMode);
        }

        emit MissionStateChanged(missionState);
        _clearIncident();
    }

    function setFormation(FormationMode _formationMode) external onlyOwner {
        formationMode = _formationMode;
        emit FormationChanged(_formationMode);
    }

    function recoverToActiveReconfigured()
        external onlyOwner inMissionState(MissionState.DEGRADED)
    {
        require(!_hasUnassignedTasks(),                                    "Still has unassigned tasks");
        require(_currentOperationalCapacity() >= degradedCapacityThreshold, "Insufficient capacity");
        missionState = MissionState.ACTIVE_RECONFIGURED;
        emit MissionStateChanged(missionState);
    }

    function completeTask(uint256 taskId) external onlyOwner {
        require(tasks[taskId].active, "Task not active");
        address assignedTo = tasks[taskId].assignedTo;
        tasks[taskId].active = false;
        if (assignedTo != address(0) && uavs[assignedTo].registered) {
            if (uavs[assignedTo].loadCurrent > 0) uavs[assignedTo].loadCurrent -= 1;
        }
        _removeFromActiveTaskIds(taskId);
        emit TaskCompleted(taskId);
    }

    function completeMission() external onlyOwner inOperationalState {
        missionState = MissionState.COMPLETED;
        emit MissionCompleted();
        emit MissionStateChanged(missionState);
    }

    function abortMission(string calldata reason) external onlyOwner {
        require(
            missionState != MissionState.ABORTED &&
            missionState != MissionState.COMPLETED,
            "Already terminal"
        );
        missionState = MissionState.ABORTED;
        emit MissionAborted(reason);
        emit MissionStateChanged(missionState);
    }

    function resetMission() public virtual onlyOwner {
        require(missionState != MissionState.SETUP, "Mission already in setup");

        for (uint256 i = 0; i < uavList.length; i++) {
            _clearUAVData(uavList[i]);
        }
        delete uavList;

        for (uint256 i = 0; i < activeTaskIds.length; i++) {
            delete tasks[activeTaskIds[i]];
        }
        delete activeTaskIds;

        suspectUav          = address(0);
        currentReason       = ReasonCode.NONE;
        currentEvidenceHash = bytes32(0);
        incidentTimestamp   = 0;
        votesForFailed      = 0;
        votesForByzantine   = 0;
        votesReject         = 0;
        failureCount        = 0;

        missionState = MissionState.SETUP;
        emit MissionReset(block.timestamp);
    }


    // UAV FUNCTIONS

    function heartbeat() external onlyRegisteredActiveUAV inOperationalState {
        uavs[msg.sender].lastHeartbeat = block.timestamp;
        emit HeartbeatReceived(msg.sender, block.timestamp);
    }

    function voteOnSuspect(VoteChoice vote)
        external onlyRegisteredActiveUAV inMissionState(MissionState.UNDER_CONFIRMATION)
    {
        require(msg.sender != suspectUav,                "Suspect cannot vote");
        require(!hasVotedOnCurrentIncident[msg.sender],  "Already voted");
        require(
            vote == VoteChoice.CONFIRM_FAILED ||
            vote == VoteChoice.CONFIRM_BYZANTINE ||
            vote == VoteChoice.REJECT,
            "Invalid vote"
        );

        hasVotedOnCurrentIncident[msg.sender] = true;

        if      (vote == VoteChoice.CONFIRM_FAILED)     votesForFailed    += 1;
        else if (vote == VoteChoice.CONFIRM_BYZANTINE)  votesForByzantine += 1;
        else                                            votesReject       += 1;

        emit VoteCast(msg.sender, suspectUav, vote);
    }

   
    // VIEW FUNCTIONS

    function version() external pure virtual returns (string memory) {
        return "MissionFail-V1";
    }

    function getUAVCount() external view returns (uint256) {
        return uavList.length;
    }

    function getActiveTaskCount() external view returns (uint256 count) {
        for (uint256 i = 0; i < activeTaskIds.length; i++) {
            if (tasks[activeTaskIds[i]].active) count++;
        }
    }

    function getActiveEligibleVoters() public view returns (uint256 count) {
        for (uint256 i = 0; i < uavList.length; i++) {
            address u = uavList[i];
            if (uavs[u].state == UAVState.ACTIVE && u != suspectUav) count++;
        }
    }

    function getResidualCapacity(address _uav) public view returns (uint256) {
        UAV memory u = uavs[_uav];
        if (!u.registered || u.state != UAVState.ACTIVE) return 0;
        if (u.capacityMax <= u.loadCurrent) return 0;
        return u.capacityMax - u.loadCurrent;
    }

    function getTaskSummary(uint256 taskId)
        external view
        returns (bool active, address assignedTo, uint256 assigneeLoad, uint256 assigneeCapacity)
    {
        Task memory t = tasks[taskId];
        active     = t.active;
        assignedTo = t.assignedTo;
        if (t.assignedTo != address(0) && uavs[t.assignedTo].registered) {
            assigneeLoad     = uavs[t.assignedTo].loadCurrent;
            assigneeCapacity = uavs[t.assignedTo].capacityMax;
        }
    }

    function getMissionSummary()
        external view
        returns (
            MissionState  state,
            FormationMode formation,
            uint256       failures,
            uint256       activeUAVs,
            uint256       activeTasks,
            address       suspect,
            ReasonCode    reason,
            uint256       vFailed,
            uint256       vByzantine,
            uint256       vReject
        )
    {
        uint256 uavCnt;
        for (uint256 i = 0; i < uavList.length; i++) {
            if (uavs[uavList[i]].state == UAVState.ACTIVE) uavCnt++;
        }
        uint256 taskCnt;
        for (uint256 i = 0; i < activeTaskIds.length; i++) {
            if (tasks[activeTaskIds[i]].active) taskCnt++;
        }
        return (
            missionState, formationMode, failureCount,
            uavCnt, taskCnt, suspectUav,
            currentReason, votesForFailed, votesForByzantine, votesReject
        );
    }


    // INTERNAL

    function _openIncident(address _suspect, ReasonCode _reason, bytes32 _evidenceHash) internal {
        suspectUav          = _suspect;
        currentReason       = _reason;
        currentEvidenceHash = _evidenceHash;
        incidentTimestamp   = block.timestamp;
        uavs[_suspect].state = UAVState.SUSPECT;
        _resetVotes();
        missionState = MissionState.UNDER_CONFIRMATION;
        emit FailureDetected(_suspect, _reason, _evidenceHash, block.timestamp);
        emit MissionStateChanged(missionState);
    }

    function _removeUAVAndReassignTasks(address _removedUav) internal {
        for (uint256 i = 0; i < activeTaskIds.length; i++) {
            uint256 taskId = activeTaskIds[i];
            if (tasks[taskId].active && tasks[taskId].assignedTo == _removedUav) {
                address newUav = _findBestReplacementUAV(_removedUav);
                if (newUav != address(0)) {
                    tasks[taskId].assignedTo  = newUav;
                    uavs[newUav].loadCurrent += 1;
                    emit TaskReassigned(taskId, _removedUav, newUav);
                } else {
                    tasks[taskId].assignedTo = address(0);
                    emit TaskUnassigned(taskId);
                }
            }
        }
        uavs[_removedUav].loadCurrent = 0;
        uavs[_removedUav].state       = UAVState.REMOVED;
        emit UAVRemoved(_removedUav);
    }

    function _findBestReplacementUAV(address _excluded) internal view returns (address bestUav) {
        uint256 bestResidual = 0;
        for (uint256 i = 0; i < uavList.length; i++) {
            address candidate = uavList[i];
            if (candidate == _excluded) continue;
            if (uavs[candidate].state != UAVState.ACTIVE) continue;
            uint256 residual = getResidualCapacity(candidate);
            if (residual > bestResidual) {
                bestResidual = residual;
                bestUav      = candidate;
            }
        }
    }

    function _totalResidualCapacity() internal view returns (uint256 total) {
        for (uint256 i = 0; i < uavList.length; i++) {
            total += getResidualCapacity(uavList[i]);
        }
    }

    function _currentOperationalCapacity() internal view returns (uint256 total) {
        for (uint256 i = 0; i < uavList.length; i++) {
            address u = uavList[i];
            if (uavs[u].state == UAVState.ACTIVE) total += uavs[u].capacityMax;
        }
    }

    function _hasUnassignedTasks() internal view returns (bool) {
        for (uint256 i = 0; i < activeTaskIds.length; i++) {
            uint256 taskId = activeTaskIds[i];
            if (tasks[taskId].active && tasks[taskId].assignedTo == address(0)) return true;
        }
        return false;
    }

    function _resetVotes() internal {
        for (uint256 i = 0; i < uavList.length; i++) {
            hasVotedOnCurrentIncident[uavList[i]] = false;
        }
        votesForFailed    = 0;
        votesForByzantine = 0;
        votesReject       = 0;
    }

    function _clearIncident() internal {
        for (uint256 i = 0; i < uavList.length; i++) {
            hasVotedOnCurrentIncident[uavList[i]] = false;
        }
        suspectUav          = address(0);
        currentReason       = ReasonCode.NONE;
        currentEvidenceHash = bytes32(0);
        incidentTimestamp   = 0;
        votesForFailed      = 0;
        votesForByzantine   = 0;
        votesReject         = 0;
    }

    function _clearUAVData(address uav) internal virtual {
        uavs[uav].registered    = false;
        uavs[uav].state         = UAVState.UNREGISTERED;
        uavs[uav].lastHeartbeat = 0;
        uavs[uav].capacityMax   = 0;
        uavs[uav].loadCurrent   = 0;
        hasVotedOnCurrentIncident[uav] = false;
    }

    function _removeFromActiveTaskIds(uint256 taskId) internal {
        for (uint256 i = 0; i < activeTaskIds.length; i++) {
            if (activeTaskIds[i] == taskId) {
                activeTaskIds[i] = activeTaskIds[activeTaskIds.length - 1];
                activeTaskIds.pop();
                return;
            }
        }
    }



    function _authorizeUpgrade(address newImpl)
        internal override onlyOwner
    {
        emit ContractUpgraded(newImpl, block.timestamp);
    }
}
