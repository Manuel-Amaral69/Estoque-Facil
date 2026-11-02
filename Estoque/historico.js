const userGP = sessionStorage.getItem('userGP');
const salesList = document.getElementById('sales-list');
const historyStatus = document.getElementById('history-status');
let vendas = [];

if (!userGP) {
  alert('Sessão inválida. Faça login novamente.');
  window.location.href = '../Login/login.html';
} else {
  carregarHistorico();
}

document.getElementById('search-sales').addEventListener('input', renderizarHistorico);
document.getElementById('filter-date').addEventListener('change', renderizarHistorico);

async function carregarHistorico() {
  try {
    const resposta = await fetch(`/vendas/${encodeURIComponent(userGP)}`);
    if (!resposta.ok) throw new Error('Não foi possível carregar o histórico.');

    const registros = await resposta.json();
    const vendasPorId = new Map();

    registros.forEach(registro => {
      if (!vendasPorId.has(registro.id)) {
        vendasPorId.set(registro.id, { ...registro, itens: [] });
      }
      if (registro.produto_id !== null) {
        vendasPorId.get(registro.id).itens.push(registro);
      }
    });

    vendas = Array.from(vendasPorId.values());
    document.getElementById('sales-count').textContent = vendas.length;
    document.getElementById('sales-total').textContent = formatarMoeda(
      vendas.reduce((total, venda) => total + Number(venda.total), 0)
    );
    renderizarHistorico();
  } catch (error) {
    historyStatus.textContent = error.message;
  }
}

function renderizarHistorico() {
  const busca = document.getElementById('search-sales').value.trim().toLocaleLowerCase('pt-BR');
  const dataSelecionada = document.getElementById('filter-date').value;
  const filtradas = vendas.filter(venda => {
    const diaVenda = venda.created_at.slice(0, 10);
    const combinaData = !dataSelecionada || diaVenda === dataSelecionada;
    const combinaProduto = !busca || venda.itens.some(item =>
      item.nome_produto.toLocaleLowerCase('pt-BR').includes(busca)
    );
    return combinaData && combinaProduto;
  });

  salesList.replaceChildren();
  if (filtradas.length === 0) {
    historyStatus.textContent = vendas.length ? 'Nenhuma venda corresponde aos filtros.' : 'Nenhuma venda registrada ainda.';
    return;
  }

  historyStatus.textContent = `${filtradas.length} ${filtradas.length === 1 ? 'venda encontrada' : 'vendas encontradas'}`;
  filtradas.forEach(venda => salesList.appendChild(criarVenda(venda)));
}

function criarVenda(venda) {
  const artigo = document.createElement('article');
  artigo.className = 'sale-entry';

  const cabecalho = document.createElement('div');
  cabecalho.className = 'sale-header';
  const titulo = document.createElement('h3');
  titulo.textContent = `Venda #${venda.id}`;
  const data = document.createElement('time');
  data.dateTime = venda.created_at.replace(' ', 'T') + 'Z';
  data.textContent = new Date(`${venda.created_at.replace(' ', 'T')}Z`).toLocaleString('pt-BR');
  const total = document.createElement('strong');
  total.className = 'sale-amount';
  total.textContent = formatarMoeda(venda.total);
  cabecalho.append(titulo, data, total);
  artigo.appendChild(cabecalho);

  const listaItens = document.createElement('ul');
  listaItens.className = 'sale-items';
  venda.itens.forEach(item => {
    const linha = document.createElement('li');
    const produto = document.createElement('span');
    produto.textContent = item.nome_produto;
    const detalhe = document.createElement('span');
    detalhe.textContent = `${item.quantidade} × ${formatarMoeda(item.valor_unitario)}`;
    const subtotal = document.createElement('strong');
    subtotal.textContent = formatarMoeda(item.subtotal);
    linha.append(produto, detalhe, subtotal);
    listaItens.appendChild(linha);
  });
  artigo.appendChild(listaItens);
  return artigo;
}

function formatarMoeda(valor) {
  return Number(valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}