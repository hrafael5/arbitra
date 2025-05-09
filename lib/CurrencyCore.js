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
    currency.rate = currency.a;

    // BNBBTC
    // ask == trying to buy
  } else {
    currency = stream.obj[fromCur + toCur];
    if (!currency){
      return false;
    }
    currency.flipped = true;
    currency.rate = (1/currency.b);

    // BTCBNB
    // bid == im trying to sell.
  }
  currency.stepFrom = fromCur;
  currency.stepTo = toCur;

  currency.tradeInfo = {
    symbol: currency.s,
    side: (currency.flipped == true) ? 'SELL' : 'BUY',
    type: 'MARKET',
    quantity: 1
  };
  // console.log('getCurrencyFromStream: from/to: ', currency.stepFrom, currency.stepTo);

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

  ret.rate = (ret.a.rate) * (ret.b.rate) * (ret.c.rate);
  return ret;
};

CurrencyCore.getCandidatesFromStreamViaPath = (stream, aPair, bPair)=>{
  var keys = {
    a: aPair.toUpperCase(),
    b: bPair.toUpperCase(),
    c: 'findme'.toUpperCase(),
  };

  var bmatches = []; // Initialize bmatches early

  // Check if stream and stream.markets are valid before trying to access them
  if (!stream || !stream.markets) {
    if (controller && controller.logger) {
      // controller.logger.warn(`[CurrencyCore] stream or stream.markets is undefined in getCandidatesFromStreamViaPath. Path: ${keys.a}->${keys.b}->C`);
    }
    return bmatches; // Return empty array if stream or markets object is missing
  }

  var apairs = stream.markets[keys.a];
  var bpairs = stream.markets[keys.b];

  // Check if apairs and bpairs are valid arrays before proceeding.
  if (!Array.isArray(apairs) || !Array.isArray(bpairs)) {
    if (controller && controller.logger) {
      // if (!Array.isArray(apairs)) controller.logger.warn(`[CurrencyCore] No market data for base ${keys.a} in getCandidatesFromStreamViaPath. Path: ${keys.a}->${keys.b}->C`);
      // if (!Array.isArray(bpairs)) controller.logger.warn(`[CurrencyCore] No market data for base ${keys.b} in getCandidatesFromStreamViaPath. Path: ${keys.a}->${keys.b}->C`);
    }
    return bmatches; // Return empty array if essential market data is missing for this path
  }

  var akeys = {}; // Initialize akeys as an object
  if (apairs.length > 0) { // Ensure apairs is not empty before mapping
     apairs.forEach((obj)=>{ akeys[obj.s.replace(keys.a, '')] = obj; }); // Use forEach for objects, or ensure akeys is an array if map is intended for array ops
  }

  // prevent 1-steps
  delete akeys[keys.b];

  /*
    Loop through BPairs
      for each bpair key, check if apair has it too.
      If it does, run arbitrage math
  */
  for (let i=0;i<bpairs.length;i++){
    var bPairTicker = bpairs[i];
    bPairTicker.key = bPairTicker.s.replace(keys.b,'');

    // from B to C
    bPairTicker.startsWithKey = bPairTicker.s.startsWith(keys.b);

    // from C to B
    bPairTicker.endsWithKey = bPairTicker.s.endsWith(keys.b);

    if (akeys[bPairTicker.key]){
      var match = bPairTicker;
      // check price from bPairTicker.key to keys.a

      var stepC = CurrencyCore.getCurrencyFromStream(stream, match.key, keys.a);

      // only do this if we definitely found a path. Some paths are impossible, so will result in an empty stepC quote.
      if (stepC){
        keys.c = match.key;

        var comparison = CurrencyCore.getArbitageRate(stream, keys.a, keys.b, keys.c);


        if (comparison){
          // console.log('getCandidatesFromStreamViaPath: from/to a: ', comparison.a.stepFrom, comparison.a.stepTo);
          // console.log('getCandidatesFromStreamViaPath: from/to b: ', comparison.b.stepFrom, comparison.b.stepTo);
          // console.log('getCandidatesFromStreamViaPath: from/to c: ', comparison.c.stepFrom, comparison.c.stepTo);

          var dt = new Date();
          var triangle = {
            ws_ts: comparison.a.E,
            ts: +dt,
            dt: dt,

            // these are for storage later
            a: comparison.a,//full ticker for first pair (BTC->BNB)
            a_symbol: comparison.a.s,
            a_step_from: comparison.a.stepFrom,//btc
            a_step_to: comparison.a.stepTo,//bnb
            a_step_type: comparison.a.tradeInfo.side,
            a_bid_price: comparison.a.b,
            a_bid_quantity: comparison.a.B,
            a_ask_price: comparison.a.a,
            a_ask_quantity: comparison.a.A,
            a_volume: comparison.a.v,
            a_trades: comparison.a.n,

            b: comparison.b,//full ticker for second pair (BNB->XMR)
            b_symbol: comparison.b.s,
            b_step_from: comparison.b.stepFrom,//bnb
            b_step_to: comparison.b.stepTo,//xmr
            b_step_type: comparison.b.tradeInfo.side,
            b_bid_price: comparison.b.b,
            b_bid_quantity: comparison.b.B,
            b_ask_price: comparison.b.a,
            b_ask_quantity: comparison.b.A,
            b_volume: comparison.b.v,
            b_trades: comparison.b.n,

            c: comparison.c,////full ticker for third pair (XMR->BTC)
            c_symbol: comparison.c.s,
            c_step_from: comparison.c.stepFrom,//xmr
            c_step_to: comparison.c.stepTo,//btc
            c_step_type: comparison.c.tradeInfo.side,
            c_bid_price: comparison.c.b,
            c_bid_quantity: comparison.c.B,
            c_ask_price: comparison.c.a,
            c_ask_quantity: comparison.c.A,
            c_volume: comparison.c.v,
            c_trades: comparison.c.n,

            rate: comparison.rate
          };
          // debugger;
          bmatches.push(triangle);

          // console.log('getCandidatesFromStreamViaPath: from/to a: ', triangle.a_step_from, triangle.a_step_to);
          // console.log('getCandidatesFromStreamViaPath: from/to b: ', triangle.b_step_from, triangle.b_step_to);
          // console.log('getCandidatesFromStreamViaPath: from/to c: ', triangle.c_step_from, triangle.c_step_to);
        }



      }
    }
  }

  if (bmatches.length){
    bmatches.sort(function(a, b) { return parseFloat(b.rate) - parseFloat(a.rate); });
  }

  return bmatches;
};
CurrencyCore.getDynamicCandidatesFromStream = (stream, options)=>{
  var matches = [];

  // Add a check for options and options.paths
  if (!options || !Array.isArray(options.paths)) {
    if (controller && controller.logger) {
        // controller.logger.warn('[CurrencyCore] options or options.paths is undefined/not an array in getDynamicCandidatesFromStream.');
    }
    return matches; // Return empty array if options or paths are invalid
  }

  for (let i=0;i<options.paths.length;i++){
    var pMatches = CurrencyCore.getCandidatesFromStreamViaPath(stream, options.start, options.paths[i]);
    matches = matches.concat(pMatches);
    // console.log("adding: " + pMatches.length + " to : " + matches.length);
  }

  if (matches.length){
    matches.sort(function(a, b) { return parseFloat(b.rate) - parseFloat(a.rate); });
  }

  return matches;
};

/*
  starts at btc
  assumes purchase of eth via btc
  looks for a purhase via eth that leads back to btc.
*/
CurrencyCore.getBTCETHCandidatesFromStream = (stream)=>{
  var keys = {
    a: 'btc'.toUpperCase(),
    b: 'eth'.toUpperCase(),
    c: 'findme'.toUpperCase(),
  };
  var bmatches = []; // Initialize bmatches early

  if (!stream || !stream.markets) {
      // console.warn("[CurrencyCore] stream.markets is undefined in getBTCETHCandidatesFromStream.");
      return bmatches;
  }

  var apairs = stream.markets.BTC;
  var bpairs = stream.markets.ETH;

  if (!Array.isArray(apairs) || !Array.isArray(bpairs)) {
    // console.warn("[CurrencyCore] apairs or bpairs is not an array in getBTCETHCandidatesFromStream.");
    return bmatches;
  }

  var akeys = {}; // Initialize akeys as an object
  if (apairs.length > 0) {
    apairs.forEach((obj)=>{ akeys[obj.s.replace(keys.a, '')] = obj; });
  }

  // prevent 1-steps
  delete akeys[keys.b];

  /*
    Loop through BPairs
      for each bpair key, check if apair has it too.
      If it does, run arbitrage math
  */
  for (let i=0;i<bpairs.length;i++){
    var bPairTicker = bpairs[i];
    bPairTicker.key = bPairTicker.s.replace(keys.b,'');

    // from B to C
    bPairTicker.startsWithKey = bPairTicker.s.startsWith(keys.b);

    // from C to B
    bPairTicker.endsWithKey = bPairTicker.s.endsWith(keys.b);

    if (akeys[bPairTicker.key]){
      var match = bPairTicker;

      keys.c = match.key;

      var rate = CurrencyCore.getArbitageRate(stream, keys.a, keys.b, keys.c);
      // Add a check for rate, as getArbitageRate can return undefined
      if (rate && typeof rate.rate !== 'undefined') { 
        var triangle = {
          a: keys.a,
          b: keys.b,
          c: keys.c,
          rate: rate.rate // Ensure we are pushing the numeric rate
        };
        bmatches.push(triangle);
      } else {
        // console.warn(`[CurrencyCore] Could not calculate arbitrage rate for ${keys.a}->${keys.b}->${keys.c}`);
      }
    }
  }

  if (bmatches.length){
    // Ensure sorting is done on the numeric rate property
    bmatches.sort(function(a, b) { return parseFloat(b.rate) - parseFloat(a.rate); }); 
  }
  return bmatches;
};


CurrencyCore.simpleArbitrageMath = (stream, candidates)=>{
  if (!stream || !candidates) return;
  //EURUSD * (1/GBPUSD) * (1/EURGBP) = 1

  //start btc
  //via xUSDT
  //end btc

  var a = candidates['BTCUSDT'];
  var b = candidates['ETHUSDT'];
  var c = candidates['ETHBTC'];

  if (!a || isNaN(a) || !b || isNaN(b) || !c || isNaN(c)) return;

  //btcusd : (flip/usdEth) : ethbtc
  var d = (a.b) * (1/b.b) * (c.b);
  //debugger;
  return d;
};

// Fires once per second, with  all ticker data from Binance
CurrencyCore.events.onAllTickerStream = stream =>{
  var key = 'allMarketTickers';

  // Basic array from api arr[0].s = ETHBTC
  CurrencyCore.streams.allMarketTickers.arr = stream;

  // Mapped object arr[ETHBTC]
  CurrencyCore.streams.allMarketTickers.obj = stream.reduce(function ( array, current ) {
    array[current.s] = current;
    return array;
  }, {});

  // Sub objects with only data on specific markets
  // Initialize markets as an object if it's not already
  if (typeof CurrencyCore.streams.allMarketTickers.markets !== 'object' || CurrencyCore.streams.allMarketTickers.markets === null) {
    CurrencyCore.streams.allMarketTickers.markets = {};
  }

  for (let i=0;i<CurrencyCore.steps.length;i++){
    const stepKey = CurrencyCore.steps[i];
    CurrencyCore.streams.allMarketTickers.markets[stepKey] = stream.filter(e => {
      return (e.s.endsWith(stepKey) || e.s.startsWith(stepKey));
    });
  }

  // something's wrong here. The BNB tree doesn't have BTC, although the BTC tree does.

  if (controller && controller.storage.streamTick)
    controller.storage.streamTick(CurrencyCore.streams[key], key);
};






// starts one global stream for all selectors. Stream feeds back info every second:
// https://github.com/binance-exchange/binance-official-api-docs/blob/master/web-socket-streams.md#all-market-tickers-stream
CurrencyCore.startAllTickerStream = function(exchange){
  if (!CurrencyCore.streams.allMarketTickers){
    CurrencyCore.streams.allMarketTickers = {};
    CurrencyCore.streams.allMarketTickers.arr = [],
    CurrencyCore.streams.allMarketTickers.obj = {};
    CurrencyCore.streams.allMarketTickers.markets = {}; // Initialize as an object
  }

  CurrencyCore.sockets.allMarketTickerStream = exchange.WS.onAllTickers(event => CurrencyCore.events.onAllTickerStream(event));
};

// starts streams for specific selectors
CurrencyCore.startWSockets = function(exchange, ctrl){

  // loop through provided csv selectors, and initiate trades & orderBook sockets for each
  // Ensure CurrencyCore.selectors is defined and is an array
  if (Array.isArray(CurrencyCore.selectors)) {
    for (let i = 0;i < CurrencyCore.selectors.length;i++){

      let selector = require('./CurrencySelector.js')(CurrencyCore.selectors[i], exchange);

      CurrencyCore.currencies[selector.key] = selector;
      CurrencyCore.currencies[selector.key].handleEvent = ctrl.events.wsEvent;
      CurrencyCore.currencies[selector.key].startWSockets(ctrl.events);
    }
  } else {
    if (controller && controller.logger) {
        // controller.logger.warn("[CurrencyCore] CurrencyCore.selectors is not an array or is undefined in startWSockets.");
    }
  }
};


module.exports = CurrencyCore.init;

