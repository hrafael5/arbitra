// load logger library
const logger = require("./lib/LoggerCore");

var env = require("node-env-file");
try {
  env(__dirname + "/.keys");
} catch (e) {
  console.warn("No .keys was provided, running with defaults.");
}
// Carrega conf.ini para process.env. node-env-file converte chaves para MAIÚSCULAS.
env(__dirname + "/conf.ini");

logger.info("\n\n\n----- Bot Starting : -----\n\n\n");

var exchangeAPI = {};

logger.info("--- Loading Exchange API");

if (process.env.ACTIVEEXCHANGE == "binance"){
  logger.info("--- \tActive Exchange:" + process.env.ACTIVEEXCHANGE);

  const api = require("binance");
  const beautifyResponse = false;
  exchangeAPI = new api.BinanceRest({
    timeout: parseInt(process.env.RESTTIMEOUT),
    recvWindow: parseInt(process.env.RESTRECVWINDOW),
    disableBeautification: beautifyResponse
  });
  exchangeAPI.WS = new api.BinanceWS(beautifyResponse);
}

// Função utilitária para ler variáveis de ambiente booleanas de forma robusta (case-insensitive)
const getBooleanEnv = (baseKey, fallbackValue) => {
  const valUpper = process.env[baseKey.toUpperCase()];
  const valLower = process.env[baseKey.toLowerCase()];
  const valAsIs = process.env[baseKey];

  let effectiveVal = fallbackValue;

  if (typeof valUpper === 'string') {
    effectiveVal = valUpper.toLowerCase() === 'true';
  } else if (typeof valLower === 'string') {
    effectiveVal = valLower.toLowerCase() === 'true';
  } else if (typeof valAsIs === 'string') {
    effectiveVal = valAsIs.toLowerCase() === 'true';
  }
  // Se a chave for PAPERONLY e o valor for "false" (string), queremos que effectiveVal seja false.
  // A lógica acima já trata isso: 'false'.toLowerCase() === 'true' é false.
  // Se a chave for PAPERONLY e o valor for "true" (string), queremos que effectiveVal seja true.
  // 'true'.toLowerCase() === 'true' é true.
  // Se a variável não for encontrada (undefined), o fallbackValue é usado.
  return effectiveVal;
};

var botOptions = {
    UI: {
      title: "Top Potential Arbitrage Triplets, via: " + (process.env.BINANCECOLUMNS || process.env.binanceColumns)
    },
    arbitrage: {
      paths: (process.env.BINANCECOLUMNS || process.env.binanceColumns).split(","),
      start: (process.env.BINANCESTARTINGPOINT || process.env.binanceStartingPoint),
      arbitrageCapitalUSDT: (process.env.ARBITRAGE_CAPITAL_USDT || process.env.arbitrage_capital_usdt),
      slippageMaxPercent: (process.env.SLIPPAGE_MAX_PERCENT || process.env.slippage_max_percent),
      orderBookDepthLimit: (process.env.ORDER_BOOK_DEPTH_LIMIT || process.env.order_book_depth_limit),
      binanceTradeFeePercent: (process.env.BINANCE_TRADE_FEE_PERCENT || process.env.binance_trade_fee_percent),
      grossProfitThresholdPercent: (process.env.GROSS_PROFIT_THRESHOLD_PERCENT || process.env.gross_profit_threshold_percent),
      minQuoteVolumeThresholdUSDT: (process.env.MIN_QUOTE_VOLUME_THRESHOLD_USDT || process.env.min_quote_volume_threshold_usdt)
    },
    storage: {
      // Para logHistory, se for "true" no conf.ini, queremos true. Se "false" ou ausente, false.
      logHistory: getBooleanEnv("LOGHISTORY", false) 
    },
    trading: {
      // Para paperOnly, se for "false" no conf.ini, queremos false (modo real).
      // Se for "true" ou ausente, queremos true (modo simulação) por segurança.
      paperOnly: getBooleanEnv("PAPERONLY", true),
      minQueuePercentageThreshold: (process.env.MINQUEUEPERCENTAGETHRESHOLD || process.env.minQueuePercentageThreshold),
      minHitsThreshold: parseInt(process.env.MINHITSTHRESHOLD || process.env.minHitsThreshold || "5")
    }
  },
  ctrl = {
    options: botOptions,
    storage: {
      trading: {
        queue: [],
        active: []
      },
      candidates: [],
      streams: [],
      pairRanks: []
    },
    logger: logger,
    exchange: exchangeAPI
  };

// Logar os valores efetivamente definidos, mostrando de onde vieram se possível
logger.info(`[CONFIG_LOG] PAPERONLY (conf.ini) = "${process.env.PAPERONLY}"`);
logger.info(`[CONFIG_LOG] paperOnly (botOptions) foi definido como: ${ctrl.options.trading.paperOnly}`);

logger.info(`[CONFIG_LOG] LOGHISTORY (conf.ini) = "${process.env.LOGHISTORY}"`);
logger.info(`[CONFIG_LOG] logHistory (botOptions) foi definido como: ${ctrl.options.storage.logHistory}`);

logger.info(`[CONFIG_LOG] MINHITSTHRESHOLD (conf.ini) = "${process.env.MINHITSTHRESHOLD}"`);
logger.info(`[CONFIG_LOG] minHitsThreshold (botOptions) foi definido como: ${ctrl.options.trading.minHitsThreshold}`);

ctrl.UI       = require("./lib/UI")(ctrl.options),
ctrl.events   = require("./lib/EventsCore")(ctrl);

require("./lib/BotCore")(ctrl);

ctrl.logger.info("----- Bot Startup Finished -----");
