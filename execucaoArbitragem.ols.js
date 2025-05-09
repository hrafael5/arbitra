const BigNumber = require("bignumber.js");

// Helper function to adjust quantity to stepSize
function adjustToStep(value, stepSize) {
  const bnValue = new BigNumber(value);
  const bnStepSize = new BigNumber(stepSize);
  if (bnStepSize.isZero() || bnStepSize.isNaN() || !bnStepSize.isFinite() || bnStepSize.dp() === null) {
    if (bnStepSize.isZero()) return bnValue.toString();
    return bnValue.decimalPlaces(0, BigNumber.ROUND_DOWN).toString();
  }
  return bnValue.minus(bnValue.modulo(bnStepSize)).decimalPlaces(bnStepSize.dp(), BigNumber.ROUND_DOWN).toString();
}

async function executeOrderWithSlippageCheck(exchange, logger, symbol, side, orderType, amountInputBaseAsset, symbolInfo, maxAllowedSlippagePercent, orderBookDepthLimit = 20) {
  logger.info(`[SlippageCheck] Initiating ${side} ${orderType} order for ${amountInputBaseAsset.toString()} of ${symbolInfo.baseAsset} on ${symbol} with max slippage ${maxAllowedSlippagePercent}%`);

  if (orderType !== "MARKET") {
    return { success: false, error: `Order type ${orderType} not supported. Only MARKET.`, data: null };
  }

  let amountBaseAsset = new BigNumber(amountInputBaseAsset);
  if (amountBaseAsset.isLessThanOrEqualTo(0)) {
    return { success: false, error: "Amount (base asset) must be positive.", data: null };
  }

  try {
    const depth = await new Promise((resolve, reject) => {
      exchange.depth(symbol, (error, depthData, fetchedSymbol) => {
        if (error) {
          logger.error(`[SlippageCheck] Error fetching order book for ${symbol}: ${JSON.stringify(error)}`);
          return reject(new Error(`Failed to fetch order book for ${symbol}`));
        }
        resolve(depthData);
      }, orderBookDepthLimit);
    });

    let referencePrice;
    let bookLevels;

    if (side === "BUY") {
      if (!depth.asks || Object.keys(depth.asks).length === 0) {
        return { success: false, error: "No asks in order book.", data: { symbol } };
      }
      bookLevels = Object.entries(depth.asks).map(([price, quantity]) => [new BigNumber(price), new BigNumber(quantity)]);
      referencePrice = bookLevels[0][0];
    } else { // SELL
      if (!depth.bids || Object.keys(depth.bids).length === 0) {
        return { success: false, error: "No bids in order book.", data: { symbol } };
      }
      bookLevels = Object.entries(depth.bids).map(([price, quantity]) => [new BigNumber(price), new BigNumber(quantity)]);
      referencePrice = bookLevels[0][0];
    }

    if (referencePrice.isLessThanOrEqualTo(0)) {
        return { success: false, error: "Invalid reference price from order book.", data: { symbol, referencePrice: referencePrice.toString() } };
    }

    let totalQuantityFilledBase = new BigNumber(0);
    let totalCostOrProceedsQuote = new BigNumber(0);
    let amountToFillBase = amountBaseAsset;

    for (const [levelPrice, levelQuantityBase] of bookLevels) {
      if (totalQuantityFilledBase.gte(amountToFillBase)) break;
      const quantityNeededFromLevelBase = BigNumber.min(amountToFillBase.minus(totalQuantityFilledBase), levelQuantityBase);
      totalQuantityFilledBase = totalQuantityFilledBase.plus(quantityNeededFromLevelBase);
      totalCostOrProceedsQuote = totalCostOrProceedsQuote.plus(quantityNeededFromLevelBase.multipliedBy(levelPrice));
    }

    if (totalQuantityFilledBase.isLessThan(amountToFillBase)) {
      logger.warn(`[SlippageCheck] Insufficient liquidity in fetched depth for ${symbol} to fill ${amountToFillBase.toString()} ${symbolInfo.baseAsset}. Can only fill ${totalQuantityFilledBase.toString()}.`);
      amountToFillBase = totalQuantityFilledBase;
      if (amountToFillBase.isLessThanOrEqualTo(0)) {
        return { success: false, error: "Insufficient liquidity, calculated fillable base amount is zero or less.", data: { symbol } };
      }
    }

    if (totalQuantityFilledBase.isZero()) {
        return { success: false, error: "Calculated fillable base quantity is zero.", data: {symbol}};
    }

    const averageExecutionPrice = totalCostOrProceedsQuote.dividedBy(totalQuantityFilledBase);
    let estimatedSlippagePercent;
    if (side === "BUY") {
      estimatedSlippagePercent = averageExecutionPrice.dividedBy(referencePrice).minus(1).multipliedBy(100);
    } else { // SELL
      estimatedSlippagePercent = referencePrice.dividedBy(averageExecutionPrice).minus(1).multipliedBy(100);
    }
    logger.info(`[SlippageCheck] ${symbol} ${side} ${amountToFillBase.toString()} ${symbolInfo.baseAsset}: RefPrice: ${referencePrice.dp(8).toString()}, AvgExecPriceEst: ${averageExecutionPrice.dp(8).toString()}, SlippageEst: ${estimatedSlippagePercent.toFixed(4)}%`);

    if (estimatedSlippagePercent.abs().gt(maxAllowedSlippagePercent)) {
      return { success: false, error: "Estimated slippage exceeds maximum allowed.", data: { symbol, estimatedSlippagePercent: estimatedSlippagePercent.toFixed(4), maxAllowedSlippagePercent } };
    }

    const finalOrderQuantityBase = new BigNumber(adjustToStep(amountToFillBase, symbolInfo.stepSize));
    if (finalOrderQuantityBase.isLessThan(symbolInfo.minQty)) {
      return { success: false, error: "Adjusted quantity less than minQty.", data: { symbol, finalOrderQuantityBase: finalOrderQuantityBase.toString(), minQty: symbolInfo.minQty } };
    }
    const notionalValue = finalOrderQuantityBase.multipliedBy(averageExecutionPrice);
    if (notionalValue.isLessThan(symbolInfo.minNotional)) {
      return { success: false, error: "Estimated notional value less than minNotional.", data: { symbol, notionalValue: notionalValue.dp(8).toString(), minNotional: symbolInfo.minNotional } };
    }
    if (finalOrderQuantityBase.isLessThanOrEqualTo(0)) {
        return { success: false, error: "Final order quantity base is zero or negative.", data: { symbol } };
    }

    logger.info(`[SlippageCheck] EXECUTE: ${side} ${finalOrderQuantityBase.toString()} ${symbolInfo.baseAsset} on ${symbol}.`);
    const orderResult = await new Promise((resolve, reject) => {
      const orderParams = { newOrderRespType: "FULL" };
      if (side === "BUY") {
        exchange.marketBuy(symbol, finalOrderQuantityBase.toString(), orderParams, (error, response) => error ? reject(error) : resolve(response));
      } else { // SELL
        exchange.marketSell(symbol, finalOrderQuantityBase.toString(), orderParams, (error, response) => error ? reject(error) : resolve(response));
      }
    });
    logger.info(`[SlippageCheck] ${symbol} ${side} API response: ${JSON.stringify(orderResult)}`);

    if (orderResult && orderResult.orderId && orderResult.status === "FILLED" && new BigNumber(orderResult.executedQty).isGreaterThan(0)) {
      const executedQty = new BigNumber(orderResult.executedQty);
      const cummulativeQuoteQty = new BigNumber(orderResult.cummulativeQuoteQty);
      const actualAvgExecutionPrice = cummulativeQuoteQty.dividedBy(executedQty);
      let actualSlippagePercent;
      if (side === "BUY") {
        actualSlippagePercent = actualAvgExecutionPrice.dividedBy(referencePrice).minus(1).multipliedBy(100);
      } else { // SELL
        actualSlippagePercent = referencePrice.dividedBy(actualAvgExecutionPrice).minus(1).multipliedBy(100);
      }
      logger.info(`[SlippageCheck] ${symbol} ${side} FILLED. ActualAvgPrice: ${actualAvgExecutionPrice.dp(8).toString()}, ActualSlippage: ${actualSlippagePercent.toFixed(4)}%`);
      return { success: true, data: { ...orderResult, actualAvgExecutionPrice: actualAvgExecutionPrice.toString(), actualSlippagePercent: actualSlippagePercent.toFixed(4), referencePrice: referencePrice.toString() } };
    } else {
      return { success: false, error: "Order execution failed or not filled properly.", data: orderResult };
    }
  } catch (error) {
    logger.error(`[SlippageCheck] CRITICAL error for ${symbol} ${side}: ${error.message}`, error.stack);
    return { success: false, error: error.message, data: { stack: error.stack } };
  }
}

async function simulateArbitragePath(ctrl, candidate, symbolInfoCache) {
  const logger = ctrl.logger;
  const initialCapital = new BigNumber(ctrl.options.arbitrage.ARBITRAGE_CAPITAL_USDT);
  const startCurrency = ctrl.options.arbitrage.binanceStartingPoint || "USDT";
  const feePercent = new BigNumber(ctrl.options.arbitrage.BINANCE_TRADE_FEE_PERCENT).dividedBy(100);

  let currentCapital = initialCapital;
  let currentAsset = startCurrency;
  const simulatedTrades = [];

  const legs = [
    { symbol: candidate.a_symbol, from: candidate.a_step_from, to: candidate.a_step_to, type: candidate.a_step_type, ticker: candidate.a },
    { symbol: candidate.b_symbol, from: candidate.b_step_from, to: candidate.b_step_to, type: candidate.b_step_type, ticker: candidate.b },
    { symbol: candidate.c_symbol, from: candidate.c_step_from, to: candidate.c_step_to, type: candidate.c_step_type, ticker: candidate.c },
  ];

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const legSymbolInfo = symbolInfoCache[leg.symbol];
    if (!legSymbolInfo || legSymbolInfo.status !== "TRADING") {
      logger.warn(`[SIMULATE] Leg ${i+1} (${leg.symbol}) not trading or no info. Aborting simulation.`);
      return { error: `Symbol ${leg.symbol} not trading or no info.` };
    }

    if (currentAsset !== leg.from) {
      logger.error(`[SIMULATE] Asset mismatch for leg ${i+1} (${leg.symbol}): Expected ${leg.from}, have ${currentAsset}. Aborting.`);
      return { error: `Asset mismatch: Expected ${leg.from}, have ${currentAsset}` };
    }

    let price, quantityToTradeBase, tradeAmountQuote;

    if (leg.type === "BUY") { // Buying base asset with quote asset
      price = new BigNumber(leg.ticker.a); // Ask price
      if (price.isLessThanOrEqualTo(0)) return { error: `Invalid ask price for ${leg.symbol}` }; 
      quantityToTradeBase = currentCapital.dividedBy(price); // Amount of base asset we can buy
      tradeAmountQuote = currentCapital; // We spend all current (quote) capital
    } else { // SELL // Selling base asset for quote asset
      price = new BigNumber(leg.ticker.b); // Bid price
      if (price.isLessThanOrEqualTo(0)) return { error: `Invalid bid price for ${leg.symbol}` };
      quantityToTradeBase = currentCapital; // Amount of base asset we sell
      tradeAmountQuote = quantityToTradeBase.multipliedBy(price);
    }
    
    // Apply exchange filters for simulation (minQty, stepSize for base asset)
    let adjustedQuantityBase = new BigNumber(adjustToStep(quantityToTradeBase, legSymbolInfo.stepSize));
    if (adjustedQuantityBase.isLessThan(legSymbolInfo.minQty)) {
        logger.warn(`[SIMULATE] Leg ${i+1} (${leg.symbol}) adjusted qty ${adjustedQuantityBase.toString()} < minQty ${legSymbolInfo.minQty}. Simulating with minQty.`);
        adjustedQuantityBase = new BigNumber(legSymbolInfo.minQty);
    }
    
    // Recalculate quote amount if base quantity was adjusted for BUY side
    if (leg.type === "BUY") {
        tradeAmountQuote = adjustedQuantityBase.multipliedBy(price);
        // Check if we have enough capital for this adjusted BUY
        if (tradeAmountQuote.isGreaterThan(currentCapital)) {
            logger.warn(`[SIMULATE] Leg ${i+1} (${leg.symbol}) after adjusting qty, required quote ${tradeAmountQuote.toString()} > available ${currentCapital.toString()}. Aborting.`);
            return { error: `Insufficient capital for adjusted BUY on ${leg.symbol}` };
        }
    } else { // For SELL, recalculate quote proceeds from adjusted base quantity
        tradeAmountQuote = adjustedQuantityBase.multipliedBy(price);
    }

    const notional = adjustedQuantityBase.multipliedBy(price);
    if (notional.isLessThan(legSymbolInfo.minNotional)) {
      logger.warn(`[SIMULATE] Leg ${i+1} (${leg.symbol}) notional ${notional.toString()} < minNotional ${legSymbolInfo.minNotional}. Aborting.`);
      return { error: `Notional value too low for ${leg.symbol}` };
    }

    const feeAmount = (leg.type === "BUY" ? adjustedQuantityBase : tradeAmountQuote).multipliedBy(feePercent);

    simulatedTrades.push({
      symbol: leg.symbol, side: leg.type, price: price.toString(), 
      quantityBase: adjustedQuantityBase.toString(), quantityQuote: tradeAmountQuote.toString(), 
      feeAsset: leg.type === "BUY" ? legSymbolInfo.baseAsset : legSymbolInfo.quoteAsset,
      fee: feeAmount.toString()
    });

    if (leg.type === "BUY") {
      currentCapital = adjustedQuantityBase.minus(feeAmount); // Capital is now in base asset, minus fee in base asset
      currentAsset = legSymbolInfo.baseAsset;
    } else { // SELL
      currentCapital = tradeAmountQuote.minus(feeAmount); // Capital is now in quote asset, minus fee in quote asset
      currentAsset = legSymbolInfo.quoteAsset;
    }
  }

  const finalCapital = currentCapital;
  let netProfit = new BigNumber(0);
  if (currentAsset === startCurrency) {
    netProfit = finalCapital.minus(initialCapital);
  } else {
    logger.warn(`[SIMULATE] Final asset ${currentAsset} differs from start asset ${startCurrency}. Profit calculation might be complex if direct conversion is not available or considered.`);
    // For simplicity, we'll report profit only if assets match. A more complex simulation might try to convert back.
  }
  const netProfitPercentage = initialCapital.isZero() ? new BigNumber(0) : netProfit.dividedBy(initialCapital).multipliedBy(100);

  logger.info(`[SIMULATE] Path: ${legs.map(l=>l.symbol).join("->")}, Initial: ${initialCapital.toString()} ${startCurrency}, Final: ${finalCapital.toString()} ${currentAsset}, NetProfit: ${netProfitPercentage.toFixed(4)}%`);

  return {
    pathInfo: candidate,
    simulation: {
      initialCapital: initialCapital.toString(),
      finalCapital: finalCapital.toString(),
      startCurrency,
      finalCurrency: currentAsset,
      netProfit: netProfit.toString(),
      netProfitPercentage: netProfitPercentage.toNumber(),
      trades: simulatedTrades,
      feesPaid: simulatedTrades.reduce((sum, trade) => sum.plus(new BigNumber(trade.fee)), new BigNumber(0)).toString()
    }
  };
}

async function executarArbitragemReal(ctrl, pathInfo, symbolInfoCache) {
  const logger = ctrl.logger;
  const exchange = ctrl.exchange;
  const initialCapitalAmount = new BigNumber(ctrl.options.arbitrage.ARBITRAGE_CAPITAL_USDT);
  const startAsset = ctrl.options.arbitrage.binanceStartingPoint || "USDT";
  const maxSlippage = parseFloat(ctrl.options.arbitrage.SLIPPAGE_MAX_PERCENT);
  const depthLimit = parseInt(ctrl.options.arbitrage.ORDER_BOOK_DEPTH_LIMIT);
  const feeRate = new BigNumber(ctrl.options.arbitrage.BINANCE_TRADE_FEE_PERCENT).dividedBy(100);

  logger.info(`[REAL_TRADE] Attempting: ${pathInfo.a_symbol} -> ${pathInfo.b_symbol} -> ${pathInfo.c_symbol}. Capital: ${initialCapitalAmount} ${startAsset}`);

  let currentAsset = startAsset;
  let currentAmount = initialCapitalAmount;
  const executedOrders = [];

  const legs = [
    { symbol: pathInfo.a_symbol, from: pathInfo.a_step_from, to: pathInfo.a_step_to, side: pathInfo.a_step_type },
    { symbol: pathInfo.b_symbol, from: pathInfo.b_step_from, to: pathInfo.b_step_to, side: pathInfo.b_step_type },
    { symbol: pathInfo.c_symbol, from: pathInfo.c_step_from, to: pathInfo.c_step_to, side: pathInfo.c_step_type },
  ];

  try {
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      const legSymbolInfo = symbolInfoCache[leg.symbol];
      if (!legSymbolInfo || legSymbolInfo.status !== "TRADING") {
        throw new Error(`Leg ${i+1} (${leg.symbol}) not trading or no info.`);
      }
      if (currentAsset !== leg.from) {
        throw new Error(`Asset mismatch for leg ${i+1} (${leg.symbol}): Expected ${leg.from}, have ${currentAsset}`);
      }

      let amountToTradeBaseAsset;
      if (leg.side === "BUY") { // currentAmount is in QUOTE, need to calculate BASE amount to buy
        // Estimate price from ticker for amount calculation (executeOrderWithSlippageCheck will use order book)
        const ticker = await new Promise((resolve, reject) => exchange.bookTickers(leg.symbol, (err, tick) => err ? reject(err) : resolve(tick)));
        if (!ticker || !ticker.askPrice) throw new Error(`Could not get ticker/askPrice for ${leg.symbol}`);
        const estimatedPrice = new BigNumber(ticker.askPrice);
        if (estimatedPrice.isLessThanOrEqualTo(0)) throw new Error(`Invalid estimated ask price for ${leg.symbol}`);
        amountToTradeBaseAsset = currentAmount.dividedBy(estimatedPrice);
      } else { // SELL // currentAmount is in BASE
        amountToTradeBaseAsset = currentAmount;
      }
      
      // Ensure amountToTradeBaseAsset is positive before adjusting
      if (amountToTradeBaseAsset.isLessThanOrEqualTo(0)) {
        throw new Error(`Calculated amount to trade for ${leg.symbol} is zero or negative before step adjustment.`);
      }
      amountToTradeBaseAsset = new BigNumber(adjustToStep(amountToTradeBaseAsset, legSymbolInfo.stepSize));
       if (amountToTradeBaseAsset.isLessThan(legSymbolInfo.minQty)) {
         logger.warn(`[REAL_TRADE] Leg ${i+1} (${leg.symbol}) base qty ${amountToTradeBaseAsset.toString()} after stepSize is less than minQty ${legSymbolInfo.minQty}. Attempting with minQty.`);
         amountToTradeBaseAsset = new BigNumber(legSymbolInfo.minQty);
       }
       if (amountToTradeBaseAsset.isLessThanOrEqualTo(0)) {
        throw new Error(`Amount to trade for ${leg.symbol} became zero or negative after adjustments.`);
      }

      logger.info(`[REAL_TRADE_LEG_${i+1}] ${leg.side} ${leg.symbol}. Current: ${currentAmount.dp(8)} ${currentAsset}. TradeBaseQtyEst: ${amountToTradeBaseAsset.dp(8)} ${legSymbolInfo.baseAsset}`);

      const orderResult = await executeOrderWithSlippageCheck(
        exchange, logger, leg.symbol, leg.side, "MARKET", 
        amountToTradeBaseAsset, legSymbolInfo, maxSlippage, depthLimit
      );

      if (!orderResult.success) {
        throw new Error(`Leg ${i+1} (${leg.symbol}) failed: ${orderResult.error} Data: ${JSON.stringify(orderResult.data)}`);
      }
      
      executedOrders.push(orderResult.data);
      const executedQtyBase = new BigNumber(orderResult.data.executedQty);
      const cummulativeQuoteQty = new BigNumber(orderResult.data.cummulativeQuoteQty);

      if (leg.side === "BUY") {
        currentAmount = executedQtyBase; // Now in base asset
        currentAsset = legSymbolInfo.baseAsset;
      } else { // SELL
        currentAmount = cummulativeQuoteQty; // Now in quote asset
        currentAsset = legSymbolInfo.quoteAsset;
      }
      // Apply fee for internal accounting consistency, though Binance fills are net of fees.
      // The fee is on the asset received or the asset spent depending on how Binance structures it.
      // For simplicity, let's assume the fee is applied on the resulting amount.
      currentAmount = currentAmount.multipliedBy(new BigNumber(1).minus(feeRate));
      logger.info(`[REAL_TRADE_LEG_${i+1}] DONE. New capital: ${currentAmount.dp(8)} ${currentAsset} (after fee ${feeRate.multipliedBy(100).toFixed(4)}%)`);
    }

    const finalAmount = currentAmount;
    const finalAsset = currentAsset;
    logger.info(`[REAL_TRADE] SUCCESS! Path: ${legs.map(l=>l.symbol).join("->")}. Initial: ${initialCapitalAmount} ${startAsset}, Final: ${finalAmount.dp(8)} ${finalAsset}`);
    return { success: true, initialAmount: initialCapitalAmount.toString(), initialAsset: startAsset, finalAmount: finalAmount.toString(), finalAsset, orders: executedOrders };

  } catch (error) {
    logger.error(`[REAL_TRADE] FAILED: ${error.message}. Path: ${legs.map(l=>l.symbol).join("->")}. Executed: ${executedOrders.length} legs.`);
    logger.error("[REAL_TRADE] Error stack:", error.stack);
    // ROLLBACK ATTEMPT
    if (executedOrders.length > 0 && currentAsset !== startAsset) {
      logger.warn(`[ROLLBACK] Attempting to convert ${currentAmount.dp(8)} ${currentAsset} back to ${startAsset}`);
      let rollbackPairSymbol, rollbackSide, rollbackAmountBase;
      const targetAsset = startAsset;

      // Try direct pair: currentAsset -> targetAsset (SELL currentAsset if it's base, BUY targetAsset if currentAsset is quote)
      const directSellPair = currentAsset + targetAsset;
      const directBuyPair = targetAsset + currentAsset;

      if (symbolInfoCache[directSellPair] && symbolInfoCache[directSellPair].baseAsset === currentAsset && symbolInfoCache[directSellPair].quoteAsset === targetAsset) {
        rollbackPairSymbol = directSellPair;
        rollbackSide = "SELL";
        rollbackAmountBase = currentAmount; // currentAmount is in currentAsset (base)
      } else if (symbolInfoCache[directBuyPair] && symbolInfoCache[directBuyPair].baseAsset === targetAsset && symbolInfoCache[directBuyPair].quoteAsset === currentAsset) {
        rollbackPairSymbol = directBuyPair;
        rollbackSide = "BUY";
        // Estimate price to calculate base amount to buy
        const ticker = await new Promise((resolve, reject) => exchange.bookTickers(rollbackPairSymbol, (err, tick) => err ? reject(err) : resolve(tick)));
        if (ticker && ticker.askPrice) {
            const estimatedPrice = new BigNumber(ticker.askPrice);
            if(estimatedPrice.isGreaterThan(0)) rollbackAmountBase = currentAmount.dividedBy(estimatedPrice); // currentAmount is in currentAsset (quote)
        } else {
             logger.error("[ROLLBACK] Could not get ticker for rollback BUY on " + rollbackPairSymbol);
        }
      }

      if (rollbackPairSymbol && rollbackSide && rollbackAmountBase && rollbackAmountBase.isGreaterThan(0)) {
        const rbSymbolInfo = symbolInfoCache[rollbackPairSymbol];
        rollbackAmountBase = new BigNumber(adjustToStep(rollbackAmountBase, rbSymbolInfo.stepSize));
        if (rollbackAmountBase.isGreaterThanOrEqualTo(rbSymbolInfo.minQty)) {
            logger.info(`[ROLLBACK] Attempting ${rollbackSide} ${rollbackAmountBase.dp(8)} ${rbSymbolInfo.baseAsset} on ${rollbackPairSymbol}`);
            const rbResult = await executeOrderWithSlippageCheck(exchange, logger, rollbackPairSymbol, rollbackSide, "MARKET", rollbackAmountBase, rbSymbolInfo, maxSlippage * 2, depthLimit); // Use higher slippage for rollback
            if (rbResult.success) {
                logger.info("[ROLLBACK] SUCCESSFUL. Final state might be closer to start asset.");
                // Update currentAmount and currentAsset based on rollback for more accurate error reporting if needed
            } else {
                logger.error(`[ROLLBACK] FAILED: ${rbResult.error}`);
            }
        } else {
            logger.error(`[ROLLBACK] Adjusted rollback amount ${rollbackAmountBase.dp(8)} for ${rollbackPairSymbol} is less than minQty or zero.`);
        }
      } else {
        logger.error("[ROLLBACK] Could not find direct pair or valid amount for rollback from " + currentAsset + " to " + startAsset);
      }
    }
    return { success: false, error: error.message, executedOrders, finalAmountAtFailure: currentAmount.toString(), finalAssetAtFailure: currentAsset };
  }
}

module.exports = {
  executeOrderWithSlippageCheck,
  simulateArbitragePath,
  executarArbitragemReal
};
