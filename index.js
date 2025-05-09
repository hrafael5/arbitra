// load logger library
const logger = require("./lib/LoggerCore");

var env = require("node-env-file");
try {
  env(__dirname + "/.keys"); // Carrega BINANCE_APIKEY, BINANCE_APISECRET
} catch (e) {
  console.warn("No .keys was provided, running with defaults.");
}
// Carrega outras configurações como activeExchange, binancePairs, restTimeout, etc.
// E também as novas variáveis: ARBITRAGE_CAPITAL_USDT, SLIPPAGE_MAX_PERCENT, ORDER_BOOK_DEPTH_LIMIT, BINANCE_TRADE_FEE_PERCENT
env(__dirname + "/conf.ini"); 

logger.info("\n\n\n----- Bot Starting : -----\n\n\n");

var exchangeAPI = {};

logger.info("--- Loading Exchange API");

if (process.env.activeExchange == "binance"){
  logger.info("--- \tActive Exchange:" + process.env.activeExchange);
  const api = require("binance");
  const beautifyResponse = false;
  exchangeAPI = new api.BinanceRest({
    key: process.env.BINANCE_APIKEY, // Adicionado para que a instância da API possa ser usada se necessário
    secret: process.env.BINANCE_APISECRET, // Adicionado
    timeout: parseInt(process.env.restTimeout) || 15000,
    recvWindow: parseInt(process.env.restRecvWindow) || 5000,
    disableBeautification: beautifyResponse
  });
  exchangeAPI.WS = new api.BinanceWS(beautifyResponse); // Não usado diretamente nas modificações atuais
} else {
  logger.error("FATAL: Exchange não configurada ou não suportada: " + process.env.activeExchange);
  process.exit(1);
}

// Validar se as variáveis de ambiente necessárias foram carregadas
const requiredEnvVars = [
  "BINANCE_APIKEY", "BINANCE_APISECRET", 
  "ARBITRAGE_CAPITAL_USDT", "SLIPPAGE_MAX_PERCENT", 
  "ORDER_BOOK_DEPTH_LIMIT", "BINANCE_TRADE_FEE_PERCENT"
];
let missingVars = false;
requiredEnvVars.forEach(varName => {
  if (!process.env[varName]) {
    logger.error(`FATAL: Variável de ambiente obrigatória não definida: ${varName}. Verifique seus arquivos .keys e conf.ini.`);
    missingVars = true;
  }
});
if (missingVars) {
  process.exit(1);
}

var botOptions = {
    UI: {
      title: "Top Potential Arbitrage Triplets, via: " + process.env.binanceColumns
    },
    arbitrage: {
      paths: process.env.binanceColumns.split(","),
      start: process.env.binanceStartingPoint
    },
    storage: {
      logHistory: process.env.logHistory === "true" || false
    },
    trading: {
      paperOnly: process.env.paperOnly === "true" || false,
      minQueuePercentageThreshold: parseFloat(process.env.minQueuePercentageThreshold) || 1.5, // Lucro LÍQUIDO mínimo esperado APÓS taxas e slippage estimado
      minHitsThreshold: parseInt(process.env.minHitsThreshold) || 1
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
    exchange: exchangeAPI // Instância da API da Binance (da biblioteca)
  };

ctrl.UI       = require("./lib/UI")(ctrl.options),
ctrl.events   = require("./lib/EventsCore")(ctrl);

// We're ready to start. Load up the webhook streams and start making it rain.
require("./lib/BotCore")(ctrl);

ctrl.logger.info("----- Bot Startup Finished -----");

