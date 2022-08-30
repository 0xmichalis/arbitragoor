import { ChainId } from '@sushiswap/sdk'
import { BigNumber, Contract, ethers, providers, utils, Wallet } from 'ethers'
import { Provider as MulticallProvider } from 'ethers-multicall'

import { config } from './config'
import { arbitrageCheck, checkReserves, checkReserves2, getCalls, getOptions, getPools, Route } from './helpers'

export default class Arbitragoor {
    // RPC providers
    private provider: providers.StaticJsonRpcProvider
    private multicallProvider: MulticallProvider

    // Wallet to execute arbitrage requests
    private wallet: Wallet

    // Amount to borrow
    private usdcToBorrow: BigNumber
    // Amount borrowed + AAVE fee
    private totalDebt: BigNumber

    // Calls provided to the multicall contract
    private calls: any[]
    // Flashloan contract
    private loaner: Contract
    // UniswapPair v2 ABI
    private uniPairAbi = [
        'function getReserves() view returns (uint112 _reserve0, uint112 _reserve1, uint32 _blockTimestampLast)',
        'function token0() view returns (address)',
    ]

    // Whether the class is initialized
    private isInitialized: boolean = false

    constructor() {
        // Setup node connections
        this.provider = new providers.StaticJsonRpcProvider(config.get('NODE_API_URL'))
        this.multicallProvider = new MulticallProvider(this.provider)

        // Setup keeper
        this.wallet = new ethers.Wallet(config.get('PRIVATE_KEY'), this.provider)
        console.log(`Keeper address: ${this.wallet.address}`)

        // Aggregate calls to include in multicall
        const pools = getPools(ChainId.MATIC)
        this.calls = getCalls(pools, this.uniPairAbi)

        // Setup flashloan contract
        this.loaner = new ethers.Contract(config.get('FLASHLOAN_ADDRESS'), [
            'function getit(address asset, uint256 amount, address[] calldata path0, address[] calldata path1, uint8 path0Router, uint8 path1Router) public',
        ], this.wallet)
        console.log(`Flashloan contract: ${this.loaner.address}`)

        // TODO: Check that the keeper has write access in the flashloan contract

        // Setup flashloan borrow amount
        const usdcHumanReadble = config.get('BORROWED_AMOUNT')
        this.usdcToBorrow = ethers.utils.parseUnits(usdcHumanReadble, 6)
        // Premium withheld by AAVE
        // https://github.com/aave/protocol-v2/blob/30a2a19f6d28b6fb8d26fc07568ca0f2918f4070/contracts/protocol/lendingpool/LendingPool.sol#L502
        const premium = this.usdcToBorrow.mul(9).div(10000)
        this.totalDebt = this.usdcToBorrow.add(premium)
        console.log(`USDC to borrow: ${usdcHumanReadble}`)
    }

    public async init(): Promise<void> {
        // Initialize multicall provider to avoid having to
        // configure a chain id
        await this.multicallProvider.init()

        // Check gas oracle is properly configured
        const opts = await getOptions()
        if (opts.maxFeePerGas)
            console.log(`Current gas price: ${utils.formatUnits(opts.maxFeePerGas, 'gwei')}`)
        else
            console.log('Gas oracle is not configured, will be falling back to ethers.js for gas')

        this.isInitialized = true
    }

    public run(): void {
        if (!this.isInitialized) {
            throw Error('uninitialized: did you run init()?')
        }

        let locked = false

        // TODO: Ideally we track 'pending' transactions in mempool
        this.provider.on('block', async (blockNumber) => {
            // Acquire lock so we won't be submitting multiple transactions across adjacent
            // blocks once we spot an arbitrage opportunity.
            if (locked) {
                console.log(`#${blockNumber}: Ignoring this block as there is already an in-flight request`)
                return
            } else {
                locked = true
            }

            try {
                // Gather reserves from all routes
                const routes: Route[] = []
                const [
                    usdcBctReserve,
                    klimaBctReserve,
                    usdcMco2Reserve,
                    klimaMco2Reserve,
                    klimaUsdcReserve,
                ] = await this.multicallProvider.all(this.calls)

                // USDC -> BCT -> KLIMA
                checkReserves(
                    this.usdcToBorrow,
                    usdcBctReserve,
                    klimaBctReserve,
                    config.get('BCT_ADDRESS'),
                    // This should match the router that supports this path in the contract
                    // In this case router0 is meant to be the SushiSwap router.
                    0,
                    this.usdcBctReverse,
                    this.klimaBctReverse,
                    routes,
                )

                // USDC -> MCO2 -> KLIMA
                checkReserves(
                    this.usdcToBorrow,
                    usdcMco2Reserve,
                    klimaMco2Reserve,
                    config.get('MCO2_ADDRESS'),
                    // This should match the router that supports this path in the contract
                    // In this case router1 is meant to be the QuickSwap router.
                    1,
                    this.usdcMco2Reverse,
                    this.klimaMco2Reverse,
                    routes,
                )

                // USDC -> KLIMA
                checkReserves2(
                    this.usdcToBorrow,
                    klimaUsdcReserve,
                    // This should match the router that supports this path in the contract
                    // In this case router0 is meant to be the SushiSwap router.
                    0,
                    routes,
                )

                // Check whether we can execute an arbitrage
                const {
                    netResult,
                    path0,
                    path1,
                    path0Router,
                    path1Router,
                } = arbitrageCheck(routes, this.totalDebt)
                if (netResult.lt(1e6)) {
                    // Less than a dollar
                    console.log(`#${blockNumber}: No arbitrage opportunity`)
                    return
                }
                console.log(`Found arbitrage opportunity: ${netResult.div(1e6)}`)

                // TODO: Sum gas costs with net result to ensure we are
                // still profitable
                const options = await getOptions()

                // Execute flasloan request
                console.log('Sending flashloan transaction...')
                const tx = await this.loaner.getit(
                    config.get('USDC_ADDRESS'),
                    this.usdcToBorrow,
                    path0,
                    path1,
                    path0Router,
                    path1Router,
                    options
                )
                await tx.wait()

                console.log(`#${blockNumber}: Flashloan request ${tx.hash} for ${utils.formatUnits(netResult, 6)} USDC successfully mined`)
            } catch (err) {
                console.error(`#${blockNumber}: Failed to execute flasloan request: ${err}`)
            } finally {
                locked = false
            }
        })
    }
}