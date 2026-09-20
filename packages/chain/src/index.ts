import { createPublicClient, http, getAddress, type Address, type PublicClient } from 'viem'
import { monad, monadTestnet } from 'viem/chains'
const erc20Abi = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }, { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] }, { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] }] as const
export type ChainEnvironment = 'testnet' | 'mainnet'
export type ChainConfig = { environment: ChainEnvironment; chainId: number; rpcUrl: string; ausdToken: Address }
export const chainConfigs: Record<ChainEnvironment, ChainConfig> = { testnet: { environment: 'testnet', chainId: 10143, rpcUrl: 'https://testnet-rpc.monad.xyz', ausdToken: getAddress('0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC') }, mainnet: { environment: 'mainnet', chainId: 143, rpcUrl: 'https://rpc.monad.xyz', ausdToken: getAddress('0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a') } }
export class ChainAdapter { readonly config: ChainConfig; readonly client: PublicClient; constructor(environment: ChainEnvironment, overrides: Partial<ChainConfig> = {}) { this.config = { ...chainConfigs[environment], ...overrides }; const chain = environment === 'mainnet' ? monad : monadTestnet; this.client = createPublicClient({ chain, transport: http(this.config.rpcUrl) }) }
  async getNativeBalance(address: Address) { return this.client.getBalance({ address }) }
  async getAusdBalance(address: Address) { const [balance, decimals, symbol] = await Promise.all([this.client.readContract({ address: this.config.ausdToken, abi: erc20Abi, functionName: 'balanceOf', args: [address] }), this.client.readContract({ address: this.config.ausdToken, abi: erc20Abi, functionName: 'decimals' }), this.client.readContract({ address: this.config.ausdToken, abi: erc20Abi, functionName: 'symbol' })]); return { balance, decimals, symbol, address: this.config.ausdToken, chainId: this.config.chainId } }
  async getBlockNumber() { return this.client.getBlockNumber() }
}
export { erc20Abi }
