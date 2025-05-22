var TradingCore = require("./TradingCore");
var DBHelpers = require("./DBHelpers").DBHelpers;
var PairRanker = require("./PairRanker").PairRanker;
// Ajustado para usar o nome original do arquivo com as correções
// *** Importante: Certifique-se que o 'execucaoArbitragem.js' referenciado aqui contém a lógica de simulação! ***
const { executarArbitragem } = require("../execucaoArbitragem");

// Configurações de controle para execução de arbitragem
const ARBITRAGEM_CONFIG = {
  cooldown: false,
  tempoCooldown: 15000, // 15 segundos entre execuções
  lucroMinimoPercentual: 1.0, // Lucro mínimo BRUTO para TENTAR EXECUTAR (mantido aqui)
  minQuoteVolumeThreshold: 5000, // Volume mínimo em USDT para cada perna
  maxTentativas: 3, // Número máximo de tentativas após falha (não implementado no fluxo atual de execucaoArbitragem)
  historicoExecucoes: [], // Histórico das últimas execuções
  maxHistorico: 10, // Tamanho máximo do histórico
  ultimaExecucao: null, // Timestamp da última execução bem-sucedida
};

module.exports = (ctrl) => {
  this.dbHelpers = new DBHelpers();
  this.pairRanker = new PairRanker();

  let lastActivityLogTime = 0;
  const activityLogInterval = 5000; // Log activity every 5 seconds

  ctrl.storage.streamTick = async (stream, streamID) => {
    if (!ctrl.currencyCore) {
        console.warn(`[${formatTimestamp()}] WARN: currencyCore not initialized yet. Skipping tick.`);
        return;
    }

    ctrl.storage.streams[streamID] = stream;

    if (streamID === "allMarketTickers") {
      const now = Date.now();
      // --- LOG DE ATIVIDADE ---
      if (now - lastActivityLogTime > activityLogInterval) {
        let activityLogMsg = `[${formatTimestamp()}] A procurar oportunidades... (Lucro Bruto Mín. EXEC: ${ARBITRAGEM_CONFIG.lucroMinimoPercentual}%, Vol Mín.: ${ARBITRAGEM_CONFIG.minQuoteVolumeThreshold} USDT`;
        if (ctrl.options.arbitrage.allowedStepB && ctrl.options.arbitrage.allowedStepB.length > 0) {
            activityLogMsg += `, Step B Permitidas: [${ctrl.options.arbitrage.allowedStepB.join(',')}]`;
        }
        activityLogMsg += ')';
        console.log(activityLogMsg);
        lastActivityLogTime = now;
      }

      // --- 1. Obter candidatos brutos ---
      try {
          ctrl.storage.candidates = ctrl.currencyCore.getDynamicCandidatesFromStream(
            stream,
            ctrl.options.arbitrage
          );
      } catch (error) {
          console.error(`[${formatTimestamp()}] ERROR: Failed to get candidates from stream:`, error);
          ctrl.storage.candidates = [];
      }

      // <<< --- 2. Filtrar candidatos PARA A UI (SEM FILTRO DE LUCRO MÍNIMO) --- >>>
      let displayCandidates = [];
      if (ctrl.storage.candidates && ctrl.storage.candidates.length > 0) {
          // Pega os parâmetros de filtro (exceto lucro mínimo para UI)
          const volumeMinimo = ARBITRAGEM_CONFIG.minQuoteVolumeThreshold;
          const moedasPermitidasStepB = ctrl.options.arbitrage.allowedStepB;

          // Aplica filtros à lista de candidatos (SEM checar lucro mínimo bruto)
          displayCandidates = ctrl.storage.candidates.filter((c) => {
              // Filtro 1: Dados básicos existem?
              if (!c || !c.rate || !c.a_step_from || !c.a_step_to || !c.b_step_to || !c.c_step_to || !c.a || !c.a.c) return false;
              // Filtro 2: Começa e termina em USDT?
              if (c.a_step_from !== 'USDT' || c.c_step_to !== 'USDT') return false;

              // <<< LINHA DO LUCRO MÍNIMO BRUTO REMOVIDA/COMENTADA PARA DISPLAY >>>
              // const lucroPotencialBruto = (c.rate - 1) * 100;
              // if (lucroPotencialBruto <= lucroMinimoBruto) return false; // NÃO FILTRAR POR LUCRO PARA A UI

              // Filtro 4: Moeda do Step B (UI Step C) permitida?
              if (moedasPermitidasStepB && moedasPermitidasStepB.length > 0 && !moedasPermitidasStepB.includes(c.b_step_to)) return false;

              // Filtro 5: Volume mínimo por perna?
              const volA_usdt = parseFloat(c.a_quote_volume);
              let volB_usdt;
              const rawVolB = parseFloat(c.b_quote_volume);
              const priceIntermediate1InUSDT = parseFloat(c.a.c);
              if (isNaN(rawVolB) || isNaN(priceIntermediate1InUSDT) || priceIntermediate1InUSDT <= 0) return false;
              volB_usdt = rawVolB * priceIntermediate1InUSDT;
              const volC_usdt = parseFloat(c.c_quote_volume);
              if (isNaN(volA_usdt) || isNaN(volB_usdt) || isNaN(volC_usdt)) return false;
              if (volA_usdt < volumeMinimo || volB_usdt < volumeMinimo || volC_usdt < volumeMinimo) return false;

              // Se passou nos filtros restantes (exceto lucro), mantém para display
              return true;
          });

          // Ordena os candidatos filtrados para exibição
          displayCandidates.sort((a, b) => b.rate - a.rate);
      }
      // <<< --- FIM DO FILTRO PARA UI --- >>>

      // --- Passa dados para outros módulos ---
      if (this.pairRanker && typeof this.pairRanker.getPairRanking === 'function') {
          this.pairRanker.getPairRanking(ctrl.storage.candidates, ctrl.storage.pairRanks, ctrl, ctrl.logger);
      }
      if (this.tradingCore && typeof this.tradingCore.updateCandidateQueue === 'function') {
        this.tradingCore.updateCandidateQueue(stream, ctrl.storage.candidates, ctrl.storage.trading.queue);
      }

      // --- 3. Atualiza a UI com a lista filtrada (sem filtro de lucro) ---
      if (ctrl.UI && typeof ctrl.UI.updateArbitageOpportunities === 'function') {
          ctrl.UI.updateArbitageOpportunities(displayCandidates);
      }

      // --- 4. Verifica se há oportunidade para EXECUTAR (AQUI O FILTRO DE LUCRO É APLICADO!) ---
      await verificarExecutarArbitragem(ctrl);

      // --- Salvar histórico ---
       if (ctrl.options.storage.logHistory && this.dbHelpers) {
        this.dbHelpers.saveArbRows(ctrl.storage.candidates, ctrl.storage.db, ctrl.logger);
        if (stream && stream.arr) {
            this.dbHelpers.saveRawTick(stream.arr, ctrl.storage.db, ctrl.logger);
        }
      }
    } // Fim do if (streamID === "allMarketTickers")
  }; // Fim do ctrl.storage.streamTick

  function formatTimestamp() {
    const now = new Date();
    return `${now.getHours().toString().padStart(2, "0")}:${now
      .getMinutes()
      .toString()
      .padStart(2, "0")}:${now.getSeconds().toString().padStart(2, "0")}`;
  }

  // Função que verifica e potencialmente executa a arbitragem (FILTRO PARA EXECUÇÃO)
  async function verificarExecutarArbitragem(ctrl) {
    if (ctrl.options.trading.paperOnly || ARBITRAGEM_CONFIG.cooldown) {
      return;
    }

    const lucroMinimoBruto = ARBITRAGEM_CONFIG.lucroMinimoPercentual; // <<< LUCRO MÍNIMO PARA EXECUTAR
    const volumeMinimo = ARBITRAGEM_CONFIG.minQuoteVolumeThreshold;
    const moedasPermitidasStepB = ctrl.options.arbitrage.allowedStepB;

    const oportunidade = ctrl.storage.candidates
      .filter((c) => {
          if (!c || !c.rate || !c.a_step_from || !c.a_step_to || !c.b_step_to || !c.c_step_to || !c.a || !c.a.c) return false;
          if (c.a_step_from !== 'USDT' || c.c_step_to !== 'USDT') return false;

          // <<< FILTRO DE LUCRO MÍNIMO PARA EXECUÇÃO MANTIDO AQUI >>>
          const lucroPotencialBruto = (c.rate - 1) * 100;
          if (lucroPotencialBruto <= lucroMinimoBruto) return false; // <<< SÓ EXECUTA SE LUCRATIVO

          if (moedasPermitidasStepB && moedasPermitidasStepB.length > 0 && !moedasPermitidasStepB.includes(c.b_step_to)) return false;

          const volA_usdt = parseFloat(c.a_quote_volume);
          let volB_usdt;
          const rawVolB = parseFloat(c.b_quote_volume);
          const priceIntermediate1InUSDT = parseFloat(c.a.c);
           if (isNaN(rawVolB) || isNaN(priceIntermediate1InUSDT) || priceIntermediate1InUSDT <= 0) return false;
          volB_usdt = rawVolB * priceIntermediate1InUSDT;
          const volC_usdt = parseFloat(c.c_quote_volume);
          if (isNaN(volA_usdt) || isNaN(volB_usdt) || isNaN(volC_usdt)) return false;
          if (volA_usdt < volumeMinimo || volB_usdt < volumeMinimo || volC_usdt < volumeMinimo) return false;

          return true;
      })
      .sort((a, b) => b.rate - a.rate)
      [0];

    if (oportunidade) {
      // ... (Lógica de execução e tratamento de resultado permanece a mesma) ...
       // Extrai os detalhes da oportunidade que PASSOU NO FILTRO
      const baseCurrency = oportunidade.a_step_from;        // USDT
      const intermediate1 = oportunidade.a_step_to;       // UI Step B (ex: BTC)
      const intermediate2 = oportunidade.b_step_to;       // UI Step C (Moeda permitida, ex: ETH)
      const finalCurrency = oportunidade.c_step_to;        // USDT
      const lucroPercentualBrutoIdentificado = (oportunidade.rate - 1) * 100;

      // Prepara dados para log
      const volA_usdt_log = parseFloat(oportunidade.a_quote_volume);
      const priceIntermediate1InUSDT_log = parseFloat(oportunidade.a.c);
      const volB_usdt_log = parseFloat(oportunidade.b_quote_volume) * priceIntermediate1InUSDT_log;
      const volC_usdt_log = parseFloat(oportunidade.c_quote_volume);

      // Log da oportunidade selecionada PARA EXECUÇÃO
      console.log(
        `[${formatTimestamp()}] INFO: Oportunidade **VÁLIDA** selecionada para SIMULAÇÃO: ${baseCurrency} → ${intermediate1} → ${intermediate2} → ${finalCurrency} | Lucro Bruto Identificado: ${lucroPercentualBrutoIdentificado.toFixed(3)}% | Volumes USDT (A/B/C): ${volA_usdt_log.toFixed(0)}/${volB_usdt_log.toFixed(0)}/${volC_usdt_log.toFixed(0)}`
      );
      console.log(`[${formatTimestamp()}] INFO: A enviar para SIMULAÇÃO DE EXECUÇÃO com verificação de profundidade do livro...`);

      // Ativa o cooldown para evitar execuções muito rápidas em sequência
      ARBITRAGEM_CONFIG.cooldown = true;
      console.log(`[${formatTimestamp()}] INFO: Cooldown ativado (antes da simulação).`);

      const rotaCompletaLog = `${baseCurrency} → ${intermediate1} → ${intermediate2} → ${finalCurrency}`;
      ctrl.logger.info(
        `⏳ Iniciando simulação para: ${rotaCompletaLog} | Lucro bruto esperado: ${lucroPercentualBrutoIdentificado.toFixed(3)}% | ${formatTimestamp()}`
      );

      // Tenta executar a arbitragem (que deve incluir a simulação primeiro)
      try {
        const resultado = await executarArbitragem(intermediate1, intermediate2);

        // Log do resultado (útil para debug)
        // console.log(
        //   `[${formatTimestamp()}] DEBUG: Resultado de executarArbitragem (com simulação):`,
        //   JSON.stringify(resultado) // Cuidado: pode logar dados sensíveis
        // );

        // --- Tratamento do Resultado ---
        if (resultado && typeof resultado.realProfitPercentage !== 'undefined') {
          ctrl.logger.info(`✅ Arbitragem REAL concluída: ${resultado.route} | Lucro REAL: ${resultado.realProfit.toFixed(2)} USDT (${resultado.realProfitPercentage.toFixed(2)}%) | Lucro SIMULADO: ${resultado.simulatedProfitPercentage.toFixed(2)}%`);
          console.log(`[${formatTimestamp()}] INFO: Arbitragem REAL concluída com sucesso.`);
          ARBITRAGEM_CONFIG.historicoExecucoes.unshift({ timestamp: Date.now(), rota: resultado.route, lucroBrutoIdentificado: lucroPercentualBrutoIdentificado, lucroSimulado: resultado.simulatedProfitPercentage, lucroReal: resultado.realProfitPercentage, successfulExecution: true });
          ARBITRAGEM_CONFIG.ultimaExecucao = Date.now();
        } else if (resultado && resultado.error && resultado.error === 'Lucro simulado insuficiente') {
          ctrl.logger.warn(`🔶 Simulação NÃO APROVADA para ${rotaCompletaLog}: ${resultado.error} (Simulado: ${resultado.simulatedProfitPercentage.toFixed(2)}%)`);
          console.warn(`[${formatTimestamp()}] WARN: Simulação NÃO APROVADA para ${rotaCompletaLog}: ${resultado.error} (Simulado: ${resultado.simulatedProfitPercentage.toFixed(2)}%)`);
          ARBITRAGEM_CONFIG.historicoExecucoes.unshift({ timestamp: Date.now(), rota: rotaCompletaLog, lucroBrutoIdentificado: lucroPercentualBrutoIdentificado, lucroSimulado: resultado.simulatedProfitPercentage, error: resultado.error, successfulExecution: false });
        } else {
          const errorMsg = resultado && resultado.error ? resultado.error : "Erro desconhecido na simulação/execução";
          ctrl.logger.error(`❌ Falha na arbitragem (simulação/execução) para ${rotaCompletaLog}: ${errorMsg}`);
          console.error(`[${formatTimestamp()}] ERROR: Falha na arbitragem (simulação/execução) para ${rotaCompletaLog}: ${errorMsg}`);
          ARBITRAGEM_CONFIG.historicoExecucoes.unshift({ timestamp: Date.now(), rota: rotaCompletaLog, lucroBrutoIdentificado: lucroPercentualBrutoIdentificado, error: errorMsg, details: resultado?.details, successfulExecution: false });
        }

        // Mantém o histórico
        if (ARBITRAGEM_CONFIG.historicoExecucoes.length > ARBITRAGEM_CONFIG.maxHistorico) {
          ARBITRAGEM_CONFIG.historicoExecucoes = ARBITRAGEM_CONFIG.historicoExecucoes.slice(0, ARBITRAGEM_CONFIG.maxHistorico);
        }
      } catch (error) {
        // Tratamento de erro crítico
        ctrl.logger.error(`❌ Erro CRÍTICO no processo de arbitragem para ${rotaCompletaLog}: ${error.message}`);
        console.error(`[${formatTimestamp()}] CRITICAL ERROR: Erro durante o processo de arbitragem para ${rotaCompletaLog}:`, error);
        ARBITRAGEM_CONFIG.historicoExecucoes.unshift({ timestamp: Date.now(), rota: rotaCompletaLog, lucroBrutoIdentificado: lucroPercentualBrutoIdentificado, error: `Erro crítico no BotCore: ${error.message}`, successfulExecution: false });
      }

      // Agenda a desativação do cooldown
      console.log(`[${formatTimestamp()}] INFO: Configurando timeout para desativar cooldown em ${ARBITRAGEM_CONFIG.tempoCooldown}ms.`);
      setTimeout(() => {
        ARBITRAGEM_CONFIG.cooldown = false;
        console.log(`\n🕒 Sistema pronto para novas arbitragens | ${formatTimestamp()}`);
      }, ARBITRAGEM_CONFIG.tempoCooldown);
    } // Fim do if (oportunidade)
  } // Fim da função verificarExecutarArbitragem

  // Inicialização dos streams e outros cores
  ctrl.logger.info("--- Starting Currency Streams");
  try {
      ctrl.currencyCore = require("./CurrencyCore")(ctrl); // Assume que CurrencyCore existe em ./lib
  } catch (error) {
      ctrl.logger.error("FATAL: Failed to initialize CurrencyCore:", error);
      process.exit(1); // Sai se não conseguir inicializar
  }

  try {
      // Verifica se TradingCore é uma função antes de chamar
      if (TradingCore && typeof TradingCore === 'function') {
          // Assume que TradingCore espera opções e currencyCore
          this.tradingCore = TradingCore(ctrl.options.trading, ctrl.currencyCore);
      } else {
          // Loga um erro se TradingCore não for uma função válida
          ctrl.logger.error("FATAL: TradingCore module is invalid or not loaded correctly.");
          process.exit(1); // Sai se TradingCore for inválido
      }
  } catch (error) {
      ctrl.logger.error("FATAL: Failed to initialize TradingCore:", error);
      process.exit(1); // Sai se houver erro na inicialização
  }
}; // Fim do module.exports