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

import "./../common/ERC20Extended.sol";
import "./VotingBase.sol";


contract VotingHybrid is VotingBase {

  uint256 constant NUM_INFLUENCES = 2;

  /// @notice Returns the identifier of the extension
  function identifier() public override pure returns (bytes32) {
    return keccak256("VotingHybrid");
  }

  /// @notice Return the version number
  /// @return The version number
  function version() public pure override returns (uint256) {
    return 1;
  }

  // [motionId][user] => [balances]
  mapping (uint256 => mapping (address => uint256[])) influences;
  // [motionId] => [balances]
  mapping (uint256 => uint256[]) totalInfluences;

  // [motionId] => lockId
  mapping (uint256 => uint256) lockIds;

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
    require(totalInfluences[_motionId].length > 0, "voting-hybrid-invalid-motion");

    if (influences[_motionId][msg.sender].length == 0) {
      influences[_motionId][msg.sender] = new uint256[](NUM_INFLUENCES);

      uint256 userRep = getReputationFromProof(_motionId, msg.sender, _key, _value, _branchMask, _siblings);
      uint256 balance = tokenLocking.getUserLock(token, msg.sender).balance;

      influences[_motionId][msg.sender][0] = userRep;
      influences[_motionId][msg.sender][1] = balance;

      totalInfluences[_motionId][0] = add(totalInfluences[_motionId][0], userRep);
      totalInfluences[_motionId][1] = add(totalInfluences[_motionId][1], balance);
    }
  }

  /// @notice Get the user influence in the motion
  /// @param _motionId The id of the motion
  /// @param _user The user in question
  function getInfluence(uint256 _motionId, address _user) public view override returns (uint256[] memory influence) {
    influence = influences[_motionId][_user];
  }

  /// @notice Get the total influence of the motion
  /// @param _motionId The id of the motion
  function getTotalInfluence(uint256 _motionId) public view override returns (uint256[] memory influence) {
    influence = totalInfluences[_motionId];
  }

  /// @notice Perform post-reveal bookkeeping
  /// @param _motionId The id of the motion
  /// @param _user The user in question
  function postReveal(uint256 _motionId, address _user) internal override {
    if (lockIds[_motionId] == 0) {
      // This is the first reveal that has taken place in this motion.
      // We lock the token for everyone to avoid double-counting,
      lockIds[_motionId] = colony.lockToken();
    }

    colony.unlockTokenForUser(_user, lockIds[_motionId]);
  }

  /// @notice Perform post-claim bookkeeping
  /// @param _motionId The id of the motion
  /// @param _user The user in question
  function postClaim(uint256 _motionId, address _user) internal override {
    uint256 lockCount = tokenLocking.getUserLock(token, _user).lockCount;

    // Lock may have already been released during reveal
    if (lockCount < lockIds[_motionId]) {
      colony.unlockTokenForUser(_user, lockIds[_motionId]);
    }
  }

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

    totalInfluences[motionCount] = new uint256[](NUM_INFLUENCES);
    motions[motionCount].maxVotes[0] = getReputationFromProof(motionCount, address(0x0), _key, _value, _branchMask, _siblings);
    motions[motionCount].maxVotes[1] = ERC20Extended(token).totalSupply();
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

  function getLockId(uint256 _motionId) public view returns (uint256) {
    return lockIds[_motionId];
  }
}
