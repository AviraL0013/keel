// Official Perpl Exchange view ABI: https://raw.githubusercontent.com/PerplFoundation/dex-sdk/main/crates/sdk/abi/dex/Exchange.json
// Source SHA-256: 766fc81326bdf27f243ca582f65c3e2ff72bc639d88674876697a63ae1c47cb3
export const exchangeReads = [
  {
    type: 'function',
    name: 'getAccountByAddr',
    inputs: [
      {
        name: 'accountAddress',
        type: 'address',
        internalType: 'address',
      },
    ],
    outputs: [
      {
        name: 'accountInfo',
        type: 'tuple',
        internalType: 'struct AccountInfo',
        components: [
          {
            name: 'accountId',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'balanceCNS',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'lockedBalanceCNS',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'frozen',
            type: 'uint8',
            internalType: 'enum FreezeStatusEnum',
          },
          {
            name: 'accountAddr',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'positions',
            type: 'tuple',
            internalType: 'struct PositionBitMap',
            components: [
              {
                name: 'bank1',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'bank2',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'bank3',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'bank4',
                type: 'uint256',
                internalType: 'uint256',
              },
            ],
          },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getAccountById',
    inputs: [
      {
        name: 'accountId',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    outputs: [
      {
        name: 'accountInfo',
        type: 'tuple',
        internalType: 'struct AccountInfo',
        components: [
          {
            name: 'accountId',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'balanceCNS',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'lockedBalanceCNS',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'frozen',
            type: 'uint8',
            internalType: 'enum FreezeStatusEnum',
          },
          {
            name: 'accountAddr',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'positions',
            type: 'tuple',
            internalType: 'struct PositionBitMap',
            components: [
              {
                name: 'bank1',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'bank2',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'bank3',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'bank4',
                type: 'uint256',
                internalType: 'uint256',
              },
            ],
          },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getPositionV2',
    inputs: [
      {
        name: 'perpId',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'accountId',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    outputs: [
      {
        name: 'positionInfo',
        type: 'tuple',
        internalType: 'struct PositionInfoV2',
        components: [
          {
            name: 'accountId',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'nextNodeId',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'prevNodeId',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'positionType',
            type: 'uint8',
            internalType: 'enum PositionEnum',
          },
          {
            name: 'depositCNS',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'pricePNS',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'lotLNS',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'entryBlock',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'pnlCNS',
            type: 'int256',
            internalType: 'int256',
          },
          {
            name: 'deltaPnlCNS',
            type: 'int256',
            internalType: 'int256',
          },
          {
            name: 'premiumPnlCNS',
            type: 'int256',
            internalType: 'int256',
          },
          {
            name: 'priceResiduePNSQ16',
            type: 'uint256',
            internalType: 'uint256',
          },
        ],
      },
      {
        name: 'markPricePNS',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'markPriceValid',
        type: 'bool',
        internalType: 'bool',
      },
    ],
    stateMutability: 'view',
  },
] as const
