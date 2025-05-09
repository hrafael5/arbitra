const fs = require("fs");
const path = require("path");

console.log("[BotCore.js] Módulo carregado e pronto para ser executado.");

function formatTimestamp() {
  const now = new Date();
  return `${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}:${now.getSeconds().toString().padStart(2, "0")}`;
}

var TradingCore = require("./TradingCore");
var DBHelpers = require("./DBHelpers").DBHelpers;
var PairRanker = require("./PairRanker").PairRanker;
const { simulateArbitragePath, executarArbitragemReal } = require("../execucaoArbitragem.js"); 
const axios = require("axios");

const ARBITRAGEM_CONFIG = {
  cooldownActive: false,
  tempoCooldownMs: parseInt(process.env.ARBITRAGE_COOLDOWN_MS) || 120000,
  lucroMinimoBrutoParaConsiderar: parseFloat(process.env.GROSS_PROFIT_THRESHOLD_PERCENT) || 0.00000001,
  minQuoteVolumeThreshold: parseFloat(process.env.MIN_QUOTE_VOLUME_THRESHOLD_USDT) || 50000,
  historicoExecucoes: [],
  maxHistorico: 10,
  ultimaExecucaoTimestamp: null,
  cachedSymbolInfo: {},
  isSimulatingOrExecuting: false,
  preFilteredViableRoutes: [],
};

// MODO DE TESTE PARA EXECUÇÃO REAL (definir como true para ativar limiares de teste)
const MODO_TESTE_EXECUCAO = false; // ATENÇÃO: Mudar para false para operação normal
const MODO_TESTE_EXECUCAO_FORCAR_CHAMADA = false; // ATENÇÃO: Força a chamada à execução real
const LUCRO_MINIMO_TESTE = 0.0001; // Lucro bruto mínimo para teste (ex: > 0%)
const VOLUME_MINIMO_TESTE = 100; // Volume mínimo em USDT para teste
// O lucro mínimo pós-simulação será ignorado se MODO_TESTE_EXECUCAO_FORCAR_CHAMADA for true
const LUCRO_MINIMO_POS_SIMULACAO_TESTE_ORIGINAL = -1.0; 

function appendToDebugLog(message) {
  const logFilePath = path.join(process.cwd(), "debug_profits.log");
  const timestamp = `[${formatTimestamp()}]`;
  
  console.log(`${timestamp} [DIAGNOSTIC_LOG] appendToDebugLog FOI CHAMADA.`);
  console.log(`${timestamp} [DIAGNOSTIC_LOG] Caminho do ficheiro de log: ${logFilePath}`);
  console.log(`${timestamp} [DIAGNOSTIC_LOG] Mensagem a ser escrita: ${message}`);

  fs.appendFile(logFilePath, message + "\n", (err) => {
    if (err) {
      console.error(`${timestamp} [DIAGNOSTIC_LOG] ERROR_WRITING_DEBUG_LOG: Falha ao escrever no ${logFilePath}:`, err.message, err.stack);
    } else {
      console.log(`${timestamp} [DIAGNOSTIC_LOG] SUCCESS_WRITING_DEBUG_LOG: Mensagem escrita com sucesso em ${logFilePath}`);
    }
  });
}

async function primeSymbolInfoCache() {
  console.log(`[${formatTimestamp()}] INFO: Iniciando priming do cache de SymbolInfo...`);
  try {
    const exchangeInfo = await axios.get(`${process.env.BASE_URL || "https://api.binance.com"}/api/v3/exchangeInfo`);
    exchangeInfo.data.symbols.forEach(symbolData => {
      const lotSizeFilter = symbolData.filters.find(f => f.filterType === "LOT_SIZE");
      const priceFilter = symbolData.filters.find(f => f.filterType === "PRICE_FILTER");
      const minNotionalFilter = symbolData.filters.find(f => f.filterType === "MIN_NOTIONAL" || f.filterType === "NOTIONAL");
      ARBITRAGEM_CONFIG.cachedSymbolInfo[symbolData.symbol] = {
        stepSize: lotSizeFilter ? parseFloat(lotSizeFilter.stepSize) : 0.00000001,
        minQty: lotSizeFilter ? parseFloat(lotSizeFilter.minQty) : 0.00000001,
        tickSize: priceFilter ? parseFloat(priceFilter.tickSize) : 0.00000001,
        minNotional: minNotionalFilter ? parseFloat(minNotionalFilter.minNotional || minNotionalFilter.notional) : 0,
        baseAsset: symbolData.baseAsset,
        quoteAsset: symbolData.quoteAsset,
        status: symbolData.status
      };
    });
    console.log(`[${formatTimestamp()}] INFO: Cache de SymbolInfo preenchido com ${Object.keys(ARBITRAGEM_CONFIG.cachedSymbolInfo).length} símbolos.`);
  } catch (error) {
    console.error(`[${formatTimestamp()}] ERROR: Falha ao preencher o cache de SymbolInfo:`, error.message);
    setTimeout(primeSymbolInfoCache, 60000); // Tentar novamente em 1 minuto em caso de falha
  }
  setTimeout(primeSymbolInfoCache, 3600000); // Atualizar a cada hora
}

async function preFilterInitialRoutes(ctrl) {
  console.log(`[${formatTimestamp()}] INFO: Iniciando pré-filtragem de rotas de arbitragem...`);
  const startAsset = ctrl.options.arbitrage.start;
  const intermediateAssets = ctrl.options.arbitrage.paths;
  const capital = parseFloat(process.env.ARBITRAGE_CAPITAL_USDT);
  const exchangeInfo = ARBITRAGEM_CONFIG.cachedSymbolInfo;
  let tickers = {};

  if (Object.keys(exchangeInfo).length === 0) {
    console.warn(`[${formatTimestamp()}] WARN: Cache de SymbolInfo vazio. Pré-filtragem não pode continuar sem ele. Tentando em 10s.`);
    await new Promise(resolve => setTimeout(resolve, 10000)); 
    if (Object.keys(ARBITRAGEM_CONFIG.cachedSymbolInfo).length === 0) {
        console.error(`[${formatTimestamp()}] ERROR: Cache de SymbolInfo ainda vazio após espera. Pré-filtragem abortada.`);
        return;
    }
  }

  try {
    const response = await axios.get(`${process.env.BASE_URL || "https://api.binance.com"}/api/v3/ticker/bookTicker`);
    response.data.forEach(ticker => {
      tickers[ticker.symbol] = { s: ticker.symbol, a: ticker.askPrice, b: ticker.bidPrice };
    });
    console.log(`[${formatTimestamp()}] INFO: Tickers atuais obtidos para pré-filtragem: ${Object.keys(tickers).length} pares.`);
  } catch (error) {
    console.error(`[${formatTimestamp()}] ERROR: Falha ao obter tickers para pré-filtragem:`, error.message);
    ARBITRAGEM_CONFIG.preFilteredViableRoutes = []; 
    return;
  }

  const allPossibleRoutes = [];
  for (let i = 0; i < intermediateAssets.length; i++) {
    if (intermediateAssets[i] === startAsset) continue;
    for (let j = 0; j < intermediateAssets.length; j++) {
      if (intermediateAssets[j] === startAsset || intermediateAssets[j] === intermediateAssets[i]) continue;
      allPossibleRoutes.push({
        from: startAsset,
        intermediate1: intermediateAssets[i],
        intermediate2: intermediateAssets[j],
        to: startAsset,
        id: `${startAsset}->${intermediateAssets[i]}->${intermediateAssets[j]}->${startAsset}`
      });
    }
  }
  console.log(`[${formatTimestamp()}] INFO: Total de rotas teóricas geradas para pré-filtragem: ${allPossibleRoutes.length}`);

  const viableRoutes = [];
  for (const route of allPossibleRoutes) {
    if (!ctrl.currencyCore || typeof ctrl.currencyCore.checkInitialRouteViability !== "function"){
        console.error("[BotCore.js] FATAL: ctrl.currencyCore.checkInitialRouteViability não está disponível.");
        ARBITRAGEM_CONFIG.preFilteredViableRoutes = null; 
        return;
    }
    const result = await ctrl.currencyCore.checkInitialRouteViability(route, capital, exchangeInfo, tickers, startAsset);
    if (result.viable) {
      viableRoutes.push(route);
    } 
  }
  ARBITRAGEM_CONFIG.preFilteredViableRoutes = viableRoutes;
  console.log(`[${formatTimestamp()}] INFO: Pré-filtragem concluída. Rotas inicialmente viáveis: ${viableRoutes.length} de ${allPossibleRoutes.length}`);
}

module.exports = (ctrl) => {
  console.log("[BotCore.js] Função module.exports executada. Configurando o bot...");
  if (MODO_TESTE_EXECUCAO) {
    console.warn("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    console.warn(`[${formatTimestamp()}] ATENÇÃO: MODO DE TESTE DE EXECUÇÃO ATIVO EM BotCore.js!`);
    console.warn(`[${formatTimestamp()}] Lucro Mínimo Bruto: ${LUCRO_MINIMO_TESTE}%`);
    console.warn(`[${formatTimestamp()}] Volume Mínimo por Perna: ${VOLUME_MINIMO_TESTE} USDT`);
    if (MODO_TESTE_EXECUCAO_FORCAR_CHAMADA) {
        console.warn(`[${formatTimestamp()}] ATENÇÃO: CHAMADA À EXECUÇÃO REAL SERÁ FORÇADA APÓS SIMULAÇÃO (Lucro Pós-Simulação ignorado)!`);
    } else {
        console.warn(`[${formatTimestamp()}] Lucro Mínimo Pós-Simulação: ${LUCRO_MINIMO_POS_SIMULACAO_TESTE_ORIGINAL}%`);
    }
    console.warn("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
  }
  this.dbHelpers = new DBHelpers();
  this.pairRanker = new PairRanker();

  const arbitrageOptions = ctrl.options.arbitrage;
  const allRelevantCoins = Array.from(new Set([arbitrageOptions.start, ...arbitrageOptions.paths]));
  ctrl.currencyCoreSteps = allRelevantCoins;

  primeSymbolInfoCache().then(async () => {
    console.log("[BotCore.js] --- Starting Currency Streams (pré-inicialização para pré-filtragem) ---");
    try {
      ctrl.currencyCore = require("./CurrencyCore")(ctrl);
    } catch (error) {
      console.error("[BotCore.js] FATAL: Failed to initialize CurrencyCore for pre-filtering:", error);
      process.exit(1);
    }
    await preFilterInitialRoutes(ctrl);
    console.log("[BotCore.js] Inicialização principal concluída após cache e pré-filtragem.");

  }).catch(error => {
     console.error(`[${formatTimestamp()}] FATAL: Erro na inicialização (cache, pré-filtragem ou CurrencyCore):`, error);
     process.exit(1);
  });

  let lastActivityLogTime = 0;
  const activityLogInterval = 15000;
  let lastCandidateCountLogTime = 0;
  const candidateCountLogInterval = 5000;

  ctrl.storage.streamTick = async (stream, streamID) => {
    if (!ctrl.currencyCore) {
      console.warn(`[${formatTimestamp()}] WARN: CurrencyCore não disponível em streamTick.`);
      return;
    }
    ctrl.storage.streams[streamID] = stream;

    if (streamID === "allMarketTickers") {
      const now = Date.now();
      if (now - lastActivityLogTime > activityLogInterval) {
        console.log(`[${formatTimestamp()}] DEBUG: Loop principal ativo. Verificando condições... PaperOnly: ${ctrl.options.trading.paperOnly}, Cooldown: ${ARBITRAGEM_CONFIG.cooldownActive}, Executando: ${ARBITRAGEM_CONFIG.isSimulatingOrExecuting}`);
        lastActivityLogTime = now;
      }

      try {
        ctrl.storage.candidates = ctrl.currencyCore.getDynamicCandidatesFromStream(
          stream,
          ctrl.options.arbitrage
        );
      } catch (error) {
        console.error(`[${formatTimestamp()}] ERROR: Falha ao obter candidatos do stream: ${error.message}`);
        ctrl.storage.candidates = [];
      }
      
      if (ctrl.storage.candidates && ctrl.options.arbitrage && ctrl.options.arbitrage.paths) {
        const moedasPermitidas = Array.from(new Set([ctrl.options.arbitrage.start, ...ctrl.options.arbitrage.paths]));
        ctrl.storage.candidates = ctrl.storage.candidates.filter(candidato => {
          if (!candidato || !candidato.a_step_from || !candidato.a_step_to || !candidato.b_step_to || !candidato.c_step_to) {
            return false;
          }
          return moedasPermitidas.includes(candidato.a_step_from) &&
                 moedasPermitidas.includes(candidato.a_step_to) &&
                 moedasPermitidas.includes(candidato.b_step_to) &&
                 moedasPermitidas.includes(candidato.c_step_to);
        });
      }

      if (ARBITRAGEM_CONFIG.preFilteredViableRoutes && ARBITRAGEM_CONFIG.preFilteredViableRoutes.length > 0 && ctrl.storage.candidates && ctrl.storage.candidates.length > 0) {
        const viableRoutesSet = new Set(ARBITRAGEM_CONFIG.preFilteredViableRoutes.map(r => `${r.from}->${r.intermediate1}->${r.intermediate2}->${r.to}`));
        ctrl.storage.candidates = ctrl.storage.candidates.filter(candidate => {
            const candidateRouteStr = `${candidate.a_step_from}->${candidate.a_step_to}->${candidate.b_step_to}->${candidate.c_step_to}`;
            return viableRoutesSet.has(candidateRouteStr);
        });
      }

      if (now - lastCandidateCountLogTime > candidateCountLogInterval) {
        console.log(`[${formatTimestamp()}] DEBUG: Candidatos (pós-filtros): ${ctrl.storage.candidates.length}.`);
        lastCandidateCountLogTime = now;
      }

      if (this.pairRanker && typeof this.pairRanker.getPairRanking === "function") {
        this.pairRanker.getPairRanking(ctrl.storage.candidates, ctrl.storage.pairRanks, ctrl, ctrl.logger);
      }
      if (ctrl.UI && typeof ctrl.UI.updateArbitageOpportunities === "function") {
        ctrl.UI.updateArbitageOpportunities(ctrl.storage.candidates);
      }

      console.log(`[${formatTimestamp()}] [DIAGNOSTIC_LOG] Antes de chamar verificarEAvaliarOportunidade. Candidatos: ${ctrl.storage.candidates ? ctrl.storage.candidates.length : 'undefined'}`);
      await verificarEAvaliarOportunidade(ctrl);

      if (ctrl.options.storage.logHistory && this.dbHelpers) {
        this.dbHelpers.saveArbRows(ctrl.storage.candidates, ctrl.storage.db, ctrl.logger);
        if (stream && stream.arr) {
          this.dbHelpers.saveRawTick(stream.arr, ctrl.storage.db, ctrl.logger);
        }
      }
    }
  };

  async function verificarEAvaliarOportunidade(ctrl) {
    const currentTimestamp = `[${formatTimestamp()}]`;
    console.log(`${currentTimestamp} [DIAGNOSTIC_LOG] Dentro de verificarEAvaliarOportunidade.`);

    if (ctrl.options.trading.paperOnly === true || ARBITRAGEM_CONFIG.cooldownActive || ARBITRAGEM_CONFIG.isSimulatingOrExecuting) {
      console.log(`${currentTimestamp} [DIAGNOSTIC_LOG] verificarEAvaliarOportunidade: Retornando devido a paperOnly, cooldown ou isSimulatingOrExecuting.`);
      return;
    }
    
    console.log(`${currentTimestamp} [DIAGNOSTIC_LOG] verificarEAvaliarOportunidade: Passou das verificações iniciais.`);
    if (!ctrl.storage.candidates || ctrl.storage.candidates.length === 0) {
      console.log(`${currentTimestamp} [DIAGNOSTIC_LOG] verificarEAvaliarOportunidade: Sem candidatos para avaliar.`);
      return;
    }

    const lucroMinimoAtual = MODO_TESTE_EXECUCAO ? LUCRO_MINIMO_TESTE : ARBITRAGEM_CONFIG.lucroMinimoBrutoParaConsiderar;
    const volumeMinimoAtual = MODO_TESTE_EXECUCAO ? VOLUME_MINIMO_TESTE : ARBITRAGEM_CONFIG.minQuoteVolumeThreshold;
    let lucroMinimoPosSimulacaoAtual = MODO_TESTE_EXECUCAO ? (MODO_TESTE_EXECUCAO_FORCAR_CHAMADA ? -Infinity : LUCRO_MINIMO_POS_SIMULACAO_TESTE_ORIGINAL) : ctrl.options.trading.minQueuePercentageThreshold;

    if(MODO_TESTE_EXECUCAO) {
      console.log(`${currentTimestamp} [DIAGNOSTIC_LOG] MODO DE TESTE ATIVO: Lucro Mínimo Bruto: ${lucroMinimoAtual}%, Volume Mínimo: ${volumeMinimoAtual} USDT`);
      if (MODO_TESTE_EXECUCAO_FORCAR_CHAMADA) {
        console.log(`${currentTimestamp} [DIAGNOSTIC_LOG] MODO DE TESTE FORÇAR CHAMADA ATIVO: Lucro Mínimo Pós-Simulação será ignorado (definido como -Infinity).`);
      } else {
        console.log(`${currentTimestamp} [DIAGNOSTIC_LOG] MODO DE TESTE ATIVO: Lucro Mínimo Pós-Simulação: ${lucroMinimoPosSimulacaoAtual}%`);
      }
    }

    const melhoresCandidatos = ctrl.storage.candidates.filter(c => {
      if (!c || !c.rate || !c.a_step_from || !c.a_step_to || !c.b_step_to || !c.c_step_to || !c.a || !c.a.rate || !c.b || !c.b.rate || !c.c || !c.c.rate) return false; 
      if (c.a_step_from !== ctrl.options.arbitrage.start || c.c_step_to !== ctrl.options.arbitrage.start) return false;
      const lucroPotencialBruto = (c.rate - 1) * 100;
      if (lucroPotencialBruto <= lucroMinimoAtual) return false;
      
      const volA_usdt = parseFloat(c.a_quote_volume);
      let priceIntermediate1InStartAsset = parseFloat(c.a.rate); 
      let volB_usdt = 0;
      if (!isNaN(parseFloat(c.b_quote_volume)) && !isNaN(priceIntermediate1InStartAsset) && priceIntermediate1InStartAsset !== 0) {
         volB_usdt = parseFloat(c.b_quote_volume) * priceIntermediate1InStartAsset;
      } else {
        return false;
      }
      const volC_usdt = parseFloat(c.c_quote_volume); 
      if (isNaN(volA_usdt) || isNaN(volB_usdt) || isNaN(volC_usdt) || volA_usdt < volumeMinimoAtual || volB_usdt < volumeMinimoAtual || volC_usdt < volumeMinimoAtual) {
        return false;
      }
      return true;
    });
    console.log(`${currentTimestamp} [DIAGNOSTIC_LOG] verificarEAvaliarOportunidade: Melhores candidatos (usando limiar ${lucroMinimoAtual}% e vol ${volumeMinimoAtual} USDT): ${melhoresCandidatos.length}`);

    const oportunidade = melhoresCandidatos.sort((a, b) => b.rate - a.rate)[0];

    if (oportunidade) {
      console.log(`${currentTimestamp} [DIAGNOSTIC_LOG] verificarEAvaliarOportunidade: OPORTUNIDADE ENCONTRADA. Iniciando escrita no log de debug.`);
      ARBITRAGEM_CONFIG.isSimulatingOrExecuting = true; 
      const { a_step_from: baseCurrency, a_step_to: intermediate1, b_step_to: intermediate2, c_step_to: finalCurrency, rate } = oportunidade;
            const rotaLog = `${baseCurrency} → ${intermediate1} → ${intermediate2} → ${finalCurrency}`;

      // Ajuste os preços com base no tipo da operação (BUY/SELL)
      // ATENÇÃO: Assumindo que oportunidade.X.rate já é o preço de mercado direto (preço do ativo base na moeda de cotação)
      // necessário para a simulação da perna X. A lógica de ASK/BID e inversão de par deve ocorrer antes, ao popular oportunidade.X.rate.
      // Se os pares (oportunidade.X_pair) não estiverem definidos (como visto no log), esta é uma suposição de último recurso,
      // e os valores de oportunidade.X.rate podem estar fundamentalmente incorretos.
      const priceLeg1 = parseFloat(oportunidade.a.rate);
      const priceLeg2 = parseFloat(oportunidade.b.rate);
      const priceLeg3_paraSimulacao = parseFloat(oportunidade.c.rate);

      // Log para depuração dos preços calculados
      console.log(`${currentTimestamp} [DEBUG_PRICES] Rota: ${rotaLog}`);
      console.log(`${currentTimestamp} [DEBUG_PRICES] Oportunidade Detalhes: a_pair: ${oportunidade.a_pair}, a_step_type: ${oportunidade.a_step_type}, a.rate: ${oportunidade.a.rate}, priceLeg1: ${priceLeg1}`);
      console.log(`${currentTimestamp} [DEBUG_PRICES] Oportunidade Detalhes: b_pair: ${oportunidade.b_pair}, b_step_type: ${oportunidade.b_step_type}, b.rate: ${oportunidade.b.rate}, priceLeg2: ${priceLeg2}`);
      console.log(`${currentTimestamp} [DEBUG_PRICES] Oportunidade Detalhes: c_pair: ${oportunidade.c_pair}, c_step_type: ${oportunidade.c_step_type}, c.rate: ${oportunidade.c.rate}, priceLeg3_paraSimulacao: ${priceLeg3_paraSimulacao}`);
      
      const lucroBrutoIdentificadoOportunidade = (oportunidade.rate - 1) * 100; // 'oportunidade.rate' é o multiplicador total da rota      console.log(`${currentTimestamp} [DIAGNOSTIC_LOG] verificarEAvaliarOportunidade: Mensagens DEBUG_PROFITS enviadas para appendToDebugLog.`);

      console.log(`${currentTimestamp} INFO: Iniciando SIMULAÇÃO DETALHADA para ${rotaLog} | Lucro Bruto (oportunidade.rate): ${lucroBrutoIdentificadoOportunidade.toFixed(3)}%`);
      const capitalInicial = parseFloat(process.env.ARBITRAGE_CAPITAL_USDT) || 50;
      const simulacao = await simulateArbitragePath(
        intermediate1,
        intermediate2,
        capitalInicial,
        ARBITRAGEM_CONFIG.cachedSymbolInfo,
        priceLeg1,
        priceLeg2, // Este será 1 / oportunidade.b.rate para refletir a venda de M1 para M2
        priceLeg3_paraSimulacao
      );

      if (simulacao.error) {
        console.error(`${currentTimestamp} ERROR: Simulação falhou para ${rotaLog}: ${simulacao.error}`);
        ARBITRAGEM_CONFIG.isSimulatingOrExecuting = false;
        return;
      }

      console.log(`${currentTimestamp} INFO: Simulação CONCLUÍDA para ${rotaLog}: Lucro Líquido Estimado: ${simulacao.simulatedProfit.toFixed(4)} USDT (${simulacao.simulatedProfitPercentage.toFixed(3)}%)`);
      
      // Condição para tentar execução real
      if (ctrl.options.trading.paperOnly === false && (simulacao.simulatedProfitPercentage >= lucroMinimoPosSimulacaoAtual)) { // lucroMinimoPosSimulacaoAtual já considera MODO_TESTE_EXECUCAO_FORCAR_CHAMADA
        console.log(`${currentTimestamp} INFO: paperOnly=${ctrl.options.trading.paperOnly}. TENTANDO EXECUÇÃO REAL. Lucro simulado: ${simulacao.simulatedProfitPercentage.toFixed(3)}%, Limiar usado: ${lucroMinimoPosSimulacaoAtual.toFixed(3)}%`);
        ARBITRAGEM_CONFIG.cooldownActive = true;
        ARBITRAGEM_CONFIG.ultimaExecucaoTimestamp = Date.now();

        const resultadoExecucao = await executarArbitragemReal(
          intermediate1,
          intermediate2,
          capitalInicial,
          ARBITRAGEM_CONFIG.cachedSymbolInfo,
          priceLeg1,
          priceLeg2,
          priceLeg3_paraSimulacao,
          ctrl.exchange // Passar a instância da API da corretora
        );

        if (resultadoExecucao.success) {
          console.log(`${currentTimestamp} ✅ EXECUÇÃO REAL BEM-SUCEDIDA para ${rotaLog}: Lucro: ${resultadoExecucao.profit.toFixed(4)} USDT (${resultadoExecucao.profitPercentage.toFixed(3)}%)`);
          ARBITRAGEM_CONFIG.historicoExecucoes.unshift({ rota: rotaLog, resultado: "SUCESSO", lucro: resultadoExecucao.profit, percentagem: resultadoExecucao.profitPercentage, timestamp: Date.now() });
        } else {
          console.error(`${currentTimestamp} ❌ EXECUÇÃO REAL FALHOU para ${rotaLog}: ${resultadoExecucao.error}`);
          ARBITRAGEM_CONFIG.historicoExecucoes.unshift({ rota: rotaLog, resultado: "FALHA", erro: resultadoExecucao.error, timestamp: Date.now() });
        }
        if (ARBITRAGEM_CONFIG.historicoExecucoes.length > ARBITRAGEM_CONFIG.maxHistorico) {
          ARBITRAGEM_CONFIG.historicoExecucoes.pop();
        }
        setTimeout(() => {
          ARBITRAGEM_CONFIG.cooldownActive = false;
          console.log(`[${formatTimestamp()}] INFO: Cooldown de arbitragem terminado.`);
        }, ARBITRAGEM_CONFIG.tempoCooldownMs);
      } else {
        console.log(`${currentTimestamp} INFO: Lucro simulado (${simulacao.simulatedProfitPercentage.toFixed(3)}%) não atingiu o mínimo de ${lucroMinimoPosSimulacaoAtual.toFixed(3)}% para execução real, ou paperOnly é true.`);
      }
      ARBITRAGEM_CONFIG.isSimulatingOrExecuting = false;
    }
  }
};
