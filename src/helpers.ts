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
    router: number,
    usdcReverse: boolean,
    klimaReverse: boolean,
    routes: RouteWithReserves[],
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
        router,
        path: [ config.get('USDC_ADDRESS'), tokenAddress, config.get('KLIMA_ADDRESS')]
    })
}

export const checkReserves2 = function(
    usdcToBorrow: BigNumber,
    klimaUsdcReserve: any,
    router: number,
    routes: RouteWithReserves[],
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
        router,
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

export interface RouteWithReserves extends Route {
    klimaAmount: BigNumber
    usdcTokenUsdcReserve: BigNumber
    usdcTokenTokenReserve: BigNumber
    klimaTokenTokenReserve: BigNumber
    klimaTokenKlimaReserve: BigNumber
}

interface Result {
    netResult: BigNumber
    path0: string[]
    path1: string[]
    path0Router: number
    path1Router: number
}

export const arbitrageCheck = function(routes: RouteWithReserves[], debt: BigNumber): Result {
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
        path0Router: routes[last].router,
        path0,
        path1Router: routes[0].router,
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

export interface IToken {
    token: Token
    type: string
}

export interface Pool {
    address?: string
    // Depends on how the liquidity routers have been configured
    // in the flashloan contract. Used as an indication of which
    // router to use for a swap.
    router: number
    token0: string
    token1: string
    // Whether token0 is token0 in the LP contract or not.
    reverse: boolean
}

const getToken = (symbol: string, tokens: IToken[]): IToken => {
    const token = tokens.find((t) => t.token.symbol === symbol)
    if (!token) throw Error(`symbol ${symbol} not found in token configuration`)
    return token
}

export const getPools = (chainId: number): Pool[] => {
    // address configuration validation
    if (addresses.tokens.length < 2) throw Error('invalid token configuration in addresses.json')
    if (addresses.liquidityPools.length < 2) throw Error('invalid lp configuration in addresses.json')

    let sourceExists = false
    let targetExists = false
    const tokens: IToken[] = []

    addresses.tokens.forEach(t => {
        const token = new Token(chainId, t.address, t.decimals, t.symbol)
        tokens.push({token, type: t.type})
        sourceExists = sourceExists || t.type === 'source'
        targetExists = targetExists || t.type === 'target'
        console.log(`${token.symbol}: ${token.address} (${t.type})`)
    })

    if (!sourceExists) throw new Error('invalid token configuration: no type=source found')
    if (!targetExists) throw new Error('invalid token configuration: no type=target found')

    const pools: Pool[] = []
    addresses.liquidityPools.forEach(p => {
        let address = ''
        if (!p.address) {
            const token0 = getToken(p.token0, tokens)
            const token1 = getToken(p.token1, tokens)
            p.address = Pair.getAddress(token0.token, token1.token)
        }
        pools.push(p)
        console.log(`${p.token0}/${p.token1}: ${address}`)
    })

    return pools
}

export interface Route {
    router: number
    path: string[]
}

export const getRoutes = (tokens: IToken[], pools: Pool[]): Route[] => {
    const routes: Route[] = []
    const tmp = new Map()

    pools.forEach(p => {
        const token0 = getToken(p.token0, tokens)
        const token1 = getToken(p.token1, tokens)
        if (token0.type === 'source' && token1.type === 'target') {
            routes.push({router: p.router, path: [token0.token.address, token1.token.address]})
            return
        }
            
        if (token1.type === 'source' && token0.type === 'target') {
            routes.push({router: p.router, path: [token1.token.address, token0.token.address]})
            return
        }
        
        let intermediate
        let edge
        if (token0.type === 'intermediate') {
            intermediate = token0
            edge = token1
        } else {
            intermediate = token1
            edge = token0
        }
        const isSource = edge.type === 'source'
        const rTmp = tmp.get(intermediate?.token.symbol)
        if (!rTmp) {
            if (isSource) {
                tmp.set(intermediate?.token.symbol, [edge, intermediate, null])
            } else {
                tmp.set(intermediate?.token.symbol, [null, intermediate, edge])
            }
        } else {
            if (isSource) {
                rTmp[0] = edge
            } else {
                rTmp[2] = edge
            }
            tmp.set(intermediate?.token.symbol, rTmp)
        }     
    })

    return routes
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
