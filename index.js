// load logger library
const logger = require('./lib/LoggerCore');

var env = require('node-env-file');
try {
  env(__dirname + '/.keys');
} catch (e) {
  console.warn('No .keys was provided, running with defaults.');
}
env(__dirname + '/conf.ini'); // Carrega as variáveis do conf.ini para process.env

logger.info('\n\n\n----- Bot Starting : -----\n\n\n');

var exchangeAPI = {};

logger.info('--- Loading Exchange API');

// make exchange module dynamic later
if (process.env.activeExchange == 'binance'){
  logger.info('--- \tActive Exchange:' + process.env.activeExchange);
  // activePairs = process.env.binancePairs;

  const api = require('binance');
  const beautifyResponse = false;
  exchangeAPI = new api.BinanceRest({
    timeout: parseInt(process.env.restTimeout), // Optional, defaults to 15000, is the request time out in milliseconds
    recvWindow: parseInt(process.env.restRecvWindow), // Optional, defaults to 5000, increase if you're getting timestamp errors
    disableBeautification: beautifyResponse
  });
  exchangeAPI.WS = new api.BinanceWS(beautifyResponse);
}

// Configurações do Bot
var botOptions = {
    UI: {
      // Usa process.env para pegar o valor do conf.ini
      title: 'Top Potential Arbitrage Triplets, via: ' + process.env.binanceColumns
    },
    arbitrage: {
      // Usa process.env para pegar os valores do conf.ini
      paths: process.env.binanceColumns.split(','),
      start: process.env.binanceStartingPoint,
      // <<< NOVA LINHA ADICIONADA ABAIXO >>>
      // Lê a lista de moedas permitidas para Step B (UI Step C), separa por vírgula e remove itens vazios
      allowedStepB: (process.env.allowedStepBCoins || '').split(',').filter(Boolean)
    },
    storage: {
      logHistory: false // Ajuste conforme necessário
    },
    trading: {
      paperOnly: false, // Ajuste para true para paper trading (simulação sem ordens reais)
      // only candidates with over x% gain potential are queued for trading
      minQueuePercentageThreshold: 1.5, // Ajuste conforme necessário
      // how many times we need to see the same opportunity before deciding to act on it
      minHitsThreshold: 1 // Ajuste conforme necessário
    }
  },
  // Objeto de Controle Principal
  ctrl = {
    options: botOptions, // Passa as opções configuradas
    storage: {
      trading: {
      // queued triplets
        queue: [],
        // actively trading triplets
        active: []
      },
      candidates: [],
      streams: [],
      pairRanks: []
    },
    logger: logger,
    exchange: exchangeAPI
  };

// Inicializa os Módulos Principais passando o objeto ctrl
ctrl.UI       = require('./lib/UI')(ctrl.options), // Passa as opções para a UI
ctrl.events   = require('./lib/EventsCore')(ctrl); // Passa ctrl para os eventos

// Carrega o Core do Bot passando o objeto ctrl
require('./lib/BotCore')(ctrl);

ctrl.logger.info('----- Bot Startup Finished -----');