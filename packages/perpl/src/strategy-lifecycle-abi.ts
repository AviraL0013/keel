// Pinned official Perpl SDK ABI, revision 01b9910761755b0a0d9c710c1ede62ab937daa7d.
// Full ABI SHA-256: 766fc81326bdf27f243ca582f65c3e2ff72bc639d88674876697a63ae1c47cb3.
import { parseAbi } from 'viem'

export const strategyLifecycleEvents = parseAbi([
  'event ClearingExpiredOrder(uint256 perpId,uint256 accountId,uint256 orderId,uint256 lockedBalanceCNS,uint256 recyclerAccountId,int256 recyclerAmountCNS,uint256 recyclerBalanceCNS)',
  'event ClearingFrozenAccountOrder(uint256 perpId,uint256 accountId,uint256 orderId,uint256 lockedBalanceCNS,uint256 recyclerAccountId,int256 recyclerAmountCNS,uint256 recyclerBalanceCNS)',
  'event ClearingInvalidCloseOrder(uint256 perpId,uint256 accountId,uint256 orderId,uint256 lockedBalanceCNS,uint256 recyclerAccountId,int256 recyclerAmountCNS,uint256 recyclerBalanceCNS)',
  'event ClearingRemainingOrderLockBeyondBalance(uint256 perpId,uint256 accountId,uint256 orderId,uint256 pricePNS,uint256 remainingLotLNS,uint256 lockedBalanceCNS,uint256 excessiveLockedBalCNS,uint256 recyclerAccountId,int256 recyclerAmountCNS,uint256 recyclerBalanceCNS)',
  'event ClearingSelfMatchingOrder(uint256 perpId,uint256 accountId,uint256 orderId,uint256 lockedBalanceCNS,uint256 recyclerAccountId,int256 recyclerAmountCNS,uint256 recyclerBalanceCNS)',
  'event MakerOrderFilled(uint256 perpId,uint256 accountId,uint256 orderId,uint256 pricePNS,uint256 lotLNS,uint256 feeCNS,uint256 lockedBalanceCNS,int256 amountCNS,uint256 balanceCNS)',
  'event MakerOrderFilledV2(uint256 perpId,uint256 accountId,uint256 orderId,uint256 pricePNS,uint256 lotLNS,uint256 feeCNS,uint256 lockedBalanceCNS,int256 amountCNS,uint256 balanceCNS,uint256 builderId,uint256 builderFeeCNS)',
  'event MakerOrderSettlementFailed(uint256 perpId,uint256 accountId,uint256 orderId,uint8 orderType,uint256 pricePNS,uint256 lotLNS,uint256 maxNegPnlCollatBPS,uint256 reason,uint256 lockedBalanceCNS,uint256 recyclerAccountId,int256 recyclerAmountCNS,uint256 recyclerBalanceCNS)',
  'event OrderBatchCompleted(uint256 gasLeft)',
  'event OrderCancelled(uint256 lockedBalanceCNS,int256 amountCNS,uint256 balanceCNS)',
  'event OrderCancelledByAdmin(uint256 perpId,uint256 accountId,uint256 orderId,uint256 lockedBalanceCNS)',
  'event OrderCancelledByLiquidator(uint256 perpId,uint256 accountId,uint256 orderId,uint256 lockedBalanceCNS)',
  'event OrderChanged(uint256 orderId,uint256 pricePNS,uint256 lotLNS,uint256 expiryBlock,uint256 lockedBalanceCNS,uint256 balanceCNS)',
  'event OrderDescIdTooLow(uint256 lastOrderDescId)',
  'event OrderDoesNotExist(uint256 perpId,uint256 orderId)',
  'event OrderPlaced(uint256 orderId,uint256 lotLNS,uint256 lockedBalanceCNS,int256 amountCNS,uint256 balanceCNS)',
  'event OrderPostFailed(uint256 reason)',
  'event OrderRequest(uint256 perpId,uint256 accountId,uint256 orderDescId,uint256 orderId,uint8 orderType,uint256 pricePNS,uint256 lotLNS,uint256 expiryBlock,bool postOnly,bool fillOrKill,bool immediateOrCancel,uint256 maxMatches,uint256 leverageHdths,uint256 lastExecutionBlock,uint256 amountCNS,uint256 maxNegPnlCollatBPS,uint256 gasLeft)',
  'event OrderRequestV2(uint256 perpId,uint256 accountId,uint256 orderDescId,uint256 orderId,uint8 orderType,uint256 pricePNS,uint256 lotLNS,uint256 expiryBlock,bool postOnly,bool fillOrKill,bool immediateOrCancel,uint256 maxMatches,uint256 leverageHdths,uint256 lastExecutionBlock,uint256 amountCNS,uint256 maxNegPnlCollatBPS,uint256 gasLeft,bytes extension)',
  'event PositionClosed(uint256 perpId,uint256 accountId,uint8 positionType,uint256 pricePNS,int256 deltaPnlCNS,int256 fundingCNS)',
  'event PositionDecreased(uint256 perpId,uint256 accountId,uint8 positionType,uint256 startDepositCNS,uint256 endDepositCNS,uint256 startLotLNS,uint256 endLotLNS,int256 deltaPnlCNS,int256 fundingCNS)',
  'event PositionIncreased(uint256 perpId,uint256 accountId,uint8 positionType,uint256 leverageHdths,uint256 startDepositCNS,uint256 endDepositCNS,int256 pnlCollateralizedCNS,int256 premiumPnlSettledCNS,uint256 maxNegPnlCollatBPS,uint256 pricePNS,uint256 startLotLNS,uint256 endLotLNS,uint256 insFeeCNS,uint256 protFeeCNS)',
  'event PositionIncreasedV2(uint256 perpId,uint256 accountId,uint8 positionType,uint256 leverageHdths,uint256 startDepositCNS,uint256 endDepositCNS,int256 pnlCollateralizedCNS,int256 premiumPnlSettledCNS,uint256 maxNegPnlCollatBPS,uint256 pricePNS,uint256 startLotLNS,uint256 endLotLNS,uint256 insFeeCNS,uint256 protFeeCNS,uint256 priceResiduePNSQ16)',
  'event PositionOpened(uint256 perpId,uint256 accountId,uint8 positionType,uint256 leverageHdths,uint256 depositCNS,int256 pnlCollateralizedCNS,uint256 pricePNS,uint256 lotLNS,uint256 insFeeCNS,uint256 protFeeCNS)',
  'event PositionOpenedV2(uint256 perpId,uint256 accountId,uint8 positionType,uint256 leverageHdths,uint256 depositCNS,int256 pnlCollateralizedCNS,uint256 pricePNS,uint256 lotLNS,uint256 insFeeCNS,uint256 protFeeCNS,uint256 priceResiduePNSQ16)',
  'event RecycleFeeToAccount(uint256 accountId,uint256 perpId,uint256 orderId,uint256 recycleFeeCNS,uint256 recycleBalanceCNS)',
  'event TakerOrderFilled(uint256 entryPricePNS,uint256 collatPricePNS,uint256 pnlPricePNS,uint256 lotLNS,uint256 feeCNS,int256 amountCNS,uint256 balanceCNS)',
  'event TakerOrderFilledV2(uint256 entryPricePNS,uint256 collatPricePNS,uint256 pnlPricePNS,uint256 lotLNS,uint256 feeCNS,int256 amountCNS,uint256 balanceCNS,uint256 builderId,uint256 builderFeeCNS)',
])
