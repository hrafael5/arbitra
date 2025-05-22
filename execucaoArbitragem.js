require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');

const API_KEY = process.env.BINANCE_APIKEY;
const API_SECRET = process.env.BINANCE_APISECRET;
const BASE_URL = 'https://api.binance.com';
const capitalUSDT = 50; // Capital inicial em USDT para a operação
const MAX_SLIPPAGE_PERCENT = 0.5; // Slippage máximo aceitável (0.5%)
const VERIFICAR_LUCRO_PREVIO = true; // Controle para ativar/desativar verificação prévia de lucro

/**
 * Obtém o timestamp atual para assinatura das requisições
 */
function getTimestamp() {
  return Date.now();
}

/**
 * Assina a requisição usando a chave secreta
 * @param {string} queryString - String de consulta a ser assinada
 * @returns {string} - Assinatura hexadecimal
 */
function sign(queryString) {
  return crypto.createHmac('sha256', API_SECRET).update(queryString).digest('hex');
}

/**
 * Solicita uma cotação para conversão via API Convert da Binance
 * @param {string} fromAsset - Moeda de origem
 * @param {string} toAsset - Moeda de destino
 * @param {string} [fromAmount] - Quantidade da moeda de origem a converter
 * @param {string} [toAmount] - Quantidade da moeda de destino a receber
 * @param {string} [validTime='10s'] - Tempo de validade da cotação (10s, 30s, 1m)
 * @param {boolean} [apenasSimulacao=false] - Se true, apenas para simulação (não loga detalhes)
 * @returns {Promise<object>} - Resposta da API com dados da cotação
 */
async function getConvertQuote(fromAsset, toAsset, fromAmount, toAmount, validTime = '10s', apenasSimulacao = false) {
  const endpoint = '/sapi/v1/convert/getQuote';
  const timestamp = getTimestamp();
  
  let queryParams = `fromAsset=${fromAsset}&toAsset=${toAsset}&timestamp=${timestamp}`;
  
  // Adiciona fromAmount ou toAmount (um dos dois é obrigatório)
  if (fromAmount) {
    queryParams += `&fromAmount=${fromAmount}`;
  } else if (toAmount) {
    queryParams += `&toAmount=${toAmount}`;
  } else {
    throw new Error("Para solicitação de cotação, 'fromAmount' ou 'toAmount' deve ser fornecido.");
  }
  
  // Adiciona validTime se fornecido
  if (validTime) {
    queryParams += `&validTime=${validTime}`;
  }
  
  const signature = sign(queryParams);
  const url = `${BASE_URL}${endpoint}?${queryParams}&signature=${signature}`;
  
  try {
    if (!apenasSimulacao) {
      console.log(`[getConvertQuote] Solicitando cotação para conversão de ${fromAmount ? fromAmount : ''} ${fromAsset} para ${toAmount ? toAmount : ''} ${toAsset}`);
    }
    
    const response = await axios.post(url, null, {
      headers: { 'X-MBX-APIKEY': API_KEY }
    });
    
    if (!apenasSimulacao) {
      console.log(`[getConvertQuote] ✅ Cotação recebida: ${fromAsset} -> ${toAsset}, ratio: ${response.data.ratio}, inverseRatio: ${response.data.inverseRatio}`);
    }
    return response.data;
    
  } catch (error) {
    console.error(`[getConvertQuote] ❌ Erro ao solicitar cotação ${fromAsset} -> ${toAsset}:`, error.message);
    if (error.response && error.response.data) {
      console.error("[getConvertQuote] Detalhes do erro da API Binance:", JSON.stringify(error.response.data));
      const binanceErrorMsg = error.response.data.msg || JSON.stringify(error.response.data);
      throw new Error(`Erro API Binance (cotação ${fromAsset} -> ${toAsset}): ${binanceErrorMsg}`);
    } else {
      throw error;
    }
  }
}

/**
 * Aceita uma cotação de conversão
 * @param {string} quoteId - ID da cotação a ser aceita
 * @returns {Promise<object>} - Resposta da API com dados da ordem
 */
async function acceptConvertQuote(quoteId) {
  const endpoint = '/sapi/v1/convert/acceptQuote';
  const timestamp = getTimestamp();
  
  const queryParams = `quoteId=${quoteId}&timestamp=${timestamp}`;
  const signature = sign(queryParams);
  const url = `${BASE_URL}${endpoint}?${queryParams}&signature=${signature}`;
  
  try {
    console.log(`[acceptConvertQuote] Aceitando cotação: ${quoteId}`);
    
    const response = await axios.post(url, null, {
      headers: { 'X-MBX-APIKEY': API_KEY }
    });
    
    console.log(`[acceptConvertQuote] ✅ Cotação aceita: orderId=${response.data.orderId}, status=${response.data.orderStatus}`);
    return response.data;
    
  } catch (error) {
    console.error(`[acceptConvertQuote] ❌ Erro ao aceitar cotação ${quoteId}:`, error.message);
    if (error.response && error.response.data) {
      console.error("[acceptConvertQuote] Detalhes do erro da API Binance:", JSON.stringify(error.response.data));
      const binanceErrorMsg = error.response.data.msg || JSON.stringify(error.response.data);
      throw new Error(`Erro API Binance (aceitar cotação ${quoteId}): ${binanceErrorMsg}`);
    } else {
      throw error;
    }
  }
}

/**
 * Verifica o status de uma ordem de conversão
 * @param {string} orderId - ID da ordem a ser verificada
 * @returns {Promise<object>} - Resposta da API com dados do status da ordem
 */
async function getConvertOrderStatus(orderId) {
  const endpoint = '/sapi/v1/convert/orderStatus';
  const timestamp = getTimestamp();
  
  const queryParams = `orderId=${orderId}&timestamp=${timestamp}`;
  const signature = sign(queryParams);
  const url = `${BASE_URL}${endpoint}?${queryParams}&signature=${signature}`;
  
  try {
    console.log(`[getConvertOrderStatus] Verificando status da ordem: ${orderId}`);
    
    const response = await axios.get(url, {
      headers: { 'X-MBX-APIKEY': API_KEY }
    });
    
    console.log(`[getConvertOrderStatus] ✅ Status da ordem ${orderId}: ${response.data.orderStatus}`);
    return response.data;
    
  } catch (error) {
    console.error(`[getConvertOrderStatus] ❌ Erro ao verificar status da ordem ${orderId}:`, error.message);
    if (error.response && error.response.data) {
      console.error("[getConvertOrderStatus] Detalhes do erro da API Binance:", JSON.stringify(error.response.data));
      const binanceErrorMsg = error.response.data.msg || JSON.stringify(error.response.data);
      throw new Error(`Erro API Binance (status da ordem ${orderId}): ${binanceErrorMsg}`);
    } else {
      throw error;
    }
  }
}

/**
 * Aguarda até que uma ordem de conversão seja concluída
 * @param {string} orderId - ID da ordem a ser monitorada
 * @param {number} maxAttempts - Número máximo de tentativas
 * @param {number} interval - Intervalo entre as verificações em ms
 * @returns {Promise<object>} - Dados da ordem concluída
 */
async function waitForConvertOrderCompletion(orderId, maxAttempts = 10, interval = 1000) {
  console.log(`[waitForConvertOrderCompletion] Aguardando conclusão da ordem ${orderId}...`);
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const orderStatus = await getConvertOrderStatus(orderId);
    
    if (orderStatus.orderStatus === 'SUCCESS') {
      console.log(`[waitForConvertOrderCompletion] ✅ Ordem ${orderId} concluída com sucesso!`);
      return orderStatus;
    } else if (orderStatus.orderStatus === 'FAILED') {
      throw new Error(`Ordem ${orderId} falhou: ${JSON.stringify(orderStatus)}`);
    }
    
    console.log(`[waitForConvertOrderCompletion] Ordem ${orderId} em processamento (${orderStatus.orderStatus}), tentativa ${attempt}/${maxAttempts}`);
    
    if (attempt < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, interval));
    }
  }
  
  throw new Error(`Tempo limite excedido aguardando a conclusão da ordem ${orderId}`);
}

/**
 * Verifica se uma arbitragem triangular seria lucrativa com base em cotações
 * @param {string} stepA - Primeira moeda (ex: BTC)
 * @param {string} stepC - Terceira moeda (ex: ETH)
 * @param {number} minLucroPercentual - Lucro mínimo percentual para aprovar
 * @returns {Promise<object>} - Resultado da simulação
 */
async function verificarLucroArbitragem(stepA, stepC, minLucroPercentual = 0.3) {
  try {
    console.log(`\n🔍 Verificando lucro potencial para arbitragem: USDT → ${stepA} → ${stepC} → USDT`);
    
    // Etapa 1: USDT -> StepA (simulação)
    const quote1 = await getConvertQuote('USDT', stepA, capitalUSDT.toString(), null, '30s', true);
    const estimatedStepA = parseFloat(quote1.toAmount);
    
    // Etapa 2: StepA -> StepC (simulação)
    const bufferFactor = 0.999;
    const amountOfStepAToSpend = (estimatedStepA * bufferFactor).toFixed(8);
    const quote2 = await getConvertQuote(stepA, stepC, amountOfStepAToSpend, null, '30s', true);
    const estimatedStepC = parseFloat(quote2.toAmount);
    
    // Etapa 3: StepC -> USDT (simulação)
    const bufferFactor3 = 0.999;
    const amountOfStepCToSpend = (estimatedStepC * bufferFactor3).toFixed(8);
    const quote3 = await getConvertQuote(stepC, 'USDT', amountOfStepCToSpend, null, '30s', true);
    const estimatedFinalUSDT = parseFloat(quote3.toAmount);
    
    // Cálculo do lucro estimado
    const lucroEstimado = estimatedFinalUSDT - capitalUSDT;
    const lucroPercentualEstimado = (lucroEstimado / capitalUSDT) * 100;
    
    console.log(`\n=== SIMULAÇÃO DE LUCRO ===`);
    console.log(`💰 Capital inicial: ${capitalUSDT.toFixed(2)} USDT`);
    console.log(`💰 Capital final estimado: ${estimatedFinalUSDT.toFixed(2)} USDT`);
    console.log(`${lucroEstimado >= 0 ? '✅' : '❌'} Lucro/Prejuízo estimado: ${lucroEstimado.toFixed(2)} USDT (${lucroPercentualEstimado.toFixed(2)}%)`);
    console.log(`🎯 Lucro mínimo necessário: ${minLucroPercentual.toFixed(2)}%`);
    
    const aprovado = lucroPercentualEstimado >= minLucroPercentual;
    console.log(`${aprovado ? '✅ APROVADO' : '❌ REPROVADO'} para execução real`);
    
    return {
      aprovado: aprovado,
      lucroEstimado: lucroEstimado,
      lucroPercentualEstimado: lucroPercentualEstimado,
      detalhes: {
        estimatedStepA: estimatedStepA,
        estimatedStepC: estimatedStepC,
        estimatedFinalUSDT: estimatedFinalUSDT
      }
    };
    
  } catch (error) {
    console.error(`\n❌ Erro durante verificação de lucro: ${error.message}`);
    return {
      aprovado: false,
      erro: error.message
    };
  }
}

/**
 * Envia uma solicitação de conversão via API Convert da Binance.
 * @param {string} fromAsset - Moeda de origem
 * @param {string} toAsset - Moeda de destino
 * @param {string} [fromAmount] - Quantidade da moeda de origem a converter
 * @param {string} [toAmount] - Quantidade da moeda de destino a receber
 * @returns {Promise<object>} - Resposta da API com dados da conversão executada
 */
async function sendConvertRequest(fromAsset, toAsset, fromAmount, toAmount) {
  try {
    // 1. Solicitar cotação
    const quote = await getConvertQuote(fromAsset, toAsset, fromAmount, toAmount);
    
    // 2. Aceitar a cotação
    const acceptedQuote = await acceptConvertQuote(quote.quoteId);
    
    // 3. Aguardar a conclusão da ordem
    const completedOrder = await waitForConvertOrderCompletion(acceptedQuote.orderId);
    
    // 4. Formatar a resposta para manter compatibilidade com o formato anterior
    const result = {
      symbol: `${toAsset}${fromAsset}`,
      orderId: completedOrder.orderId,
      executedQty: completedOrder.toAmount,
      cummulativeQuoteQty: completedOrder.fromAmount,
      status: completedOrder.orderStatus,
      type: 'CONVERT',
      side: fromAmount ? 'SELL' : 'BUY',
      fills: [
        {
          price: completedOrder.ratio,
          qty: completedOrder.toAmount,
          commission: '0', // Não há comissão explícita no Convert
          commissionAsset: toAsset
        }
      ],
      // Campos adicionais específicos do Convert
      fromAsset: completedOrder.fromAsset,
      toAsset: completedOrder.toAsset,
      ratio: completedOrder.ratio,
      inverseRatio: completedOrder.inverseRatio
    };
    
    return result;
    
  } catch (error) {
    console.error(`[sendConvertRequest] ❌ Erro na conversão ${fromAsset} -> ${toAsset}:`, error.message);
    throw error;
  }
}

/**
 * Executa uma arbitragem triangular usando a API Convert.
 * @param {string} stepA - Primeira moeda (ex: BTC)
 * @param {string} stepC - Terceira moeda (ex: ETH)
 * @returns {Promise<object>} - Resultado da operação.
 */
async function executarArbitragem(stepA, stepC) {
  const route = `USDT → ${stepA} → ${stepC} → USDT`;
  console.log(`\n🔄 Iniciando processo de arbitragem triangular via API Convert para: ${route}`);
  console.log(`💰 Capital inicial: ${capitalUSDT} USDT`);

  try {
    // Verificação prévia de lucro (opcional, controlada por VERIFICAR_LUCRO_PREVIO)
    if (VERIFICAR_LUCRO_PREVIO) {
      const verificacao = await verificarLucroArbitragem(stepA, stepC, 0.3);
      
      if (!verificacao.aprovado) {
        return {
          route: route,
          error: 'Lucro simulado insuficiente',
          simulatedProfitPercentage: verificacao.lucroPercentualEstimado || 0,
          details: verificacao
        };
      }
      
      console.log(`\n✅ Verificação de lucro aprovada. Prosseguindo com execução real.`);
    }
    
    let order1, order2, order3;
    let obtainedStepA = 0;
    let obtainedStepC = 0;
    let finalUSDT = 0;

    // === ETAPA 1: USDT -> StepA ===
    console.log(`\n🔹 Etapa 1: Convertendo USDT para ${stepA}`);
    
    // Para a primeira etapa, vamos usar fromAmount para gastar `capitalUSDT`
    const capitalParaEtapa1 = capitalUSDT.toString();
    console.log(`   Convertendo ${capitalParaEtapa1} USDT para ${stepA}`);
    
    order1 = await sendConvertRequest('USDT', stepA, capitalParaEtapa1);
    
    obtainedStepA = parseFloat(order1.executedQty);
    const costStepA = parseFloat(order1.cummulativeQuoteQty);
    console.log(`   ✅ Conversão 1 concluída: Obteve ${obtainedStepA.toFixed(8)} ${stepA} gastando ${costStepA.toFixed(2)} USDT`);
    
    if (obtainedStepA <= 0) throw new Error("Quantidade de StepA obtida na Etapa 1 foi zero ou inválida.");

    // === ETAPA 2: StepA -> StepC ===
    console.log(`\n🔹 Etapa 2: Convertendo ${stepA} para ${stepC}`);
    
    // Aplicar buffer: usar uma porcentagem do obtainedStepA para a conversão
    const bufferFactor = 0.999; // Usa 99.9% do StepA para a conversão (para cobrir slippage implícito)
    const amountOfStepAToSpend = (obtainedStepA * bufferFactor).toFixed(8);
    
    console.log(`   Saldo ${stepA} disponível: ${obtainedStepA.toFixed(8)}`);
    console.log(`   Convertendo ${amountOfStepAToSpend} ${stepA} (com buffer) para ${stepC}`);
    
    order2 = await sendConvertRequest(stepA, stepC, amountOfStepAToSpend);
    
    obtainedStepC = parseFloat(order2.executedQty);
    console.log(`   ✅ Conversão 2 concluída: Obteve ${obtainedStepC.toFixed(8)} ${stepC} (gastou ${order2.cummulativeQuoteQty} ${stepA})`);
    
    if (obtainedStepC <= 0) throw new Error("Quantidade de StepC obtida na Etapa 2 foi zero ou inválida.");

    // === ETAPA 3: StepC -> USDT ===
    console.log(`\n🔹 Etapa 3: Convertendo ${stepC} para USDT`);
    
    // Aplicar buffer: usar uma porcentagem do obtainedStepC para a conversão
    const bufferFactor3 = 0.999;
    const amountOfStepCToSpend = (obtainedStepC * bufferFactor3).toFixed(8);
    
    console.log(`   Saldo ${stepC} disponível: ${obtainedStepC.toFixed(8)}`);
    console.log(`   Convertendo ${amountOfStepCToSpend} ${stepC} (com buffer) para USDT`);
    
    order3 = await sendConvertRequest(stepC, 'USDT', amountOfStepCToSpend);
    
    finalUSDT = parseFloat(order3.executedQty);
    console.log(`   ✅ Conversão 3 concluída: Recebeu ${finalUSDT.toFixed(2)} USDT (vendeu ${order3.cummulativeQuoteQty} ${stepC})`);

    // === CÁLCULO DE RESULTADOS ===
    const lucroUSDT = finalUSDT - capitalUSDT;
    const lucroPercentual = (lucroUSDT / capitalUSDT) * 100;
    
    console.log(`\n=== RESULTADO FINAL ===`);
    console.log(`💰 Capital inicial: ${capitalUSDT.toFixed(2)} USDT`);
    console.log(`💰 Capital final: ${finalUSDT.toFixed(2)} USDT`);
    console.log(`${lucroUSDT >= 0 ? '✅' : '❌'} Lucro/Prejuízo: ${lucroUSDT.toFixed(2)} USDT (${lucroPercentual.toFixed(2)}%)`);
    
    // Retorna o resultado no formato esperado pelo BotCore
    return {
      route: route,
      initialCapital: capitalUSDT,
      finalCapital: finalUSDT,
      realProfit: lucroUSDT,
      realProfitPercentage: lucroPercentual,
      simulatedProfitPercentage: VERIFICAR_LUCRO_PREVIO ? null : lucroPercentual, // Não há simulação separada no Convert se não verificou antes
      orders: {
        order1: order1,
        order2: order2,
        order3: order3
      }
    };
    
  } catch (error) {
    console.error(`\n❌ Erro durante a arbitragem via Convert: ${error.message}`);
    
    // Retorna o erro no formato esperado pelo BotCore
    return {
      route: route,
      error: error.message,
      details: error.stack
    };
  }
}

module.exports = {
  executarArbitragem,
  sendConvertRequest,
  getConvertQuote,
  acceptConvertQuote,
  getConvertOrderStatus,
  verificarLucroArbitragem,
  // Exporta a constante para permitir controle externo
  VERIFICAR_LUCRO_PREVIO
};
