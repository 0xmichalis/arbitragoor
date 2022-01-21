import axios from 'axios'
import { BigNumber, ethers, utils } from 'ethers'

import { config } from './config'

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
    let gasPrice: BigNumber
    const options = {
        gasLimit: BigNumber.from(650000),
    }

    try {
        const gasOracleUrl = config.get('GAS_ORACLE_URL')
        if (!gasOracleUrl) {
            return options
        }
        const resp = await axios.get(gasOracleUrl)
        gasPrice = utils.parseUnits(resp.data.result.FastGasPrice, 'gwei')
    } catch (e) {
        console.log(`Failed to get gas price from oracle, tx will use ethers defaults: ${e.message}`)
        return options
    }

    // Tip to miners
    const maxPrioFeeWei = config.get('GAS_MAX_PRIORITY_FEE_WEI')
    const tip = maxPrioFeeWei ? BigNumber.from(maxPrioFeeWei) : BigNumber.from(30000000000)

    const maxFeeCeilingWei = config.get('GAS_MAX_FEE_CEILING_WEI')
    const maxFeeCeiling = maxFeeCeilingWei ? BigNumber.from(maxFeeCeilingWei) : BigNumber.from(1300000000000)
    if (gasPrice.gt(maxFeeCeiling)) {
        gasPrice = maxFeeCeiling
    }

    return {
        ...options,
        maxFeePerGas: gasPrice,
        maxPriorityFeePerGas: tip,
    }
}
