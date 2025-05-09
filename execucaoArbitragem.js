const simulateArbitrageLeg = async (symbol, side, inputAmount, isQuoteAssetQty, legPrice, cachedSymbolInfo) => {
  console.log(`[SIM_LEG_TRACE] Iniciando simulateArbitrageLeg: symbol=${symbol}, side=${side}, inputAmount=${inputAmount}, isQuoteAssetQty=${isQuoteAssetQty}, legPrice=${legPrice}`);
  try {
    if (!cachedSymbolInfo || typeof cachedSymbolInfo !== 'object') {
      const errorMsg = `cachedSymbolInfo inválido ou não fornecido para ${symbol}.`;
      console.error(`[SIM_LEG_ERROR] ${errorMsg}`);
      return { error: errorMsg };
    }
    const symbolData = cachedSymbolInfo[symbol];
    if (!symbolData) {
      const errorMsg = `Dados do símbolo ${symbol} não encontrados no cachedSymbolInfo.`;
      console.error(`[SIM_LEG_ERROR] ${errorMsg}`);
      return { error: errorMsg };
    }
    const price = parseFloat(legPrice);
    const stepSize = parseFloat(symbolData.stepSize);
    const minQty = parseFloat(symbolData.minQty);
    const minNotional = parseFloat(symbolData.minNotional);

    if (isNaN(price) || price <= 0) {
        const errorMsg = `Preço da perna inválido para ${symbol}: ${legPrice}`;
        console.error(`[SIM_LEG_ERROR] ${errorMsg}`);
        return { error: errorMsg };
    }
    // ... (restante da função simulateArbitrageLeg como estava)
    console.log(`[SIM_LEG_TRACE] ${symbol}: Price (legPrice)=${price}, StepSize=${stepSize}, MinQty=${minQty}, MinNotional=${minNotional}`);

    const roundQty = (qty, step) => {
      if (step === 0) return qty;
      const precision = Math.max(0, Math.floor(-Math.log10(step)));
      return parseFloat((Math.floor(qty / step) * step).toFixed(precision));
    };

    let qty;
    if (isQuoteAssetQty) {
      qty = roundQty(inputAmount / price, stepSize);
      console.log(`[SIM_LEG_TRACE] ${symbol}: Qtd calculada (baseada em quote): ${inputAmount / price} (de ${inputAmount} ${symbolData.quoteAsset} @ ${price}), Arredondada para: ${qty} ${symbolData.baseAsset}`);
    } else {
      qty = roundQty(inputAmount, stepSize);
      console.log(`[SIM_LEG_TRACE] ${symbol}: Qtd (baseada em base): ${inputAmount} ${symbolData.baseAsset}, Arredondada para: ${qty} ${symbolData.baseAsset}`);
    }

    if (qty < minQty) {
        console.warn(`[SIM_LEG_WARN] Quantidade calculada ${qty} ${symbolData.baseAsset} para ${symbol} é menor que minQty ${minQty}. Input: ${inputAmount}. Verificando minNotional.`);
        if (qty === 0 && inputAmount > 0 && minQty > 0) {
             const errorMsg = `Quantidade para ${symbol} arredondada para 0 (de ${isQuoteAssetQty ? (inputAmount/price) : inputAmount}) devido ao stepSize ${stepSize}, mas minQty é ${minQty}.`;
             console.error(`[SIM_LEG_ERROR] ${errorMsg}`);
             return { error: errorMsg };
        }
    }
    
    const estimatedValueInQuote = isQuoteAssetQty ? inputAmount : qty * price;
    console.log(`[SIM_LEG_TRACE] ${symbol}: Valor Estimado da Ordem (em ${symbolData.quoteAsset}): ${estimatedValueInQuote}`);

    if (estimatedValueInQuote < minNotional) {
      const errorMsg = `Valor estimado da ordem ${estimatedValueInQuote} ${symbolData.quoteAsset} para ${symbol} é menor que minNotional ${minNotional}.`;
      console.error(`[SIM_LEG_ERROR] ${errorMsg}`);
      return { error: errorMsg };
    }

    const feePercent = parseFloat(process.env.BINANCE_TRADE_FEE_PERCENT) || 0.1;
    let finalAmountObtained;
    let assetObtained;

    if (side === 'BUY') {
        finalAmountObtained = qty * (1 - (feePercent / 100));
        assetObtained = symbolData.baseAsset;
        console.log(`[SIM_LEG_TRACE] ${symbol} (BUY): Obtido ${finalAmountObtained} ${assetObtained} (de ${qty} antes da taxa ${feePercent}%)`);
    } else { // side === 'SELL'
        finalAmountObtained = (qty * price) * (1 - (feePercent / 100));
        assetObtained = symbolData.quoteAsset;
        console.log(`[SIM_LEG_TRACE] ${symbol} (SELL): Obtido ${finalAmountObtained} ${assetObtained} (de ${qty * price} antes da taxa ${feePercent}%)`);
    }

    return {
      finalAmount: finalAmountObtained,
      assetObtained: assetObtained,
      finalQtyBeforeTax: qty,
      avgPriceSimulated: price,
      executedQtyBase: qty,
      executedQtyQuote: qty * price,
      feeApplied: feePercent,
      symbolUsed: symbol,
      sideUsed: side
    };
  } catch (err) {
    console.error(`[SIM_LEG_ERROR] Erro catastrófico em simulateArbitrageLeg para ${symbol}: ${err.message}`, err.stack);
    return { error: `Erro em simulateArbitrageLeg (${symbol}): ${err.message}` };
  }
};

const simulateArbitragePath = async (
  intermediate1, 
  intermediate2, 
  initialCapital, 
  cachedSymbolInfo,
  priceLeg1, 
  priceLeg2, 
  priceLeg3
) => {
  try {
    let currentAsset = "USDT"; 
    let currentAmount = initialCapital;

    console.log(`[SIM_PATH_DEBUG] Iniciando simulação de caminho: ${currentAsset} -> ${intermediate1} -> ${intermediate2} -> ${currentAsset} com Capital Inicial: ${currentAmount} ${currentAsset}`);
    console.log(`[SIM_PATH_DEBUG] Preços das pernas: Leg1=${priceLeg1}, Leg2=${priceLeg2}, Leg3=${priceLeg3}`);

    const leg1Symbol = `${intermediate1}${currentAsset}`;
    console.log(`[SIM_PATH_DEBUG] Perna 1: Tentando ${currentAsset} -> ${intermediate1} via ${leg1Symbol} @ ${priceLeg1}`);
    const leg1Info = await simulateArbitrageLeg(leg1Symbol, 'BUY', currentAmount, true, priceLeg1, cachedSymbolInfo);
    if (leg1Info.error) {
      console.error(`[SIM_PATH_ERROR] Perna 1 (${leg1Symbol}) falhou: ${leg1Info.error}`);
      return { error: `Perna 1 (${leg1Symbol}): ${leg1Info.error}`, path: [leg1Info || {}] };
    }
    console.log(`[SIM_PATH_DEBUG] Perna 1 (${leg1Symbol}) OK. Obtido: ${leg1Info.finalAmount} ${leg1Info.assetObtained}`);
    currentAsset = leg1Info.assetObtained;
    currentAmount = leg1Info.finalAmount;

    let leg2Symbol, leg2Side, leg2InputIsQuote;
    const symbolTry1_leg2 = `${intermediate2}${currentAsset}`;
    const symbolTry1Data_leg2 = cachedSymbolInfo[symbolTry1_leg2];

    if (symbolTry1Data_leg2 && symbolTry1Data_leg2.status === "TRADING") {
      leg2Symbol = symbolTry1_leg2;
      leg2Side = 'BUY';
      leg2InputIsQuote = (symbolTry1Data_leg2.quoteAsset === currentAsset);
    } else {
      const symbolTry2_leg2 = `${currentAsset}${intermediate2}`;
      const symbolTry2Data_leg2 = cachedSymbolInfo[symbolTry2_leg2];
      if (symbolTry2Data_leg2 && symbolTry2Data_leg2.status === "TRADING") {
        leg2Symbol = symbolTry2_leg2;
        leg2Side = 'SELL';
        leg2InputIsQuote = (symbolTry2Data_leg2.quoteAsset === currentAsset);
      } else {
        const errorMsg = `Nenhum par de negociação válido encontrado para Perna 2 entre ${currentAsset} e ${intermediate2}. Tentativas: ${symbolTry1_leg2}, ${symbolTry2_leg2}`;
        console.error(`[SIM_PATH_ERROR] ${errorMsg}`);
        return { error: errorMsg, path: [leg1Info, {}] };
      }
    }
    console.log(`[SIM_PATH_DEBUG] Perna 2: Tentando ${currentAsset} -> ${intermediate2} via ${leg2Symbol} (${leg2Side}) @ ${priceLeg2}, Input: ${currentAmount} ${currentAsset}, Input é Quote: ${leg2InputIsQuote}`);
    
    const leg2Info = await simulateArbitrageLeg(leg2Symbol, leg2Side, currentAmount, leg2InputIsQuote, priceLeg2, cachedSymbolInfo);
    if (leg2Info.error) {
      console.error(`[SIM_PATH_ERROR] Perna 2 (${leg2Symbol}) falhou: ${leg2Info.error}`);
      return { error: `Perna 2 (${leg2Symbol}): ${leg2Info.error}`, path: [leg1Info, leg2Info || {}] };
    }
    console.log(`[SIM_PATH_DEBUG] Perna 2 (${leg2Symbol}) OK. Obtido: ${leg2Info.finalAmount} ${leg2Info.assetObtained}`);
    currentAsset = leg2Info.assetObtained;
    currentAmount = leg2Info.finalAmount;

    const leg3Symbol = `${currentAsset}USDT`;
    console.log(`[SIM_PATH_DEBUG] Perna 3: Tentando ${currentAsset} -> USDT via ${leg3Symbol} @ ${priceLeg3}`);
    const leg3Info = await simulateArbitrageLeg(leg3Symbol, 'SELL', currentAmount, false, priceLeg3, cachedSymbolInfo);
    if (leg3Info.error) {
      console.error(`[SIM_PATH_ERROR] Perna 3 (${leg3Symbol}) falhou: ${leg3Info.error}`);
      return { error: `Perna 3 (${leg3Symbol}): ${leg3Info.error}`, path: [leg1Info, leg2Info, leg3Info || {}] };
    }
    console.log(`[SIM_PATH_DEBUG] Perna 3 (${leg3Symbol}) OK. Obtido: ${leg3Info.finalAmount} ${leg3Info.assetObtained} (USDT)`);
    const finalUsdtAmount = leg3Info.finalAmount;

    console.log(`[SIM_PATH_DEBUG] Simulação concluída. Capital Inicial USDT: ${initialCapital}, Capital Final USDT: ${finalUsdtAmount}`);
    return {
      simulatedProfit: finalUsdtAmount - initialCapital,
      simulatedProfitPercentage: ((finalUsdtAmount / initialCapital) - 1) * 100,
      finalSimulatedUSDT: finalUsdtAmount,
      path: [leg1Info, leg2Info, leg3Info]
    };

  } catch (err) {
    console.error(`[SIM_PATH_ERROR] Erro catastrófico na simulação de caminho: ${err.message}`, err.stack);
    return { error: `Erro na simulação de caminho: ${err.message}` };
  }
};

/*
NOVA FUNÇÃO PARA EXECUÇÃO REAL
Esta função será responsável por executar as três pernas da arbitragem triangular
utilizando chamadas reais à API da Binance (ou outra exchange configurada).
*/
const executarArbitragemReal = async (
  intermediate1, 
  intermediate2, 
  initialCapital, 
  cachedSymbolInfo,
  priceLeg1, // Preço estimado para USDT -> intermediate1
  priceLeg2, // Preço estimado para intermediate1 -> intermediate2
  priceLeg3, // Preço estimado para intermediate2 -> USDT
  exchangeAPI // Instância da API da Binance (ou outra)
) => {
  console.log(`[REAL_EXEC_INFO] Iniciando EXECUÇÃO REAL de arbitragem: USDT -> ${intermediate1} -> ${intermediate2} -> USDT`);
  console.log(`[REAL_EXEC_INFO] Capital Inicial: ${initialCapital} USDT. Preços estimados (simulação): L1=${priceLeg1}, L2=${priceLeg2}, L3=${priceLeg3}`);

  // Logs adicionados para depuração do objeto exchangeAPI
  console.log("[REAL_EXEC_DEBUG] Verificando exchangeAPI...");
  console.log("[REAL_EXEC_DEBUG] typeof exchangeAPI:", typeof exchangeAPI);
  if (exchangeAPI && typeof exchangeAPI === 'object') {
    console.log("[REAL_EXEC_DEBUG] Chaves (métodos/propriedades) do objeto exchangeAPI:", Object.keys(exchangeAPI));
    // Se a API for estruturada como client.trade.newOrder()
    if (typeof exchangeAPI.trade === 'object' && exchangeAPI.trade !== null) {
        console.log("[REAL_EXEC_DEBUG] Chaves (métodos/propriedades) de exchangeAPI.trade:", Object.keys(exchangeAPI.trade));
    }
    // Verificar se 'order' ou 'newOrder' existem diretamente ou em 'trade'
    if (typeof exchangeAPI.order === 'function') {
        console.log("[REAL_EXEC_DEBUG] exchangeAPI.order é uma função.");
    } else {
        console.log("[REAL_EXEC_DEBUG] exchangeAPI.order NÃO é uma função.");
    }
    if (exchangeAPI.trade && typeof exchangeAPI.trade.newOrder === 'function') {
        console.log("[REAL_EXEC_DEBUG] exchangeAPI.trade.newOrder é uma função.");
    } else {
        console.log("[REAL_EXEC_DEBUG] exchangeAPI.trade.newOrder NÃO é uma função (ou exchangeAPI.trade não existe).");
    }
  }
  // Fim dos logs adicionados

  if (!exchangeAPI || typeof exchangeAPI.order !== 'function') {
    console.error("[REAL_EXEC_ERROR] exchangeAPI inválida ou função order não disponível. Verifique os logs de depuração acima para detalhes sobre o objeto exchangeAPI.");
    return { success: false, error: "exchangeAPI inválida ou função order não disponível para execução real. Verifique os logs." };
  }

  let currentAsset = "USDT";
  let currentAmount = initialCapital;
  const pathResults = [];
  const feePercent = parseFloat(process.env.BINANCE_TRADE_FEE_PERCENT) || 0.1;

  // Função auxiliar para obter precisão de uma string de stepSize
  const getPrecision = (stepSizeStr) => {
    const stepSize = parseFloat(stepSizeStr);
    if (isNaN(stepSize) || stepSize <= 0) return 8; // Default precision
    if (stepSize >= 1) return 0;
    const decimalPart = String(stepSize).split('.')[1];
    return decimalPart ? decimalPart.length : 0;
  };

  try {
    // --- PERNA 1: USDT -> intermediate1 (e.g., BTC) ---
    const leg1Symbol = `${intermediate1}${currentAsset}`; // e.g., BTCUSDT
    const leg1SymbolData = cachedSymbolInfo[leg1Symbol];
    if (!leg1SymbolData) {
        console.error(`[REAL_EXEC_ERROR] Dados de símbolo não encontrados para ${leg1Symbol} na Perna 1.`);
        return { success: false, error: `Dados não encontrados para ${leg1Symbol}` };
    }
    // Para MARKET BUY com quoteOrderQty, a Binance usa a precisão do quote asset (USDT)
    // Usar toFixed(8) é geralmente seguro para quoteOrderQty, a exchange truncará se necessário.
    const leg1OrderParams = { 
        symbol: leg1Symbol, 
        side: 'BUY', 
        type: 'MARKET', 
        quoteOrderQty: initialCapital.toFixed(8) 
    };
    console.log(`[REAL_EXEC_LEG1] Enviando Ordem: COMPRAR ${intermediate1} com ${initialCapital.toFixed(8)} ${currentAsset} no par ${leg1Symbol}`, leg1OrderParams);
    
    const order1 = await exchangeAPI.order(leg1OrderParams);
    console.log("[REAL_EXEC_LEG1] Resposta da Ordem 1:", JSON.stringify(order1));

    if (!order1 || order1.status !== 'FILLED') {
      const errorMsg = `Falha na Perna 1 (${leg1Symbol}): Status ${order1?.status}, Msg: ${order1?.msg}`;
      console.error(`[REAL_EXEC_ERROR] ${errorMsg}`);
      pathResults.push({ symbol: leg1Symbol, side: 'BUY', params: leg1OrderParams, response: order1, error: errorMsg });
      return { success: false, error: errorMsg, path: pathResults };
    }
    const amountLeg1Obtained = parseFloat(order1.executedQty);
    const costLeg1Quote = parseFloat(order1.cummulativeQuoteQty);
    const effectivePriceLeg1 = costLeg1Quote / amountLeg1Obtained;
    currentAmount = amountLeg1Obtained * (1 - (feePercent / 100)); // Aplicar taxa sobre o ativo obtido
    currentAsset = intermediate1;
    pathResults.push({ 
        symbol: leg1Symbol, side: 'BUY', params: leg1OrderParams, response: order1, 
        amountIn: initialCapital, assetIn: "USDT", 
        amountOutGross: amountLeg1Obtained, amountOutNet: currentAmount, assetOut: currentAsset, 
        effectivePrice: effectivePriceLeg1 
    });
    console.log(`[REAL_EXEC_LEG1] Perna 1 SUCESSO. Obtido (líquido de taxa simulada): ${currentAmount.toFixed(8)} ${currentAsset}. Preço Efetivo: ${effectivePriceLeg1.toFixed(8)}`);

    // --- PERNA 2: intermediate1 -> intermediate2 (e.g., BTC -> ETH) ---
    let leg2Symbol, leg2Side, leg2OrderParams;
    const leg2SymbolTry1 = `${intermediate2}${currentAsset}`; // e.g., ETHBTC (comprar ETH com BTC)
    const leg2SymbolTry1Data = cachedSymbolInfo[leg2SymbolTry1];
    const leg2SymbolTry2 = `${currentAsset}${intermediate2}`; // e.g., BTCETH (vender BTC por ETH)
    const leg2SymbolTry2Data = cachedSymbolInfo[leg2SymbolTry2];

    if (leg2SymbolTry1Data && leg2SymbolTry1Data.status === "TRADING") {
      leg2Symbol = leg2SymbolTry1;
      leg2Side = 'BUY';
      // Comprar intermediate2 usando currentAsset (intermediate1). currentAsset é a quote asset.
      leg2OrderParams = { 
          symbol: leg2Symbol, 
          side: 'BUY', 
          type: 'MARKET', 
          quoteOrderQty: currentAmount.toFixed(8) // Usar a quantidade de currentAsset que temos
      };
      console.log(`[REAL_EXEC_LEG2] Enviando Ordem: COMPRAR ${intermediate2} com ${currentAmount.toFixed(8)} ${currentAsset} no par ${leg2Symbol}`, leg2OrderParams);
    } else if (leg2SymbolTry2Data && leg2SymbolTry2Data.status === "TRADING") {
      leg2Symbol = leg2SymbolTry2;
      leg2Side = 'SELL';
      // Vender currentAsset (intermediate1) para obter intermediate2. currentAsset é a base asset.
      const leg2Qty = roundQty(currentAmount, parseFloat(leg2SymbolTry2Data.stepSize));
      if (leg2Qty < parseFloat(leg2SymbolTry2Data.minQty)) {
          const errorMsg = `Perna 2 (${leg2Symbol}): Quantidade ${leg2Qty} < minQty ${leg2SymbolTry2Data.minQty}`;
          console.error("[REAL_EXEC_ERROR]", errorMsg);
          pathResults.push({ error: errorMsg });
          return { success: false, error: errorMsg, path: pathResults };
      }
      leg2OrderParams = { 
          symbol: leg2Symbol, 
          side: 'SELL', 
          type: 'MARKET', 
          quantity: leg2Qty.toFixed(getPrecision(leg2SymbolTry2Data.stepSize)) 
      };
      console.log(`[REAL_EXEC_LEG2] Enviando Ordem: VENDER ${leg2Qty.toFixed(getPrecision(leg2SymbolTry2Data.stepSize))} ${currentAsset} por ${intermediate2} no par ${leg2Symbol}`, leg2OrderParams);
    } else {
      const errorMsg = `Nenhum par de negociação válido encontrado para Perna 2 entre ${currentAsset} e ${intermediate2}`;
      console.error(`[REAL_EXEC_ERROR] ${errorMsg}`);
      pathResults.push({ error: errorMsg });
      return { success: false, error: errorMsg, path: pathResults };
    }
    
    const order2 = await exchangeAPI.order(leg2OrderParams);
    console.log("[REAL_EXEC_LEG2] Resposta da Ordem 2:", JSON.stringify(order2));

    if (!order2 || order2.status !== 'FILLED') {
      const errorMsg = `Falha na Perna 2 (${leg2Symbol}): Status ${order2?.status}, Msg: ${order2?.msg}`;
      console.error(`[REAL_EXEC_ERROR] ${errorMsg}`);
      pathResults.push({ symbol: leg2Symbol, side: leg2Side, params: leg2OrderParams, response: order2, error: errorMsg });
      return { success: false, error: errorMsg, path: pathResults };
    }

    const amountInLeg2 = currentAmount; // Salvar o input para o pathResults
    const assetInLeg2 = currentAsset;
    let amountLeg2ObtainedGross, costLeg2Quote = parseFloat(order2.cummulativeQuoteQty), executedQtyLeg2Base = parseFloat(order2.executedQty);
    let effectivePriceLeg2;

    if (leg2Side === 'BUY') {
      amountLeg2ObtainedGross = executedQtyLeg2Base; // Obtemos intermediate2 (base asset do par)
      effectivePriceLeg2 = costLeg2Quote / amountLeg2ObtainedGross;
      currentAmount = amountLeg2ObtainedGross * (1 - (feePercent / 100));
      currentAsset = intermediate2;
    } else { // SELL
      amountLeg2ObtainedGross = costLeg2Quote; // Obtemos intermediate2 (quote asset do par)
      effectivePriceLeg2 = amountLeg2ObtainedGross / executedQtyLeg2Base; // Preço é quote/base
      currentAmount = amountLeg2ObtainedGross * (1 - (feePercent / 100));
      currentAsset = intermediate2;
    }
    pathResults.push({ 
        symbol: leg2Symbol, side: leg2Side, params: leg2OrderParams, response: order2, 
        amountIn: amountInLeg2, assetIn: assetInLeg2, 
        amountOutGross: amountLeg2ObtainedGross, amountOutNet: currentAmount, assetOut: currentAsset, 
        effectivePrice: effectivePriceLeg2 
    });
    console.log(`[REAL_EXEC_LEG2] Perna 2 SUCESSO. Obtido (líquido de taxa simulada): ${currentAmount.toFixed(8)} ${currentAsset}. Preço Efetivo: ${effectivePriceLeg2.toFixed(8)}`);

    // --- PERNA 3: intermediate2 -> USDT (e.g., ETH -> USDT) ---
    const leg3Symbol = `${currentAsset}USDT`; // e.g., ETHUSDT
    const leg3SymbolData = cachedSymbolInfo[leg3Symbol];
    if (!leg3SymbolData) {
        console.error(`[REAL_EXEC_ERROR] Dados de símbolo não encontrados para ${leg3Symbol} na Perna 3.`);
        pathResults.push({ error: `Dados não encontrados para ${leg3Symbol}` });
        return { success: false, error: `Dados não encontrados para ${leg3Symbol}`, path: pathResults };
    }
    const leg3Qty = roundQty(currentAmount, parseFloat(leg3SymbolData.stepSize));
    if (leg3Qty < parseFloat(leg3SymbolData.minQty)) {
        const errorMsg = `Perna 3 (${leg3Symbol}): Quantidade ${leg3Qty} < minQty ${leg3SymbolData.minQty}`;
        console.error("[REAL_EXEC_ERROR]", errorMsg);
        pathResults.push({ error: errorMsg });
        return { success: false, error: errorMsg, path: pathResults };
    }
    const leg3OrderParams = { 
        symbol: leg3Symbol, 
        side: 'SELL', 
        type: 'MARKET', 
        quantity: leg3Qty.toFixed(getPrecision(leg3SymbolData.stepSize)) 
    };
    console.log(`[REAL_EXEC_LEG3] Enviando Ordem: VENDER ${leg3Qty.toFixed(getPrecision(leg3SymbolData.stepSize))} ${currentAsset} por USDT no par ${leg3Symbol}`, leg3OrderParams);

    const order3 = await exchangeAPI.order(leg3OrderParams);
    console.log("[REAL_EXEC_LEG3] Resposta da Ordem 3:", JSON.stringify(order3));

    if (!order3 || order3.status !== 'FILLED') {
      const errorMsg = `Falha na Perna 3 (${leg3Symbol}): Status ${order3?.status}, Msg: ${order3?.msg}`;
      console.error(`[REAL_EXEC_ERROR] ${errorMsg}`);
      pathResults.push({ symbol: leg3Symbol, side: 'SELL', params: leg3OrderParams, response: order3, error: errorMsg });
      return { success: false, error: errorMsg, path: pathResults };
    }

    const amountInLeg3 = currentAmount; // Salvar o input para o pathResults
    const assetInLeg3 = currentAsset;
    const amountLeg3ObtainedGross = parseFloat(order3.cummulativeQuoteQty); // USDT obtido
    const executedQtyLeg3Base = parseFloat(order3.executedQty);
    const effectivePriceLeg3 = amountLeg3ObtainedGross / executedQtyLeg3Base;
    currentAmount = amountLeg3ObtainedGross * (1 - (feePercent / 100));
    currentAsset = "USDT";
    pathResults.push({ 
        symbol: leg3Symbol, side: 'SELL', params: leg3OrderParams, response: order3, 
        amountIn: amountInLeg3, assetIn: assetInLeg3, 
        amountOutGross: amountLeg3ObtainedGross, amountOutNet: currentAmount, assetOut: currentAsset, 
        effectivePrice: effectivePriceLeg3 
    });
    console.log(`[REAL_EXEC_LEG3] Perna 3 SUCESSO. Obtido (líquido de taxa simulada): ${currentAmount.toFixed(8)} ${currentAsset}. Preço Efetivo: ${effectivePriceLeg3.toFixed(8)}`);

    const finalProfit = currentAmount - initialCapital;
    const finalProfitPercentage = (finalProfit / initialCapital) * 100;
    console.log(`[REAL_EXEC_SUCCESS] Execução REAL CONCLUÍDA. Capital Final: ${currentAmount.toFixed(8)} USDT. Lucro: ${finalProfit.toFixed(8)} USDT (${finalProfitPercentage.toFixed(3)}%)`);
    return {
      success: true,
      profit: finalProfit,
      profitPercentage: finalProfitPercentage,
      finalAmount: currentAmount,
      path: pathResults
    };

  } catch (error) {
    console.error(`[REAL_EXEC_ERROR] Erro catastrófico durante execução real: ${error.message}`, error.stack);
    pathResults.push({ error: `Erro catastrófico: ${error.message}` });
    return { success: false, error: `Erro na execução real: ${error.message}`, path: pathResults };
  }
};

module.exports = {
  simulateArbitragePath,
  executarArbitragemReal // Exportar a nova função
};

