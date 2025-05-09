var inherits = require('util').inherits;
var EventEmitter = require('events').EventEmitter;
const BigNumber = require('bignumber.js'); // For precise calculations

module.exports = TradingCore;

function TradingCore(opts, currencyCore) {
  if (!(this instanceof TradingCore)) return new TradingCore(opts, currencyCore);

  this._started = Date.now();
  this._opts = opts;
  this._minQueuePercentageThreshold = (opts.trading.minQueuePercentageThreshold) ? new BigNumber(opts.trading.minQueuePercentageThreshold).dividedBy(100).plus(1) : new BigNumber(0);
  this._minHitsThreshold = (opts.trading.minHitsThreshold) ? opts.trading.minHitsThreshold : 0;
  this._currencyCore = currencyCore;
  this._activeTrades = {};
  this._exchangeInfoCache = null;
  this._exchangeInfoCacheTimestamp = 0;
  this._cacheDuration = 60 * 60 * 1000; // 1 hour cache for exchangeInfo
  this._tradeCooldowns = new Map(); // For managing cooldowns per path

  EventEmitter.call(this);
}

inherits(TradingCore, EventEmitter);

function adjustToStep(value, stepSize) {
  const bnValue = new BigNumber(value);
  const bnStepSize = new BigNumber(stepSize);
  if (bnStepSize.isZero() || bnStepSize.isNaN() || !bnStepSize.isFinite()) return bnValue.toString();
  return bnValue.minus(bnValue.modulo(bnStepSize)).decimalPlaces(bnStepSize.dp(), BigNumber.ROUND_DOWN).toString();
}

TradingCore.prototype.setCooldown = function(pathKey) {
  const cooldownMs = parseInt(this._opts.arbitrage.ARBITRAGE_COOLDOWN_MS, 10) || 30000;
  this._tradeCooldowns.set(pathKey, Date.now() + cooldownMs);
  // const logger = (typeof controller !== 'undefined' && controller.logger) ? controller.logger : console;
  // logger.debug(`[TRADING_CORE] Cooldown set for path ${pathKey} for ${cooldownMs}ms`);
};

TradingCore.prototype.isOnCooldown = function(pathKey) {
  const cooldownUntil = this._tradeCooldowns.get(pathKey);
  if (cooldownUntil && Date.now() < cooldownUntil) {
    return true;
  }
  this._tradeCooldowns.delete(pathKey);
  return false;
};

TradingCore.prototype.initiateTrade = async function(pathInfo) {
  var self = this;
  const logger = (typeof controller !== 'undefined' && controller.logger) ? controller.logger : console;
  const exchange = (typeof controller !== 'undefined' && controller.exchange) ? controller.exchange : null;

  const pathKey = `${pathInfo.a_symbol}_${pathInfo.b_symbol}_${pathInfo.c_symbol}`;

  if (!exchange) {
    logger.error(`[TRADING_CORE] Exchange API (controller.exchange) is not available. Cannot initiate trade for ${pathKey}.`);
    self.emit('tradeError', { pathInfo, error: 'Exchange API not available', pathKey });
    return;
  }

  if (self.isOnCooldown(pathKey)) {
    // logger.info(`[TRADING_CORE] Path ${pathKey} is on cooldown. Trade initiation skipped.`);
    return;
  }

  if (this._opts.trading.paperOnly) {
    logger.info(`[PAPER_TRADE_LOGGED] Path ${pathKey}, Est. Net Profit: ${pathInfo.simulation.netProfitPercentage.toFixed(8)}%. Simulation: Initial ${pathInfo.simulation.initialCapital.toString()} ${pathInfo.simulation.startCurrency}, Final ${pathInfo.simulation.finalCapital.toString()} ${pathInfo.simulation.finalCurrency}`);
    self.setCooldown(pathKey);
    self.emit('tradeCompleted', { pathInfo, paperTrade: true, success: true, details: 'Paper trade logged.', pathKey });
    return;
  }

  logger.info(`[REAL_TRADE_ATTEMPT] Initiating trade for path: ${pathKey}. Est. Profit: ${pathInfo.simulation.netProfitPercentage.toFixed(8)}%`);
  self.emit('tradeInitiated', {pathInfo, pathKey});
  self.setCooldown(pathKey); // Set cooldown immediately

  let exchangeInfo;
  try {
    exchangeInfo = await self.getExchangeInfo();
  } catch (err) {
    logger.error(`[TRADING_CORE] CRITICAL: Failed to get exchange info for real trade ${pathKey}: ${err.message}`);
    self.emit('tradeError', { pathInfo, error: 'Failed to get exchange info for real trade.', pathKey, critical: true });
    return;
  }

  const feeRate = new BigNumber(self._opts.arbitrage.binanceTradeFeePercent).dividedBy(100);
  const startCurrency = self._opts.arbitrage.startCurrency || 'USDT';
  let currentCapitalAsset = startCurrency;
  let currentCapitalAmount = new BigNumber(self._opts.arbitrage.arbitrageCapitalUSDT);

  const pathDefinition = [
    { from: pathInfo.a_step_from, to: pathInfo.a_step_to, symbol: pathInfo.a_symbol },
    { from: pathInfo.b_step_from, to: pathInfo.b_step_to, symbol: pathInfo.b_symbol },
    { from: pathInfo.c_step_from, to: pathInfo.c_step_to, symbol: pathInfo.c_symbol },
  ];

  const executedTrades = [];
  let legError = null;

  try {
    for (let i = 0; i < pathDefinition.length; i++) {
      const leg = pathDefinition[i];
      logger.info(`[REAL_TRADE_LEG_${i+1}/${pathDefinition.length}] Processing ${leg.symbol}: ${leg.from} -> ${leg.to}. Current capital: ${currentCapitalAmount.dp(8).toString()} ${currentCapitalAsset}`);

      if (currentCapitalAsset !== leg.from) {
        throw new Error(`Asset mismatch for leg ${i+1} (${leg.symbol}): Expected ${leg.from}, have ${currentCapitalAsset}`);
      }

      const pairInfo = exchangeInfo[leg.symbol];
      if (!pairInfo || pairInfo.status !== 'TRADING') {
        throw new Error(`Symbol ${leg.symbol} (leg ${i+1}) is not trading or no info available.`);
      }

      const filters = pairInfo.filters.reduce((obj, filter) => { obj[filter.filterType] = filter; return obj; }, {});
      const lotSizeFilter = filters['LOT_SIZE'] || filters['MARKET_LOT_SIZE'];
      const minNotionalFilter = filters['MIN_NOTIONAL'];
      
      if (!lotSizeFilter || !lotSizeFilter.stepSize) throw new Error(`LOT_SIZE filter (or stepSize) not found for ${leg.symbol} (leg ${i+1})`);

      const ticker = await new Promise((resolve, reject) => {
        exchange.bookTickers(leg.symbol, (error, tickerResponse) => {
          if (error) return reject(new Error(`API Error: Failed to get bookTicker for ${leg.symbol} (leg ${i+1}): ${JSON.stringify(error)}`));
          if (!tickerResponse || typeof tickerResponse !== 'object') return reject(new Error(`Invalid bookTicker response for ${leg.symbol} (leg ${i+1})`));
          resolve(tickerResponse);
        });
      });

      if (!ticker.bidPrice || !ticker.askPrice) {
          throw new Error(`Could not get valid bid/ask prices from ticker for ${leg.symbol} (leg ${i+1})`);
      }
      
      let price;
      let quantityToTrade;
      let orderSide; 

      if (leg.from === pairInfo.quoteAsset && leg.to === pairInfo.baseAsset) {
        orderSide = 'BUY';
        price = new BigNumber(ticker.askPrice);
        if (price.isZero() || price.isLessThan(0)) throw new Error(`Ask price for ${leg.symbol} (leg ${i+1}) is zero or negative.`);
        quantityToTrade = currentCapitalAmount.dividedBy(price); // Quantity of base asset to buy
      } else if (leg.from === pairInfo.baseAsset && leg.to === pairInfo.quoteAsset) {
        orderSide = 'SELL';
        price = new BigNumber(ticker.bidPrice);
        if (price.isZero() || price.isLessThan(0)) throw new Error(`Bid price for ${leg.symbol} (leg ${i+1}) is zero or negative.`);
        quantityToTrade = currentCapitalAmount; // Quantity of base asset to sell
      } else {
        throw new Error(`Asset path ${leg.from}->${leg.to} does not match symbol ${leg.symbol} base/quote assets (${pairInfo.baseAsset}/${pairInfo.quoteAsset}) for leg ${i+1}`);
      }

      let adjustedQuantity = new BigNumber(adjustToStep(quantityToTrade, lotSizeFilter.stepSize));

      if (adjustedQuantity.isZero() || adjustedQuantity.isLessThan(0)) {
        throw new Error(`Calculated quantity for ${leg.symbol} (leg ${i+1}) is zero or negative: ${adjustedQuantity.dp(8).toString()} (from original ${quantityToTrade.dp(8).toString()})`);
      }
      if (lotSizeFilter.minQty && adjustedQuantity.isLessThan(lotSizeFilter.minQty)) {
        throw new Error(`Order for ${leg.symbol} (leg ${i+1}) qty ${adjustedQuantity.dp(8).toString()} is less than minQty ${lotSizeFilter.minQty}. (Original qty: ${quantityToTrade.dp(8).toString()})`);
      }
      if (minNotionalFilter && minNotionalFilter.minNotional) {
          const notionalValue = adjustedQuantity.multipliedBy(price);
          if (notionalValue.isLessThan(minNotionalFilter.minNotional)) {
            throw new Error(`Order for ${leg.symbol} (leg ${i+1}) notional value ${notionalValue.dp(8).toString()} is less than minNotional ${minNotionalFilter.minNotional}. (Qty: ${adjustedQuantity.dp(8).toString()}, Price: ${price.dp(8).toString()})`);
          }
      }
      
      logger.info(`[REAL_TRADE_LEG_${i+1}] Attempting ${orderSide} ${adjustedQuantity.dp(8).toString()} of ${orderSide === 'BUY' ? pairInfo.baseAsset : leg.from} for ${leg.symbol} at market price (est. ${price.dp(8).toString()})`);

      let orderResult;
      const orderParams = { timeInForce: 'GTC' }; // GTC is typical for market orders, though often ignored by API for MARKET type.

      if (orderSide === 'BUY') {
        orderResult = await new Promise((resolve, reject) => {
          exchange.marketBuy(leg.symbol, adjustedQuantity.toString(), orderParams, (error, response) => {
            if (error) return reject(new Error(typeof error === 'string' ? error : (error.body ? JSON.stringify(error.body) : JSON.stringify(error)) ));
            resolve(response);
          });
        });
      } else { // SELL
        orderResult = await new Promise((resolve, reject) => {
          exchange.marketSell(leg.symbol, adjustedQuantity.toString(), orderParams, (error, response) => {
            if (error) return reject(new Error(typeof error === 'string' ? error : (error.body ? JSON.stringify(error.body) : JSON.stringify(error)) ));
            resolve(response);
          });
        });
      }

      logger.info(`[REAL_TRADE_LEG_${i+1}] ${orderSide} order for ${leg.symbol} API response: ${JSON.stringify(orderResult)}`);

      if (!orderResult || !orderResult.orderId) {
         throw new Error(`Order for ${leg.symbol} (leg ${i+1}) failed: No orderId in response. Response: ${JSON.stringify(orderResult)}`);
      }
      // For MARKET orders, status should be FILLED. If it's NEW or PARTIALLY_FILLED immediately, something is unusual or it's a non-atomic market order execution.
      // We will rely on executedQty and cummulativeQuoteQty for the actual amounts.
      if (orderResult.status !== 'FILLED') {
        logger.warn(`[REAL_TRADE_LEG_${i+1}] Order for ${leg.symbol} status is '${orderResult.status}', not 'FILLED'. This might be acceptable if executedQty > 0. Will proceed based on executedQty.`);
      }
      if (!orderResult.executedQty || new BigNumber(orderResult.executedQty).isZero()){
        throw new Error(`Order for ${leg.symbol} (leg ${i+1}) executed with zero quantity. Status: ${orderResult.status}. Response: ${JSON.stringify(orderResult)}`);
      }
      
      executedTrades.push({ leg, orderResult });
      let executedQty = new BigNumber(orderResult.executedQty);
      let cummulativeQuoteQty = new BigNumber(orderResult.cummulativeQuoteQty);
      
      if (orderSide === 'BUY') {
        // After BUY, capital is in baseAsset, amount is executedQty (minus fee implicitly handled by Binance)
        currentCapitalAmount = executedQty; 
        currentCapitalAsset = pairInfo.baseAsset;
        logger.info(`[REAL_TRADE_LEG_${i+1}] Successfully BOUGHT ${executedQty.dp(8).toString()} ${pairInfo.baseAsset}. New capital: ${currentCapitalAmount.dp(8).toString()} ${currentCapitalAsset}`);
      } else { // SELL
        // After SELL, capital is in quoteAsset, amount is cummulativeQuoteQty (minus fee implicitly handled by Binance)
        currentCapitalAmount = cummulativeQuoteQty; 
        currentCapitalAsset = pairInfo.quoteAsset;
        logger.info(`[REAL_TRADE_LEG_${i+1}] Successfully SOLD ${executedQty.dp(8).toString()} ${pairInfo.baseAsset} for ${cummulativeQuoteQty.dp(8).toString()} ${pairInfo.quoteAsset}. New capital: ${currentCapitalAmount.dp(8).toString()} ${currentCapitalAsset}`);
      }
      // Apply fee explicitly for our accounting, though Binance reports amounts post-fee.
      currentCapitalAmount = currentCapitalAmount.multipliedBy(new BigNumber(1).minus(feeRate));
      logger.info(`[REAL_TRADE_LEG_${i+1}] Capital after applying fee (${feeRate.multipliedBy(100).toFixed(4)}%): ${currentCapitalAmount.dp(8).toString()} ${currentCapitalAsset}`);
    }

    // All legs executed successfully
    logger.info(`[REAL_TRADE_SUCCESS] Path ${pathKey} executed successfully.`);
    logger.info(`Initial capital: ${new BigNumber(self._opts.arbitrage.arbitrageCapitalUSDT).dp(8).toString()} ${startCurrency}. Final capital: ${currentCapitalAmount.dp(8).toString()} ${currentCapitalAsset}`);
    if (currentCapitalAsset !== startCurrency) {
        logger.warn(`[REAL_TRADE_SUCCESS_WARNING] Final asset ${currentCapitalAsset} is different from start asset ${startCurrency}. Profit calculation might be misleading if not converted back.`);
    }
    self.emit('tradeCompleted', { pathInfo, success: true, executedTrades, initialCapitalAmount: self._opts.arbitrage.arbitrageCapitalUSDT, initialCapitalAsset: startCurrency, finalCapitalAmount: currentCapitalAmount.toString(), finalCapitalAsset: currentCapitalAsset, pathKey });

  } catch (error) {
    legError = error; // Store the error that broke the loop
    logger.error(`[REAL_TRADE_FAILED] Error during execution of path ${pathKey} (Leg ${executedTrades.length + 1}): ${error.message}`);
    logger.error("[REAL_TRADE_FAILED] Error stack:", error.stack);
    logger.error("[REAL_TRADE_FAILED] Executed trades so far:", JSON.stringify(executedTrades.map(t => ({ symbol: t.leg.symbol, orderId: t.orderResult.orderId, status: t.orderResult.status, executedQty: t.orderResult.executedQty }) )));
    self.emit('tradeError', { pathInfo, error: error.message, executedTrades, currentCapitalAmount: currentCapitalAmount.toString(), currentCapitalAsset, pathKey });

    // ROLLBACK ATTEMPT
    if (executedTrades.length > 0 && currentCapitalAsset !== startCurrency) {
      logger.warn(`[ROLLBACK_ATTEMPT] Path ${pathKey} failed. Current asset: ${currentCapitalAmount.dp(8).toString()} ${currentCapitalAsset}. Attempting to convert back to ${startCurrency}`);
      try {
        const targetCurrency = startCurrency;
        let rollbackPairSymbol = null;
        let rollbackSide = null; // 'BUY' or 'SELL' on the rollbackPairSymbol

        // Scenario 1: Current asset is BASE of a pair with QUOTE = targetCurrency (e.g., current=BTC, target=USDT, pair=BTCUSDT, so SELL BTC)
        const directSellPair = currentCapitalAsset + targetCurrency;
        if (exchangeInfo[directSellPair] && exchangeInfo[directSellPair].status === 'TRADING' && exchangeInfo[directSellPair].baseAsset === currentCapitalAsset && exchangeInfo[directSellPair].quoteAsset === targetCurrency) {
            rollbackPairSymbol = directSellPair;
            rollbackSide = 'SELL'; // Sell current (base) to get target (quote)
        }
        // Scenario 2: Current asset is QUOTE of a pair with BASE = targetCurrency (e.g., current=USDT, target=BTC, pair=BTCUSDT, so BUY BTC)
        const directBuyPair = targetCurrency + currentCapitalAsset;
        if (!rollbackPairSymbol && exchangeInfo[directBuyPair] && exchangeInfo[directBuyPair].status === 'TRADING' && exchangeInfo[directBuyPair].baseAsset === targetCurrency && exchangeInfo[directBuyPair].quoteAsset === currentCapitalAsset) {
            rollbackPairSymbol = directBuyPair;
            rollbackSide = 'BUY'; // Buy target (base) using current (quote)
        }

        if (rollbackPairSymbol && rollbackSide) {
            const rbPairInfo = exchangeInfo[rollbackPairSymbol];
            const rbLotSizeFilter = rbPairInfo.filters.reduce((obj, filter) => { obj[filter.filterType] = filter; return obj; }, {})['LOT_SIZE'] || rbPairInfo.filters.reduce((obj, filter) => { obj[filter.filterType] = filter; return obj; }, {})['MARKET_LOT_SIZE'];
            const rbMinNotionalFilter = rbPairInfo.filters.reduce((obj, filter) => { obj[filter.filterType] = filter; return obj; }, {})['MIN_NOTIONAL'];
            
            if (!rbLotSizeFilter || !rbLotSizeFilter.stepSize) throw new Error(`LOT_SIZE filter (or stepSize) not found for rollback symbol ${rollbackPairSymbol}`);

            const rbTicker = await new Promise((resolve, reject) => {
              exchange.bookTickers(rollbackPairSymbol, (err, tickerRes) => {
                if (err) return reject(new Error(`API Error: Failed to get bookTicker for rollback ${rollbackPairSymbol}: ${JSON.stringify(err)}`));
                if (!tickerRes || typeof tickerRes !== 'object') return reject(new Error(`Invalid bookTicker response for rollback ${rollbackPairSymbol}`));
                resolve(tickerRes);
              });
            });
            if (!rbTicker.bidPrice || !rbTicker.askPrice) throw new Error(`Could not get valid bid/ask prices for rollback ticker ${rollbackPairSymbol}`);

            let quantityForRollback;
            let rbPrice;

            if (rollbackSide === 'SELL') { // Selling currentCapitalAsset (which is base in rollbackPairSymbol)
                quantityForRollback = new BigNumber(adjustToStep(currentCapitalAmount, rbLotSizeFilter.stepSize));
                rbPrice = new BigNumber(rbTicker.bidPrice); // We are selling, so use bid price for estimation
            } else { // BUYING targetCurrency (which is base in rollbackPairSymbol) with currentCapitalAsset (quote)
                rbPrice = new BigNumber(rbTicker.askPrice); // We are buying, so use ask price
                if (rbPrice.isZero() || rbPrice.isLessThan(0)) throw new Error(`Rollback ask price for ${rollbackPairSymbol} is zero or negative.`);
                quantityForRollback = new BigNumber(adjustToStep(currentCapitalAmount.dividedBy(rbPrice), rbLotSizeFilter.stepSize));
            }

            if (quantityForRollback.isZero() || quantityForRollback.isLessThan(0)) {
                throw new Error(`Rollback quantity for ${rollbackPairSymbol} is zero or negative: ${quantityForRollback.dp(8).toString()}`);
            }
            if (rbLotSizeFilter.minQty && quantityForRollback.isLessThan(rbLotSizeFilter.minQty)) {
                throw new Error(`Rollback quantity ${quantityForRollback.dp(8).toString()} for ${rollbackPairSymbol} is less than minQty ${rbLotSizeFilter.minQty}`);
            }
            if (rbMinNotionalFilter && rbMinNotionalFilter.minNotional) {
                const rbNotional = quantityForRollback.multipliedBy(rbPrice);
                if (rbNotional.isLessThan(rbMinNotionalFilter.minNotional)) {
                    throw new Error(`Rollback notional value ${rbNotional.dp(8).toString()} for ${rollbackPairSymbol} is less than minNotional ${rbMinNotionalFilter.minNotional}`);
                }
            }

            logger.info(`[ROLLBACK_ATTEMPT] Attempting ${rollbackSide} ${quantityForRollback.dp(8).toString()} of ${rollbackSide === 'SELL' ? rbPairInfo.baseAsset : targetCurrency} via ${rollbackPairSymbol}`);
            const rbOrderParams = { timeInForce: 'GTC' };
            let rollbackOrderResult;

            if (rollbackSide === 'SELL') {
                rollbackOrderResult = await new Promise((resolve, reject) => exchange.marketSell(rollbackPairSymbol, quantityForRollback.toString(), rbOrderParams, (e,r) => e ? reject(new Error(e.body ? JSON.stringify(e.body) : JSON.stringify(e))) : resolve(r)));
            } else { // BUY
                rollbackOrderResult = await new Promise((resolve, reject) => exchange.marketBuy(rollbackPairSymbol, quantityForRollback.toString(), rbOrderParams, (e,r) => e ? reject(new Error(e.body ? JSON.stringify(e.body) : JSON.stringify(e))) : resolve(r)));
            }
            logger.info(`[ROLLBACK_ATTEMPT] ${rollbackSide} order response: ${JSON.stringify(rollbackOrderResult)}`);
            if (rollbackOrderResult && rollbackOrderResult.orderId && rollbackOrderResult.status === 'FILLED' && new BigNumber(rollbackOrderResult.executedQty).isGreaterThan(0)) {
                logger.info(`[ROLLBACK_SUCCESS] Successfully executed rollback trade. OrderId: ${rollbackOrderResult.orderId}`);
                self.emit('tradeRollbackSuccess', { pathInfo, pathKey, rollbackOrderResult, originalError: legError ? legError.message : 'Unknown leg error' });
            } else {
                throw new Error(`Rollback order for ${rollbackPairSymbol} failed or did not fill. Response: ${JSON.stringify(rollbackOrderResult)}`);
            }
        } else {
          logger.warn(`[ROLLBACK_ATTEMPT] Cannot find suitable direct trading pair to convert ${currentCapitalAsset} to ${targetCurrency}. Manual intervention may be required.`);
          self.emit('tradeRollbackFailed', { pathInfo, pathKey, error: `No direct pair to convert ${currentCapitalAsset} to ${targetCurrency}`, currentCapitalAsset, currentCapitalAmount: currentCapitalAmount.toString(), originalError: legError ? legError.message : 'Unknown leg error' });
        }
      } catch (rollbackError) {
        logger.error(`[ROLLBACK_FAILED] Error during rollback attempt for path ${pathKey}: ${rollbackError.message}`);
        logger.error("[ROLLBACK_FAILED] Rollback error stack:", rollbackError.stack);
        self.emit('tradeRollbackFailed', { pathInfo, pathKey, error: rollbackError.message, currentCapitalAsset, currentCapitalAmount: currentCapitalAmount.toString(), originalError: legError ? legError.message : 'Unknown leg error' });
      }
    } else if (executedTrades.length === 0 && legError) {
        logger.info(`[REAL_TRADE_FAILED] Trade failed on first leg or before any execution for path ${pathKey}. No rollback needed as capital is still in ${startCurrency}.`);
    } else if (currentCapitalAsset === startCurrency && legError){
        logger.info(`[REAL_TRADE_FAILED] Trade failed but current asset ${currentCapitalAsset} is already the start currency ${startCurrency}. No rollback needed.`);
    }
  }
};

TradingCore.prototype.updateCandidateQueue = function(stream, candidates, queueInput){ // queueInput is the old object-based queue
  var self = this;
  let newQueue = {}; // Process into a new queue object to avoid modifying while iterating if issues arise
  if (typeof queueInput === 'object' && queueInput !== null) {
    Object.assign(newQueue, queueInput);
  }

  for (let i=0;i<candidates.length;i++){
    let cand = candidates[i];
    // Use a more unique pathKey based on symbols for cooldown and identification
    let pathKey = `${cand.a_symbol}_${cand.b_symbol}_${cand.c_symbol}`;

    if (self.isOnCooldown(pathKey)) continue;
    
    // Ensure cand.rate is a BigNumber for comparison
    const candRate = new BigNumber(cand.rate);
    const profitThreshold = new BigNumber(this._opts.arbitrage.grossProfitThresholdPercent).dividedBy(100).plus(1);

    if (candRate.isGreaterThanOrEqualTo(profitThreshold)){
      // Use pathKey for the queue to ensure uniqueness and align with cooldown logic
      if (!newQueue[pathKey]){
        newQueue[pathKey] = { ...cand, rates: [], hits: 0, pathKey: pathKey }; // Store pathKey in candidate object
      }
      newQueue[pathKey].hits++;
      newQueue[pathKey].rates.push(candRate); // Store BigNumber rate     
    } else {
      break; // Assuming candidates are sorted by rate
    }
  }
  
  // Convert queue object to sorted array for processing
  let sortedQueueArray = Object.values(newQueue).sort((a, b) => {
      if (b.hits === a.hits) {
          const avgRateA = a.rates.reduce((sum, rate) => sum.plus(rate), new BigNumber(0)).dividedBy(a.rates.length || 1);
          const avgRateB = b.rates.reduce((sum, rate) => sum.plus(rate), new BigNumber(0)).dividedBy(b.rates.length || 1);
          return avgRateB.comparedTo(avgRateA); // Higher average rate is better
      }
      return b.hits - a.hits; // More hits is better
  });

  self.candidateQueue = sortedQueueArray; 
  self.emit('queueUpdated', self.candidateQueue);
  if (self.candidateQueue.length > 0) {
    self.processQueue(self.candidateQueue, stream); 
  }
  return newQueue; // Return the object-based queue that was built (might be used by caller)
};

TradingCore.prototype.processQueue = async function(queueArray, stream){ 
  var self = this;
  const logger = (typeof controller !== 'undefined' && controller.logger) ? controller.logger : console;

  for (let i=0; i < queueArray.length; i++){
    let cand = queueArray[i]; // cand already includes pathKey

    if (self.isOnCooldown(cand.pathKey)) {
        // logger.debug(`[PROCESS_QUEUE] Path ${cand.pathKey} is on cooldown, skipping.`);
        continue;
    }
    
    if (cand.hits >= this._minHitsThreshold){
      try {
        // Pass the full candidate object, which should include all necessary path details (a_step_from etc.)
        const simulationResult = await self.simulateArbitragePath(cand, stream);
        
        // Ensure _minQueuePercentageThreshold is correctly used (it's rate, e.g., 1.005 for 0.5%)
        // simulationResult.netProfitPercentage is already a percentage (e.g., 0.5 for 0.5%)
        const minNetProfitPercent = this._minQueuePercentageThreshold.minus(1).multipliedBy(100);

        if (simulationResult && simulationResult.netProfitPercentage.isGreaterThanOrEqualTo(minNetProfitPercent)) { 
          logger.info(`[TRADE_OPPORTUNITY] Path ${cand.pathKey} met profit threshold. Est. Net Profit: ${simulationResult.netProfitPercentage.toFixed(8)}% (Threshold: ${minNetProfitPercent.toFixed(8)}%)`);
          self.emit('newTradeQueued', { ...cand, simulation: simulationResult }, self.time());
          await self.initiateTrade({ ...cand, simulation: simulationResult }); 
        } else if (simulationResult) {
          // logger.debug(`[PROCESS_QUEUE] Path ${cand.pathKey} simulated. Net profit ${simulationResult.netProfitPercentage.toFixed(8)}% did not meet threshold ${minNetProfitPercent.toFixed(8)}%`);
        }
      } catch (error) {
        logger.error(`[PROCESS_QUEUE] Error during simulation or trade initiation for ${cand.pathKey}: ${error.message}. Stack: ${error.stack ? error.stack.split('\n')[0] : 'No stack'}`);
      }
    }
  }
};

TradingCore.prototype.getExchangeInfo = async function() {
  var self = this;
  const exchange = (typeof controller !== 'undefined' && controller.exchange) ? controller.exchange : null;
  if (!exchange) {
    return Promise.reject(new Error('Exchange API (controller.exchange) is not available in TradingCore context'));
  }

  if (self._exchangeInfoCache && (Date.now() - self._exchangeInfoCacheTimestamp < self._cacheDuration)) {
    return self._exchangeInfoCache;
  }
  return new Promise((resolve, reject) => {
    exchange.exchangeInfo((error, data) => {
      if (error) return reject(new Error ( JSON.stringify(error.body || error.message || error) ));
      if (data && data.symbols && Array.isArray(data.symbols)) {
        self._exchangeInfoCache = data.symbols.reduce((obj, item) => {
          obj[item.symbol] = item;
          return obj;
        }, {});
        self._exchangeInfoCacheTimestamp = Date.now();
        resolve(self._exchangeInfoCache);
      } else {
        reject(new Error('Failed to fetch or parse exchangeInfo: Data or symbols array missing or not an array.'));
      }
    });
  });
};

TradingCore.prototype.simulateArbitragePath = async function(candidate, stream) {
  var self = this;
  const logger = (typeof controller !== 'undefined' && controller.logger) ? controller.logger : console;
  let exchangeInfo;
  try {
    exchangeInfo = await self.getExchangeInfo();
  } catch (err) {
      logger.error(`[SIMULATE] CRITICAL: Failed to get exchange info for simulation of path ${candidate.pathKey || 'N/A'}: ${err.message}`);
      throw err; 
  }

  const fee = new BigNumber(self._opts.arbitrage.binanceTradeFeePercent).dividedBy(100);
  const initialSimulatedCapital = new BigNumber(self._opts.arbitrage.arbitrageCapitalUSDT);
  let currentSimulatedCapital = initialSimulatedCapital;
  const startCurrency = self._opts.arbitrage.startCurrency || 'USDT';
  let currentSimulatedAsset = startCurrency;

  const path = [
    { from: candidate.a_step_from, to: candidate.a_step_to, symbol: candidate.a_symbol },
    { from: candidate.b_step_from, to: candidate.b_step_to, symbol: candidate.b_symbol },
    { from: candidate.c_step_from, to: candidate.c_step_to, symbol: candidate.c_symbol },
  ];

  for (let i = 0; i < path.length; i++) {
    const leg = path[i];

    if (currentSimulatedAsset !== leg.from) {
        // logger.debug(`[SIMULATE] Path ${candidate.pathKey}: Asset mismatch for leg ${i+1} (${leg.symbol}). Expected ${leg.from}, have ${currentSimulatedAsset}.`);
        return null;
    }

    const pairInfo = exchangeInfo[leg.symbol];
    if (!pairInfo || pairInfo.status !== 'TRADING') {
      // logger.debug(`[SIMULATE] Path ${candidate.pathKey}: Leg ${i+1} (${leg.symbol}) not trading or no info.`);
      return null;
    }

    const filters = pairInfo.filters.reduce((obj, filter) => { obj[filter.filterType] = filter; return obj; }, {});
    const lotSizeFilter = filters['LOT_SIZE'] || filters['MARKET_LOT_SIZE'];
    const minNotionalFilter = filters['MIN_NOTIONAL'];
    if (!lotSizeFilter || !lotSizeFilter.stepSize) { /*logger.debug(`[SIMULATE] Path ${candidate.pathKey}: LOT_SIZE filter/stepSize missing for ${leg.symbol}`);*/ return null; }

    let price, qtyTradedSim, obtainedAmountSim;
    const tickerData = self._currencyCore.getCurrencyFromStream(stream, leg.from, leg.to);
    if (!tickerData || !tickerData.a || !tickerData.b) {
        // logger.debug(`[SIMULATE] Path ${candidate.pathKey}: No stream ticker data for ${leg.from}->${leg.to} (${leg.symbol})`);
        return null;
    }

    if (leg.from === pairInfo.quoteAsset && leg.to === pairInfo.baseAsset) { // BUY base with quote
        price = new BigNumber(tickerData.a); 
        if (price.isZero() || price.isLessThan(0)) return null; 
        let quantityToBuySim = currentSimulatedCapital.dividedBy(price); 
        qtyTradedSim = new BigNumber(adjustToStep(quantityToBuySim, lotSizeFilter.stepSize));
        obtainedAmountSim = qtyTradedSim; // For simulation, assume fee is applied at the end or per trade based on Binance's typical reporting
        currentSimulatedCapital = obtainedAmountSim.multipliedBy(new BigNumber(1).minus(fee)); 
        currentSimulatedAsset = pairInfo.baseAsset;
    } else if (leg.from === pairInfo.baseAsset && leg.to === pairInfo.quoteAsset) { // SELL base for quote
        price = new BigNumber(tickerData.b); 
        if (price.isZero() || price.isLessThan(0)) return null;
        let quantityToSellSim = currentSimulatedCapital; 
        qtyTradedSim = new BigNumber(adjustToStep(quantityToSellSim, lotSizeFilter.stepSize));
        obtainedAmountSim = qtyTradedSim.multipliedBy(price); 
        currentSimulatedCapital = obtainedAmountSim.multipliedBy(new BigNumber(1).minus(fee)); 
        currentSimulatedAsset = pairInfo.quoteAsset;
    } else {
        // logger.debug(`[SIMULATE] Path ${candidate.pathKey}: Asset path ${leg.from}->${leg.to} does not match symbol ${leg.symbol} base/quote assets.`);
        return null;
    }
    
    if (qtyTradedSim.isZero() || qtyTradedSim.isLessThan(0)) return null;
    if (lotSizeFilter.minQty && qtyTradedSim.isLessThan(lotSizeFilter.minQty)) return null;
    if (minNotionalFilter && minNotionalFilter.minNotional) {
        if (price.multipliedBy(qtyTradedSim).isLessThan(minNotionalFilter.minNotional)) return null;
    }
  }
  
  if (currentSimulatedAsset !== startCurrency) {
    // logger.debug(`[SIMULATE] Path ${candidate.pathKey} did not end in start currency ${startCurrency}. Ended in ${currentSimulatedAsset}.`);
    return null;
  }

  const netProfit = currentSimulatedCapital.minus(initialSimulatedCapital);
  const netProfitPercentage = initialSimulatedCapital.isZero() ? new BigNumber(0) : netProfit.dividedBy(initialSimulatedCapital).multipliedBy(100);

  return {
    initialCapital: initialSimulatedCapital,
    finalCapital: currentSimulatedCapital,
    netProfit: netProfit,
    netProfitPercentage: netProfitPercentage,
    startCurrency: startCurrency,
    finalCurrency: currentSimulatedAsset
  };
};

TradingCore.prototype.time = function() {  
  var self = this;
  return this._started && Date.now() - this._started;
};

