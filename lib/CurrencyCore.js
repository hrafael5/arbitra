var CurrencyCore = {};
var controller = {};

CurrencyCore.events = {};
CurrencyCore.events.onAllTickerStream = ()=>{},

// constructor
CurrencyCore.init = (ctrl) => {
  if (!ctrl.exchange){
    throw 'Undefined currency exchange connector. Will not be able to communicate with exchange API.';
  }

  // Stores
  CurrencyCore.currencies = {},
  CurrencyCore.sockets = {},
  CurrencyCore.streams = {},
  controller = ctrl,
  CurrencyCore.steps = ['BTC','ETH','BNB','USDT'];

  //CurrencyCore.startWSockets(exchange, ctrl);
  CurrencyCore.startAllTickerStream(ctrl.exchange, ctrl);
  CurrencyCore.queueTicker(5000);

  return CurrencyCore;
};

CurrencyCore.queueTicker = (interval)=>{
  if (!interval) interval = 3000;
  setTimeout(()=>{
    CurrencyCore.queueTicker(interval);
  }, interval);
  CurrencyCore.tick();
};

CurrencyCore.tick = ()=>{
  //debugger;
};

CurrencyCore.getCurrencyFromStream = (stream, fromCur, toCur)=>{
  if (!stream || !fromCur || !toCur) return;

  /*
   Binance uses xxxBTC notation. If we're looking at xxxBTC and we want to go from BTC to xxx, that means we're buying, vice versa for selling.
  */
  var currency = stream.obj[toCur + fromCur];
  if (currency){
    // found a match using reversed binance syntax, meaning we're buying if we're going from->to (btc->xxx in xxxBTC ticker) using a fromCurtoCur ticker.
    currency.flipped = false;
    currency.rate = currency.a; // Use ask price for buying

    // BNBBTC
    // ask == trying to buy
  } else {
    currency = stream.obj[fromCur + toCur];
    if (!currency){
      return false;
    }
    currency.flipped = true;
    // When selling (flipped), we want the bid price for the original pair (e.g., BTCBNB bid)
    // The rate for arbitrage calculation needs to be 1 / bid price of the original pair
    currency.rate = (1/currency.b); // Use 1 / bid price for selling

    // BTCBNB
    // bid == im trying to sell.
  }
  currency.stepFrom = fromCur;
  currency.stepTo = toCur;

  currency.tradeInfo = {
    symbol: currency.s,
    side: (currency.flipped == true) ? 'SELL' : 'BUY',
    type: 'MARKET',
    quantity: 1 // Placeholder, actual quantity calculated later
  };

  return currency;
};

CurrencyCore.getArbitageRate = (stream, step1, step2, step3)=>{
  if (!stream || !step1 || !step2 || !step3) return;
  var ret = {
    a: CurrencyCore.getCurrencyFromStream(stream, step1, step2),
    b: CurrencyCore.getCurrencyFromStream(stream, step2, step3),
    c: CurrencyCore.getCurrencyFromStream(stream, step3, step1)
  };

  if (!ret.a || !ret.b || !ret.c) return;

  // Calculate rate using the appropriate ask/bid prices fetched in getCurrencyFromStream
  ret.rate = (ret.a.rate) * (ret.b.rate) * (ret.c.rate);
  return ret;
};

CurrencyCore.getCandidatesFromStreamViaPath = (stream, aPair, bPair)=>{
  var keys = {
    a: aPair.toUpperCase(),
    b: bPair.toUpperCase(),
    c: 'findme'.toUpperCase(),
  };

  // Ensure stream.markets exists and has the required keys
  if (!stream || !stream.markets || !stream.markets[keys.a] || !stream.markets[keys.b]) {
      // console.warn(`[CurrencyCore] Market data missing for ${keys.a} or ${keys.b}`);
      return [];
  }

  var apairs = stream.markets[keys.a];
  var bpairs = stream.markets[keys.b];

  var akeys = {};
  // Use reduce for potentially cleaner mapping, ensure obj and obj.s exist
  akeys = apairs.reduce((acc, obj) => {
      if (obj && obj.s) {
          const key = obj.s.replace(keys.a, '');
          if (key !== keys.b) { // prevent 1-steps and self-references
              acc[key] = obj;
          }
      }
      return acc;
  }, {});

  var bmatches = [];
  for (let i=0;i<bpairs.length;i++){
    var bPairTicker = bpairs[i];
    // Ensure bPairTicker and its symbol 's' are valid
    if (!bPairTicker || !bPairTicker.s) continue;

    // Determine the potential third currency (key 'c')
    let potentialC = '';
    if (bPairTicker.s.startsWith(keys.b)) {
        potentialC = bPairTicker.s.substring(keys.b.length);
    } else if (bPairTicker.s.endsWith(keys.b)) {
        potentialC = bPairTicker.s.substring(0, bPairTicker.s.length - keys.b.length);
    } else {
        continue; // Pair doesn't involve keys.b as expected
    }

    // Check if this potential 'c' exists in the pairs involving 'a'
    if (akeys[potentialC]){
      keys.c = potentialC;

      // Calculate the arbitrage opportunity details
      var comparison = CurrencyCore.getArbitageRate(stream, keys.a, keys.b, keys.c);


      if (comparison && comparison.a && comparison.b && comparison.c){
          var dt = new Date();
          var triangle = {
            ws_ts: comparison.a.E, // Assuming event time comes from the first leg
            ts: +dt,
            dt: dt,

            // Leg A details (e.g., USDT -> intermediate1)
            a: comparison.a, // Raw ticker data for leg A
            a_symbol: comparison.a.s,
            a_step_from: comparison.a.stepFrom,
            a_step_to: comparison.a.stepTo,
            a_step_type: comparison.a.tradeInfo.side,
            a_rate: comparison.a.rate, // Rate used for calculation (ask or 1/bid)
            a_bid_price: comparison.a.b,
            a_bid_quantity: comparison.a.B,
            a_ask_price: comparison.a.a,
            a_ask_quantity: comparison.a.A,
            a_volume: comparison.a.v, // Base asset volume 24h
            a_quote_volume: comparison.a.q, // Quote asset volume 24h (ADDED)
            a_trades: comparison.a.n,

            // Leg B details (e.g., intermediate1 -> intermediate2)
            b: comparison.b,
            b_symbol: comparison.b.s,
            b_step_from: comparison.b.stepFrom,
            b_step_to: comparison.b.stepTo,
            b_step_type: comparison.b.tradeInfo.side,
            b_rate: comparison.b.rate,
            b_bid_price: comparison.b.b,
            b_bid_quantity: comparison.b.B,
            b_ask_price: comparison.b.a,
            b_ask_quantity: comparison.b.A,
            b_volume: comparison.b.v,
            b_quote_volume: comparison.b.q, // (ADDED)
            b_trades: comparison.b.n,

            // Leg C details (e.g., intermediate2 -> USDT)
            c: comparison.c,
            c_symbol: comparison.c.s,
            c_step_from: comparison.c.stepFrom,
            c_step_to: comparison.c.stepTo,
            c_step_type: comparison.c.tradeInfo.side,
            c_rate: comparison.c.rate,
            c_bid_price: comparison.c.b,
            c_bid_quantity: comparison.c.B,
            c_ask_price: comparison.c.a,
            c_ask_quantity: comparison.c.A,
            c_volume: comparison.c.v,
            c_quote_volume: comparison.c.q, // (ADDED)
            c_trades: comparison.c.n,

            // Overall calculated rate
            rate: comparison.rate
          };
          bmatches.push(triangle);
        }
      }
    }

  // Sort by rate descending AFTER the loop
  if (bmatches.length){
    bmatches.sort(function(a, b) { return parseFloat(b.rate) - parseFloat(a.rate); });
  }

  return bmatches;
};

CurrencyCore.getDynamicCandidatesFromStream = (stream, options)=>{
  var matches = [];

  // Ensure options and paths exist
  if (!options || !options.paths || !options.start) {
      console.error("[CurrencyCore] Invalid options provided to getDynamicCandidatesFromStream");
      return [];
  }

  for (let i=0;i<options.paths.length;i++){
    // Ensure path is valid before processing
    if (options.paths[i]) {
        var pMatches = CurrencyCore.getCandidatesFromStreamViaPath(stream, options.start, options.paths[i]);
        // Check if pMatches is an array before concatenating
        if (Array.isArray(pMatches)) {
            matches = matches.concat(pMatches);
        }
    }
  }

  // Sort final list by rate descending
  if (matches.length){
    matches.sort(function(a, b) { return parseFloat(b.rate) - parseFloat(a.rate); });
  }

  return matches;
};


// Fires once per second, with all ticker data from Binance
CurrencyCore.events.onAllTickerStream = stream =>{
  if (!stream || !Array.isArray(stream) || stream.length === 0) {
    return; // Stop processing if data is invalid
  }
  var key = 'allMarketTickers';

  // Ensure the stream storage object exists
  if (!CurrencyCore.streams[key]) {
      CurrencyCore.streams[key] = { arr: [], obj: {}, markets: {} };
  }

  // Basic array from api arr[0].s = ETHBTC
  CurrencyCore.streams[key].arr = stream;

  // Mapped object arr[ETHBTC]
  try {
    CurrencyCore.streams[key].obj = stream.reduce((acc, current) => {
      if (current && current.s) { // Check if current and current.s are valid
        acc[current.s] = current;
      } else {
        // console.warn("Invalid item in stream data:", current);
      }
      return acc;
    }, {});
  } catch (e) {
    console.error("Failed to map stream object:", e);
    return; // Stop processing if mapping fails
  }

  // Sub objects with only data on specific markets
  try {
    // Initialize markets object for each step if it doesn't exist
    CurrencyCore.steps.forEach(step => {
        if (!CurrencyCore.streams[key].markets[step]) {
            CurrencyCore.streams[key].markets[step] = [];
        }
    });

    // Clear previous market data before filtering
    for (const step in CurrencyCore.streams[key].markets) {
        CurrencyCore.streams[key].markets[step] = [];
    }

    // Populate market data
    stream.forEach(e => {
        if (e && e.s) {
            CurrencyCore.steps.forEach(step => {
                if (e.s.endsWith(step) || e.s.startsWith(step)) {
                    // Ensure the market array exists before pushing
                    if (CurrencyCore.streams[key].markets[step]) {
                        CurrencyCore.streams[key].markets[step].push(e);
                    } else {
                         // This case should ideally not happen due to initialization above
                         // console.warn(`Market array for step ${step} not initialized.`);
                    }
                }
            });
        }
    });

  } catch (e) {
    console.error("Failed to create market sub-objects:", e);
    return; // Stop processing if filtering fails
  }

  // Trigger the next step in the controller
  if (controller && controller.storage && typeof controller.storage.streamTick === 'function'){
    controller.storage.streamTick(CurrencyCore.streams[key], key);
  } else {
    // console.warn("controller.storage.streamTick not found or not a function.");
  }
};


// starts one global stream for all selectors. Stream feeds back info every second:
// https://github.com/binance-exchange/binance-official-api-docs/blob/master/web-socket-streams.md#all-market-tickers-stream
CurrencyCore.startAllTickerStream = function(exchange){
  // Initialize stream storage structure correctly
  if (!CurrencyCore.streams.allMarketTickers){
    CurrencyCore.streams.allMarketTickers = {
        arr: [],
        obj: {},
        markets: {}
    };
    // Initialize market arrays for each step
    CurrencyCore.steps.forEach(step => {
        CurrencyCore.streams.allMarketTickers.markets[step] = [];
    });
  }

  // Ensure exchange and WS are valid
  if (exchange && exchange.WS && typeof exchange.WS.onAllTickers === 'function') {
      try {
          CurrencyCore.sockets.allMarketTickerStream = exchange.WS.onAllTickers(event => CurrencyCore.events.onAllTickerStream(event));
          console.log("[CurrencyCore] Started all market tickers stream.");
      } catch (error) {
          console.error("[CurrencyCore] Error starting all market tickers stream:", error);
      }
  } else {
      console.error("[CurrencyCore] Exchange WS or onAllTickers function not available.");
  }
};

// starts streams for specific selectors (commented out, seems unused in provided index.js)
/*
CurrencyCore.startWSockets = function(exchange, ctrl){
  // loop through provided csv selectors, and initiate trades & orderBook sockets for each
  for (let i = 0;i < CurrencyCore.selectors.length;i++){
    let selector = require('./CurrencySelector.js')(CurrencyCore.selectors[i], exchange);
    CurrencyCore.currencies[selector.key] = selector;
    CurrencyCore.currencies[selector.key].handleEvent = ctrl.events.wsEvent;
    CurrencyCore.currencies[selector.key].startWSockets(ctrl.events);
  }
};
*/

module.exports = CurrencyCore.init;

