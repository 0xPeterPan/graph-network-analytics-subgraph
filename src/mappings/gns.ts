import { BigDecimal, BigInt, Bytes, ipfs, json } from '@graphprotocol/graph-ts'
import {
  SubgraphPublished,
  SubgraphDeprecated,
  NameSignalEnabled,
  NSignalMinted,
  NSignalBurned,
  NameSignalUpgrade,
  NameSignalDisabled,
  GRTWithdrawn,
  SubgraphMetadataUpdated,
  SetDefaultName,
  SubgraphPublished1,
  SubgraphDeprecated1,
  SubgraphMetadataUpdated1,
  SignalMinted,
  SignalBurned,
  GRTWithdrawn1,
  SubgraphUpgraded,
  SubgraphVersionUpdated,
  LegacySubgraphClaimed,
} from '../types/GNS/GNS'

import {
  Subgraph,
  SubgraphVersion,
  NameSignalTransaction,
  Curator,
  Delegator,
  Indexer,
  GraphAccountName,
  SubgraphDeployment,
} from '../types/schema'

import { jsonToString, zeroBD } from './utils'
import {
  createOrLoadSubgraphDeployment,
  createOrLoadGraphAccount,
  createOrLoadCurator,
  addQm,
  resolveName,
  createOrLoadSubgraph,
  joinID,
  createOrLoadNameSignal,
  getSubgraphID,
  convertBigIntSubgraphIDToBase58,
} from './helpers'

export function handleSetDefaultName(event: SetDefaultName): void {
  let graphAccount = createOrLoadGraphAccount(
    event.params.graphAccount.toHexString(),
    event.block.timestamp,
  )

  if (graphAccount.defaultName != null) {
    let graphAccountName = GraphAccountName.load(graphAccount.defaultName!)!
    // If trying to set the same name, do nothing
    if (graphAccountName.name == event.params.name) {
      return
    }

    // A user is resetting their name. This is done by passing nameIdentifier = bytes32(0)
    // String can be anything, but in front end we should just do a blank string
    if (
      event.params.nameIdentifier.toHex() ==
      '0x0000000000000000000000000000000000000000000000000000000000000000'
    ) {
      graphAccountName.graphAccount = null
      graphAccountName.save()

      graphAccount.defaultName = null
      graphAccount.defaultDisplayName = null
      graphAccount.save()

      let indexer = Indexer.load(event.params.graphAccount.toHexString())!
      if (indexer != null) {
        indexer.defaultDisplayName = graphAccount.defaultDisplayName
        indexer.save()
      }

      let delegator = Delegator.load(event.params.graphAccount.toHexString())!
      if (delegator != null) {
        delegator.defaultDisplayName = graphAccount.defaultDisplayName
        delegator.save()
      }
    }
  }

  let newDefaultName = resolveName(
    event.params.graphAccount,
    event.params.name,
    event.params.nameIdentifier,
  )

  // Edge case - a user sets a correct ID, and then sets an incorrect ID. It should not overwrite
  // the good name with null
  if (newDefaultName != null) {
    graphAccount.defaultName = newDefaultName
    graphAccount.defaultDisplayName = event.params.name

    // And if the GraphAccount changes default name, we should change it on the indexer too.
    // Indexer also has a defaultDisplayName because it helps with filtering.
    let userAddress = event.params.graphAccount.toHexString()

    let indexer = Indexer.load(userAddress)!
    if (indexer != null) {
      indexer.defaultDisplayName = graphAccount.defaultDisplayName
      indexer.save()
    }

    let delegator = Delegator.load(userAddress)!
    if (delegator != null) {
      delegator.defaultDisplayName = graphAccount.defaultDisplayName
      delegator.save()
    }
  }
  graphAccount.save()
}

export function handleSubgraphMetadataUpdated(event: SubgraphMetadataUpdated): void {
  let subgraphID = getSubgraphID(event.params.graphAccount, event.params.subgraphNumber)
  let subgraph = createOrLoadSubgraph(subgraphID, event.params.graphAccount, event.block.timestamp)

  let hexHash = addQm(event.params.subgraphMetadata) as Bytes
  let base58Hash = hexHash.toBase58()
  subgraph.metadataHash = event.params.subgraphMetadata
  subgraph.updatedAt = event.block.timestamp.toI32()
  subgraph.save()
}

/**
 * @dev handleSubgraphPublished - Publishes a SubgraphVersion. If it is the first SubgraphVersion,
 * it will also create the Subgraph
 * - Updates subgraph, creates if needed
 * - Creates subgraph version
 * - Creates subgraph deployment, if needed
 * - creates graph account, if needed
 */
export function handleSubgraphPublished(event: SubgraphPublished): void {
  let subgraphID = getSubgraphID(event.params.graphAccount, event.params.subgraphNumber)
  let versionID: string
  let versionNumber: number

  // Update subgraph
  let subgraph = createOrLoadSubgraph(subgraphID, event.params.graphAccount, event.block.timestamp)

  versionID = joinID([subgraph.id, subgraph.versionCount.toString()])
  subgraph.creatorAddress = changetype<Bytes>(event.params.graphAccount)
  subgraph.subgraphNumber = event.params.subgraphNumber
  subgraph.oldID = joinID([
    event.params.graphAccount.toHexString(),
    event.params.subgraphNumber.toString(),
  ])
  subgraph.currentVersion = versionID
  subgraph.versionCount = subgraph.versionCount.plus(BigInt.fromI32(1))

  // Creates Graph Account, if needed
  createOrLoadGraphAccount(event.params.graphAccount.toHexString(), event.block.timestamp)
  subgraph.updatedAt = event.block.timestamp.toI32()
  subgraph.save()

  // Create subgraph deployment, if needed. Can happen if the deployment has never been staked on
  let subgraphDeploymentID = event.params.subgraphDeploymentID.toHexString()
  let deployment = createOrLoadSubgraphDeployment(subgraphDeploymentID, event.block.timestamp)

  // Create subgraph version
  let subgraphVersion = new SubgraphVersion(versionID)
  subgraphVersion.subgraph = subgraph.id
  subgraphVersion.subgraphDeployment = subgraphDeploymentID
  subgraphVersion.version = versionNumber as i32
  subgraphVersion.createdAt = event.block.timestamp.toI32()
  let hexHash = changetype<Bytes>(addQm(event.params.versionMetadata))
  let base58Hash = hexHash.toBase58()
  subgraphVersion.metadataHash = event.params.versionMetadata
  //subgraphVersion = fetchSubgraphVersionMetadata(subgraphVersion, base58Hash)
  subgraphVersion.save()
}
/**
 * @dev handleSubgraphDeprecated
 * - updates subgraph to have no version and no name
 * - deprecates subgraph version
 */
export function handleSubgraphDeprecated(event: SubgraphDeprecated): void {
  let bigIntID = getSubgraphID(event.params.graphAccount, event.params.subgraphNumber)
  let subgraphID = convertBigIntSubgraphIDToBase58(bigIntID)
  let subgraph = Subgraph.load(subgraphID)!

  subgraph.active = false
  subgraph.updatedAt = event.block.timestamp.toI32()
  subgraph.save()
}

export function handleNameSignalEnabled(event: NameSignalEnabled): void {
  let bigIntID = getSubgraphID(event.params.graphAccount, event.params.subgraphNumber)
  let subgraphID = convertBigIntSubgraphIDToBase58(bigIntID)
  let subgraph = Subgraph.load(subgraphID)!

  // Right now we set deploymentID in SubgraphPublished, so only this is needed
  subgraph.reserveRatio = event.params.reserveRatio.toI32()
  subgraph.save()
}

export function handleNSignalMinted(event: NSignalMinted): void {
  let curatorID = event.params.nameCurator.toHexString()
  let bigIntID = getSubgraphID(event.params.graphAccount, event.params.subgraphNumber)
  let subgraphID = convertBigIntSubgraphIDToBase58(bigIntID)
  let subgraph = Subgraph.load(subgraphID)!

  subgraph.nameSignalAmount = subgraph.nameSignalAmount.plus(event.params.nSignalCreated)
  subgraph.signalledTokens = subgraph.signalledTokens.plus(event.params.tokensDeposited)
  subgraph.save()

  let nameSignal = createOrLoadNameSignal(
    event.params.nameCurator.toHexString(),
    subgraphID,
    event.block.timestamp,
  )
  nameSignal.nameSignal = nameSignal.nameSignal.plus(event.params.nSignalCreated)
  nameSignal.signalledTokens = nameSignal.signalledTokens.plus(event.params.tokensDeposited)
  nameSignal.lastNameSignalChange = event.block.timestamp.toI32()
  nameSignal.averageCostBasis = nameSignal.averageCostBasis.plus(
    event.params.tokensDeposited.toBigDecimal(),
  )

  // zero division protection
  if (nameSignal.nameSignal.toBigDecimal() != zeroBD) {
    nameSignal.averageCostBasisPerSignal = nameSignal.averageCostBasis.div(
      nameSignal.nameSignal.toBigDecimal(),
    )
  }
  nameSignal.save()

  // Update the curator
  let curator = createOrLoadCurator(event.params.nameCurator.toHexString(), event.block.timestamp)
  curator.totalNameSignalledTokens = curator.totalNameSignalledTokens.plus(
    event.params.tokensDeposited,
  )
  curator.totalNameSignalAverageCostBasis = curator.totalNameSignalAverageCostBasis.plus(
    event.params.tokensDeposited.toBigDecimal(),
  )
  curator.totalNameSignal = curator.totalNameSignal.plus(event.params.nSignalCreated.toBigDecimal())

  // zero division protection
  if (curator.totalNameSignal != zeroBD) {
    curator.totalAverageCostBasisPerNameSignal = curator.totalNameSignalAverageCostBasis.div(
      curator.totalNameSignal,
    )
  }
  curator.save()

  // Create n signal tx
  let nSignalTransaction = new NameSignalTransaction(
    event.transaction.hash.toHexString().concat('-').concat(event.logIndex.toString()),
  )
  nSignalTransaction.blockNumber = event.block.number.toI32()
  nSignalTransaction.timestamp = event.block.timestamp.toI32()
  nSignalTransaction.signer = event.params.nameCurator.toHexString()
  nSignalTransaction.type = 'MintNSignal'
  nSignalTransaction.nameSignal = event.params.nSignalCreated
  nSignalTransaction.versionSignal = event.params.vSignalCreated
  nSignalTransaction.tokens = event.params.tokensDeposited
  nSignalTransaction.subgraph = subgraphID
  nSignalTransaction.save()
}

export function handleNSignalBurned(event: NSignalBurned): void {
  let bigIntID = getSubgraphID(event.params.graphAccount, event.params.subgraphNumber)
  let subgraphID = convertBigIntSubgraphIDToBase58(bigIntID)
  let subgraph = Subgraph.load(subgraphID)!

  subgraph.nameSignalAmount = subgraph.nameSignalAmount.minus(event.params.nSignalBurnt)
  subgraph.unsignalledTokens = subgraph.unsignalledTokens.plus(event.params.tokensReceived)
  subgraph.save()

  // update name signal
  let nameSignal = createOrLoadNameSignal(
    event.params.nameCurator.toHexString(),
    subgraphID,
    event.block.timestamp,
  )

  nameSignal.nameSignal = nameSignal.nameSignal.minus(event.params.nSignalBurnt)
  nameSignal.unsignalledTokens = nameSignal.unsignalledTokens.plus(event.params.tokensReceived)
  nameSignal.lastNameSignalChange = event.block.timestamp.toI32()

  // update acb to reflect new name signal balance
  let previousACB = nameSignal.averageCostBasis
  nameSignal.averageCostBasis = nameSignal.nameSignal
    .toBigDecimal()
    .times(nameSignal.averageCostBasisPerSignal)
  let diffACB = previousACB.minus(nameSignal.averageCostBasis)
  if (nameSignal.averageCostBasis == BigDecimal.fromString('0')) {
    nameSignal.averageCostBasisPerSignal = BigDecimal.fromString('0')
  }
  nameSignal.save()

  // update curator
  let curator = createOrLoadCurator(event.params.nameCurator.toHexString(), event.block.timestamp)
  curator.totalNameUnsignalledTokens = curator.totalNameUnsignalledTokens.plus(
    event.params.tokensReceived,
  )
  curator.totalNameSignal = curator.totalNameSignal.minus(event.params.nSignalBurnt.toBigDecimal())
  curator.totalNameSignalAverageCostBasis = curator.totalNameSignalAverageCostBasis.minus(diffACB)
  if (curator.totalNameSignal == BigDecimal.fromString('0')) {
    curator.totalAverageCostBasisPerNameSignal = BigDecimal.fromString('0')
  } else {
    curator.totalAverageCostBasisPerNameSignal = curator.totalNameSignalAverageCostBasis.div(
      curator.totalNameSignal,
    )
  }
  curator.save()

  // Create n signal tx
  let nSignalTransaction = new NameSignalTransaction(
    event.transaction.hash.toHexString().concat('-').concat(event.logIndex.toString()),
  )
  nSignalTransaction.blockNumber = event.block.number.toI32()
  nSignalTransaction.timestamp = event.block.timestamp.toI32()
  nSignalTransaction.signer = event.params.nameCurator.toHexString()
  nSignalTransaction.type = 'BurnNSignal'
  nSignalTransaction.nameSignal = event.params.nSignalBurnt
  nSignalTransaction.versionSignal = event.params.vSignalBurnt
  nSignalTransaction.tokens = event.params.tokensReceived
  nSignalTransaction.subgraph = subgraphID
  nSignalTransaction.save()
}

export function handleNameSignalUpgrade(event: NameSignalUpgrade): void {
  let bigIntID = getSubgraphID(event.params.graphAccount, event.params.subgraphNumber)
  let subgraphID = convertBigIntSubgraphIDToBase58(bigIntID)
  let subgraph = Subgraph.load(subgraphID)!

  // Weirdly here, we add the token amount to both, but also the name curator owner must
  // stake the withdrawal fees, so both balance fairly
  // TODO - will have to come back here and make sure my thinking is correct
  subgraph.unsignalledTokens = subgraph.unsignalledTokens.plus(event.params.tokensSignalled)
  subgraph.signalledTokens = subgraph.signalledTokens.plus(event.params.tokensSignalled)
  subgraph.save()
}

// Only need to upgrade withdrawable tokens. Everything else handled from
// curation events, or handleGRTWithdrawn
export function handleNameSignalDisabled(event: NameSignalDisabled): void {
  let bigIntID = getSubgraphID(event.params.graphAccount, event.params.subgraphNumber)
  let subgraphID = convertBigIntSubgraphIDToBase58(bigIntID)
  let subgraph = Subgraph.load(subgraphID)!
  subgraph.withdrawableTokens = event.params.withdrawableGRT
  subgraph.save()
}

export function handleGRTWithdrawn(event: GRTWithdrawn): void {
  let bigIntID = getSubgraphID(event.params.graphAccount, event.params.subgraphNumber)
  let subgraphID = convertBigIntSubgraphIDToBase58(bigIntID)
  let subgraph = Subgraph.load(subgraphID)!
  subgraph.withdrawableTokens = subgraph.withdrawableTokens.minus(event.params.withdrawnGRT)
  subgraph.withdrawnTokens = subgraph.withdrawnTokens.plus(event.params.withdrawnGRT)
  subgraph.nameSignalAmount = subgraph.nameSignalAmount.minus(event.params.nSignalBurnt)
  subgraph.save()

  let nameSignal = createOrLoadNameSignal(
    event.params.nameCurator.toHexString(),
    subgraphID,
    event.block.timestamp,
  )
  nameSignal.withdrawnTokens = event.params.withdrawnGRT
  nameSignal.nameSignal = nameSignal.nameSignal.minus(event.params.nSignalBurnt)
  nameSignal.lastNameSignalChange = event.block.timestamp.toI32()
  nameSignal.save()

  let curator = Curator.load(event.params.nameCurator.toHexString())!
  curator.totalWithdrawnTokens = curator.totalWithdrawnTokens.plus(event.params.withdrawnGRT)
  curator.save()
}

// - event: SubgraphPublished(indexed uint256,indexed bytes32,uint32)
//   handler: handleSubgraphPublishedV2

export function handleSubgraphPublishedV2(event: SubgraphPublished1): void {
  let bigIntID = event.params.subgraphID
  let subgraphID = convertBigIntSubgraphIDToBase58(bigIntID)
  let subgraph = Subgraph.load(subgraphID)!

  subgraph.reserveRatio = event.params.reserveRatio.toI32()
  subgraph.save()
}

// - event: SubgraphDeprecated(indexed uint256,uint256)
//   handler: handleSubgraphDeprecatedV2

export function handleSubgraphDeprecatedV2(event: SubgraphDeprecated1): void {
  let bigIntID = event.params.subgraphID
  let subgraphID = convertBigIntSubgraphIDToBase58(bigIntID)
  let subgraph = Subgraph.load(subgraphID)!

  subgraph.active = false
  subgraph.updatedAt = event.block.timestamp.toI32()
  subgraph.withdrawableTokens = event.params.withdrawableGRT
  subgraph.save()
}

// - event: SubgraphMetadataUpdated(indexed uint256,bytes32)
//   handler: handleSubgraphMetadataUpdatedV2

export function handleSubgraphMetadataUpdatedV2(event: SubgraphMetadataUpdated1): void {
  let bigIntID = event.params.subgraphID
  let subgraphID = convertBigIntSubgraphIDToBase58(bigIntID)
  let subgraph = Subgraph.load(subgraphID)!

  let hexHash = addQm(event.params.subgraphMetadata) as Bytes
  let base58Hash = hexHash.toBase58()
  subgraph.metadataHash = event.params.subgraphMetadata

  subgraph.updatedAt = event.block.timestamp.toI32()
  subgraph.save()
}

// - event: SignalMinted(indexed uint256,indexed address,uint256,uint256,uint256)
//   handler: handleNSignalMintedV2

export function handleNSignalMintedV2(event: SignalMinted): void {
  let curatorID = event.params.curator.toHexString()
  let bigIntID = event.params.subgraphID
  let subgraphID = convertBigIntSubgraphIDToBase58(bigIntID)
  let subgraph = Subgraph.load(subgraphID)!

  subgraph.nameSignalAmount = subgraph.nameSignalAmount.plus(event.params.nSignalCreated)
  subgraph.signalledTokens = subgraph.signalledTokens.plus(event.params.tokensDeposited)
  subgraph.save()

  let nameSignal = createOrLoadNameSignal(
    event.params.curator.toHexString(),
    subgraphID,
    event.block.timestamp,
  )
  nameSignal.nameSignal = nameSignal.nameSignal.plus(event.params.nSignalCreated)
  nameSignal.signalledTokens = nameSignal.signalledTokens.plus(event.params.tokensDeposited)
  nameSignal.lastNameSignalChange = event.block.timestamp.toI32()
  nameSignal.averageCostBasis = nameSignal.averageCostBasis.plus(
    event.params.tokensDeposited.toBigDecimal(),
  )

  // zero division protection
  if (nameSignal.nameSignal.toBigDecimal() != zeroBD) {
    nameSignal.averageCostBasisPerSignal = nameSignal.averageCostBasis.div(
      nameSignal.nameSignal.toBigDecimal(),
    )
  }
  nameSignal.save()

  // Update the curator
  let curator = createOrLoadCurator(event.params.curator.toHexString(), event.block.timestamp)
  curator.totalNameSignalledTokens = curator.totalNameSignalledTokens.plus(
    event.params.tokensDeposited,
  )
  curator.totalNameSignalAverageCostBasis = curator.totalNameSignalAverageCostBasis.plus(
    event.params.tokensDeposited.toBigDecimal(),
  )
  curator.totalNameSignal = curator.totalNameSignal.plus(event.params.nSignalCreated.toBigDecimal())

  // zero division protection
  if (curator.totalNameSignal != zeroBD) {
    curator.totalAverageCostBasisPerNameSignal = curator.totalNameSignalAverageCostBasis.div(
      curator.totalNameSignal,
    )
  }
  curator.save()

  // Create n signal tx
  let nSignalTransaction = new NameSignalTransaction(
    event.transaction.hash.toHexString().concat('-').concat(event.logIndex.toString()),
  )
  nSignalTransaction.blockNumber = event.block.number.toI32()
  nSignalTransaction.timestamp = event.block.timestamp.toI32()
  nSignalTransaction.signer = event.params.curator.toHexString()
  nSignalTransaction.type = 'MintNSignal'
  nSignalTransaction.nameSignal = event.params.nSignalCreated
  nSignalTransaction.versionSignal = event.params.vSignalCreated
  nSignalTransaction.tokens = event.params.tokensDeposited
  nSignalTransaction.subgraph = subgraphID
  nSignalTransaction.save()
}

// - event: SignalBurned(indexed uint256,indexed address,uint256,uint256,uint256)
//   handler: handleNSignalBurnedV2

export function handleNSignalBurnedV2(event: SignalBurned): void {
  let bigIntID = event.params.subgraphID
  let subgraphID = convertBigIntSubgraphIDToBase58(bigIntID)
  let subgraph = Subgraph.load(subgraphID)!

  subgraph.nameSignalAmount = subgraph.nameSignalAmount.minus(event.params.nSignalBurnt)
  subgraph.unsignalledTokens = subgraph.unsignalledTokens.plus(event.params.tokensReceived)
  subgraph.save()

  // update name signal
  let nameSignal = createOrLoadNameSignal(
    event.params.curator.toHexString(),
    subgraphID,
    event.block.timestamp,
  )

  nameSignal.nameSignal = nameSignal.nameSignal.minus(event.params.nSignalBurnt)
  nameSignal.unsignalledTokens = nameSignal.unsignalledTokens.plus(event.params.tokensReceived)
  nameSignal.lastNameSignalChange = event.block.timestamp.toI32()

  // update acb to reflect new name signal balance
  let previousACB = nameSignal.averageCostBasis
  nameSignal.averageCostBasis = nameSignal.nameSignal
    .toBigDecimal()
    .times(nameSignal.averageCostBasisPerSignal)
  let diffACB = previousACB.minus(nameSignal.averageCostBasis)
  if (nameSignal.averageCostBasis == BigDecimal.fromString('0')) {
    nameSignal.averageCostBasisPerSignal = BigDecimal.fromString('0')
  }
  nameSignal.save()

  // update curator
  let curator = createOrLoadCurator(event.params.curator.toHexString(), event.block.timestamp)
  curator.totalNameUnsignalledTokens = curator.totalNameUnsignalledTokens.plus(
    event.params.tokensReceived,
  )
  curator.totalNameSignal = curator.totalNameSignal.minus(event.params.nSignalBurnt.toBigDecimal())
  curator.totalNameSignalAverageCostBasis = curator.totalNameSignalAverageCostBasis.minus(diffACB)
  if (curator.totalNameSignal == BigDecimal.fromString('0')) {
    curator.totalAverageCostBasisPerNameSignal = BigDecimal.fromString('0')
  } else {
    curator.totalAverageCostBasisPerNameSignal = curator.totalNameSignalAverageCostBasis.div(
      curator.totalNameSignal,
    )
  }
  curator.save()

  // Create n signal tx
  let nSignalTransaction = new NameSignalTransaction(
    event.transaction.hash.toHexString().concat('-').concat(event.logIndex.toString()),
  )
  nSignalTransaction.blockNumber = event.block.number.toI32()
  nSignalTransaction.timestamp = event.block.timestamp.toI32()
  nSignalTransaction.signer = event.params.curator.toHexString()
  nSignalTransaction.type = 'BurnNSignal'
  nSignalTransaction.nameSignal = event.params.nSignalBurnt
  nSignalTransaction.versionSignal = event.params.vSignalBurnt
  nSignalTransaction.tokens = event.params.tokensReceived
  nSignalTransaction.subgraph = subgraphID
  nSignalTransaction.save()
}

// - event: GRTWithdrawn(indexed uint256,indexed address,uint256,uint256)
//   handler: handleGRTWithdrawnV2

export function handleGRTWithdrawnV2(event: GRTWithdrawn1): void {
  let bigIntID = event.params.subgraphID
  let subgraphID = convertBigIntSubgraphIDToBase58(bigIntID)
  let subgraph = Subgraph.load(subgraphID)!
  subgraph.withdrawableTokens = subgraph.withdrawableTokens.minus(event.params.withdrawnGRT)
  subgraph.withdrawnTokens = subgraph.withdrawnTokens.plus(event.params.withdrawnGRT)
  subgraph.nameSignalAmount = subgraph.nameSignalAmount.minus(event.params.nSignalBurnt)
  subgraph.save()

  let nameSignal = createOrLoadNameSignal(
    event.params.curator.toHexString(),
    subgraphID,
    event.block.timestamp,
  )
  nameSignal.withdrawnTokens = event.params.withdrawnGRT
  nameSignal.nameSignal = nameSignal.nameSignal.minus(event.params.nSignalBurnt)
  nameSignal.lastNameSignalChange = event.block.timestamp.toI32()
  nameSignal.save()

  let curator = Curator.load(event.params.curator.toHexString())!
  curator.totalWithdrawnTokens = curator.totalWithdrawnTokens.plus(event.params.withdrawnGRT)
  curator.save()
}

// - event: SubgraphUpgraded(indexed uint256,uint256,uint256,indexed bytes32)
//   handler: handleSubgraphUpgraded

export function handleSubgraphUpgraded(event: SubgraphUpgraded): void {
  let bigIntID = event.params.subgraphID
  let subgraphID = convertBigIntSubgraphIDToBase58(bigIntID)
  let subgraph = Subgraph.load(subgraphID)!

  // Weirdly here, we add the token amount to both, but also the name curator owner must
  // stake the withdrawal fees, so both balance fairly
  // TODO - will have to come back here and make sure my thinking is correct
  subgraph.unsignalledTokens = subgraph.unsignalledTokens.plus(event.params.tokensSignalled)
  subgraph.signalledTokens = subgraph.signalledTokens.plus(event.params.tokensSignalled)
  subgraph.save()
}

// - event: SubgraphVersionUpdated(indexed uint256,indexed bytes32,bytes32)
//   handler: handleSubgraphVersionUpdated

export function handleSubgraphVersionUpdated(event: SubgraphVersionUpdated): void {
  let bigIntID = event.params.subgraphID
  let subgraphID = convertBigIntSubgraphIDToBase58(bigIntID)
  let versionID: string
  let versionNumber: number

  // Update subgraph
  let subgraph = Subgraph.load(subgraphID)!
  versionID = joinID([subgraph.id, subgraph.versionCount.toString()])
  subgraph.currentVersion = versionID
  subgraph.versionCount = subgraph.versionCount.plus(BigInt.fromI32(1))
  subgraph.updatedAt = event.block.timestamp.toI32()
  subgraph.save()

  // Create subgraph deployment, if needed. Can happen if the deployment has never been staked on
  let subgraphDeploymentID = event.params.subgraphDeploymentID.toHexString()
  let deployment = createOrLoadSubgraphDeployment(subgraphDeploymentID, event.block.timestamp)

  // Create subgraph version
  let subgraphVersion = new SubgraphVersion(versionID)
  subgraphVersion.subgraph = subgraph.id
  subgraphVersion.subgraphDeployment = subgraphDeploymentID
  subgraphVersion.version = versionNumber as i32
  subgraphVersion.createdAt = event.block.timestamp.toI32()
  let hexHash = changetype<Bytes>(addQm(event.params.versionMetadata))
  let base58Hash = hexHash.toBase58()
  subgraphVersion.metadataHash = event.params.versionMetadata
  //subgraphVersion = fetchSubgraphVersionMetadata(subgraphVersion, base58Hash)
  subgraphVersion.save()
}

// - event: LegacySubgraphClaimed(indexed address,uint256)
//   handler: handleLegacySubgraphClaimed

export function handleLegacySubgraphClaimed(event: LegacySubgraphClaimed): void {
  let subgraphID = getSubgraphID(event.params.graphAccount, event.params.subgraphNumber)

  // Update subgraph
  let subgraph = createOrLoadSubgraph(subgraphID, event.params.graphAccount, event.block.timestamp)
  subgraph.migrated = true
  subgraph.save()
}
