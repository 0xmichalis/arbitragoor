import axios from 'axios'
import { BigNumber, utils } from 'ethers'
import { Contract as MulticallContract } from 'ethers-multicall'

import addresses from './config/addresses.json'
import { config } from './config'
import { Pair, Token } from '@sushiswap/sdk'

// Copied from https://github.com/sushiswap/sushiswap/blob/45da97206358039039883c4a99c005bb8a4bef0c/contracts/uniswapv2/libraries/UniswapV2Library.sol#L48-L51
const getAmountOut = function(amountIn: BigNumber, reserveIn: BigNumber, reserveOut: BigNumber): BigNumber {
    const amountInWithFee = amountIn.mul(997)
    const numerator = amountInWithFee.mul(reserveOut)
    const denominator = reserveIn.mul(1000).add(amountInWithFee)
    return numerator.div(denominator)
}

export const checkReserves = function(
    usdcToBorrow: BigNumber,
    usdcTokenReserve: any,
    tokenKlimaReserve: any,
    tokenAddress: string,
    supportedRouter: number,
    usdcReverse: boolean,
    klimaReverse: boolean,
    routes: Route[],
): void {
    const [
        usdcTokenUsdcReserve,
        usdcTokenTokenReserve
    ] = usdcTokenReserve
    const [
        klimaTokenTokenReserve,
        klimaTokenKlimaReserve
    ] = tokenKlimaReserve

    const klimaViaToken = getKlima(
        usdcToBorrow,
        usdcReverse ? usdcTokenTokenReserve : usdcTokenUsdcReserve,
        usdcReverse ? usdcTokenUsdcReserve : usdcTokenTokenReserve,
        klimaReverse ? klimaTokenTokenReserve: klimaTokenKlimaReserve,
        klimaReverse ? klimaTokenKlimaReserve : klimaTokenTokenReserve,
    )

    routes.push({
        klimaAmount: klimaViaToken,
        usdcTokenUsdcReserve: usdcReverse ? usdcTokenTokenReserve : usdcTokenUsdcReserve,
        usdcTokenTokenReserve: usdcReverse ? usdcTokenUsdcReserve : usdcTokenTokenReserve,
        klimaTokenTokenReserve: klimaReverse ? klimaTokenTokenReserve: klimaTokenKlimaReserve,
        klimaTokenKlimaReserve: klimaReverse ? klimaTokenKlimaReserve : klimaTokenTokenReserve,
        supportedRouter,
        path: [ config.get('USDC_ADDRESS'), tokenAddress, config.get('KLIMA_ADDRESS')]
    })
}

export const checkReserves2 = function(
    usdcToBorrow: BigNumber,
    klimaUsdcReserve: any,
    supportedRouter: number,
    routes: Route[],
): void {
    const [
        usdcReserve,
        klimaReserve,
    ] = klimaUsdcReserve

    const klima = getAmountOut(usdcToBorrow, usdcReserve, klimaReserve)

    routes.push({
        klimaAmount: klima,
        usdcTokenUsdcReserve: BigNumber.from(0),
        usdcTokenTokenReserve: BigNumber.from(0),
        klimaTokenTokenReserve: usdcReserve,
        klimaTokenKlimaReserve: klimaReserve,
        supportedRouter,
        path: [ config.get('USDC_ADDRESS'), config.get('KLIMA_ADDRESS')]
    })
}

const getKlima = function(
    amountIn: BigNumber,
    usdcTokenUsdcReserve: BigNumber,
    usdcTokenTokenReserve: BigNumber,
    klimaTokenTokenReserve: BigNumber,
    klimaTokenKlimaReserve: BigNumber,
): BigNumber {
    const tokenAmount = getAmountOut(amountIn, usdcTokenUsdcReserve, usdcTokenTokenReserve)
    return getAmountOut(tokenAmount, klimaTokenTokenReserve, klimaTokenKlimaReserve)
}

const getUsdc = function(
    amountIn: BigNumber,
    klimaTokenKlimaReserve: BigNumber,
    klimaTokenTokenReserve: BigNumber,
    usdcTokenTokenReserve: BigNumber,
    usdcTokenUsdcReserve: BigNumber,
): BigNumber {
    const tokenAmount = getAmountOut(amountIn, klimaTokenKlimaReserve, klimaTokenTokenReserve)
    return getAmountOut(tokenAmount, usdcTokenTokenReserve, usdcTokenUsdcReserve)
}

export interface Route {
    supportedRouter: number
    klimaAmount: BigNumber
    usdcTokenUsdcReserve: BigNumber
    usdcTokenTokenReserve: BigNumber
    klimaTokenTokenReserve: BigNumber
    klimaTokenKlimaReserve: BigNumber
    path: string[]
}

interface Result {
    netResult: BigNumber
    path0: string[]
    path1: string[]
    path0Router: number
    path1Router: number
}

export const arbitrageCheck = function(routes: Route[], debt: BigNumber): Result {
    // Sort arrays and check for arbitrage opportunity between the
    // first and last routes.
    routes.sort(function(a, b) {
        // Ascending order
        return a.klimaAmount.sub(b.klimaAmount).toNumber()
    })

    const last = routes.length - 1
    // At this point we know that the last route in the array gets us the
    // most KLIMA for usdcToBorrow so we use that KLIMA amount to check how
    // much USDC the other route can give us.
    let gotUsdc: BigNumber
    let path0: string[] = routes[last].path
    let path1: string[] = []
    if (routes[0].path.length == 2) {
        path1 = [
            routes[0].path[1],
            routes[0].path[0],
        ]
        gotUsdc = getAmountOut(
            routes[last].klimaAmount,
            routes[0].klimaTokenKlimaReserve,
            routes[0].klimaTokenTokenReserve,
        )
    } else {
        path1 = [
            routes[0].path[2],
            routes[0].path[1],
            routes[0].path[0],
        ]
        gotUsdc = getUsdc(
            routes[last].klimaAmount,
            routes[0].klimaTokenKlimaReserve,
            routes[0].klimaTokenTokenReserve,
            routes[0].usdcTokenTokenReserve,
            routes[0].usdcTokenUsdcReserve,
        )
    }

    return {
        netResult: gotUsdc.sub(debt),
        path0Router: routes[last].supportedRouter,
        path0,
        path1Router: routes[0].supportedRouter,
        path1,
    }
}

export const getOptions = async function() {
    const options = {
        gasLimit: BigNumber.from(650000),
        maxFeePerGas: null,
        maxPriorityFeePerGas: null
    }

    try {
        const gasOracleUrl = config.get('GAS_ORACLE_URL')
        if (!gasOracleUrl) return options

        const resp = await axios.get(gasOracleUrl)
        const gasPrice = utils.parseUnits(resp.data.result.FastGasPrice, 'gwei')
        return {
            ...options,
            maxFeePerGas: gasPrice,
            maxPriorityFeePerGas: utils.parseUnits('50', 'gwei'),
        }
    } catch (e) {
        console.log(`Failed to get gas price from oracle, tx will use ethers defaults: ${e}`)
        return options
    }
}

export interface Pool {
    address?: string
    router: number
    token0: string
    token1: string
    reverse: boolean
}

const getToken = (symbol: string, tokens: Token[]): Token => {
    const token = tokens.find((t) => t.symbol === symbol)
    if (!token) throw Error(`symbol ${symbol} not found in token configuration`)
    return token
}

export const getPools = (chainId: number): Pool[] => {
    // address configuration validation
    if (addresses.tokens.length < 4) throw Error('invalid token configuration in addresses.json')
    if (addresses.liquidityPools.length < 3) throw Error('invalid lp configuration in addresses.json')

    const tokens: Token[] = []
    addresses.tokens.forEach(t => {
        const token = new Token(chainId, t.address, t.decimals, t.symbol)
        tokens.push(token)
        console.log(`${token.symbol}: ${token.address}`)
    })

    const pools: Pool[] = []
    addresses.liquidityPools.forEach(p => {
        let address = ''
        if (!p.address) {
            const token0 = getToken(p.token0, tokens)
            const token1 = getToken(p.token1, tokens)
            p.address = Pair.getAddress(token0, token1)
        }
        pools.push(p)
        console.log(`${p.token0}/${p.token1}: ${address}`)
    })

    return pools
}

export const getCalls = (pools: Pool[], poolAbi: string[]): any[] => {
    const contracts: MulticallContract[] = []
    pools.forEach(p => {
        if (!p.address) throw Error(`undefined address for pool ${JSON.stringify(p)}`)
        contracts.push(new MulticallContract(p.address, poolAbi))
    })

    const calls: any[] = []
    contracts.forEach(c => calls.push(c.getReserves()))
    return calls
}
