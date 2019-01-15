/* globals artifacts */

import path from "path";
import BN from "bn.js";
import { TruffleLoader } from "@colony/colony-js-contract-loader-fs";

import {
  forwardTime,
  checkErrorRevert,
  checkErrorRevertEthers,
  makeReputationKey,
  makeReputationValue,
  submitAndForwardTimeToDispute,
  runBinarySearch,
  getActiveRepCycle,
  advanceMiningCycleNoContest,
  accommodateChallengeAndInvalidateHash,
  finishReputationMiningCycleAndWithdrawAllMinerStakes
} from "../helpers/test-helper";

import { giveUserCLNYTokensAndStake, setupFinalizedTask, fundColonyWithTokens } from "../helpers/test-data-generator";

import {
  INT128_MAX,
  DEFAULT_STAKE,
  REWARD,
  INITIAL_FUNDING,
  MANAGER_PAYOUT,
  EVALUATOR_PAYOUT,
  WORKER_PAYOUT,
  MINING_CYCLE_DURATION,
  DECAY_RATE,
  ZERO_ADDRESS
} from "../helpers/constants";

import ReputationMinerTestWrapper from "../packages/reputation-miner/test/ReputationMinerTestWrapper";
import MaliciousReputationMinerExtraRep from "../packages/reputation-miner/test/MaliciousReputationMinerExtraRep";
import MaliciousReputationMinerWrongProofLogEntry from "../packages/reputation-miner/test/MaliciousReputationMinerWrongProofLogEntry";
import MaliciousReputationMinerClaimNew from "../packages/reputation-miner/test/MaliciousReputationMinerClaimNew";
import MaliciousReputationMinerClaimNoOriginReputation from "../packages/reputation-miner/test/MaliciousReputationMinerClaimNoOriginReputation";
import MaliciousReputationMinerClaimWrongOriginReputation from "../packages/reputation-miner/test/MaliciousReputationMinerClaimWrongOriginReputation";
import MaliciousReputationMinerClaimWrongChildReputation from "../packages/reputation-miner/test/MaliciousReputationMinerClaimWrongChildReputation";

const EtherRouter = artifacts.require("EtherRouter");
const IMetaColony = artifacts.require("IMetaColony");
const IColonyNetwork = artifacts.require("IColonyNetwork");
const ITokenLocking = artifacts.require("ITokenLocking");
const Token = artifacts.require("Token");
const IReputationMiningCycle = artifacts.require("IReputationMiningCycle");

const loader = new TruffleLoader({
  contractDir: path.resolve(__dirname, "..", "build", "contracts")
});

const useJsTree = true;

contract("ColonyNetworkMining", accounts => {
  const MANAGER = accounts[0];
  const EVALUATOR = accounts[1];
  const WORKER = accounts[2];

  const MAIN_ACCOUNT = accounts[5];
  const OTHER_ACCOUNT = accounts[6];
  const OTHER_ACCOUNT2 = accounts[7];
  const OTHER_ACCOUNT3 = accounts[8];

  let metaColony;
  let colonyNetwork;
  let tokenLocking;
  let clny;
  let goodClient;
  let badClient;
  let badClient2;
  const realProviderPort = process.env.SOLIDITY_COVERAGE ? 8555 : 8545;

  before(async () => {
    const etherRouter = await EtherRouter.deployed();
    colonyNetwork = await IColonyNetwork.at(etherRouter.address);
    const tokenLockingAddress = await colonyNetwork.getTokenLocking();
    tokenLocking = await ITokenLocking.at(tokenLockingAddress);
    const metaColonyAddress = await colonyNetwork.getMetaColony();
    metaColony = await IMetaColony.at(metaColonyAddress);
    const clnyAddress = await metaColony.getToken();
    clny = await Token.at(clnyAddress);

    goodClient = new ReputationMinerTestWrapper({ loader, realProviderPort, useJsTree, minerAddress: MAIN_ACCOUNT });
    await goodClient.resetDB();
  });

  beforeEach(async () => {
    goodClient = new ReputationMinerTestWrapper({ loader, realProviderPort, useJsTree, minerAddress: MAIN_ACCOUNT });
    await goodClient.initialise(colonyNetwork.address);

    // Kick off reputation mining.
    // TODO: Tests for the first reputation cycle (when log empty) should be done in another file
    const lock = await tokenLocking.getUserLock(clny.address, MAIN_ACCOUNT);
    assert.equal(lock.balance, DEFAULT_STAKE.toString());

    // Advance two cycles to clear active and inactive state.
    await advanceMiningCycleNoContest({ colonyNetwork, test: this });
    await advanceMiningCycleNoContest({ colonyNetwork, test: this });

    // The inactive reputation log now has the reward for this miner, and the accepted state is empty.
    // This is the same starting point for all tests.
    const repCycle = await getActiveRepCycle(colonyNetwork);
    const nInactiveLogEntries = await repCycle.getReputationUpdateLogLength();
    assert.equal(nInactiveLogEntries.toNumber(), 1);

    // Burn MAIN_ACCOUNTS accumulated mining rewards.
    const userBalance = await clny.balanceOf(MAIN_ACCOUNT);
    await clny.burn(userBalance, { from: MAIN_ACCOUNT });
  });

  afterEach(async () => {
    await finishReputationMiningCycleAndWithdrawAllMinerStakes(colonyNetwork, this);
  });

  describe("disagreement over child reputation updates", () => {
    before(async () => {
      // TODO: Amending the global skills tree is messing up with the "happy path" tests as that
      // also amends the tree in its `before`. Deal with this when we do test refactoring in #317
      await metaColony.addGlobalSkill(1);
      await metaColony.addGlobalSkill(4);
      // Initialise global skills tree: 1 -> 4 -> 5, local skills tree 2 -> 3
    });

    beforeEach(async () => {
      await giveUserCLNYTokensAndStake(colonyNetwork, MAIN_ACCOUNT, DEFAULT_STAKE);
      await giveUserCLNYTokensAndStake(colonyNetwork, OTHER_ACCOUNT, DEFAULT_STAKE);

      await fundColonyWithTokens(metaColony, clny, INITIAL_FUNDING.muln(4));
    });

    it("if one person claims an origin skill doesn't exist but the other does (and proves such), should be handled correctly", async () => {
      await setupFinalizedTask({ colonyNetwork, colony: metaColony });
      await setupFinalizedTask({ colonyNetwork, colony: metaColony });
      await advanceMiningCycleNoContest({ colonyNetwork, test: this });

      // We make two tasks, which guarantees that the origin reputation actually exists if we disagree about
      // any update caused by the second task
      await setupFinalizedTask({
        colonyNetwork,
        colony: metaColony,
        skillId: 5,
        managerPayout: 1000000000000,
        evaluatorPayout: 1000000000,
        workerPayout: 5000000000000,
        managerRating: 3,
        workerRating: 3,
        worker: OTHER_ACCOUNT
      });

      // Task two payouts are less so that the reputation should bee nonzero afterwards
      await setupFinalizedTask({
        colonyNetwork,
        colony: metaColony,
        skillId: 4,
        managerPayout: 100000000000,
        evaluatorPayout: 100000000,
        workerPayout: 500000000000,
        managerRating: 1,
        workerRating: 1,
        worker: OTHER_ACCOUNT
      });

      await goodClient.resetDB();
      await advanceMiningCycleNoContest({ colonyNetwork, test: this, client: goodClient });
      await goodClient.saveCurrentState();

      // The update log should contain the person being rewarded for the previous
      // update cycle, and reputation updates for two task completions (manager, worker, evaluator);
      // That's nine in total.
      const repCycle = await getActiveRepCycle(colonyNetwork);
      const nLogEntries = await repCycle.getReputationUpdateLogLength();
      assert.equal(nLogEntries.toNumber(), 9);

      badClient = new MaliciousReputationMinerClaimNoOriginReputation(
        { loader, realProviderPort, useJsTree, minerAddress: OTHER_ACCOUNT },
        34, // Passing in update number for colony wide skillId: 5, user: 0
        1
      );

      // Moving the state to the bad client
      await badClient.initialise(colonyNetwork.address);
      const currentGoodClientState = await goodClient.getRootHash();
      await badClient.loadState(currentGoodClientState);

      await submitAndForwardTimeToDispute([goodClient, badClient], this);

      const righthash = await goodClient.getRootHash();
      const wronghash = await badClient.getRootHash();
      assert(righthash !== wronghash, "Hashes from clients are equal, surprisingly");

      await accommodateChallengeAndInvalidateHash(colonyNetwork, this, goodClient, badClient);
      await repCycle.confirmNewHash(1);
      const acceptedHash = await colonyNetwork.getReputationRootHash();
      assert.equal(righthash, acceptedHash, "The correct hash was not accepted");
    });

    it("if one person lies about what the origin skill is when there is an origin skill for a user update, should be handled correctly", async () => {
      await giveUserCLNYTokensAndStake(colonyNetwork, OTHER_ACCOUNT2, DEFAULT_STAKE);
      await giveUserCLNYTokensAndStake(colonyNetwork, OTHER_ACCOUNT3, DEFAULT_STAKE);

      await setupFinalizedTask({ colonyNetwork, colony: metaColony });
      await setupFinalizedTask({ colonyNetwork, colony: metaColony });

      await advanceMiningCycleNoContest({ colonyNetwork, test: this });

      // We make two tasks, which guarantees that the origin reputation actually exists if we disagree about
      // any update caused by the second task
      await setupFinalizedTask({
        colonyNetwork,
        colony: metaColony,
        skillId: 5,
        managerPayout: 1000000000000,
        evaluatorPayout: 1000000000,
        workerPayout: 5000000000000,
        managerRating: 3,
        workerRating: 3,
        worker: OTHER_ACCOUNT
      });

      await advanceMiningCycleNoContest({ colonyNetwork, test: this, client: goodClient });

      // Task two payouts are less so that the reputation should bee nonzero afterwards
      await setupFinalizedTask({
        colonyNetwork,
        colony: metaColony,
        skillId: 4,
        managerPayout: 100000000000,
        evaluatorPayout: 100000000,
        workerPayout: 500000000000,
        managerRating: 1,
        workerRating: 1,
        worker: OTHER_ACCOUNT
      });

      await goodClient.resetDB();
      await advanceMiningCycleNoContest({ colonyNetwork, test: this, client: goodClient });
      await goodClient.saveCurrentState();

      // The update log should contain the person being rewarded for the previous
      // update cycle, and reputation updates for one task completion (manager, worker (domain and skill), evaluator);
      // That's five in total.
      const repCycle = await getActiveRepCycle(colonyNetwork);
      const nLogEntries = await repCycle.getReputationUpdateLogLength();
      assert.equal(nLogEntries.toNumber(), 5);

      const badClientWrongSkill = new MaliciousReputationMinerClaimWrongOriginReputation(
        { loader, realProviderPort, useJsTree, minerAddress: OTHER_ACCOUNT },
        31, // Passing in update number for skillId: 5, user: 9f485401a3c22529ab6ea15e2ebd5a8ca54a5430
        30,
        "skillId"
      );

      const badClientWrongColony = new MaliciousReputationMinerClaimWrongOriginReputation(
        { loader, realProviderPort, useJsTree, minerAddress: OTHER_ACCOUNT2 },
        31, // Passing in update number for skillId: 5, user: 9f485401a3c22529ab6ea15e2ebd5a8ca54a5430
        30,
        "colonyAddress"
      );

      const badClientWrongUser = new MaliciousReputationMinerClaimWrongOriginReputation(
        { loader, realProviderPort, useJsTree, minerAddress: OTHER_ACCOUNT3 },
        31, // Passing in update number for skillId: 5, user: 9f485401a3c22529ab6ea15e2ebd5a8ca54a5430
        30,
        "userAddress"
      );

      await badClientWrongUser.initialise(colonyNetwork.address);
      await badClientWrongColony.initialise(colonyNetwork.address);
      await badClientWrongSkill.initialise(colonyNetwork.address);

      // Moving the state to the bad clients
      const currentGoodClientState = await goodClient.getRootHash();
      await badClientWrongUser.loadState(currentGoodClientState);
      await badClientWrongColony.loadState(currentGoodClientState);
      await badClientWrongSkill.loadState(currentGoodClientState);

      await submitAndForwardTimeToDispute([goodClient, badClientWrongUser, badClientWrongColony, badClientWrongSkill], this);
      const righthash = await goodClient.getRootHash();
      const wronghash = await badClientWrongUser.getRootHash();
      assert(righthash !== wronghash, "Hashes from clients are equal, surprisingly");

      // Run through the dispute until we can call respondToChallenge
      await goodClient.confirmJustificationRootHash();
      await badClientWrongUser.confirmJustificationRootHash();
      await runBinarySearch(goodClient, badClientWrongUser);
      await goodClient.confirmBinarySearchResult();
      await badClientWrongUser.confirmBinarySearchResult();

      await checkErrorRevertEthers(badClientWrongUser.respondToChallenge(), "colony-reputation-mining-origin-user-incorrect");
      await checkErrorRevertEthers(badClientWrongColony.respondToChallenge(), "colony-reputation-mining-origin-colony-incorrect");
      await checkErrorRevertEthers(badClientWrongSkill.respondToChallenge(), "colony-reputation-mining-origin-skill-incorrect");

      // Cleanup
      await goodClient.respondToChallenge();
      await forwardTime(MINING_CYCLE_DURATION / 6, this);
      await repCycle.invalidateHash(0, 1);
      await repCycle.confirmNewHash(1);
    });

    it("if one person lies about what the child skill is when dealing with a colony-wide update, should be handled correctly", async () => {
      await giveUserCLNYTokensAndStake(colonyNetwork, MAIN_ACCOUNT, DEFAULT_STAKE);
      await giveUserCLNYTokensAndStake(colonyNetwork, OTHER_ACCOUNT, DEFAULT_STAKE);

      await fundColonyWithTokens(metaColony, clny, INITIAL_FUNDING.muln(4));
      await setupFinalizedTask({ colonyNetwork, colony: metaColony });
      await setupFinalizedTask({ colonyNetwork, colony: metaColony });

      await advanceMiningCycleNoContest({ colonyNetwork, test: this });

      // We make two tasks, which guarantees that the origin reputation actually exists if we disagree about
      // any update caused by the second task
      await setupFinalizedTask({
        colonyNetwork,
        colony: metaColony,
        skillId: 5,
        managerPayout: 1000000000000,
        evaluatorPayout: 1000000000,
        workerPayout: 5000000000000,
        managerRating: 3,
        workerRating: 3,
        worker: OTHER_ACCOUNT
      });

      await advanceMiningCycleNoContest({ colonyNetwork, test: this, client: goodClient });

      // Task two payouts are less so that the reputation should bee nonzero afterwards
      await setupFinalizedTask({
        colonyNetwork,
        colony: metaColony,
        skillId: 4,
        managerPayout: 100000000000,
        evaluatorPayout: 100000000,
        workerPayout: 500000000000,
        managerRating: 1,
        workerRating: 1,
        worker: OTHER_ACCOUNT
      });

      await goodClient.resetDB();
      await advanceMiningCycleNoContest({ colonyNetwork, test: this, client: goodClient });
      await goodClient.saveCurrentState();

      badClient = new MaliciousReputationMinerExtraRep({ loader, realProviderPort, useJsTree, minerAddress: OTHER_ACCOUNT }, 28, 0xfffffffff);

      // The update log should contain the person being rewarded for the previous
      // update cycle, and reputation updates for one task completion (manager, worker (domain and skill), evaluator);
      // That's five in total.
      const repCycle = await getActiveRepCycle(colonyNetwork);
      const nLogEntries = await repCycle.getReputationUpdateLogLength();
      assert.equal(nLogEntries.toNumber(), 5);

      const badClientWrongSkill = new MaliciousReputationMinerClaimWrongChildReputation(
        { loader, realProviderPort, useJsTree, minerAddress: MAIN_ACCOUNT },
        "skillId"
      );

      const badClientWrongColony = new MaliciousReputationMinerClaimWrongChildReputation(
        { loader, realProviderPort, useJsTree, minerAddress: MAIN_ACCOUNT },
        "colonyAddress"
      );

      const badClientWrongUser = new MaliciousReputationMinerClaimWrongChildReputation(
        { loader, realProviderPort, useJsTree, minerAddress: MAIN_ACCOUNT },
        "userAddress"
      );

      // Moving the state to the bad clients
      await badClient.initialise(colonyNetwork.address);
      await badClientWrongUser.initialise(colonyNetwork.address);
      await badClientWrongColony.initialise(colonyNetwork.address);
      await badClientWrongSkill.initialise(colonyNetwork.address);

      const currentGoodClientState = await goodClient.getRootHash();
      await badClientWrongUser.loadState(currentGoodClientState);
      await badClientWrongColony.loadState(currentGoodClientState);
      await badClientWrongSkill.loadState(currentGoodClientState);
      await badClient.loadState(currentGoodClientState);

      await submitAndForwardTimeToDispute([goodClient, badClient, badClientWrongUser, badClientWrongColony, badClientWrongSkill], this);
      const righthash = await goodClient.getRootHash();
      const wronghash = await badClient.getRootHash();
      assert(righthash !== wronghash, "Hashes from clients are equal, surprisingly");

      // Run through the dispute until we can call respondToChallenge
      await goodClient.confirmJustificationRootHash();
      await badClient.confirmJustificationRootHash();
      await runBinarySearch(goodClient, badClient);
      await goodClient.confirmBinarySearchResult();
      await badClient.confirmBinarySearchResult();

      await checkErrorRevertEthers(badClientWrongUser.respondToChallenge(), "colony-reputation-mining-child-user-incorrect");
      await checkErrorRevertEthers(badClientWrongColony.respondToChallenge(), "colony-reputation-mining-child-colony-incorrect");
      await checkErrorRevertEthers(badClientWrongSkill.respondToChallenge(), "colony-reputation-mining-child-skill-incorrect");

      // Cleanup
      await goodClient.respondToChallenge();
      await forwardTime(MINING_CYCLE_DURATION / 6, this);
      await repCycle.invalidateHash(0, 1);
      await repCycle.confirmNewHash(1);
    });

    it("if a colony wide total calculation (for a parent skill) is wrong, it should be handled correctly", async () => {
      await setupFinalizedTask({
        colonyNetwork,
        colony: metaColony,
        skillId: 5,
        managerPayout: 1000000000000,
        evaluatorPayout: 1000000000,
        workerPayout: 5000000000000,
        managerRating: 2,
        workerRating: 2,
        worker: OTHER_ACCOUNT
      });

      await advanceMiningCycleNoContest({ colonyNetwork, test: this });

      await setupFinalizedTask({
        colonyNetwork,
        colony: metaColony,
        skillId: 4,
        managerPayout: 1000000000,
        evaluatorPayout: 1000000000,
        workerPayout: 1000000000,
        managerRating: 1,
        workerRating: 1,
        worker: OTHER_ACCOUNT
      });

      await goodClient.resetDB();
      await advanceMiningCycleNoContest({ colonyNetwork, test: this, client: goodClient });
      await goodClient.saveCurrentState();

      // The update log should contain the person being rewarded for the previous
      // update cycle, and reputation update for one task completion (manager, worker, evaluator);
      // That's five in total.
      const repCycle = await getActiveRepCycle(colonyNetwork);
      const nLogEntries = await repCycle.getReputationUpdateLogLength();
      assert.equal(nLogEntries.toNumber(), 5);

      badClient = new MaliciousReputationMinerExtraRep(
        { loader, minerAddress: OTHER_ACCOUNT, realProviderPort, useJsTree },
        28, // Passing in colony wide update number for skillId: 4, user: 0
        "0xffff"
      );
      // Moving the state to the bad client
      await badClient.initialise(colonyNetwork.address);
      const currentGoodClientState = await goodClient.getRootHash();
      await badClient.loadState(currentGoodClientState);

      await submitAndForwardTimeToDispute([goodClient, badClient], this);
      const righthash = await goodClient.getRootHash();
      const wronghash = await badClient.getRootHash();
      assert(righthash !== wronghash, "Hashes from clients are equal, surprisingly");

      await accommodateChallengeAndInvalidateHash(colonyNetwork, this, goodClient, badClient, {
        client2: { respondToChallenge: "colony-reputation-mining-decreased-reputation-value-incorrect" }
      });
      await repCycle.confirmNewHash(1);
    });

    it("if origin skill reputation calculation underflows and is wrong, it should be handled correctly", async () => {
      await setupFinalizedTask({ colonyNetwork, colony: metaColony });
      await setupFinalizedTask({ colonyNetwork, colony: metaColony });

      await setupFinalizedTask({
        colonyNetwork,
        colony: metaColony,
        skillId: 5,
        managerPayout: 1000000000000,
        evaluatorPayout: 1000000000,
        workerPayout: 5000000000000,
        managerRating: 3,
        workerRating: 3,
        worker: OTHER_ACCOUNT
      });

      await advanceMiningCycleNoContest({ colonyNetwork, test: this });

      await setupFinalizedTask({
        colonyNetwork,
        colony: metaColony,
        skillId: 4,
        managerPayout: 1000000000000,
        evaluatorPayout: 1000000000,
        workerPayout: 5000000000000,
        managerRating: 1,
        workerRating: 1,
        worker: OTHER_ACCOUNT
      });

      await goodClient.resetDB();
      await advanceMiningCycleNoContest({ colonyNetwork, test: this, client: goodClient });
      await goodClient.saveCurrentState();

      // The update log should contain the person being rewarded for the previous
      // update cycle, and reputation update for one task completion (manager, worker, evaluator);
      // That's five in total.
      const repCycle = await getActiveRepCycle(colonyNetwork);
      const nLogEntries = await repCycle.getReputationUpdateLogLength();
      assert.equal(nLogEntries.toNumber(), 5);

      badClient = new MaliciousReputationMinerExtraRep(
        { loader, minerAddress: OTHER_ACCOUNT, realProviderPort, useJsTree },
        30, // Passing in colony wide update number for skillId: 4, user: 0
        "0xfffffffff"
      );
      // Moving the state to the bad client
      await badClient.initialise(colonyNetwork.address);
      const currentGoodClientState = await goodClient.getRootHash();
      await badClient.loadState(currentGoodClientState);

      await submitAndForwardTimeToDispute([goodClient, badClient], this);
      const righthash = await goodClient.getRootHash();
      const wronghash = await badClient.getRootHash();
      assert(righthash !== wronghash, "Hashes from clients are equal, surprisingly");

      await accommodateChallengeAndInvalidateHash(colonyNetwork, this, goodClient, badClient, {
        client2: { respondToChallenge: "colony-reputation-mining-decreased-reputation-value-incorrect" }
      });
      await repCycle.confirmNewHash(1);
    });

    it("if child skill reputation calculation is wrong, it should be handled correctly", async () => {
      await setupFinalizedTask({
        colonyNetwork,
        colony: metaColony,
        skillId: 5,
        managerPayout: 1000000000000,
        evaluatorPayout: 1000000000,
        workerPayout: 5000000000000,
        managerRating: 3,
        workerRating: 3,
        worker: OTHER_ACCOUNT
      });

      await advanceMiningCycleNoContest({ colonyNetwork, test: this });

      await setupFinalizedTask({
        colonyNetwork,
        colony: metaColony,
        skillId: 4,
        managerPayout: 1000000000,
        evaluatorPayout: 1000000000,
        workerPayout: 1000000000,
        managerRating: 1,
        workerRating: 1,
        worker: OTHER_ACCOUNT
      });

      await goodClient.resetDB();
      await advanceMiningCycleNoContest({ colonyNetwork, test: this, client: goodClient });
      await goodClient.saveCurrentState();

      // The update log should contain the person being rewarded for the previous
      // update cycle, and reputation update for one task completion (manager, worker, evaluator);
      // That's five in total.
      const repCycle = await getActiveRepCycle(colonyNetwork);
      const nLogEntries = await repCycle.getReputationUpdateLogLength();
      assert.equal(nLogEntries.toNumber(), 5);

      badClient = new MaliciousReputationMinerExtraRep(
        { loader, minerAddress: OTHER_ACCOUNT, realProviderPort, useJsTree },
        29, // Passing in update number for skillId: 5, user: 9f485401a3c22529ab6ea15e2ebd5a8ca54a5430
        "0xf"
      );

      // Moving the state to the bad client
      await badClient.initialise(colonyNetwork.address);
      const currentGoodClientState = await goodClient.getRootHash();
      await badClient.loadState(currentGoodClientState);

      await submitAndForwardTimeToDispute([goodClient, badClient], this);
      const righthash = await goodClient.getRootHash();
      const wronghash = await badClient.getRootHash();
      assert(righthash !== wronghash, "Hashes from clients are equal, surprisingly");

      await accommodateChallengeAndInvalidateHash(colonyNetwork, this, goodClient, badClient, {
        client2: { respondToChallenge: "colony-reputation-mining-child-reputation-value-incorrect" }
      });
      await repCycle.confirmNewHash(1);
    });

    it("if a child reputation calculation is wrong, it should be handled correctly if that user has never had that reputation before", async () => {
      await advanceMiningCycleNoContest({ colonyNetwork, test: this });

      await setupFinalizedTask({
        colonyNetwork,
        colony: metaColony,
        skillId: 4,
        managerPayout: 1000000000000,
        evaluatorPayout: 1000000000,
        workerPayout: 5000000000000,
        managerRating: 1,
        workerRating: 1,
        worker: OTHER_ACCOUNT
      });

      await goodClient.resetDB();
      await advanceMiningCycleNoContest({ colonyNetwork, test: this, client: goodClient });
      await goodClient.saveCurrentState();

      const repCycle = await getActiveRepCycle(colonyNetwork);

      // The update log should contain the person being rewarded for the previous
      // update cycle, and reputation update for one task completion (manager, worker, evaluator);
      // That's five in total.
      const nLogEntries = await repCycle.getReputationUpdateLogLength();
      assert.equal(nLogEntries.toNumber(), 5);
      badClient = new MaliciousReputationMinerExtraRep(
        { loader, minerAddress: OTHER_ACCOUNT, realProviderPort, useJsTree },
        21, // Passing in update number for skillId: 5, user: 9f485401a3c22529ab6ea15e2ebd5a8ca54a5430
        "0xffffffffffffffff"
      );
      // Moving the state to the bad client
      await badClient.initialise(colonyNetwork.address);
      const currentGoodClientState = await goodClient.getRootHash();
      await badClient.loadState(currentGoodClientState);

      await submitAndForwardTimeToDispute([goodClient, badClient], this);
      const righthash = await goodClient.getRootHash();
      const wronghash = await badClient.getRootHash();
      assert(righthash !== wronghash, "Hashes from clients are equal, surprisingly");

      await accommodateChallengeAndInvalidateHash(colonyNetwork, this, goodClient, badClient, {
        client2: { respondToChallenge: "colony-reputation-mining-child-reputation-value-non-zero" }
      });
      await repCycle.confirmNewHash(1);
    });

    it("if a child reputation colony-wide calculation is wrong, it should be handled correctly", async () => {
      await setupFinalizedTask({
        colonyNetwork,
        colony: metaColony,
        skillId: 5,
        managerPayout: 1000000000000,
        evaluatorPayout: 1000000000,
        workerPayout: 5000000000000,
        managerRating: 3,
        workerRating: 3,
        worker: OTHER_ACCOUNT
      });

      await advanceMiningCycleNoContest({ colonyNetwork, test: this });

      await setupFinalizedTask({
        colonyNetwork,
        colony: metaColony,
        skillId: 4,
        managerPayout: 1000000000000,
        evaluatorPayout: 1000000000,
        workerPayout: 5000000000000,
        managerRating: 1,
        workerRating: 1,
        worker: accounts[5]
      });

      await goodClient.resetDB();
      await advanceMiningCycleNoContest({ colonyNetwork, test: this, client: goodClient });
      await goodClient.saveCurrentState();

      const repCycle = await getActiveRepCycle(colonyNetwork);

      // The update log should contain the person being rewarded for the previous
      // update cycle, and reputation update for one task completion (manager, worker, evaluator);
      // That's five in total.
      const nLogEntries = await repCycle.getReputationUpdateLogLength();
      assert.equal(nLogEntries.toNumber(), 5);

      badClient = new MaliciousReputationMinerExtraRep(
        { loader, minerAddress: OTHER_ACCOUNT, realProviderPort, useJsTree },
        26, // Passing in update number for skillId: 5, user: 0
        "0xfffffffffff"
      );
      // Moving the state to the bad client
      await badClient.initialise(colonyNetwork.address);
      const currentGoodClientState = await goodClient.getRootHash();
      await badClient.loadState(currentGoodClientState);

      await submitAndForwardTimeToDispute([goodClient, badClient], this);
      const righthash = await goodClient.getRootHash();
      const wronghash = await badClient.getRootHash();
      assert(righthash !== wronghash, "Hashes from clients are equal, surprisingly");

      await accommodateChallengeAndInvalidateHash(colonyNetwork, this, goodClient, badClient, {
        client2: { respondToChallenge: "colony-reputation-mining-child-reputation-value-incorrect" }
      });
      await repCycle.confirmNewHash(1);
    });

    it("if user child skill (in a negative update) reputation calculation is wrong, it should be handled correctly", async () => {
      await setupFinalizedTask({
        colonyNetwork,
        colony: metaColony,
        skillId: 5,
        managerPayout: 1000000000000,
        evaluatorPayout: 1000000000,
        workerPayout: 5000000000000,
        managerRating: 3,
        workerRating: 3,
        worker: OTHER_ACCOUNT
      });

      await advanceMiningCycleNoContest({ colonyNetwork, test: this });

      await setupFinalizedTask({
        colonyNetwork,
        colony: metaColony,
        skillId: 4,
        managerPayout: 1000000000000,
        evaluatorPayout: 1000000000,
        workerPayout: 5000000000000,
        managerRating: 1,
        workerRating: 1,
        worker: OTHER_ACCOUNT
      });

      await goodClient.resetDB();
      await advanceMiningCycleNoContest({ colonyNetwork, test: this, client: goodClient });
      await goodClient.saveCurrentState();

      // The update log should contain the person being rewarded for the previous
      // update cycle, and reputation update for one task completion (manager, worker, evaluator);
      // That's five in total.
      const repCycle = await getActiveRepCycle(colonyNetwork);
      const nLogEntries = await repCycle.getReputationUpdateLogLength();
      assert.equal(nLogEntries.toNumber(), 5);

      badClient = new MaliciousReputationMinerExtraRep(
        { loader, minerAddress: OTHER_ACCOUNT, realProviderPort, useJsTree },
        29, // Passing in update number for skillId: 5, user: 9f485401a3c22529ab6ea15e2ebd5a8ca54a5430
        "4800000000000"
      );
      // Moving the state to the bad client
      await badClient.initialise(colonyNetwork.address);
      const currentGoodClientState = await goodClient.getRootHash();
      await badClient.loadState(currentGoodClientState);

      await submitAndForwardTimeToDispute([goodClient, badClient], this);
      const righthash = await goodClient.getRootHash();
      const wronghash = await badClient.getRootHash();
      assert(righthash !== wronghash, "Hashes from clients are equal, surprisingly");

      await accommodateChallengeAndInvalidateHash(colonyNetwork, this, goodClient, badClient, {
        client2: { respondToChallenge: "colony-reputation-mining-child-reputation-value-incorrect" }
      });
      await repCycle.confirmNewHash(1);
    });

    it("if a colony-wide child skill reputation amount calculation underflows and is wrong, it should be handled correctly", async () => {
      await setupFinalizedTask({
        colonyNetwork,
        colony: metaColony,
        skillId: 5,
        managerPayout: 1000000000000,
        evaluatorPayout: 1000000000,
        workerPayout: 1000000000000,
        managerRating: 2,
        workerRating: 2,
        worker: OTHER_ACCOUNT
      });

      await advanceMiningCycleNoContest({ colonyNetwork, test: this });

      await setupFinalizedTask({
        colonyNetwork,
        colony: metaColony,
        skillId: 4,
        managerPayout: 1000000000000,
        evaluatorPayout: 1000000000,
        workerPayout: 1000000000001,
        managerRating: 1,
        workerRating: 1,
        worker: OTHER_ACCOUNT
      });

      await goodClient.resetDB();
      await advanceMiningCycleNoContest({ colonyNetwork, test: this, client: goodClient });
      await goodClient.saveCurrentState();

      // The update log should contain the person being rewarded for the previous
      // update cycle, and reputation update for one task completion (manager, worker, evaluator);
      // That's five in total.
      const repCycle = await getActiveRepCycle(colonyNetwork);
      const nLogEntries = await repCycle.getReputationUpdateLogLength();
      assert.equal(nLogEntries.toNumber(), 5);

      badClient = new MaliciousReputationMinerExtraRep(
        { loader, minerAddress: OTHER_ACCOUNT, realProviderPort, useJsTree },
        26, // Passing in colony wide update number for skillId: 5, user: 0
        "0xfffffffff"
      );
      // Moving the state to the bad client
      await badClient.initialise(colonyNetwork.address);
      const currentGoodClientState = await goodClient.getRootHash();
      await badClient.loadState(currentGoodClientState);

      await submitAndForwardTimeToDispute([goodClient, badClient], this);
      const righthash = await goodClient.getRootHash();
      const wronghash = await badClient.getRootHash();
      assert(righthash !== wronghash, "Hashes from clients are equal, surprisingly");

      await accommodateChallengeAndInvalidateHash(colonyNetwork, this, goodClient, badClient, {
        client2: { respondToChallenge: "colony-reputation-mining-child-reputation-value-non-zero" }
      });
      await repCycle.confirmNewHash(1);
    });

    it.skip("dispute should resolve if a bad actor responds on behalf of the good submission omitting some proofs that exist", async () => {
      await advanceMiningCycleNoContest({ colonyNetwork, test: this });

      // We make two tasks, which guarantees that the origin reputation actually exists if we disagree about
      // any update caused by the second task
      await setupFinalizedTask({
        colonyNetwork,
        colony: metaColony,
        skillId: 5,
        managerPayout: 1000000000000,
        evaluatorPayout: 1000000000,
        workerPayout: 5000000000000,
        managerRating: 3,
        workerRating: 3,
        worker: OTHER_ACCOUNT
      });

      await advanceMiningCycleNoContest({ colonyNetwork, test: this, client: goodClient });

      // Task two payouts are more so that the reputation should be zero afterwards
      await setupFinalizedTask({
        colonyNetwork,
        colony: metaColony,
        skill: 4,
        managerPayout: 10000000000000,
        evaluatorPayout: 10000000000,
        workerPayout: 50000000000000,
        managerRating: 1,
        workerRating: 1,
        worker: OTHER_ACCOUNT
      });

      await advanceMiningCycleNoContest({ colonyNetwork, test: this, client: goodClient });

      await goodClient.resetDB();
      await goodClient.saveCurrentState();

      // The update log should contain the person being rewarded for the previous
      // update cycle, and reputation updates for one task completion (manager, worker (domain and skill), evaluator);
      // That's five in total.
      const repCycle = await getActiveRepCycle(colonyNetwork);
      const nLogEntries = await repCycle.getReputationUpdateLogLength();
      assert.equal(nLogEntries.toNumber(), 5);

      badClient = new MaliciousReputationMinerClaimNew(
        { loader, minerAddress: OTHER_ACCOUNT, realProviderPort, useJsTree },
        30 // Passing in update number for skillId: 1, user: 9f485401a3c22529ab6ea15e2ebd5a8ca54a5430
      );
      await badClient.initialise(colonyNetwork.address);

      // Moving the state to the bad client
      await badClient.initialise(colonyNetwork.address);
      const currentGoodClientState = await goodClient.getRootHash();
      await badClient.loadState(currentGoodClientState);

      await forwardTime(MINING_CYCLE_DURATION / 2, this);
      await goodClient.addLogContentsToReputationTree();
      await goodClient.submitRootHash();
      await badClient.addLogContentsToReputationTree();
      await badClient.submitRootHash();
      await forwardTime(MINING_CYCLE_DURATION / 2, this);

      await goodClient.submitJustificationRootHash();
      await badClient.submitJustificationRootHash();

      await goodClient.respondToBinarySearchForChallenge();
      await badClient.respondToBinarySearchForChallenge();
      await goodClient.respondToBinarySearchForChallenge();
      await badClient.respondToBinarySearchForChallenge();
      await goodClient.respondToBinarySearchForChallenge();
      await badClient.respondToBinarySearchForChallenge();
      await goodClient.respondToBinarySearchForChallenge();
      await badClient.respondToBinarySearchForChallenge();
      await goodClient.respondToBinarySearchForChallenge();
      await badClient.respondToBinarySearchForChallenge();
      await goodClient.respondToBinarySearchForChallenge();
      await badClient.respondToBinarySearchForChallenge();

      await goodClient.confirmBinarySearchResult();
      await badClient.confirmBinarySearchResult();

      // Now get all the information needed to fire off a respondToChallenge call
      const [round, index] = await goodClient.getMySubmissionRoundAndIndex();
      const submission = await repCycle.getDisputeRounds(round.toString(), index.toString());
      const firstDisagreeIdx = new BN(submission[8].toString());
      const lastAgreeIdx = firstDisagreeIdx.subn(1);
      const reputationKey = await goodClient.getKeyForUpdateNumber(lastAgreeIdx.toString());
      const [agreeStateBranchMask, agreeStateSiblings] = await goodClient.justificationTree.getProof(`0x${lastAgreeIdx.toString(16, 64)}`);
      const [disagreeStateBranchMask, disagreeStateSiblings] = await goodClient.justificationTree.getProof(`0x${firstDisagreeIdx.toString(16, 64)}`);
      const logEntryNumber = await goodClient.getLogEntryNumberForLogUpdateNumber(lastAgreeIdx.toString());

      // This is an incorrect response coming from a bad actor, but claiming to be responding on behalf of the good client
      repCycle.respondToChallenge(
        [
          round.toString(),
          index.toString(),
          goodClient.justificationHashes[`0x${new BN(firstDisagreeIdx).toString(16, 64)}`].justUpdatedProof.branchMask.toString(),
          goodClient.justificationHashes[`0x${new BN(lastAgreeIdx).toString(16, 64)}`].nextUpdateProof.nNodes.toString(),
          agreeStateBranchMask.toString(),
          goodClient.justificationHashes[`0x${new BN(firstDisagreeIdx).toString(16, 64)}`].justUpdatedProof.nNodes.toString(),
          disagreeStateBranchMask.toString(),
          goodClient.justificationHashes[`0x${new BN(lastAgreeIdx).toString(16, 64)}`].newestReputationProof.branchMask,
          logEntryNumber.toString(),
          0,
          goodClient.justificationHashes[`0x${new BN(lastAgreeIdx).toString(16, 64)}`].originReputationProof.branchMask,
          goodClient.justificationHashes[`0x${new BN(lastAgreeIdx).toString(16, 64)}`].nextUpdateProof.reputation,
          goodClient.justificationHashes[`0x${new BN(lastAgreeIdx).toString(16, 64)}`].nextUpdateProof.uid,
          goodClient.justificationHashes[`0x${new BN(firstDisagreeIdx).toString(16, 64)}`].justUpdatedProof.reputation,
          goodClient.justificationHashes[`0x${new BN(firstDisagreeIdx).toString(16, 64)}`].justUpdatedProof.uid,
          goodClient.justificationHashes[`0x${new BN(lastAgreeIdx).toString(16, 64)}`].newestReputationProof.reputation,
          goodClient.justificationHashes[`0x${new BN(lastAgreeIdx).toString(16, 64)}`].newestReputationProof.uid,
          0,
          // This is the right line.
          // goodClient.justificationHashes[`0x${new BN(lastAgreeIdx).toString(16, 64)}`].originReputationProof.reputation,
          goodClient.justificationHashes[`0x${new BN(lastAgreeIdx).toString(16, 64)}`].originReputationProof.uid
        ],
        reputationKey,
        goodClient.justificationHashes[`0x${new BN(firstDisagreeIdx).toString(16, 64)}`].justUpdatedProof.siblings,
        agreeStateSiblings,
        disagreeStateSiblings,
        goodClient.justificationHashes[`0x${new BN(lastAgreeIdx).toString(16, 64)}`].newestReputationProof.key,
        goodClient.justificationHashes[`0x${new BN(lastAgreeIdx).toString(16, 64)}`].newestReputationProof.siblings,
        goodClient.justificationHashes[`0x${new BN(lastAgreeIdx).toString(16, 64)}`].originReputationProof.key,
        goodClient.justificationHashes[`0x${new BN(lastAgreeIdx).toString(16, 64)}`].originReputationProof.siblings,
        { gasLimit: 4000000 }
      );

      // Now respond with the bad client
      await badClient.respondToChallenge();

      // Try and respond as a good actor
      await goodClient.respondToChallenge();

      // Try and complete this mining cycle.
      await forwardTime(MINING_CYCLE_DURATION / 6, this);
      await repCycle.invalidateHash(0, 1);
      await repCycle.confirmNewHash(1);
      const acceptedHash = await colonyNetwork.getReputationRootHash();
      const goodHash = await goodClient.getRootHash();
      assert.equal(acceptedHash, goodHash);
    });
  });

  describe("Misbehaviour during dispute resolution", () => {
    // NOTE: These tests need the before from the previous block to run correctly, setting up skills 4 and 5

    it("should prevent a user from jumping ahead during dispute resolution", async () => {
      badClient = new MaliciousReputationMinerExtraRep({ loader, realProviderPort, useJsTree, minerAddress: OTHER_ACCOUNT }, 1, 0xfffffffff);
      await badClient.initialise(colonyNetwork.address);

      await giveUserCLNYTokensAndStake(colonyNetwork, OTHER_ACCOUNT, DEFAULT_STAKE);
      await advanceMiningCycleNoContest({ colonyNetwork, test: this });

      const addr = await colonyNetwork.getReputationMiningCycle(true);
      let repCycle = await IReputationMiningCycle.at(addr);
      await forwardTime(MINING_CYCLE_DURATION, this);
      await repCycle.submitRootHash("0x00", 0, "0x00", 10, { from: MAIN_ACCOUNT });
      await repCycle.confirmNewHash(0);

      repCycle = await getActiveRepCycle(colonyNetwork);
      await submitAndForwardTimeToDispute([goodClient, badClient], this);

      // Check we can't start binary search before we've confirmed JRH
      await checkErrorRevertEthers(goodClient.respondToBinarySearchForChallenge(), "colony-reputation-mining-challenge-not-active");

      // Check we can't confirm binary search before we've confirmed JRH
      await checkErrorRevertEthers(goodClient.confirmBinarySearchResult(), "colony-reputation-jrh-hash-not-verified");

      // Check we can't respond to challenge before we've confirmed JRH
      await checkErrorRevertEthers(goodClient.respondToChallenge(), "colony-reputation-mining-binary-search-result-not-confirmed");

      await goodClient.confirmJustificationRootHash();
      await badClient.confirmJustificationRootHash();

      // Check we can't confirm binary search before we've started it
      await checkErrorRevertEthers(goodClient.confirmBinarySearchResult(), "colony-reputation-binary-search-incomplete");

      // Check we can't respond to challenge before we've started binary search
      await checkErrorRevertEthers(goodClient.respondToChallenge(), "colony-reputation-binary-search-incomplete");

      await goodClient.respondToBinarySearchForChallenge();
      await badClient.respondToBinarySearchForChallenge();

      // Check we can't confirm binary search before we've finished it
      // Check we can't respond to challenge before we've finished it
      await runBinarySearch(goodClient, badClient);

      // Check we can't respond to challenge before we've confirmed the binary search result
      await checkErrorRevertEthers(goodClient.respondToChallenge(), "colony-reputation-mining-binary-search-result-not-confirmed");

      // Cleanup
      await goodClient.confirmBinarySearchResult();
      await badClient.confirmBinarySearchResult();

      await goodClient.respondToChallenge();
      await forwardTime(MINING_CYCLE_DURATION / 6, this);
      await repCycle.invalidateHash(0, 1);
      await repCycle.confirmNewHash(1);
    });

    it("should prevent a user from confirming a JRH they can't prove is correct", async () => {
      badClient = new MaliciousReputationMinerExtraRep({ loader, realProviderPort, useJsTree, minerAddress: OTHER_ACCOUNT }, 1, 0xfffffffff);
      await badClient.initialise(colonyNetwork.address);

      await giveUserCLNYTokensAndStake(colonyNetwork, OTHER_ACCOUNT, DEFAULT_STAKE);
      await advanceMiningCycleNoContest({ colonyNetwork, test: this });

      const repCycle = await getActiveRepCycle(colonyNetwork);
      await submitAndForwardTimeToDispute([goodClient, badClient], this);

      const nLogEntries = await repCycle.getReputationUpdateLogLength();
      const lastLogEntry = await repCycle.getReputationUpdateLogEntry(nLogEntries.subn(1));
      const totalnUpdates = new BN(lastLogEntry.nUpdates).add(new BN(lastLogEntry.nPreviousUpdates));

      const [branchMask1, siblings1] = await goodClient.justificationTree.getProof(`0x${new BN("0").toString(16, 64)}`);
      const [branchMask2, siblings2] = await goodClient.justificationTree.getProof(`0x${totalnUpdates.toString(16, 64)}`);
      const [round, index] = await goodClient.getMySubmissionRoundAndIndex();

      await checkErrorRevert(
        repCycle.confirmJustificationRootHash(round, index, "123456", siblings1, branchMask2, siblings2),
        "colony-reputation-mining-invalid-jrh-proof-1"
      );

      await checkErrorRevert(
        repCycle.confirmJustificationRootHash(round, index, branchMask1, siblings1, "123456", siblings2),
        "colony-reputation-mining-invalid-jrh-proof-2"
      );

      // Cleanup
      await accommodateChallengeAndInvalidateHash(colonyNetwork, this, goodClient, badClient, {
        client2: { respondToChallenge: "colony-reputation-mining-increased-reputation-value-incorrect" }
      });
      await checkErrorRevert(repCycle.confirmNewHash(0), "colony-reputation-mining-not-final-round");
      await repCycle.confirmNewHash(1);
    });

    it("should correctly check the proof of the previously newest reputation, if necessary", async () => {
      await giveUserCLNYTokensAndStake(colonyNetwork, OTHER_ACCOUNT, DEFAULT_STAKE);

      await fundColonyWithTokens(metaColony, clny, INITIAL_FUNDING.muln(3));
      await setupFinalizedTask({ colonyNetwork, colony: metaColony });
      await setupFinalizedTask({ colonyNetwork, colony: metaColony });
      await setupFinalizedTask({ colonyNetwork, colony: metaColony });

      await advanceMiningCycleNoContest({ colonyNetwork, test: this });

      badClient = new MaliciousReputationMinerExtraRep({ loader, minerAddress: OTHER_ACCOUNT, realProviderPort, useJsTree }, 27, 0xfffffffff);
      await badClient.initialise(colonyNetwork.address);

      await submitAndForwardTimeToDispute([goodClient, badClient], this);

      await goodClient.confirmJustificationRootHash();
      await badClient.confirmJustificationRootHash();

      await runBinarySearch(goodClient, badClient);

      await goodClient.confirmBinarySearchResult();
      await badClient.confirmBinarySearchResult();

      // Now get all the information needed to fire off a respondToChallenge call
      const repCycle = await getActiveRepCycle(colonyNetwork);
      const [round, index] = await goodClient.getMySubmissionRoundAndIndex();
      const submission = await repCycle.getDisputeRounds(round, index);
      const firstDisagreeIdx = new BN(submission.lowerBound);
      const lastAgreeIdx = firstDisagreeIdx.subn(1);
      const reputationKey = await goodClient.getKeyForUpdateNumber(lastAgreeIdx.toString());
      const [agreeStateBranchMask, agreeStateSiblings] = await goodClient.justificationTree.getProof(`0x${lastAgreeIdx.toString(16, 64)}`);
      const [disagreeStateBranchMask, disagreeStateSiblings] = await goodClient.justificationTree.getProof(`0x${firstDisagreeIdx.toString(16, 64)}`);
      const logEntryNumber = await goodClient.getLogEntryNumberForLogUpdateNumber(lastAgreeIdx.toString());

      await checkErrorRevert(
        repCycle.respondToChallenge(
          [
            round,
            index,
            goodClient.justificationHashes[`0x${firstDisagreeIdx.toString(16, 64)}`].justUpdatedProof.branchMask,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].nextUpdateProof.nNodes,
            agreeStateBranchMask,
            goodClient.justificationHashes[`0x${firstDisagreeIdx.toString(16, 64)}`].justUpdatedProof.nNodes,
            disagreeStateBranchMask,
            // This is the wrong line
            123456,
            // This is the correct line, for future reference
            // this.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].newestReputationProof.branchMask,
            logEntryNumber,
            0,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].originReputationProof.branchMask,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].nextUpdateProof.reputation,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].nextUpdateProof.uid,
            goodClient.justificationHashes[`0x${firstDisagreeIdx.toString(16, 64)}`].justUpdatedProof.reputation,
            goodClient.justificationHashes[`0x${firstDisagreeIdx.toString(16, 64)}`].justUpdatedProof.uid,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].newestReputationProof.reputation,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].newestReputationProof.uid,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].originReputationProof.reputation,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].originReputationProof.uid,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].childReputationProof.branchMask,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].childReputationProof.reputation,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].childReputationProof.uid,
            0
          ],
          reputationKey,
          goodClient.justificationHashes[`0x${firstDisagreeIdx.toString(16, 64)}`].justUpdatedProof.siblings,
          agreeStateSiblings,
          disagreeStateSiblings,
          goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].newestReputationProof.key,
          goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].newestReputationProof.siblings,
          goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].originReputationProof.key,
          goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].originReputationProof.siblings,
          goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].childReputationProof.key,
          goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].childReputationProof.siblings
        ),
        "colony-reputation-mining-last-state-disagreement"
      );

      // Cleanup
      await forwardTime(MINING_CYCLE_DURATION, this);
      await goodClient.respondToChallenge();
      await repCycle.invalidateHash(0, 1);
      await repCycle.confirmNewHash(1);
    });

    it("should correctly check the proof of the origin skill and child skill reputations, if necessary", async () => {
      await giveUserCLNYTokensAndStake(colonyNetwork, MAIN_ACCOUNT, DEFAULT_STAKE);
      await giveUserCLNYTokensAndStake(colonyNetwork, OTHER_ACCOUNT, DEFAULT_STAKE);

      await fundColonyWithTokens(
        metaColony,
        clny,
        new BN("1000000000000")
          .muln(4)
          .add(new BN(5000000000000))
          .add(new BN(1000000000))
      );

      await advanceMiningCycleNoContest({ colonyNetwork, test: this });
      await setupFinalizedTask({
        colonyNetwork,
        colony: metaColony,
        skillId: 5,
        managerPayout: 1000000000000,
        evaluatorPayout: 1000000000,
        workerPayout: 5000000000000,
        managerRating: 3,
        workerRating: 3,
        worker: OTHER_ACCOUNT
      });

      await setupFinalizedTask({
        colonyNetwork,
        colony: metaColony,
        skillId: 4,
        managerPayout: 1000000000000,
        evaluatorPayout: 1000000000000,
        workerPayout: 1000000000000,
        managerRating: 1,
        workerRating: 1,
        worker: OTHER_ACCOUNT
      });

      await advanceMiningCycleNoContest({ colonyNetwork, test: this });

      // The update log should contain the person being rewarded for the previous
      // update cycle, and reputation update for two task completions (manager, worker, evaluator);
      // That's 9 in total.
      const repCycle = await getActiveRepCycle(colonyNetwork);
      const nLogEntries = await repCycle.getReputationUpdateLogLength();
      assert.equal(nLogEntries.toNumber(), 9);

      badClient = new MaliciousReputationMinerExtraRep({ loader, minerAddress: OTHER_ACCOUNT, realProviderPort, useJsTree }, 26, 0xfffff);
      await badClient.initialise(colonyNetwork.address);
      await submitAndForwardTimeToDispute([goodClient, badClient], this);
      await goodClient.confirmJustificationRootHash();
      await badClient.confirmJustificationRootHash();

      await runBinarySearch(goodClient, badClient);
      await goodClient.confirmBinarySearchResult();
      await badClient.confirmBinarySearchResult();

      // Now get all the information needed to fire off a respondToChallenge call
      const [round, index] = await goodClient.getMySubmissionRoundAndIndex();
      const submission = await repCycle.getDisputeRounds(round.toString(), index.toString());
      const firstDisagreeIdx = new BN(submission.lowerBound);
      const lastAgreeIdx = firstDisagreeIdx.subn(1);
      const reputationKey = await goodClient.getKeyForUpdateNumber(lastAgreeIdx.toString());
      const [agreeStateBranchMask, agreeStateSiblings] = await goodClient.justificationTree.getProof(`0x${lastAgreeIdx.toString(16, 64)}`);
      const [disagreeStateBranchMask, disagreeStateSiblings] = await goodClient.justificationTree.getProof(`0x${firstDisagreeIdx.toString(16, 64)}`);
      const logEntryNumber = await goodClient.getLogEntryNumberForLogUpdateNumber(lastAgreeIdx.toString());

      await checkErrorRevert(
        repCycle.respondToChallenge(
          [
            round.toString(),
            index.toString(),
            goodClient.justificationHashes[`0x${firstDisagreeIdx.toString(16, 64)}`].justUpdatedProof.branchMask.toString(),
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].nextUpdateProof.nNodes.toString(),
            agreeStateBranchMask.toString(),
            goodClient.justificationHashes[`0x${firstDisagreeIdx.toString(16, 64)}`].justUpdatedProof.nNodes.toString(),
            disagreeStateBranchMask.toString(),
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].newestReputationProof.branchMask,
            logEntryNumber.toString(),
            0,
            // This is the wrong value
            disagreeStateBranchMask.toString(),
            // This is the correct line, for future reference
            // goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].originReputationProof.branchMask
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].nextUpdateProof.reputation,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].nextUpdateProof.uid,
            goodClient.justificationHashes[`0x${firstDisagreeIdx.toString(16, 64)}`].justUpdatedProof.reputation,
            goodClient.justificationHashes[`0x${firstDisagreeIdx.toString(16, 64)}`].justUpdatedProof.uid,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].newestReputationProof.reputation,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].newestReputationProof.uid,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].originReputationProof.reputation,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].originReputationProof.uid,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].childReputationProof.branchMask,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].childReputationProof.reputation,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].childReputationProof.uid,
            0
          ],
          reputationKey,
          goodClient.justificationHashes[`0x${firstDisagreeIdx.toString(16, 64)}`].justUpdatedProof.siblings,
          agreeStateSiblings,
          disagreeStateSiblings,
          goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].newestReputationProof.key,
          goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].newestReputationProof.siblings,
          goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].originReputationProof.key,
          goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].originReputationProof.siblings,
          goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].childReputationProof.key,
          goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].childReputationProof.siblings
        ),
        "colony-reputation-mining-origin-skill-state-disagreement"
      );

      await checkErrorRevert(
        repCycle.respondToChallenge(
          [
            round.toString(),
            index.toString(),
            goodClient.justificationHashes[`0x${firstDisagreeIdx.toString(16, 64)}`].justUpdatedProof.branchMask.toString(),
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].nextUpdateProof.nNodes.toString(),
            agreeStateBranchMask.toString(),
            goodClient.justificationHashes[`0x${firstDisagreeIdx.toString(16, 64)}`].justUpdatedProof.nNodes.toString(),
            disagreeStateBranchMask.toString(),
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].newestReputationProof.branchMask,
            logEntryNumber.toString(),
            0,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].originReputationProof.branchMask,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].nextUpdateProof.reputation,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].nextUpdateProof.uid,
            goodClient.justificationHashes[`0x${firstDisagreeIdx.toString(16, 64)}`].justUpdatedProof.reputation,
            goodClient.justificationHashes[`0x${firstDisagreeIdx.toString(16, 64)}`].justUpdatedProof.uid,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].newestReputationProof.reputation,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].newestReputationProof.uid,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].originReputationProof.reputation,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].originReputationProof.uid,
            // This is the wrong value
            disagreeStateBranchMask.toString(),
            // This is the correct line, for future reference
            // goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].childReputationProof.branchMask,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].childReputationProof.reputation,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].childReputationProof.uid,
            0
          ],
          reputationKey,
          goodClient.justificationHashes[`0x${firstDisagreeIdx.toString(16, 64)}`].justUpdatedProof.siblings,
          agreeStateSiblings,
          disagreeStateSiblings,
          goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].newestReputationProof.key,
          goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].newestReputationProof.siblings,
          goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].originReputationProof.key,
          goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].originReputationProof.siblings,
          goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].childReputationProof.key,
          goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].childReputationProof.siblings
        ),
        "colony-reputation-mining-child-skill-state-disagreement"
      );

      // Cleanup
      await forwardTime(MINING_CYCLE_DURATION, this);
      await goodClient.respondToChallenge();
      await repCycle.invalidateHash(0, 1);
      await repCycle.confirmNewHash(1);
    });

    it("should correctly check the UID of the reputation if the reputation update being disputed is a decay", async () => {
      badClient = new MaliciousReputationMinerExtraRep({ loader, realProviderPort, useJsTree, minerAddress: OTHER_ACCOUNT }, 1, 0xfffffffff);
      await badClient.initialise(colonyNetwork.address);

      await giveUserCLNYTokensAndStake(colonyNetwork, OTHER_ACCOUNT, DEFAULT_STAKE);

      await fundColonyWithTokens(metaColony, clny);
      await setupFinalizedTask({ colonyNetwork, colony: metaColony });

      await advanceMiningCycleNoContest({ colonyNetwork, test: this });

      await badClient.initialise(colonyNetwork.address);
      await badClient.addLogContentsToReputationTree();

      await advanceMiningCycleNoContest({ colonyNetwork, client: goodClient, test: this });

      await submitAndForwardTimeToDispute([goodClient, badClient], this);

      await goodClient.confirmJustificationRootHash();
      await badClient.confirmJustificationRootHash();

      await runBinarySearch(goodClient, badClient);

      await goodClient.confirmBinarySearchResult();
      await badClient.confirmBinarySearchResult();

      // Now get all the information needed to fire off a respondToChallenge call
      const repCycle = await getActiveRepCycle(colonyNetwork);
      const [round, index] = await goodClient.getMySubmissionRoundAndIndex();
      const submission = await repCycle.getDisputeRounds(round, index);
      const firstDisagreeIdx = new BN(submission.lowerBound);
      const lastAgreeIdx = firstDisagreeIdx.subn(1);
      const reputationKey = await goodClient.getKeyForUpdateNumber(lastAgreeIdx.toString());
      const [agreeStateBranchMask, agreeStateSiblings] = await goodClient.justificationTree.getProof(`0x${lastAgreeIdx.toString(16, 64)}`);
      const [disagreeStateBranchMask, disagreeStateSiblings] = await goodClient.justificationTree.getProof(`0x${firstDisagreeIdx.toString(16, 64)}`);
      const logEntryNumber = await goodClient.getLogEntryNumberForLogUpdateNumber(lastAgreeIdx.toString());

      const agreeStateReputationUIDFake = new BN(
        goodClient.justificationHashes[`0x${firstDisagreeIdx.toString(16, 64)}`].justUpdatedProof.uid.slice(2),
        16
      )
        .addn(1)
        .toString(16, 64);

      await checkErrorRevert(
        repCycle.respondToChallenge(
          [
            round,
            index,
            goodClient.justificationHashes[`0x${firstDisagreeIdx.toString(16, 64)}`].justUpdatedProof.branchMask,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].nextUpdateProof.nNodes,
            agreeStateBranchMask,
            goodClient.justificationHashes[`0x${firstDisagreeIdx.toString(16, 64)}`].justUpdatedProof.nNodes,
            disagreeStateBranchMask,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].newestReputationProof.branchMask,
            logEntryNumber,
            0,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].originReputationProof.branchMask,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].nextUpdateProof.reputation,
            // This is the correct line
            // goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].nextUpdateProof.uid,
            agreeStateReputationUIDFake,
            goodClient.justificationHashes[`0x${firstDisagreeIdx.toString(16, 64)}`].justUpdatedProof.reputation,
            goodClient.justificationHashes[`0x${firstDisagreeIdx.toString(16, 64)}`].justUpdatedProof.uid,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].newestReputationProof.reputation,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].newestReputationProof.uid,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].originReputationProof.reputation,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].originReputationProof.uid,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].originReputationProof.branchMask,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].originReputationProof.reputation,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].originReputationProof.uid,
            0
          ],
          reputationKey,
          goodClient.justificationHashes[`0x${firstDisagreeIdx.toString(16, 64)}`].justUpdatedProof.siblings,
          agreeStateSiblings,
          disagreeStateSiblings,
          goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].newestReputationProof.key,
          goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].newestReputationProof.siblings,
          goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].originReputationProof.key,
          goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].originReputationProof.siblings,
          goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].childReputationProof.key,
          goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].childReputationProof.siblings
        ),
        "colony-reputation-mining-uid-not-decay"
      );

      // Cleanup
      await forwardTime(MINING_CYCLE_DURATION, this);
      await goodClient.respondToChallenge();
      await repCycle.invalidateHash(0, 1);
      await repCycle.confirmNewHash(1);
    });

    it("should correctly require the proof of the reputation under dispute before and after the change in question", async () => {
      await giveUserCLNYTokensAndStake(colonyNetwork, OTHER_ACCOUNT, DEFAULT_STAKE);

      await fundColonyWithTokens(metaColony, clny, INITIAL_FUNDING.muln(3));
      await setupFinalizedTask({ colonyNetwork, colony: metaColony });
      await setupFinalizedTask({ colonyNetwork, colony: metaColony });
      await setupFinalizedTask({ colonyNetwork, colony: metaColony });

      await advanceMiningCycleNoContest({ colonyNetwork, test: this });

      badClient = new MaliciousReputationMinerExtraRep({ loader, realProviderPort, useJsTree, minerAddress: OTHER_ACCOUNT }, 24, 0xfffffffff);
      await badClient.initialise(colonyNetwork.address);

      await submitAndForwardTimeToDispute([goodClient, badClient], this);

      await goodClient.confirmJustificationRootHash();
      await badClient.confirmJustificationRootHash();

      await runBinarySearch(goodClient, badClient);

      await goodClient.confirmBinarySearchResult();
      await badClient.confirmBinarySearchResult();

      // Now get all the information needed to fire off a respondToChallenge call
      const repCycle = await getActiveRepCycle(colonyNetwork);
      const [round, index] = await goodClient.getMySubmissionRoundAndIndex();
      const submission = await repCycle.getDisputeRounds(round, index);
      const firstDisagreeIdx = new BN(submission.lowerBound);
      const lastAgreeIdx = firstDisagreeIdx.subn(1);
      const reputationKey = await goodClient.getKeyForUpdateNumber(lastAgreeIdx.toString());
      const [agreeStateBranchMask, agreeStateSiblings] = await goodClient.justificationTree.getProof(`0x${lastAgreeIdx.toString(16, 64)}`);
      const [disagreeStateBranchMask, disagreeStateSiblings] = await goodClient.justificationTree.getProof(`0x${firstDisagreeIdx.toString(16, 64)}`);
      const logEntryNumber = await goodClient.getLogEntryNumberForLogUpdateNumber(lastAgreeIdx.toString());

      await checkErrorRevert(
        repCycle.respondToChallenge(
          [
            round,
            index,
            goodClient.justificationHashes[`0x${firstDisagreeIdx.toString(16, 64)}`].justUpdatedProof.branchMask,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].nextUpdateProof.nNodes,
            // This is the right line
            // agreeStateBranchMask,
            // This is the wrong line
            123456,
            goodClient.justificationHashes[`0x${firstDisagreeIdx.toString(16, 64)}`].justUpdatedProof.nNodes,
            disagreeStateBranchMask,
            // This is the correct line, for future reference
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].newestReputationProof.branchMask,
            logEntryNumber,
            0,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].originReputationProof.branchMask,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].nextUpdateProof.reputation,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].nextUpdateProof.uid,
            goodClient.justificationHashes[`0x${firstDisagreeIdx.toString(16, 64)}`].justUpdatedProof.reputation,
            goodClient.justificationHashes[`0x${firstDisagreeIdx.toString(16, 64)}`].justUpdatedProof.uid,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].newestReputationProof.reputation,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].newestReputationProof.uid,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].originReputationProof.reputation,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].originReputationProof.uid,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].childReputationProof.branchMask,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].childReputationProof.uid,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].childReputationProof.reputation,
            0
          ],
          reputationKey,
          goodClient.justificationHashes[`0x${firstDisagreeIdx.toString(16, 64)}`].justUpdatedProof.siblings,
          agreeStateSiblings,
          disagreeStateSiblings,
          goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].newestReputationProof.key,
          goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].newestReputationProof.siblings,
          goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].originReputationProof.key,
          goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].originReputationProof.siblings,
          goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].childReputationProof.key,
          goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].childReputationProof.siblings
        ),
        "colony-reputation-mining-invalid-before-reputation-proof"
      );

      await checkErrorRevert(
        repCycle.respondToChallenge(
          [
            round,
            index,
            goodClient.justificationHashes[`0x${firstDisagreeIdx.toString(16, 64)}`].justUpdatedProof.branchMask,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].nextUpdateProof.nNodes,
            agreeStateBranchMask,
            goodClient.justificationHashes[`0x${firstDisagreeIdx.toString(16, 64)}`].justUpdatedProof.nNodes,
            // This is the wrong line
            123456,
            // This is the right line
            // disagreeStateBranchMask,
            // This is the correct line, for future reference
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].newestReputationProof.branchMask,
            logEntryNumber,
            0,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].originReputationProof.branchMask,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].nextUpdateProof.reputation,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].nextUpdateProof.uid,
            goodClient.justificationHashes[`0x${firstDisagreeIdx.toString(16, 64)}`].justUpdatedProof.reputation,
            goodClient.justificationHashes[`0x${firstDisagreeIdx.toString(16, 64)}`].justUpdatedProof.uid,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].newestReputationProof.reputation,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].newestReputationProof.uid,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].originReputationProof.reputation,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].originReputationProof.uid,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].childReputationProof.branchMask,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].childReputationProof.uid,
            goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].childReputationProof.reputation,
            0
          ],
          reputationKey,
          goodClient.justificationHashes[`0x${firstDisagreeIdx.toString(16, 64)}`].justUpdatedProof.siblings,
          agreeStateSiblings,
          disagreeStateSiblings,
          goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].newestReputationProof.key,
          goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].newestReputationProof.siblings,
          goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].originReputationProof.key,
          goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].originReputationProof.siblings,
          goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].childReputationProof.key,
          goodClient.justificationHashes[`0x${lastAgreeIdx.toString(16, 64)}`].childReputationProof.siblings
        ),
        "colony-reputation-mining-invalid-after-reputation-proof"
      );

      // Cleanup
      await forwardTime(MINING_CYCLE_DURATION, this);
      await goodClient.respondToChallenge();
      await repCycle.invalidateHash(0, 1);
      await repCycle.confirmNewHash(1);
    });

    it("should prevent a hash from advancing if it might still get an opponent", async function advancingTest() {
      this.timeout(10000000);

      assert.isTrue(accounts.length >= 11, "Not enough accounts for test to run");
      const accountsForTest = accounts.slice(3, 11);

      await fundColonyWithTokens(metaColony, clny, INITIAL_FUNDING.muln(8));
      for (let i = 0; i < 8; i += 1) {
        await giveUserCLNYTokensAndStake(colonyNetwork, accountsForTest[i], DEFAULT_STAKE);
        await setupFinalizedTask({ colonyNetwork, colony: metaColony, worker: accountsForTest[i] });
        // These have to be done sequentially because this function uses the total number of tasks as a proxy for getting the
        // right taskId, so if they're all created at once it messes up.
      }

      // We need to complete the current reputation cycle so that all the required log entries are present
      await advanceMiningCycleNoContest({ colonyNetwork, test: this });

      const clients = await Promise.all(
        accountsForTest.map(async (addr, index) => {
          const client = new MaliciousReputationMinerExtraRep(
            { loader, realProviderPort, useJsTree, minerAddress: addr },
            accountsForTest.length - index,
            index
          );
          // Each client will get a different reputation update entry wrong by a different amount, apart from the first one which
          // will submit a correct hash.
          await client.initialise(colonyNetwork.address);
          return client;
        })
      );

      const repCycle = await getActiveRepCycle(colonyNetwork);
      await forwardTime(MINING_CYCLE_DURATION / 2, this);

      for (let i = 0; i < 8; i += 1) {
        // Doing these individually rather than in a big loop because with many instances of the EVM
        // churning away at once, I *think* it's slower.
        await clients[i].addLogContentsToReputationTree();
        await clients[i].submitRootHash();
        await clients[i].confirmJustificationRootHash();
      }

      await forwardTime(MINING_CYCLE_DURATION / 2, this);
      await accommodateChallengeAndInvalidateHash(colonyNetwork, this, clients[0], clients[1], {
        client2: { respondToChallenge: "colony-reputation-mining-increased-reputation-value-incorrect" }
      });
      await accommodateChallengeAndInvalidateHash(colonyNetwork, this, clients[2], clients[3], {
        client2: { respondToChallenge: "colony-reputation-mining-increased-reputation-value-incorrect" }
      });
      await accommodateChallengeAndInvalidateHash(colonyNetwork, this, clients[4], clients[5], {
        client2: { respondToChallenge: "colony-reputation-mining-increased-reputation-value-incorrect" }
      });

      // This is the first pairing in round 2
      await accommodateChallengeAndInvalidateHash(colonyNetwork, this, clients[0], clients[2], {
        client2: { respondToChallenge: "colony-reputation-mining-increased-reputation-value-incorrect" }
      });
      await checkErrorRevert(
        accommodateChallengeAndInvalidateHash(colonyNetwork, this, clients[4]),
        "colony-reputation-mining-previous-dispute-round-not-complete"
      );

      // Now clean up
      await accommodateChallengeAndInvalidateHash(colonyNetwork, this, clients[6], clients[7], {
        client2: { respondToChallenge: "colony-reputation-mining-increased-reputation-value-incorrect" }
      });
      await accommodateChallengeAndInvalidateHash(colonyNetwork, this, clients[4], clients[6], {
        client2: { respondToChallenge: "colony-reputation-mining-increased-reputation-value-incorrect" }
      });
      await accommodateChallengeAndInvalidateHash(colonyNetwork, this, clients[0], clients[4], {
        client2: { respondToChallenge: "colony-reputation-mining-increased-reputation-value-incorrect" }
      });
      await repCycle.confirmNewHash(3);
    });

    it("should only allow the last hash standing to be confirmed", async () => {
      badClient = new MaliciousReputationMinerExtraRep({ loader, realProviderPort, useJsTree, minerAddress: OTHER_ACCOUNT }, 1, 0xfffffffff);
      await badClient.initialise(colonyNetwork.address);

      await giveUserCLNYTokensAndStake(colonyNetwork, OTHER_ACCOUNT, DEFAULT_STAKE);
      await advanceMiningCycleNoContest({ colonyNetwork, test: this });

      const repCycle = await getActiveRepCycle(colonyNetwork);
      await submitAndForwardTimeToDispute([goodClient, badClient], this);

      await goodClient.confirmJustificationRootHash();
      await badClient.confirmJustificationRootHash();

      await accommodateChallengeAndInvalidateHash(colonyNetwork, this, goodClient, badClient, {
        client2: { respondToChallenge: "colony-reputation-mining-increased-reputation-value-incorrect" }
      });
      await checkErrorRevert(repCycle.confirmNewHash(0), "colony-reputation-mining-not-final-round");
      await repCycle.confirmNewHash(1);
    });

    it("incorrectly confirming a binary search result should fail", async () => {
      await giveUserCLNYTokensAndStake(colonyNetwork, OTHER_ACCOUNT, DEFAULT_STAKE);
      await advanceMiningCycleNoContest({ colonyNetwork, test: this });

      badClient = new MaliciousReputationMinerExtraRep({ loader, realProviderPort, useJsTree, minerAddress: OTHER_ACCOUNT }, 3, 0xffffffffffff);
      await badClient.initialise(colonyNetwork.address);

      const repCycle = await getActiveRepCycle(colonyNetwork);

      await submitAndForwardTimeToDispute([goodClient, badClient], this);

      await goodClient.confirmJustificationRootHash();
      await badClient.confirmJustificationRootHash();

      await runBinarySearch(goodClient, badClient);

      const [round, index] = await goodClient.getMySubmissionRoundAndIndex();
      const submission = await repCycle.getDisputeRounds(round, index);
      const targetNode = submission.lowerBound;
      const targetNodeKey = ReputationMinerTestWrapper.getHexString(targetNode, 64);
      const [branchMask, siblings] = await goodClient.justificationTree.getProof(targetNodeKey);

      await checkErrorRevert(
        repCycle.confirmBinarySearchResult(round, index, "0x00", branchMask, siblings),
        "colony-reputation-mining-invalid-binary-search-confirmation"
      );

      // Cleanup
      await forwardTime(MINING_CYCLE_DURATION / 6, this);
      await goodClient.confirmBinarySearchResult();
      await repCycle.invalidateHash(0, 1);
      await repCycle.confirmNewHash(1);
    });

    it("should not allow stages to be skipped even if the number of updates is a power of 2", async () => {
      // Note that our jrhNNodes can never be a power of two, because we always have an even number of updates (because every reputation change
      // has a user-specific an a colony-specific effect, and we always have one extra state in the Justification Tree because we include the last
      // accepted hash as the first node. jrhNNodes is always odd, therefore, and can never be a power of two.
      await giveUserCLNYTokensAndStake(colonyNetwork, OTHER_ACCOUNT, DEFAULT_STAKE);
      await advanceMiningCycleNoContest({ colonyNetwork, test: this });

      await fundColonyWithTokens(metaColony, clny, INITIAL_FUNDING.muln(4));
      await setupFinalizedTask({ colonyNetwork, colony: metaColony });
      await setupFinalizedTask({ colonyNetwork, colony: metaColony });
      await setupFinalizedTask({
        colonyNetwork,
        colony: metaColony,
        token: clny,
        manager: MAIN_ACCOUNT,
        worker: OTHER_ACCOUNT,
        workerRating: 1,
        managerPayout: 1,
        evaluatorPayout: 1,
        workerPayout: 1
      });

      await advanceMiningCycleNoContest({ colonyNetwork, client: goodClient, test: this });

      const addr = await colonyNetwork.getReputationMiningCycle(false);
      const inactiveRepCycle = await IReputationMiningCycle.at(addr);

      let powerTwoEntries = false;
      while (!powerTwoEntries) {
        await setupFinalizedTask( // eslint-disable-line
          {
            colonyNetwork,
            colony: metaColony,
            token: clny,
            evaluator: MAIN_ACCOUNT,
            worker: OTHER_ACCOUNT,
            workerRating: 1,
            managerPayout: 1,
            evaluatorPayout: 1,
            workerPayout: 1
          }
        );

        const nLogEntries = await inactiveRepCycle.getReputationUpdateLogLength();
        const lastLogEntry = await inactiveRepCycle.getReputationUpdateLogEntry(nLogEntries - 1);

        const currentHashNNodes = await colonyNetwork.getReputationRootHashNNodes();
        const nUpdates = new BN(lastLogEntry.nUpdates).add(new BN(lastLogEntry.nPreviousUpdates)).add(currentHashNNodes);
        // The total number of updates we expect is the nPreviousUpdates in the last entry of the log plus the number
        // of updates that log entry implies by itself, plus the number of decays (the number of nodes in current state)
        if (parseInt(nUpdates.toString(2).slice(1), 10) === 0) {
          powerTwoEntries = true;
        }
      }

      await advanceMiningCycleNoContest({ colonyNetwork, client: goodClient, test: this });

      await goodClient.saveCurrentState();
      const savedHash = await goodClient.reputationTree.getRootHash();

      badClient = new MaliciousReputationMinerExtraRep({ loader, realProviderPort, useJsTree, minerAddress: OTHER_ACCOUNT }, 5, 0xfffffffff);
      await badClient.initialise(colonyNetwork.address);

      await badClient.loadState(savedHash);
      await submitAndForwardTimeToDispute([goodClient, badClient], this);

      await goodClient.confirmJustificationRootHash();
      await badClient.confirmJustificationRootHash();

      // Incomplete binary search
      await goodClient.respondToBinarySearchForChallenge();
      await badClient.respondToBinarySearchForChallenge();
      await badClient.respondToBinarySearchForChallenge();
      await goodClient.respondToBinarySearchForChallenge();
      await badClient.respondToBinarySearchForChallenge();
      await goodClient.respondToBinarySearchForChallenge();
      await badClient.respondToBinarySearchForChallenge();
      await goodClient.respondToBinarySearchForChallenge();
      await badClient.respondToBinarySearchForChallenge();
      await goodClient.respondToBinarySearchForChallenge();
      await badClient.respondToBinarySearchForChallenge();
      await goodClient.respondToBinarySearchForChallenge();

      // We need one more response to binary search from each side. Check we can't confirm early
      await checkErrorRevertEthers(goodClient.confirmBinarySearchResult(), "colony-reputation-binary-search-incomplete");

      // Check we can't respond to challenge before we've completed the binary search
      await checkErrorRevertEthers(goodClient.respondToChallenge(), "colony-reputation-binary-search-incomplete");
      await goodClient.respondToBinarySearchForChallenge();
      // Check we can't confirm even if we're done, but our opponent isn't
      await checkErrorRevertEthers(goodClient.confirmBinarySearchResult(), "colony-reputation-binary-search-incomplete");
      await badClient.respondToBinarySearchForChallenge();

      // Check we can't respond to challenge before confirming result
      await checkErrorRevertEthers(goodClient.respondToChallenge(), "colony-reputation-mining-binary-search-result-not-confirmed");

      // Now we can confirm
      await goodClient.confirmBinarySearchResult();
      await badClient.confirmBinarySearchResult();

      // Check we can't continue confirming
      await checkErrorRevertEthers(goodClient.respondToBinarySearchForChallenge(), "colony-reputation-mining-challenge-not-active");
      await goodClient.respondToChallenge();
      // Check we can't respond again
      await checkErrorRevertEthers(goodClient.respondToChallenge(), "colony-reputation-mining-challenge-already-responded");

      await forwardTime(MINING_CYCLE_DURATION / 6, this);
      const repCycle = await getActiveRepCycle(colonyNetwork);
      await repCycle.invalidateHash(0, 1);
      await repCycle.confirmNewHash(1);
    });

    it("should fail to respondToBinarySearchForChallenge if not consistent with JRH", async () => {
      badClient = new MaliciousReputationMinerExtraRep({ loader, realProviderPort, useJsTree, minerAddress: OTHER_ACCOUNT }, 1, 0xfffffffff);
      await badClient.initialise(colonyNetwork.address);

      await giveUserCLNYTokensAndStake(colonyNetwork, OTHER_ACCOUNT, DEFAULT_STAKE);
      await advanceMiningCycleNoContest({ colonyNetwork, test: this });

      const repCycle = await getActiveRepCycle(colonyNetwork);
      await submitAndForwardTimeToDispute([goodClient, badClient], this);

      await goodClient.confirmJustificationRootHash();
      await badClient.confirmJustificationRootHash();

      await checkErrorRevert(
        repCycle.respondToBinarySearchForChallenge(0, 0, "0x00", 0x07, ["0x00", "0x00", "0x00"]),
        "colony-reputation-mining-invalid-binary-search-response"
      );

      // Cleanup
      await accommodateChallengeAndInvalidateHash(colonyNetwork, this, goodClient, badClient, {
        client2: { respondToChallenge: "colony-reputation-mining-increased-reputation-value-incorrect" }
      });
      await repCycle.confirmNewHash(1);
    });

    it("should fail to respondToChallenge if any part of the key is wrong", async () => {
      await giveUserCLNYTokensAndStake(colonyNetwork, OTHER_ACCOUNT, DEFAULT_STAKE);
      await advanceMiningCycleNoContest({ colonyNetwork, test: this });

      badClient = new MaliciousReputationMinerExtraRep({ loader, realProviderPort, useJsTree, minerAddress: OTHER_ACCOUNT }, 3, 0xffffffffffff);
      await badClient.initialise(colonyNetwork.address);

      const repCycle = await getActiveRepCycle(colonyNetwork);
      await submitAndForwardTimeToDispute([goodClient, badClient], this);

      await goodClient.confirmJustificationRootHash();
      await badClient.confirmJustificationRootHash();

      await runBinarySearch(goodClient, badClient);

      await goodClient.confirmBinarySearchResult();
      await badClient.confirmBinarySearchResult();

      const logEntry = await repCycle.getReputationUpdateLogEntry(0);

      const colonyAddress = logEntry.colony.slice(2);
      const userAddress = logEntry.user.slice(2);
      const skillId = new BN(logEntry.skillId);

      // Linter fail
      const wrongColonyKey = `0x${new BN(0, 16).toString(16, 40)}${new BN(skillId.toString()).toString(16, 64)}${new BN(userAddress, 16).toString(
        16,
        40
      )}`;
      const wrongReputationKey = `0x${new BN(colonyAddress, 16).toString(16, 40)}${new BN(0).toString(16, 64)}${new BN(userAddress, 16).toString(
        16,
        40
      )}`;
      const wrongUserKey = `0x${new BN(colonyAddress, 16).toString(16, 40)}${new BN(skillId.toString()).toString(16, 64)}${new BN(0, 16).toString(
        16,
        40
      )}`;

      await checkErrorRevert(
        repCycle.respondToChallenge(
          [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
          wrongColonyKey,
          [],
          [],
          [],
          "0x00",
          [],
          "0x00",
          [],
          "0x00",
          []
        ),
        "colony-reputation-mining-colony-address-mismatch"
      );

      await checkErrorRevert(
        repCycle.respondToChallenge(
          [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
          wrongReputationKey,
          [],
          [],
          [],
          "0x00",
          [],
          "0x00",
          [],
          "0x00",
          []
        ),
        "colony-reputation-mining-skill-id-mismatch"
      );

      await checkErrorRevert(
        repCycle.respondToChallenge(
          [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
          wrongUserKey,
          [],
          [],
          [],
          "0x00",
          [],
          "0x00",
          [],
          "0x00",
          []
        ),
        "colony-reputation-mining-user-address-mismatch"
      );

      await forwardTime(MINING_CYCLE_DURATION / 6, this);
      await goodClient.respondToChallenge();
      await repCycle.invalidateHash(0, 1);
      await repCycle.confirmNewHash(1);
    });

    it("should fail to respondToChallenge if binary search for challenge is not complete yet", async () => {
      badClient = new MaliciousReputationMinerExtraRep({ loader, realProviderPort, useJsTree, minerAddress: OTHER_ACCOUNT }, 1, 0xfffffffff);
      await badClient.initialise(colonyNetwork.address);

      await giveUserCLNYTokensAndStake(colonyNetwork, OTHER_ACCOUNT, DEFAULT_STAKE);
      await advanceMiningCycleNoContest({ colonyNetwork, test: this });

      const repCycle = await getActiveRepCycle(colonyNetwork);
      await submitAndForwardTimeToDispute([goodClient, badClient], this);

      await goodClient.confirmJustificationRootHash();
      await badClient.confirmJustificationRootHash();

      await goodClient.respondToBinarySearchForChallenge();
      await badClient.respondToBinarySearchForChallenge();

      await checkErrorRevert(
        repCycle.respondToChallenge(
          [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
          "0x00",
          [],
          [],
          [],
          "0x00",
          [],
          "0x00",
          [],
          "0x00",
          []
        ),
        "colony-reputation-binary-search-incomplete"
      );

      // Cleanup
      await badClient.respondToBinarySearchForChallenge();
      await goodClient.respondToBinarySearchForChallenge();

      await badClient.respondToBinarySearchForChallenge();
      await goodClient.respondToBinarySearchForChallenge();

      await goodClient.confirmBinarySearchResult();
      await badClient.confirmBinarySearchResult();

      await forwardTime(MINING_CYCLE_DURATION / 6, this);
      await goodClient.respondToChallenge();
      await repCycle.invalidateHash(0, 1);
      await repCycle.confirmNewHash(1);
    });

    it("should refuse to confirmNewHash while the minimum submission window has not elapsed", async () => {
      await giveUserCLNYTokensAndStake(colonyNetwork, OTHER_ACCOUNT, DEFAULT_STAKE);
      await advanceMiningCycleNoContest({ colonyNetwork, test: this });

      const repCycle = await getActiveRepCycle(colonyNetwork);

      await goodClient.addLogContentsToReputationTree();
      await badClient.addLogContentsToReputationTree();

      await forwardTime(MINING_CYCLE_DURATION / 2, this);
      await goodClient.submitRootHash();

      await checkErrorRevert(repCycle.confirmNewHash(0), "colony-reputation-mining-submission-window-still-open");

      // Cleanup
      await forwardTime(MINING_CYCLE_DURATION / 2, this);
      await repCycle.confirmNewHash(0);
    });

    [{ word: "high", badClient1Argument: 1, badClient2Argument: 1 }, { word: "low", badClient1Argument: 9, badClient2Argument: -1 }].forEach(
      async args => {
        it(`should fail to respondToChallenge if supplied log entry does not correspond to the entry under disagreement and supplied log entry
          is too ${args.word}`, async () => {
          await giveUserCLNYTokensAndStake(colonyNetwork, OTHER_ACCOUNT, DEFAULT_STAKE);
          await giveUserCLNYTokensAndStake(colonyNetwork, OTHER_ACCOUNT2, DEFAULT_STAKE);

          await fundColonyWithTokens(metaColony, clny, INITIAL_FUNDING.muln(2));
          await setupFinalizedTask({ colonyNetwork, colony: metaColony });
          await setupFinalizedTask({ colonyNetwork, colony: metaColony });

          await advanceMiningCycleNoContest({ colonyNetwork, test: this });
          const repCycle = await getActiveRepCycle(colonyNetwork);

          await goodClient.addLogContentsToReputationTree();

          badClient = new MaliciousReputationMinerExtraRep(
            { loader, realProviderPort, useJsTree, minerAddress: OTHER_ACCOUNT },
            args.badClient1Argument,
            10
          );
          await badClient.initialise(colonyNetwork.address);

          badClient2 = new MaliciousReputationMinerWrongProofLogEntry(
            { loader, realProviderPort, useJsTree, minerAddress: OTHER_ACCOUNT2 },
            args.badClient2Argument
          );
          await badClient2.initialise(colonyNetwork.address);

          await submitAndForwardTimeToDispute([badClient, badClient2], this);

          const wronghash = await badClient.getRootHash();
          const wronghash2 = await badClient2.getRootHash();
          assert.notEqual(wronghash, wronghash2, "Hashes from clients are equal, surprisingly");

          await badClient.confirmJustificationRootHash();
          await badClient2.confirmJustificationRootHash();

          await runBinarySearch(badClient, badClient2);

          await goodClient.confirmBinarySearchResult();
          await badClient.confirmBinarySearchResult();

          if (args.word === "high") {
            await checkErrorRevertEthers(
              badClient2.respondToChallenge(),
              "colony-reputation-mining-update-number-part-of-previous-log-entry-updates"
            );
          } else {
            await checkErrorRevertEthers(
              badClient2.respondToChallenge(),
              "colony-reputation-mining-update-number-part-of-following-log-entry-updates"
            );
          }

          // Cleanup
          await forwardTime(MINING_CYCLE_DURATION / 6, this);
          await goodClient.respondToChallenge();
          await repCycle.invalidateHash(0, 0);
          await repCycle.confirmNewHash(1);
        });
      }
    );
  });

  describe("Another child reputation dispute", () => {
    it("if reputation calculation is wrong, contracts should cope if child skills added during the mining cycle or dispute process", async () => {
      await giveUserCLNYTokensAndStake(colonyNetwork, MAIN_ACCOUNT, DEFAULT_STAKE);
      await giveUserCLNYTokensAndStake(colonyNetwork, OTHER_ACCOUNT, DEFAULT_STAKE);
      await giveUserCLNYTokensAndStake(colonyNetwork, OTHER_ACCOUNT2, DEFAULT_STAKE);

      await fundColonyWithTokens(metaColony, clny, INITIAL_FUNDING.muln(4));

      await setupFinalizedTask({
        colonyNetwork,
        colony: metaColony,
        skillId: 5,
        managerPayout: 1000000000000,
        evaluatorPayout: 1000000000,
        workerPayout: 5000000000000,
        managerRating: 3,
        workerRating: 3,
        worker: OTHER_ACCOUNT
      });

      await advanceMiningCycleNoContest({ colonyNetwork, test: this });

      await setupFinalizedTask({
        colonyNetwork,
        colony: metaColony,
        skillId: 4,
        managerPayout: 1000000000,
        evaluatorPayout: 1000000000,
        workerPayout: 1000000000,
        managerRating: 1,
        workerRating: 1,
        worker: OTHER_ACCOUNT
      });

      await goodClient.resetDB();
      await advanceMiningCycleNoContest({ colonyNetwork, test: this, client: goodClient });
      await goodClient.saveCurrentState();

      // The update log should contain the person being rewarded for the previous
      // update cycle, and reputation update for one task completion (manager, worker, evaluator);
      // That's five in total.
      const repCycle = await getActiveRepCycle(colonyNetwork);
      const nLogEntries = await repCycle.getReputationUpdateLogLength();
      assert.equal(nLogEntries.toNumber(), 5);

      badClient = new MaliciousReputationMinerExtraRep(
        { loader, realProviderPort, useJsTree, minerAddress: OTHER_ACCOUNT },
        27, // Passing in update number for skillId: 1, user: 0
        "0xfffffffff"
      );

      badClient2 = new MaliciousReputationMinerExtraRep(
        { loader, realProviderPort, useJsTree, minerAddress: OTHER_ACCOUNT2 },
        29, // Passing in update number for skillId: 5, user: 9f485401a3c22529ab6ea15e2ebd5a8ca54a5430
        "0xfffffffff"
      );

      await metaColony.addGlobalSkill(5);

      // Moving the state to the bad client
      await badClient.initialise(colonyNetwork.address);
      await badClient2.initialise(colonyNetwork.address);
      const currentGoodClientState = await goodClient.getRootHash();
      await badClient.loadState(currentGoodClientState);
      await badClient2.loadState(currentGoodClientState);

      await submitAndForwardTimeToDispute([goodClient, badClient, badClient2], this);
      await metaColony.addGlobalSkill(6);

      const righthash = await goodClient.getRootHash();
      const wronghash = await badClient.getRootHash();
      assert(righthash !== wronghash, "Hashes from clients are equal, surprisingly");

      await accommodateChallengeAndInvalidateHash(colonyNetwork, this, goodClient, badClient, {
        client2: { respondToChallenge: "colony-reputation-mining-decreased-reputation-value-incorrect" }
      });
      await repCycle.invalidateHash(0, 3);
      await accommodateChallengeAndInvalidateHash(colonyNetwork, this, goodClient, badClient2, {
        client2: { respondToChallenge: "colony-reputation-mining-child-reputation-value-incorrect" }
      });
      await repCycle.confirmNewHash(2);
    });
  });

  describe("Intended ('happy path') behaviours", () => {
    before(async () => {
      // We're not resetting the global skills tree as the Network is not reset
      // Initialise global skills tree: 1 -> 4 -> 5 -> 6 -> 7 -> 8 -> 9 -> 10

      await metaColony.addGlobalSkill(7);
      await metaColony.addGlobalSkill(8);
      await metaColony.addGlobalSkill(9);
    });

    it("should cope with many hashes being submitted and eliminated before a winner is assigned", async function manySubmissionTest() {
      this.timeout(100000000);

      // TODO: This test probably needs to be written more carefully to make sure all possible edge cases are dealt with
      for (let i = 3; i < 11; i += 1) {
        await giveUserCLNYTokensAndStake(colonyNetwork, accounts[i], DEFAULT_STAKE);
        // These have to be done sequentially because this function uses the total number of tasks as a proxy for getting the
        // right taskId, so if they're all created at once it messes up.
      }
      await fundColonyWithTokens(metaColony, clny, INITIAL_FUNDING.muln(30));

      await advanceMiningCycleNoContest({ colonyNetwork, test: this });

      const clients = await Promise.all(
        accounts.slice(3, 11).map(async (addr, index) => {
          const entryToFalsify = 7 - index;
          const amountToFalsify = index; // NB The first client is 'bad', but told to get the calculation wrong by 0, so is actually good.
          const client = new MaliciousReputationMinerExtraRep(
            { loader, realProviderPort, useJsTree, minerAddress: addr },
            entryToFalsify,
            amountToFalsify
          );
          // Each client will get a different reputation update entry wrong by a different amount, apart from the first one which
          // will submit a correct hash.
          await client.initialise(colonyNetwork.address);
          return client;
        })
      );

      // We need to complete the current reputation cycle so that all the required log entries are present
      await advanceMiningCycleNoContest({ colonyNetwork, test: this, client: clients[0] });

      await clients[0].saveCurrentState();
      const savedHash = await clients[0].reputationTree.getRootHash();
      await Promise.all(
        clients.map(async client => {
          client.loadState(savedHash);
        })
      );

      await submitAndForwardTimeToDispute(clients, this);

      // Round 1
      await accommodateChallengeAndInvalidateHash(colonyNetwork, this, clients[0], clients[1], {
        client2: { respondToChallenge: "colony-reputation-mining-increased-reputation-value-incorrect" }
      });
      await accommodateChallengeAndInvalidateHash(colonyNetwork, this, clients[2], clients[3], {
        client2: { respondToChallenge: "colony-reputation-mining-increased-reputation-value-incorrect" }
      });
      await accommodateChallengeAndInvalidateHash(colonyNetwork, this, clients[4], clients[5], {
        client2: { respondToChallenge: "colony-reputation-mining-decay-incorrect" }
      });
      await accommodateChallengeAndInvalidateHash(colonyNetwork, this, clients[6], clients[7], {
        client2: { respondToChallenge: "colony-reputation-mining-decay-incorrect" }
      });

      // Round 2
      await accommodateChallengeAndInvalidateHash(colonyNetwork, this, clients[0], clients[2], {
        client2: { respondToChallenge: "colony-reputation-mining-increased-reputation-value-incorrect" }
      });
      await accommodateChallengeAndInvalidateHash(colonyNetwork, this, clients[4], clients[6], {
        client2: { respondToChallenge: "colony-reputation-mining-decay-incorrect" }
      });

      // Round 3
      await accommodateChallengeAndInvalidateHash(colonyNetwork, this, clients[0], clients[4], {
        client2: { respondToChallenge: "colony-reputation-mining-decay-incorrect" }
      });

      const repCycle = await getActiveRepCycle(colonyNetwork);
      await repCycle.confirmNewHash(3);
    });

    it("should be able to process a large reputation update log", async () => {
      await fundColonyWithTokens(metaColony, clny, INITIAL_FUNDING.muln(30));
      // TODO It would be so much better if we could do these in parallel, but until colonyNetwork#192 is fixed, we can't.
      for (let i = 0; i < 30; i += 1) {
        await setupFinalizedTask( // eslint-disable-line
          {
            colonyNetwork,
            colony: metaColony,
            token: clny,
            workerRating: 2,
            managerPayout: 1,
            evaluatorPayout: 1,
            workerPayout: 1
          }
        );
      }

      // Complete two reputation cycles to process the log
      await advanceMiningCycleNoContest({ colonyNetwork, test: this });
      await advanceMiningCycleNoContest({ colonyNetwork, test: this });
    });

    it("should allow submitted hashes to go through multiple responses to a challenge", async () => {
      badClient = new MaliciousReputationMinerExtraRep({ loader, realProviderPort, useJsTree, minerAddress: OTHER_ACCOUNT }, 1, 0xfffffffff);
      await badClient.initialise(colonyNetwork.address);

      await giveUserCLNYTokensAndStake(colonyNetwork, OTHER_ACCOUNT, DEFAULT_STAKE);
      await advanceMiningCycleNoContest({ colonyNetwork, test: this });

      const repCycle = await getActiveRepCycle(colonyNetwork);
      await submitAndForwardTimeToDispute([goodClient, badClient], this);

      await goodClient.confirmJustificationRootHash();
      await badClient.confirmJustificationRootHash();

      await runBinarySearch(goodClient, badClient);

      await goodClient.confirmBinarySearchResult();
      await badClient.confirmBinarySearchResult();

      await forwardTime(MINING_CYCLE_DURATION / 6, this);
      await goodClient.respondToChallenge();
      await repCycle.invalidateHash(0, 1);
      await repCycle.confirmNewHash(1);
    });

    it("should cope if someone's existing reputation would go negative, setting it to zero instead", async () => {
      await giveUserCLNYTokensAndStake(colonyNetwork, OTHER_ACCOUNT, DEFAULT_STAKE);

      // Create reputation
      await fundColonyWithTokens(metaColony, clny, INITIAL_FUNDING.muln(3));
      await setupFinalizedTask({ colonyNetwork, colony: metaColony, worker: MAIN_ACCOUNT });
      await setupFinalizedTask({ colonyNetwork, colony: metaColony, worker: OTHER_ACCOUNT });

      badClient = new MaliciousReputationMinerExtraRep({ loader, realProviderPort, useJsTree, minerAddress: OTHER_ACCOUNT }, 29, 0xffffffffffff);
      await badClient.initialise(colonyNetwork.address);

      // Send rep to 0
      await setupFinalizedTask({
        colonyNetwork,
        colony: metaColony,
        managerPayout: 1000000000000,
        evaluatorPayout: 1000000000000,
        workerPayout: 1000000000000,
        managerRating: 1,
        workerRating: 1
      });

      await advanceMiningCycleNoContest({ colonyNetwork, test: this });

      const repCycle = await getActiveRepCycle(colonyNetwork);
      await submitAndForwardTimeToDispute([goodClient, badClient], this);

      await accommodateChallengeAndInvalidateHash(colonyNetwork, this, goodClient, badClient, {
        client2: { respondToChallenge: "colony-reputation-mining-reputation-value-non-zero" }
      });
      await repCycle.confirmNewHash(1);
    });

    it("should cope if someone's new reputation would be negative, setting it to zero instead", async () => {
      await giveUserCLNYTokensAndStake(colonyNetwork, OTHER_ACCOUNT, DEFAULT_STAKE);

      await fundColonyWithTokens(metaColony, clny, INITIAL_FUNDING.muln(3));
      await setupFinalizedTask({ colonyNetwork, colony: metaColony, worker: MAIN_ACCOUNT });
      await setupFinalizedTask({ colonyNetwork, colony: metaColony, worker: OTHER_ACCOUNT });

      badClient = new MaliciousReputationMinerExtraRep({ loader, realProviderPort, useJsTree, minerAddress: OTHER_ACCOUNT }, 31, 0xffffffffffff);
      await badClient.initialise(colonyNetwork.address);

      await setupFinalizedTask({
        colonyNetwork,
        colony: metaColony,
        worker: accounts[4],
        managerPayout: 1000000000000,
        evaluatorPayout: 1000000000000,
        workerPayout: 1000000000000,
        managerRating: 1,
        workerRating: 1
      });

      await advanceMiningCycleNoContest({ colonyNetwork, test: this });

      const repCycle = await getActiveRepCycle(colonyNetwork);
      await submitAndForwardTimeToDispute([goodClient, badClient], this);

      await accommodateChallengeAndInvalidateHash(colonyNetwork, this, goodClient, badClient, {
        client2: { respondToChallenge: "colony-reputation-mining-child-reputation-value-non-zero" }
      });
      await repCycle.confirmNewHash(1);
    });

    it("should cope if someone's reputation would overflow, setting it to the maximum value instead", async () => {
      await giveUserCLNYTokensAndStake(colonyNetwork, OTHER_ACCOUNT, DEFAULT_STAKE);
      await advanceMiningCycleNoContest({ colonyNetwork, test: this });

      await fundColonyWithTokens(metaColony, clny, INITIAL_FUNDING.muln(2));
      await setupFinalizedTask({ colonyNetwork, colony: metaColony, worker: MAIN_ACCOUNT });
      await setupFinalizedTask({ colonyNetwork, colony: metaColony, worker: OTHER_ACCOUNT });

      const bigPayout = new BN("10").pow(new BN("38"));

      badClient = new MaliciousReputationMinerExtraRep(
        { loader, realProviderPort, useJsTree, minerAddress: OTHER_ACCOUNT },
        29,
        bigPayout.muln(2).neg()
      );
      await badClient.initialise(colonyNetwork.address);

      let repCycle = await getActiveRepCycle(colonyNetwork);
      const rootGlobalSkill = await colonyNetwork.getRootGlobalSkillId();
      const globalKey = await ReputationMinerTestWrapper.getKey(metaColony.address, rootGlobalSkill, ZERO_ADDRESS);
      const userKey = await ReputationMinerTestWrapper.getKey(metaColony.address, rootGlobalSkill, MAIN_ACCOUNT);

      await goodClient.insert(globalKey, INT128_MAX.subn(1), 0);
      await goodClient.insert(userKey, INT128_MAX.subn(1), 0);
      await badClient.insert(globalKey, INT128_MAX.subn(1), 0);
      await badClient.insert(userKey, INT128_MAX.subn(1), 0);

      const rootHash = await goodClient.getRootHash();
      await fundColonyWithTokens(metaColony, clny, bigPayout.muln(4));
      await setupFinalizedTask({
        colonyNetwork,
        colony: metaColony,
        worker: MAIN_ACCOUNT,
        managerPayout: bigPayout,
        evaluatorPayout: bigPayout,
        workerPayout: bigPayout,
        managerRating: 3,
        workerRating: 3
      });

      await forwardTime(MINING_CYCLE_DURATION, this);
      await repCycle.submitRootHash(rootHash, 2, "0x00", 10, { from: MAIN_ACCOUNT });
      await repCycle.confirmNewHash(0);

      repCycle = await getActiveRepCycle(colonyNetwork);
      await submitAndForwardTimeToDispute([goodClient, badClient], this);
      await accommodateChallengeAndInvalidateHash(colonyNetwork, this, goodClient, badClient, {
        client2: { respondToChallenge: "colony-reputation-mining-reputation-not-max-int128" }
      });
      await repCycle.confirmNewHash(1);
    });

    it("should calculate reputation decays correctly if they are large", async () => {
      await giveUserCLNYTokensAndStake(colonyNetwork, OTHER_ACCOUNT, DEFAULT_STAKE);
      await advanceMiningCycleNoContest({ colonyNetwork, test: this });

      badClient = new MaliciousReputationMinerExtraRep({ loader, realProviderPort, useJsTree, minerAddress: OTHER_ACCOUNT }, 1, new BN("10"));
      await badClient.initialise(colonyNetwork.address);

      const rootGlobalSkill = await colonyNetwork.getRootGlobalSkillId();
      const globalKey = await ReputationMinerTestWrapper.getKey(metaColony.address, rootGlobalSkill, ZERO_ADDRESS);
      const userKey = await ReputationMinerTestWrapper.getKey(metaColony.address, rootGlobalSkill, MAIN_ACCOUNT);

      await goodClient.insert(globalKey, INT128_MAX.subn(1), 0);
      await goodClient.insert(userKey, INT128_MAX.subn(1), 0);
      await badClient.insert(globalKey, INT128_MAX.subn(1), 0);
      await badClient.insert(userKey, INT128_MAX.subn(1), 0);

      const rootHash = await goodClient.getRootHash();
      let repCycle = await getActiveRepCycle(colonyNetwork);
      await forwardTime(MINING_CYCLE_DURATION, this);
      await repCycle.submitRootHash(rootHash, 2, "0x00", 10, { from: MAIN_ACCOUNT });
      await repCycle.confirmNewHash(0);

      repCycle = await getActiveRepCycle(colonyNetwork);
      await submitAndForwardTimeToDispute([goodClient, badClient], this);
      await accommodateChallengeAndInvalidateHash(colonyNetwork, this, goodClient, badClient, {
        client2: { respondToChallenge: "colony-reputation-mining-decay-incorrect" }
      });
      await repCycle.confirmNewHash(1);

      const largeCalculationResult = INT128_MAX.subn(1)
        .mul(DECAY_RATE.NUMERATOR)
        .div(DECAY_RATE.DENOMINATOR);
      const decayKey = await ReputationMinerTestWrapper.getKey(metaColony.address, rootGlobalSkill, MAIN_ACCOUNT);
      const decimalValueDecay = new BN(goodClient.reputations[decayKey].slice(2, 66), 16);

      assert.equal(
        largeCalculationResult.toString(16, 64),
        goodClient.reputations[decayKey].slice(2, 66),
        `Incorrect decay. Actual value is ${decimalValueDecay}`
      );
    });

    it("should keep reputation updates that occur during one update window for the next window", async () => {
      // Creates an entry in the reputation log for the worker and manager
      await fundColonyWithTokens(metaColony, clny);
      await setupFinalizedTask({ colonyNetwork, colony: metaColony });

      let addr = await colonyNetwork.getReputationMiningCycle(false);
      let inactiveReputationMiningCycle = await IReputationMiningCycle.at(addr);
      const initialRepLogLength = await inactiveReputationMiningCycle.getReputationUpdateLogLength();

      await advanceMiningCycleNoContest({ colonyNetwork, test: this });

      // This confirmation should freeze the reputation log that we added the above task entries to and move it to the inactive rep log
      const repCycle = await getActiveRepCycle(colonyNetwork);
      assert.equal(inactiveReputationMiningCycle.address, repCycle.address);

      const finalRepLogLength = await repCycle.getReputationUpdateLogLength();
      assert.equal(finalRepLogLength.toNumber(), initialRepLogLength.toNumber());

      // Check the active log now has one entry in it (which will be the rewards for the miner who submitted
      // the accepted hash.
      addr = await colonyNetwork.getReputationMiningCycle(false);
      inactiveReputationMiningCycle = await IReputationMiningCycle.at(addr);

      const activeRepLogLength = await inactiveReputationMiningCycle.getReputationUpdateLogLength();
      assert.equal(activeRepLogLength.toNumber(), 1);
    });

    it("should insert reputation updates from the log", async () => {
      await fundColonyWithTokens(metaColony, clny, INITIAL_FUNDING.muln(3));
      await setupFinalizedTask({ colonyNetwork, colony: metaColony });
      await setupFinalizedTask({ colonyNetwork, colony: metaColony });
      await setupFinalizedTask({ colonyNetwork, colony: metaColony });

      await setupFinalizedTask({
        colonyNetwork,
        colony: metaColony,
        skillId: 4,
        managerPayout: 1000000000000,
        evaluatorPayout: 1000000000,
        workerPayout: 5000000000000,
        managerRating: 1,
        workerRating: 1,
        evaluator: EVALUATOR,
        worker: accounts[3]
      });

      await advanceMiningCycleNoContest({ colonyNetwork, test: this });

      // Should be 17 updates: 1 for the previous mining cycle and 4x4 for the tasks.
      const repCycle = await getActiveRepCycle(colonyNetwork);
      const activeLogEntries = await repCycle.getReputationUpdateLogLength();
      assert.equal(activeLogEntries.toNumber(), 17);

      await goodClient.resetDB();
      await advanceMiningCycleNoContest({ colonyNetwork, test: this, client: goodClient });
      assert.equal(Object.keys(goodClient.reputations).length, 27);

      const GLOBAL_SKILL = new BN(1);
      const META_ROOT_SKILL = new BN(2);
      const MINING_SKILL = new BN(3);

      const META_ROOT_SKILL_TOTAL = REWARD.add(
        MANAGER_PAYOUT.add(EVALUATOR_PAYOUT)
          .add(WORKER_PAYOUT)
          .muln(3)
      )
        .add(new BN(1000000000))
        .sub(new BN(1000000000000))
        .sub(new BN(5000000000000));

      const reputationProps = [
        { id: 1, skill: META_ROOT_SKILL, account: undefined, value: META_ROOT_SKILL_TOTAL },
        { id: 2, skill: MINING_SKILL, account: undefined, value: REWARD },
        { id: 3, skill: META_ROOT_SKILL, account: MAIN_ACCOUNT, value: REWARD },
        { id: 4, skill: MINING_SKILL, account: MAIN_ACCOUNT, value: REWARD },
        // Completing 3 standard tasks
        {
          id: 5,
          skill: META_ROOT_SKILL,
          account: MANAGER,
          value: MANAGER_PAYOUT.add(EVALUATOR_PAYOUT)
            .muln(3)
            .sub(new BN(1000000000000))
        },
        { id: 6, skill: META_ROOT_SKILL, account: WORKER, value: WORKER_PAYOUT.muln(3) },
        // TODO: This next check needs to be updated once colony wide reputation is fixed for child updates
        // It needs to NOT deduct anything from the global skill rep as the user had 0 rep in the child skill
        { id: 7, skill: GLOBAL_SKILL, account: undefined, value: WORKER_PAYOUT.muln(3).sub(new BN(5000000000000)) },
        { id: 8, skill: GLOBAL_SKILL, account: WORKER, value: WORKER_PAYOUT.muln(3) },
        // Completing a task in skill 4
        { id: 9, skill: MINING_SKILL, account: MANAGER, value: new BN(0) },
        { id: 10, skill: META_ROOT_SKILL, account: EVALUATOR, value: new BN(1000000000) },
        { id: 11, skill: MINING_SKILL, account: accounts[3], value: new BN(0) },
        { id: 12, skill: META_ROOT_SKILL, account: accounts[3], value: new BN(0) },
        { id: 13, skill: new BN(5), account: undefined, value: new BN(0) },
        { id: 14, skill: new BN(6), account: undefined, value: new BN(0) },
        { id: 15, skill: new BN(7), account: undefined, value: new BN(0) },
        { id: 16, skill: new BN(8), account: undefined, value: new BN(0) },
        { id: 17, skill: new BN(9), account: undefined, value: new BN(0) },
        { id: 18, skill: new BN(10), account: undefined, value: new BN(0) },
        { id: 19, skill: new BN(4), account: undefined, value: new BN(0) },
        { id: 20, skill: new BN(5), account: accounts[3], value: new BN(0) },
        { id: 21, skill: new BN(6), account: accounts[3], value: new BN(0) },
        { id: 22, skill: new BN(7), account: accounts[3], value: new BN(0) },
        { id: 23, skill: new BN(8), account: accounts[3], value: new BN(0) },
        { id: 24, skill: new BN(9), account: accounts[3], value: new BN(0) },
        { id: 25, skill: new BN(10), account: accounts[3], value: new BN(0) },
        { id: 26, skill: GLOBAL_SKILL, account: accounts[3], value: new BN(0) },
        { id: 27, skill: new BN(4), account: accounts[3], value: new BN(0) }
      ];

      reputationProps.forEach(reputationProp => {
        const key = makeReputationKey(metaColony.address, reputationProp.skill, reputationProp.account);
        const value = makeReputationValue(reputationProp.value, reputationProp.id);
        const decimalValue = new BN(goodClient.reputations[key].slice(2, 66), 16);
        assert.equal(goodClient.reputations[key], value.toString(), `${reputationProp.id} failed. Actual value is ${decimalValue}`);
      });
    });

    it("should correctly update child reputations", async () => {
      await giveUserCLNYTokensAndStake(colonyNetwork, MAIN_ACCOUNT, DEFAULT_STAKE);

      await fundColonyWithTokens(metaColony, clny, INITIAL_FUNDING);
      await setupFinalizedTask({ colonyNetwork, colony: metaColony });

      // Earn some reputation for manager and worker in first task, then do badly in second task and lose some of it
      await setupFinalizedTask({
        colonyNetwork,
        colony: metaColony,
        skillId: 10,
        evaluator: EVALUATOR,
        managerPayout: 1000000000000,
        evaluatorPayout: 1000000000,
        workerPayout: 5000000000000,
        managerRating: 3,
        workerRating: 3
      });

      await setupFinalizedTask({
        colonyNetwork,
        colony: metaColony,
        skillId: 8,
        evaluator: EVALUATOR,
        managerPayout: 1000000000000,
        evaluatorPayout: 1000000000,
        workerPayout: 4200000000000,
        managerRating: 2,
        workerRating: 1
      });

      await advanceMiningCycleNoContest({ colonyNetwork, test: this });

      // Should be 13 updates: 1 for the previous mining cycle and 3x4 for the tasks.
      const repCycle = await getActiveRepCycle(colonyNetwork);
      const nInactiveLogEntries = await repCycle.getReputationUpdateLogLength();
      assert.equal(nInactiveLogEntries.toNumber(), 13);

      await advanceMiningCycleNoContest({ colonyNetwork, test: this, client: goodClient });
      assert.equal(Object.keys(goodClient.reputations).length, 24);

      const GLOBAL_SKILL = new BN(1);
      const META_ROOT_SKILL = new BN(2);
      const MINING_SKILL = new BN(3);

      // = 1550000005802000000000
      const META_ROOT_SKILL_TOTAL = REWARD.add(MANAGER_PAYOUT)
        .add(EVALUATOR_PAYOUT)
        .add(WORKER_PAYOUT)
        .add(new BN(2500000000000)) // for last 2 tasks manager payouts = 1000000000000*1.5 + 1000000000000
        .add(new BN(2000000000)) // for last 2 tasks evaluator payouts = 1000000000 + 1000000000
        .add(new BN(3300000000000)); // for task worker payout = 5000000000000*1.5
      // deduct the worker payout from the poorly performed task -4200000000000
      // = 3300000000000

      const reputationProps = [
        { id: 1, skill: META_ROOT_SKILL, account: undefined, value: META_ROOT_SKILL_TOTAL },
        { id: 2, skill: MINING_SKILL, account: undefined, value: REWARD },
        { id: 3, skill: META_ROOT_SKILL, account: MAIN_ACCOUNT, value: REWARD },
        { id: 4, skill: MINING_SKILL, account: MAIN_ACCOUNT, value: REWARD },
        { id: 5, skill: META_ROOT_SKILL, account: MANAGER, value: MANAGER_PAYOUT.add(EVALUATOR_PAYOUT).add(new BN(2500000000000)) },
        { id: 6, skill: META_ROOT_SKILL, account: WORKER, value: WORKER_PAYOUT.add(new BN(3300000000000)) },
        { id: 7, skill: GLOBAL_SKILL, account: undefined, value: WORKER_PAYOUT.add(new BN(3300000000000)) },
        { id: 8, skill: GLOBAL_SKILL, account: WORKER, value: WORKER_PAYOUT.add(new BN(3300000000000)) },
        { id: 9, skill: META_ROOT_SKILL, account: EVALUATOR, value: new BN(2000000000) },
        { id: 10, skill: new BN(9), account: undefined, value: new BN(3300000000000) },
        { id: 11, skill: new BN(8), account: undefined, value: new BN(3300000000000) },
        { id: 12, skill: new BN(7), account: undefined, value: new BN(3300000000000) },
        { id: 13, skill: new BN(6), account: undefined, value: new BN(3300000000000) },
        { id: 14, skill: new BN(5), account: undefined, value: new BN(3300000000000) },
        { id: 15, skill: new BN(4), account: undefined, value: new BN(3300000000000) },
        { id: 16, skill: new BN(10), account: undefined, value: new BN(3300000000000) },
        { id: 17, skill: new BN(9), account: WORKER, value: new BN(3300000000000) },
        { id: 18, skill: new BN(8), account: WORKER, value: new BN(3300000000000) }, // 44% decrease
        { id: 19, skill: new BN(7), account: WORKER, value: new BN(3300000000000) },
        { id: 20, skill: new BN(6), account: WORKER, value: new BN(3300000000000) },
        { id: 21, skill: new BN(5), account: WORKER, value: new BN(3300000000000) },
        { id: 22, skill: new BN(4), account: WORKER, value: new BN(3300000000000) },
        { id: 23, skill: new BN(10), account: WORKER, value: new BN(3300000000000) },
        { id: 24, skill: MINING_SKILL, account: WORKER, value: 0 }
      ];

      reputationProps.forEach(reputationProp => {
        const key = makeReputationKey(metaColony.address, reputationProp.skill, reputationProp.account);
        const value = makeReputationValue(reputationProp.value, reputationProp.id);
        const decimalValue = new BN(goodClient.reputations[key].slice(2, 66), 16);
        assert.equal(goodClient.reputations[key], value.toString(), `${reputationProp.id} failed. Actual value is ${decimalValue}`);
      });
    });

    it("should correctly update parent reputations", async () => {
      // Make sure there's funding for the task
      await fundColonyWithTokens(metaColony, clny);

      // Do the task
      await setupFinalizedTask({
        colonyNetwork,
        colony: metaColony,
        skillId: 10,
        manager: MANAGER,
        evaluator: EVALUATOR,
        worker: WORKER
      });

      await advanceMiningCycleNoContest({ colonyNetwork, test: this });

      // Should be 5 updates: 1 for the previous mining cycle and 4 for the task.
      // The update log should contain the person being rewarded for the previous update cycle,
      // and 2x4 reputation updates for the task completions (manager, worker (domain and skill), evaluator);
      // That's 9 in total.
      const repCycle = await getActiveRepCycle(colonyNetwork);
      const activeLogEntries = await repCycle.getReputationUpdateLogLength();
      assert.equal(activeLogEntries.toNumber(), 5);

      await goodClient.addLogContentsToReputationTree();

      const META_ROOT_SKILL = 2;
      const MINING_SKILL = 3;

      const reputationProps = [
        { id: 1, skillId: META_ROOT_SKILL, account: undefined, value: REWARD.add(MANAGER_PAYOUT).add(EVALUATOR_PAYOUT).add(WORKER_PAYOUT) }, // eslint-disable-line prettier/prettier
        { id: 2, skillId: MINING_SKILL, account: undefined, value: REWARD },
        { id: 3, skillId: META_ROOT_SKILL, account: MAIN_ACCOUNT, value: REWARD },
        { id: 4, skillId: MINING_SKILL, account: MAIN_ACCOUNT, value: REWARD },

        { id: 5, skillId: META_ROOT_SKILL, account: MANAGER, value: MANAGER_PAYOUT },
        { id: 6, skillId: META_ROOT_SKILL, account: EVALUATOR, value: EVALUATOR_PAYOUT },
        { id: 7, skillId: META_ROOT_SKILL, account: WORKER, value: WORKER_PAYOUT },

        { id: 8, skillId: 9, account: undefined, value: WORKER_PAYOUT },
        { id: 9, skillId: 8, account: undefined, value: WORKER_PAYOUT },
        { id: 10, skillId: 7, account: undefined, value: WORKER_PAYOUT },
        { id: 11, skillId: 6, account: undefined, value: WORKER_PAYOUT },
        { id: 12, skillId: 5, account: undefined, value: WORKER_PAYOUT },
        { id: 13, skillId: 4, account: undefined, value: WORKER_PAYOUT },
        { id: 14, skillId: 1, account: undefined, value: WORKER_PAYOUT },
        { id: 15, skillId: 10, account: undefined, value: WORKER_PAYOUT },

        { id: 16, skillId: 9, account: WORKER, value: WORKER_PAYOUT },
        { id: 17, skillId: 8, account: WORKER, value: WORKER_PAYOUT },
        { id: 18, skillId: 7, account: WORKER, value: WORKER_PAYOUT },
        { id: 19, skillId: 6, account: WORKER, value: WORKER_PAYOUT },
        { id: 20, skillId: 5, account: WORKER, value: WORKER_PAYOUT },
        { id: 21, skillId: 4, account: WORKER, value: WORKER_PAYOUT },
        { id: 22, skillId: 1, account: WORKER, value: WORKER_PAYOUT },
        { id: 23, skillId: 10, account: WORKER, value: WORKER_PAYOUT }
      ];

      assert.equal(Object.keys(goodClient.reputations).length, reputationProps.length);

      reputationProps.forEach(reputationProp => {
        const key = makeReputationKey(metaColony.address, new BN(reputationProp.skillId), reputationProp.account);
        const value = makeReputationValue(reputationProp.value, reputationProp.id);
        const decimalValue = new BN(goodClient.reputations[key].slice(2, 66), 16);
        assert.equal(goodClient.reputations[key], value, `${reputationProp.id} failed. Actual value is ${decimalValue}`);
      });
    });

    it("should cope if the wrong reputation transition is a distant parent", async () => {
      await metaColony.addGlobalSkill(1);
      await metaColony.addGlobalSkill(4);
      await metaColony.addGlobalSkill(5);
      await metaColony.addGlobalSkill(6);
      await metaColony.addGlobalSkill(7);
      await metaColony.addGlobalSkill(8);
      await metaColony.addGlobalSkill(9);

      // 1 -> 4 -> 5 -> 6 -> 7 -> 8 -> 9 -> 10

      await giveUserCLNYTokensAndStake(colonyNetwork, OTHER_ACCOUNT, DEFAULT_STAKE);

      await fundColonyWithTokens(metaColony, clny, INITIAL_FUNDING.muln(3));
      await setupFinalizedTask({ colonyNetwork, colony: metaColony });
      await setupFinalizedTask({ colonyNetwork, colony: metaColony });
      await setupFinalizedTask({ colonyNetwork, colony: metaColony, skillId: 10 });

      await advanceMiningCycleNoContest({ colonyNetwork, test: this });

      // Should be 13 updates: 1 for the previous mining cycle and 3x4 for the tasks.
      const repCycle = await getActiveRepCycle(colonyNetwork);
      const nInactiveLogEntries = await repCycle.getReputationUpdateLogLength();
      assert.equal(nInactiveLogEntries.toNumber(), 13);

      // Skill 4
      badClient = new MaliciousReputationMinerExtraRep({ loader, realProviderPort, useJsTree, minerAddress: OTHER_ACCOUNT }, 40, 0xfffffffff);
      await badClient.initialise(colonyNetwork.address);

      await submitAndForwardTimeToDispute([goodClient, badClient], this);

      const righthash = await goodClient.getRootHash();
      const wronghash = await badClient.getRootHash();
      assert.notEqual(righthash, wronghash, "Hashes from clients are equal, surprisingly");

      await accommodateChallengeAndInvalidateHash(colonyNetwork, this, goodClient, badClient, {
        client2: { respondToChallenge: "colony-reputation-mining-increased-reputation-value-incorrect" }
      });
      await repCycle.confirmNewHash(1);
    });

    it("should allow a user to prove their reputation", async () => {
      await advanceMiningCycleNoContest({ colonyNetwork, test: this });

      await goodClient.addLogContentsToReputationTree();
      const newRootHash = await goodClient.getRootHash();

      await forwardTime(MINING_CYCLE_DURATION, this);
      const repCycle = await getActiveRepCycle(colonyNetwork);

      await repCycle.submitRootHash(newRootHash, 10, "0x00", 10, { from: MAIN_ACCOUNT });
      await repCycle.confirmNewHash(0);

      const key = makeReputationKey(metaColony.address, new BN("2"), MAIN_ACCOUNT);
      const value = goodClient.reputations[key];
      const [branchMask, siblings] = await goodClient.getProof(key);
      const isValid = await metaColony.verifyReputationProof(key, value, branchMask, siblings, { from: MAIN_ACCOUNT });
      assert.isTrue(isValid);
    });

    it("should correctly decay a reputation to zero, and then 'decay' to zero in subsequent cycles", async () => {
      await giveUserCLNYTokensAndStake(colonyNetwork, OTHER_ACCOUNT, DEFAULT_STAKE);
      await advanceMiningCycleNoContest({ colonyNetwork, test: this });

      badClient = new MaliciousReputationMinerExtraRep({ loader, realProviderPort, useJsTree, minerAddress: OTHER_ACCOUNT }, 1, new BN("10"));
      await badClient.initialise(colonyNetwork.address);

      const rootGlobalSkill = await colonyNetwork.getRootGlobalSkillId();
      const globalKey = await ReputationMinerTestWrapper.getKey(metaColony.address, rootGlobalSkill, ZERO_ADDRESS);
      const userKey = await ReputationMinerTestWrapper.getKey(metaColony.address, rootGlobalSkill, MAIN_ACCOUNT);

      await goodClient.insert(globalKey, new BN("1"), 0);
      await goodClient.insert(userKey, new BN("1"), 0);
      await badClient.insert(globalKey, new BN("1"), 0);
      await badClient.insert(userKey, new BN("1"), 0);

      const rootHash = await goodClient.getRootHash();

      await forwardTime(MINING_CYCLE_DURATION, this);
      let repCycle = await getActiveRepCycle(colonyNetwork);
      await repCycle.submitRootHash(rootHash, 2, "0x00", 10, { from: MAIN_ACCOUNT });
      await repCycle.confirmNewHash(0);

      const decayKey = await ReputationMinerTestWrapper.getKey(metaColony.address, rootGlobalSkill, MAIN_ACCOUNT);

      // Check we have exactly one reputation.
      assert.equal(
        "0x00000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000002",
        goodClient.reputations[decayKey]
      );

      repCycle = await getActiveRepCycle(colonyNetwork);
      await submitAndForwardTimeToDispute([goodClient, badClient], this);

      await goodClient.confirmJustificationRootHash();
      await badClient.confirmJustificationRootHash();

      await accommodateChallengeAndInvalidateHash(colonyNetwork, this, goodClient, badClient, {
        client2: { respondToChallenge: "colony-reputation-mining-decay-incorrect" }
      });
      await repCycle.confirmNewHash(1);

      await giveUserCLNYTokensAndStake(colonyNetwork, OTHER_ACCOUNT, DEFAULT_STAKE);

      // Check it decayed from 1 to 0.
      assert.equal(
        "0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002",
        goodClient.reputations[decayKey]
      );

      // If we use the existing badClient we get `Error: invalid BigNumber value`, not sure why.
      badClient = new MaliciousReputationMinerExtraRep({ loader, realProviderPort, useJsTree, minerAddress: OTHER_ACCOUNT }, 1, new BN("10"));
      await badClient.initialise(colonyNetwork.address);

      const keys = Object.keys(goodClient.reputations);
      for (let i = 0; i < keys.length; i += 1) {
        const key = keys[i];
        const value = goodClient.reputations[key];
        const score = new BN(value.slice(2, 66), 16);
        await badClient.insert(key, score, 0);
      }

      await submitAndForwardTimeToDispute([goodClient, badClient], this);
      await accommodateChallengeAndInvalidateHash(colonyNetwork, this, goodClient, badClient, {
        client2: { respondToChallenge: "colony-reputation-mining-decay-incorrect" }
      });

      repCycle = await getActiveRepCycle(colonyNetwork);
      await repCycle.confirmNewHash(1);

      // Check it 'decayed' from 0 to 0
      assert.equal(
        "0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002",
        goodClient.reputations[decayKey]
      );
    });

    it.skip("should abort if a deposit did not complete correctly");
  });
});
