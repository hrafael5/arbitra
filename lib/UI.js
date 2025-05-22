var CLI = require('clui'),
  clc = require('cli-color');

var Line        = CLI.Line,
  LineBuffer  = CLI.LineBuffer;

var UI = {};
// constructor
UI.init = (options)=>{
  UI.options = options;

  UI.outputBuffer  = new LineBuffer({
    x: 0,
    y: 0,
    width: 'console',
    height: 'console'
  });

  // Store the title line object
  UI.titleLine = new Line(UI.outputBuffer)
    .column(UI.options.UI.title, UI.options.UI.title.length + 25, [clc.green]) // Increase width to accommodate timestamp
    .fill()
    .store();

  // Remove old UI.message definition (if any existed previously)
  // UI.message = new Line(UI.outputBuffer) ...

  UI.blankLine = new Line(UI.outputBuffer)
    .fill()
    .store();

  // Define column widths (ajuste se necessário)
  UI.cols = [10, 10, 10, 10]; // Ajustado para StepA, StepB, StepC, Rate

  // Define os cabeçalhos das colunas
  UI.header = new Line(UI.outputBuffer)
    .column('Step A', UI.cols[0], [clc.cyan])
    .column('Step B', UI.cols[1], [clc.cyan])
    .column('Step C', UI.cols[2], [clc.cyan])
    .column('Rate', UI.cols[3], [clc.cyan]) // Lucro Bruto %
    .column('Fee BNB', 10, [clc.cyan])      // Taxa estimada com BNB %
    .column('Net (BNB)', 12, [clc.green])    // Lucro líquido com taxa BNB %
    .column('Fee Norm', 10, [clc.cyan])     // Taxa estimada Normal %
    .column('Net (Norm)', 12, [clc.green])   // Lucro líquido com taxa Normal %
    .fill()
    .store();

  UI.line;
  // Usar maxRows da configuração se disponível, senão um padrão
  UI.maxRows = parseInt(process.env.maxRows) || 20; // Ex: Padrão 20 se não definido
  UI.outputBuffer.output(); // Desenha a UI inicial (título, linha em branco, cabeçalho)

  return UI;
};

UI.updateArbitageOpportunities = (tickers)=>{
  if (!UI.outputBuffer || !tickers){
    return;
  }

  // --- Atualiza o Título com Timestamp ---
  // Remove a linha do título antigo (geralmente a primeira linha, índice 0)
  if (UI.outputBuffer.lines.length > 0) {
      // Assumindo que título, linha em branco e cabeçalho são as 3 primeiras linhas fixas
      // Encontra a linha do título para remover (pode não ser sempre a 0 se houver logs acima)
      // Vamos apenas remover e readicionar as fixas para simplificar
      UI.outputBuffer.lines.splice(0, UI.outputBuffer.lines.length); // Limpa tudo temporariamente
  }

  // Recria Título, Linha Branca e Cabeçalho
  const now = new Date();
  const timestamp = `${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}:${now.getSeconds().toString().padStart(2, "0")}`;
  const newTitleLine = new Line(UI.outputBuffer)
    .column(`${UI.options.UI.title} (Atualizado: ${timestamp})`, UI.options.UI.title.length + 25, [clc.green])
    .fill()
    .store();
  // Adiciona novamente as linhas fixas na ordem correta
  UI.outputBuffer.lines.push(newTitleLine);
  UI.outputBuffer.lines.push(UI.blankLine); // Adiciona a linha em branco
  UI.outputBuffer.lines.push(UI.header);   // Adiciona o cabeçalho

  // --- Adiciona as Linhas de Oportunidade ---

  // Define as taxas estimadas TOTAIS para 3 pernas
  const totalFeeBNBPercent = 0.225; // 0.075% * 3
  const totalFeeNormalPercent = 0.300; // 0.1% * 3

  const maxDisplayRows = Math.min(tickers.length, UI.maxRows); // Limita ao número de tickers ou maxRows

  for (let i=0; i < maxDisplayRows; i++){
    var ticker = tickers[i];
    // Verifica se o ticker é válido e tem os dados necessários
    if (!ticker || !ticker.a || !ticker.b || !ticker.c) continue; // Pula se inválido

    var color = clc.green; // Cor padrão para lucro positivo
    if (ticker.rate && ticker.rate < 1) color = clc.red; // Vermelho para lucro negativo

    // Calcula a taxa de lucro bruta em %
    var ratePercent = ((ticker.rate - 1)* 100);

    // ---> CÁLCULO CORRIGIDO DAS TAXAS <---
    // As taxas são fixas (estimadas), não dependem mais do 'ratePercent'
    var feesBNB = totalFeeBNBPercent;
    var feesNormal = totalFeeNormalPercent;

    // Calcula o lucro líquido subtraindo as taxas fixas
    var netRateBNB = ratePercent - feesBNB;
    var netRateNormal = ratePercent - feesNormal;
    // ---> FIM DO CÁLCULO CORRIGIDO <---

    // Define a cor baseada no lucro líquido Normal (mais conservador)
    // Se mesmo o lucro bruto for negativo, mantém vermelho
    if (ratePercent >= 0) {
         color = netRateNormal > 0 ? clc.green : clc.red;
    }


    // Monta a linha da tabela com os valores corrigidos
    UI.line = new Line(UI.outputBuffer)
      .column(ticker.a_step_from.toString(), UI.cols[0], [clc.cyan]) // Step A
      .column(ticker.b.stepFrom.toString(), UI.cols[1], [clc.cyan]) // Step B
      .column(ticker.c.stepFrom.toString(), UI.cols[2], [clc.cyan]) // Step C

      .column(ratePercent.toFixed(3) + '%', UI.cols[3], [clc.cyan])       // Rate (Bruto)
      .column(feesBNB.toFixed(3) + '%', 10, [clc.cyan])                // Fee BNB (Fixo)
      .column(netRateBNB.toFixed(3) + '%', 12, [netRateBNB > 0 ? clc.green : clc.red]) // Net (BNB)

      .column(feesNormal.toFixed(3) + '%', 10, [clc.cyan])             // Fee Norm (Fixo)
      .column(netRateNormal.toFixed(3) + '%', 12, [color])            // Net (Norm) - Usa a cor definida

      .fill()
      .store();
      UI.outputBuffer.lines.push(UI.line); // Adiciona a linha ao buffer
  }

  // Adiciona linhas em branco se houver menos oportunidades que maxRows
  // for (let i = tickers.length; i < UI.maxRows; i++) {
  //    const blank = new Line(UI.outputBuffer).fill().store();
  //    UI.outputBuffer.lines.push(blank);
  // }


  UI.outputBuffer.output(); // Desenha a UI atualizada no console
};

// --- Funções updateTickers, updateUI, addTrade permanecem as mesmas ---
// (O código delas não foi colado aqui para brevidade, mas não precisa ser alterado)

UI.updateTickers = (tickers)=>{
    // Esta função parece não ser usada ativamente para a tabela de arbitragem
    // Mantida caso seja usada para outra visualização
  if (!UI.outputBuffer || !tickers){
    return;
  }


  var keys = Object.keys(tickers).sort();
  // Limpa apenas as linhas de tickers antigos, se houver (assumindo que começam após o cabeçalho)
   if (UI.outputBuffer.lines.length > 3) {
       UI.outputBuffer.lines.splice(3, UI.outputBuffer.lines.length - 3);
   }

  //UI.maxRows = keys.length + 2; // Não deve sobrescrever maxRows aqui

  const maxTickerRows = Math.min(keys.length, UI.maxRows);

  for (let i=0; i < maxTickerRows; i++){
    var ticker = tickers[keys[i]];
    if (!ticker) continue; // Pula se inválido


    //* Exemplo de colunas para updateTickers (ajuste conforme necessário)
    UI.line = new Line(UI.outputBuffer)
      .column(ticker.E ? ticker.E.toString() : 'N/A', UI.cols[0]) // Event Time
      .column(ticker.s ? ticker.s.toString() : 'N/A', UI.cols[1]) // Symbol
      // bid
      .column(ticker.b ? ticker.b.toString() : 'N/A', UI.cols[2]) // Bid Price
      .column(ticker.B ? ticker.B.toString() : 'N/A', 15) // Bid Quantity (Ajustar largura)

      // ask
      .column(ticker.a ? ticker.a.toString() : 'N/A', UI.cols[2]) // Ask Price
      .column(ticker.A ? ticker.A.toString() : 'N/A', 15) // Ask Quantity (Ajustar largura)

      .column(ticker.n ? ticker.n.toString() : 'N/A', UI.cols[1]) // Number of Trades
      .fill()
      .store();//*/
      UI.outputBuffer.lines.push(UI.line); // Adiciona a linha ao buffer
  }
  UI.outputBuffer.output();
};


/* Exemplo de dados de trade (para addTrade)
    { eventType: 'aggTrade',
      eventTime: 1514559250559,
      symbol: 'XRPETH',
      tradeId: 916488,
      price: '0.00224999',
      quantity: '100.00000000',
      firstTradeId: 1090457,
      lastTradeId: 1090457,
      time: 1514559250554,
      maker: false,
      ignored: true }
*/
UI.updateUI = function(trimOld){
    // Função genérica para redesenhar, pode ser usada por addTrade
  if (trimOld && UI.outputBuffer.lines.length > (UI.maxRows + 3)) { // Considera as 3 linhas de cabeçalho
        // Remove a linha mais antiga de dados (após o cabeçalho)
        UI.outputBuffer.lines.splice(3, 1);
    }
  UI.outputBuffer.output();
};

UI.addTrade = function(time, symbol, tradeId, price, quantity){
    // Exemplo simples de como adicionar uma linha de trade
  const tradeLine = new Line(UI.outputBuffer)
    .column(time.toString(), UI.cols[0])
    .column(symbol.toString(), UI.cols[1])
    .column(price.toString(), UI.cols[2])
    .column(quantity.toString(), 15) // Ajustar largura
    .column(tradeId.toString(), 15)   // Adicionar ID do trade, por exemplo
    .fill()
    .store();

    // Insere a nova linha de trade logo após o cabeçalho
    UI.outputBuffer.lines.splice(3, 0, tradeLine);

  UI.updateUI(true); // Redesenha, removendo linhas antigas se necessário
};



module.exports = UI.init;