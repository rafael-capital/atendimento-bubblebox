// ==========================================
// AVISO DE FECHAMENTO DAS UNIDADES (sem IA)
// ==========================================
// Das 23h em diante, olha as vendas da VMLav e avisa o Rafael no WhatsApp (pelo número da
// Bubble Box) quando cada unidade pode fechar. Regras do Rafael (10/10/2026):
// - vale a hora do último pagamento no totem, não o status da máquina (secadora aberta antes
//   do fim e fechada de novo fica "ocupada" até alguém abrir);
// - lavagem: pode fechar 45 min depois da compra; secagem: 50 min depois da compra;
// - aviso por unidade, não por máquina; lavagem pendente mostra quando o ciclo termina;
//   cliente que compra secagem depois da lavagem gera uma atualização da previsão;
// - segue monitorando até as 3 unidades serem liberadas.
// A Lavadora 1 do Centro está desconectada: não gera venda, então não entra na conta.

const VMLAV_API = 'https://apps.vmhub.vmtecnologia.io/vmlav/api/externa/v1';
const UNIDADES = { 448: 'Centro', 1761: 'Jardim Simus', 2739: 'Vila Olímpia' };
const LIBERA_MIN = { LAVAGEM: 45, SECAGEM: 50 }; // minutos depois da compra
const CICLO_MIN = { LAVAGEM: 34, SECAGEM: 45 };  // duração máxima do ciclo (só pra estimativa)
const HORA_INICIO = 23;
const BUSCAR_DESDE_MIN = 120; // vendas das últimas 2h antes das 23h ainda podem estar rodando
const INTERVALO_MS = 2 * 60 * 1000;

const utc = (s) => new Date(String(s).endsWith('Z') ? s : `${s}Z`);
const br = (d) => new Date(d.getTime() - 3 * 3600e3); // Brasília (sem horário de verão)
const hhmm = (d) => br(d).toISOString().slice(11, 16);
const isoZ = (d) => d.toISOString().slice(0, 19) + 'Z';

// Início da "noite" atual (23h de Brasília); null fora da janela 23h–06h
function inicioDaNoite(agora) {
  const b = br(agora);
  const h = b.getUTCHours();
  if (h >= 6 && h < HORA_INICIO) return null;
  const dia = new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate() - (h < 6 ? 1 : 0), HORA_INICIO + 3));
  return dia; // 23h BRT = 02h UTC do dia seguinte (Date.UTC ajusta a virada)
}

function tipoDaVenda(v) {
  const itens = (v.pedido && v.pedido.itens) || [];
  return itens.some((i) => i.tipoServico === 'SECAGEM') ? 'SECAGEM' : 'LAVAGEM';
}

// Situação de cada unidade a partir das vendas: último serviço e quando pode fechar
function situacao(vendas, agora) {
  const out = {};
  for (const [id, nome] of Object.entries(UNIDADES)) {
    const daUnidade = vendas.filter((v) => String(v.idLavanderia) === id)
      .map((v) => {
        const compra = utc(v.data);
        const tipo = tipoDaVenda(v);
        return { idVenda: v.idVenda, tipo, compra, fimCiclo: new Date(compra.getTime() + CICLO_MIN[tipo] * 60e3),
          libera: new Date(compra.getTime() + LIBERA_MIN[tipo] * 60e3) };
      })
      .sort((a, b) => a.libera - b.libera);
    const ultima = daUnidade[daUnidade.length - 1] || null;
    out[id] = { nome, ultima, ultimoIdVenda: Math.max(0, ...daUnidade.map((x) => x.idVenda || 0)),
      liberada: !ultima || ultima.libera <= agora };
  }
  return out;
}

function linhaPendente(s) {
  const u = s.ultima;
  const servico = u.tipo === 'LAVAGEM' ? 'lavagem' : 'secagem';
  const termina = u.tipo === 'LAVAGEM' ? `ciclo termina por volta de ${hhmm(u.fimCiclo)}` : `seca até ${hhmm(u.fimCiclo)} no máximo`;
  return `⏳ *${s.nome}* — ${servico} paga às ${hhmm(u.compra)} (${termina}). Previsão pra fechar: *${hhmm(u.libera)}*`;
}

// Mensagem completa: o que pode fechar e o que ainda está em uso
function resumo(sit) {
  const liberadas = Object.values(sit).filter((s) => s.liberada).map((s) => s.nome);
  const pendentes = Object.values(sit).filter((s) => !s.liberada);
  const linhas = ['🌙 *Fechamento das unidades*'];
  if (liberadas.length) linhas.push(`✅ Pode fechar: *${liberadas.join(', ')}*`);
  pendentes.forEach((s) => linhas.push(linhaPendente(s)));
  if (pendentes.length) linhas.push('Eu sigo monitorando e te aviso quando liberar.');
  return linhas;
}

function criarMonitor({ vmlavKey, enviar, log = console }) {
  let noite = null;     // ISO da noite em andamento
  let estado = {};      // idUnidade -> { liberada, libera, ultimoIdVenda }
  let terminou = false;
  let falhas = 0;

  async function buscarVendas(desde, ate) {
    const q = `pagina=0&quantidade=1000&somenteSucesso=true&dataInicio=${encodeURIComponent(isoZ(desde))}&dataTermino=${encodeURIComponent(isoZ(ate))}`;
    const r = await fetch(`${VMLAV_API}/vendas?${q}`, { headers: { 'x-api-key': vmlavKey } });
    if (!r.ok) throw new Error(`VMLav respondeu ${r.status}`);
    const data = await r.json();
    return (Array.isArray(data) ? data : data.value || []).filter((v) => UNIDADES[v.idLavanderia]);
  }

  // Uma rodada: decide o que avisar. Exportada sem efeitos colaterais além de enviar()
  async function rodada(agora = new Date(), vendasForcadas = null) {
    const inicio = inicioDaNoite(agora);
    if (!inicio) { noite = null; return null; }
    if (noite !== inicio.toISOString()) { noite = inicio.toISOString(); estado = {}; terminou = false; falhas = 0; }
    if (terminou) return null;

    let vendas;
    try {
      vendas = vendasForcadas || await buscarVendas(new Date(inicio.getTime() - BUSCAR_DESDE_MIN * 60e3), agora);
      falhas = 0;
    } catch (err) {
      falhas++;
      log.error(`⚠️  Fechamento: ${err.message} (falha ${falhas})`);
      if (falhas === 3) await enviar('⚠️ *Fechamento das unidades*\nNão estou conseguindo consultar a VMLav há alguns minutos. Confira as unidades pelas câmeras — eu continuo tentando.');
      return null;
    }

    const sit = situacao(vendas, agora);
    const primeira = Object.keys(estado).length === 0;
    const linhas = [];

    if (primeira) {
      linhas.push(...resumo(sit));
    } else {
      for (const [id, s] of Object.entries(sit)) {
        const antes = estado[id];
        const novaVenda = s.ultimoIdVenda > antes.ultimoIdVenda;
        if (s.liberada && !antes.liberada) {
          linhas.push(`✅ Pode fechar: *${s.nome}*`);
        } else if (!s.liberada && antes.liberada && novaVenda) {
          linhas.push(`⚠️ *${s.nome}*: nova venda depois do aviso! Se ainda não fechou, aguarde.`);
          linhas.push(linhaPendente(s));
        } else if (!s.liberada && novaVenda && s.ultima.libera.getTime() !== antes.libera) {
          const u = s.ultima;
          const oQue = u.tipo === 'SECAGEM' ? 'cliente comprou secagem' : 'nova lavagem paga';
          linhas.push(`🔄 *${s.nome}*: ${oQue} às ${hhmm(u.compra)}. Nova previsão pra fechar: *${hhmm(u.libera)}*`);
        }
      }
      if (linhas.length) {
        const faltam = Object.values(sit).filter((s) => !s.liberada).map((s) => s.nome);
        linhas.unshift('🌙 *Fechamento das unidades*');
        linhas.push(faltam.length ? `Ainda monitorando: ${faltam.join(', ')}` : '🎉 Todas as unidades liberadas. Boa noite!');
      }
    }

    for (const [id, s] of Object.entries(sit)) {
      estado[id] = { liberada: s.liberada, libera: s.ultima ? s.ultima.libera.getTime() : 0, ultimoIdVenda: s.ultimoIdVenda };
    }
    if (Object.values(sit).every((s) => s.liberada)) {
      terminou = true;
      if (primeira) linhas.push('🎉 Todas as unidades liberadas. Boa noite!');
    }

    if (!linhas.length) return null;
    const texto = linhas.join('\n');
    await enviar(texto);
    return texto;
  }

  // Teste a qualquer hora: manda a situação de agora (sem mexer no monitoramento da noite)
  async function previa(agora = new Date()) {
    const sit = situacao(await buscarVendas(new Date(agora.getTime() - BUSCAR_DESDE_MIN * 60e3), agora), agora);
    const texto = ['🧪 *TESTE — não é o aviso real*', ...resumo(sit)].join('\n');
    await enviar(texto);
    return texto;
  }

  function iniciar() {
    const tick = () => rodada().catch((err) => log.error('⚠️  Fechamento:', err.message));
    setInterval(tick, INTERVALO_MS);
    tick();
  }

  return { rodada, previa, iniciar };
}

module.exports = { criarMonitor, situacao, inicioDaNoite };
