/*
  This file is part of The Colony Network.

  The Colony Network is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  The Colony Network is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with The Colony Network. If not, see <http://www.gnu.org/licenses/>.
*/

pragma solidity 0.7.3;
pragma experimental ABIEncoderV2;

import "./VotingBase.sol";


contract VotingReputation is VotingBase {

  uint256 constant NUM_INFLUENCES = 1;

  /// @notice Returns the identifier of the extension
  function identifier() public override pure returns (bytes32) {
    return keccak256("VotingReputation");
  }

  /// @notice Return the version number
  /// @return The version number
  function version() public pure override returns (uint256) {
    return 1;
  }

  // [motionId][skillId][user] => reputationBalance
  mapping (uint256 => mapping (uint256 => mapping (address => uint256[]))) influences;
  // [motionId][skillId] => reputationBalance
  mapping (uint256 => mapping (uint256 => uint256[])) totalInfluences;

  // Public

  /// @notice Set influence for a motion
  /// @param _motionId The id of the motion
  /// @param _key Reputation tree key for the root domain
  /// @param _value Reputation tree value for the root domain
  /// @param _branchMask The branchmask of the proof
  /// @param _siblings The siblings of the proof
  function setInfluence(
    uint256 _motionId,
    bytes memory _key,
    bytes memory _value,
    uint256 _branchMask,
    bytes32[] memory _siblings
  )
    public
  {
    uint256 skillId = motions[_motionId].skillId;
    require(totalInfluences[_motionId][skillId].length > 0, "voting-reputation-invalid-motion");

    if (influences[_motionId][skillId][msg.sender].length == 0) {
      influences[_motionId][skillId][msg.sender] = new uint256[](NUM_INFLUENCES);
      uint256 userRep = getReputationFromProof(_motionId, msg.sender, _key, _value, _branchMask, _siblings);

      influences[_motionId][skillId][msg.sender][0] = userRep;
      totalInfluences[_motionId][skillId][0] = add(totalInfluences[_motionId][skillId][0], userRep);
    }
  }

  /// @notice Get the user influence in the motion
  /// @param _motionId The id of the motion
  /// @param _user The user in question
  function getInfluence(uint256 _motionId, address _user)
    public
    view
    override
    returns (uint256[] memory influence)
  {
    influence = influences[_motionId][motions[_motionId].skillId][_user];
  }

  /// @notice Get the total influence in the motion
  /// @param _motionId The id of the motion
  function getTotalInfluence(uint256 _motionId)
    public
    view
    override
    returns (uint256[] memory influence)
  {
    influence = totalInfluences[_motionId][motions[_motionId].skillId];
  }

  function postReveal(uint256 _motionId, address _user) internal override {}
  function postClaim(uint256 _motionId, address _user) internal override {}

  /// @notice Create a motion in the root domain
  /// @param _altTarget The contract to which we send the action (0x0 for the colony)
  /// @param _action A bytes array encoding a function call
  /// @param _key Reputation tree key for the root domain
  /// @param _value Reputation tree value for the root domain
  /// @param _branchMask The branchmask of the proof
  /// @param _siblings The siblings of the proof
  function createRootMotion(
    address _altTarget,
    bytes memory _action,
    bytes memory _key,
    bytes memory _value,
    uint256 _branchMask,
    bytes32[] memory _siblings
  )
    public
  {
    createMotion(_altTarget, _action, 1, NUM_INFLUENCES);
    Motion storage motion = motions[motionCount];

    totalInfluences[motionCount][motion.skillId] = new uint256[](NUM_INFLUENCES);
    motion.maxVotes[0] = getReputationFromProof(motionCount, address(0x0), _key, _value, _branchMask, _siblings);
  }

  /// @notice Create a motion in any domain
  /// @param _domainId The domain where we vote on the motion
  /// @param _childSkillIndex The childSkillIndex pointing to the domain of the action
  /// @param _action A bytes array encoding a function call
  /// @param _key Reputation tree key for the domain
  /// @param _value Reputation tree value for the domain
  /// @param _branchMask The branchmask of the proof
  /// @param _siblings The siblings of the proof
  function createDomainMotion(
    uint256 _domainId,
    uint256 _childSkillIndex,
    bytes memory _action,
    bytes memory _key,
    bytes memory _value,
    uint256 _branchMask,
    bytes32[] memory _siblings
  )
    public
  {
    // Check the function requires a non-root permission (and thus a domain proof)
    require(
      colony.getCapabilityRoles(getSig(_action)) | ROOT_ROLES != ROOT_ROLES,
      "voting-base-invalid-function"
    );

    uint256 domainSkillId = colony.getDomain(_domainId).skillId;
    uint256 actionDomainSkillId = getActionDomainSkillId(_action);

    if (domainSkillId != actionDomainSkillId) {
      uint256 childSkillId = colonyNetwork.getChildSkillId(domainSkillId, _childSkillIndex);
      require(childSkillId == actionDomainSkillId, "voting-base-invalid-domain-id");
    }

    createMotion(address(0x0), _action, _domainId, NUM_INFLUENCES);
    Motion storage motion = motions[motionCount];

    totalInfluences[motionCount][motion.skillId] = new uint256[](NUM_INFLUENCES);
    motion.maxVotes[0] = getReputationFromProof(motionCount, address(0x0), _key, _value, _branchMask, _siblings);
  }

  /// @notice Stake on a motion
  /// @param _motionId The id of the motion
  /// @param _permissionDomainId The domain where the extension has the arbitration permission
  /// @param _childSkillIndex For the domain in which the motion is occurring
  /// @param _vote The side being supported (0 = NAY, 1 = YAY)
  /// @param _amount The amount of tokens being staked
  /// @param _key Reputation tree key for the staker/domain
  /// @param _value Reputation tree value for the staker/domain
  /// @param _branchMask The branchmask of the proof
  /// @param _siblings The siblings of the proof
  function stakeMotion(
    uint256 _motionId,
    uint256 _permissionDomainId,
    uint256 _childSkillIndex,
    uint256 _vote,
    uint256 _amount,
    bytes memory _key,
    bytes memory _value,
    uint256 _branchMask,
    bytes32[] memory _siblings
  )
    public
  {
    setInfluence(_motionId, _key, _value, _branchMask, _siblings);
    internalStakeMotion(_motionId, _permissionDomainId, _childSkillIndex, _vote, _amount);
  }

  /// @notice Submit a vote secret for a motion
  /// @param _motionId The id of the motion
  /// @param _voteSecret The hashed vote secret
  /// @param _key Reputation tree key for the staker/domain
  /// @param _value Reputation tree value for the staker/domain
  /// @param _branchMask The branchmask of the proof
  /// @param _siblings The siblings of the proof
  function submitVote(
    uint256 _motionId,
    bytes32 _voteSecret,
    bytes memory _key,
    bytes memory _value,
    uint256 _branchMask,
    bytes32[] memory _siblings
  )
    public
  {
    setInfluence(_motionId, _key, _value, _branchMask, _siblings);
    internalSubmitVote(_motionId, _voteSecret);
  }

  /// @notice Escalate a motion to a higher domain
  /// @param _motionId The id of the motion
  /// @param _newDomainId The desired domain of escalation
  /// @param _childSkillIndex For the current domain, relative to the escalated domain
  /// @param _key Reputation tree key for the new domain
  /// @param _value Reputation tree value for the new domain
  /// @param _branchMask The branchmask of the proof
  /// @param _siblings The siblings of the proof
  function escalateMotion(
    uint256 _motionId,
    uint256 _newDomainId,
    uint256 _childSkillIndex,
    bytes memory _key,
    bytes memory _value,
    uint256 _branchMask,
    bytes32[] memory _siblings
  )
    public
  {
    Motion storage motion = motions[_motionId];

    require(getMotionState(_motionId) == MotionState.Closed, "voting-base-motion-not-closed");

    uint256 newDomainSkillId = colony.getDomain(_newDomainId).skillId;
    uint256 childSkillId = colonyNetwork.getChildSkillId(newDomainSkillId, _childSkillIndex);
    require(childSkillId == motion.skillId, "voting-base-invalid-domain-proof");

    uint256 domainId = motion.domainId;
    motion.domainId = _newDomainId;
    motion.skillId = newDomainSkillId;

    totalInfluences[_motionId][motion.skillId] = new uint256[](NUM_INFLUENCES);
    motion.maxVotes[0] = getReputationFromProof(_motionId, address(0x0), _key, _value, _branchMask, _siblings);

    uint256 loser = (motion.votes[0][NAY] < motion.votes[0][YAY]) ? NAY : YAY;
    motion.stakes[loser] = sub(motion.stakes[loser], motion.paidVoterComp);
    motion.pastVoterComp[loser] = add(motion.pastVoterComp[loser], motion.paidVoterComp);
    delete motion.paidVoterComp;

    uint256 requiredStake = getRequiredStake(_motionId);
    motion.events[STAKE_END] = (motion.stakes[NAY] < requiredStake || motion.stakes[YAY] < requiredStake) ?
      uint64(block.timestamp + stakePeriod) : uint64(block.timestamp);

    motion.events[SUBMIT_END] = motion.events[STAKE_END] + uint64(submitPeriod);
    motion.events[REVEAL_END] = motion.events[SUBMIT_END] + uint64(revealPeriod);

    motion.escalated = true;

    emit MotionEscalated(_motionId, msg.sender, domainId, _newDomainId);

    if (motion.events[STAKE_END] == uint64(block.timestamp)) {
      emit MotionEventSet(_motionId, STAKE_END);
    }
  }

}
