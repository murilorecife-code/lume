// Servidor de rastreio de entrega em tempo real.
// Os dados ficam salvos num banco Postgres de verdade (ex: Supabase) — veja db.js.
// Pedidos ficam guardados por até 40 dias; motoboys ficam salvos pra sempre.
// Endpoints:
//   POST /api/motoboys                    -> cadastra um motoboy parceiro (exige senha de admin)
//   GET  /api/motoboys                    -> lista motoboys parceiros
//   POST /api/pedidos                     -> cadastra um pedido (fica "pendente", na fila)
//   GET  /api/pedidos?status=em_rota|entregue -> lista pedidos (painel da loja). em_rota traz pendente + em_rota juntos
//   POST /api/pedidos/:code/iniciar       -> motoboy aperta o "play": envia o link e começa o GPS
//   POST /api/pedidos/:code/localizacao   -> motoboy envia sua posição GPS
//   GET  /api/pedidos/:code               -> cliente consulta status/posição/ETA
//   POST /api/pedidos/:code/entregar      -> marca pedido como entregue
//   POST /api/relatorio                   -> totais de faturamento (exige senha de admin ou de um motoboy)

const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const { pool, initSchema, limparPedidosAntigos, RETENCAO_PEDIDOS_DIAS } = require('./db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// log de diagnóstico: não mostra a senha, só confirma se as variáveis de
// ambiente essenciais foram configuradas (ajuda a identificar problema de
// deploy sem expor segredo nenhum nos logs).
console.log(
  'Iniciando servidor... DATABASE_URL configurada:', !!process.env.DATABASE_URL,
  '| ADMIN_PASSWORD configurada:', !!process.env.ADMIN_PASSWORD,
  '| PORT:', PORT
);

// senha única do administrador/dono da loja — configure isso como variável de
// ambiente no Render (Environment -> Add Environment Variable -> ADMIN_PASSWORD).
// Não deixe o valor padrão abaixo em produção.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'troque-esta-senha';

// formas de pagamento em que o motoboy recebe o dinheiro/cartão na hora da entrega:
// pra essas, exigimos confirmação de "recebi o valor" antes de fechar o pedido.
const FORMAS_COBRADAS_NA_ENTREGA = ['Cartão na entrega', 'Dinheiro na entrega'];

function gerarIdMotoboy() {
  return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// envolve uma rota assíncrona pra nunca deixar um erro de banco derrubar o
// servidor sem resposta — sempre volta um JSON de erro pro cliente.
function assincrona(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      console.error('Erro na rota', req.method, req.path, ':', e.message);
      res.status(500).json({ erro: 'Erro interno no servidor. Tente de novo em instantes.' });
    }
  };
}

// util: fetch com timeout, pra nunca deixar uma chamada externa travar nossa resposta
async function fetchComTimeout(url, options = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---- geocodificação do endereço (Nominatim/OpenStreetMap, gratuito) ----
async function geocodeAddress(enderecoTexto) {
  try {
    const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(enderecoTexto);
    const resp = await fetchComTimeout(url, {
      headers: { 'User-Agent': 'rastreio-gps-entrega-prototipo/1.0 (teste interno)' }
    }, 6000);
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data || !data[0]) return null;
    return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
  } catch (e) {
    console.error('Falha ao geocodificar endereço:', e.message);
    return null;
  }
}

// ---- distância/duração real via OSRM (roteamento gratuito, sem chave) ----
// Cacheado por pedido por alguns segundos: a tela da cliente consulta a cada poucos
// segundos, e chamar o serviço externo a cada consulta é lento e pode ser bloqueado
// por limite de uso. Esse cache é só de cálculo (não é dado de negócio), então
// continua em memória mesmo com o banco — não tem problema sumir num restart.
async function calcularRota(origem, destino) {
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${origem.lng},${origem.lat};${destino.lng},${destino.lat}?overview=false`;
    const resp = await fetchComTimeout(url, {}, 6000);
    if (!resp.ok) return null;
    const data = await resp.json();
    const rota = data && data.routes && data.routes[0];
    if (!rota) return null;
    return { distanciaMetros: rota.distance, duracaoSegundos: rota.duration };
  } catch (e) {
    console.error('Falha ao calcular rota:', e.message);
    return null;
  }
}

const rotaCache = {}; // code -> { rota, calculadoEm, ultimaPosUsada }
const ROTA_CACHE_MS = 12000; // recalcula no máximo a cada 12s por pedido

async function calcularRotaComCache(code, origem, destino) {
  const cache = rotaCache[code];
  const mesmaPos = cache && cache.ultimaPosUsada &&
    cache.ultimaPosUsada.lat === origem.lat && cache.ultimaPosUsada.lng === origem.lng;
  if (cache && (mesmaPos || Date.now() - cache.calculadoEm < ROTA_CACHE_MS)) {
    return cache.rota;
  }
  const rota = await calcularRota(origem, destino);
  rotaCache[code] = { rota, calculadoEm: Date.now(), ultimaPosUsada: origem };
  return rota;
}

// ---- conversão linha do banco <-> objeto usado nas respostas da API ----
function motoboyRowToJson(row) {
  return { id: row.id, nome: row.nome, telefone: row.telefone, placa: row.placa || '', criadoEm: +new Date(row.criado_em) };
}

function pedidoRowToJson(row) {
  return {
    code: row.code,
    nome: row.nome,
    telefone: row.telefone,
    rua: row.rua,
    numero: row.numero,
    bairro: row.bairro,
    cidade: row.cidade,
    complemento: row.complemento,
    referencia: row.referencia,
    enderecoTexto: row.endereco_texto,
    motoboyId: row.motoboy_id,
    motoboyNome: row.motoboy_nome,
    valorEntrega: row.valor_entrega != null ? Number(row.valor_entrega) : null,
    formaPagamento: row.forma_pagamento,
    clientCoords: (row.client_lat != null && row.client_lng != null) ? { lat: row.client_lat, lng: row.client_lng } : null,
    motoboyPath: row.motoboy_path || [],
    status: row.status,
    delivered: row.delivered,
    valorRecebido: row.valor_recebido,
    obs: row.obs,
    obsHorario: row.obs_horario,
    createdAt: +new Date(row.created_at),
    iniciadoEm: row.iniciado_em ? +new Date(row.iniciado_em) : null,
    deliveredAt: row.delivered_at ? +new Date(row.delivered_at) : null,
  };
}

// ---- verifica uma senha digitada: pode ser a senha de admin OU a senha
// pessoal de algum motoboy cadastrado. Usado pro cadastro de motoboy (só
// admin) e pra ver o relatório de valores (admin vê tudo, motoboy vê só o dele).
async function verificarSenha(senhaDigitada) {
  if (!senhaDigitada) return { ok: false };
  if (senhaDigitada === ADMIN_PASSWORD) return { ok: true, tipo: 'admin' };

  const { rows } = await pool.query('SELECT id, nome, senha_hash FROM motoboys WHERE senha_hash IS NOT NULL');
  for (const row of rows) {
    if (await bcrypt.compare(senhaDigitada, row.senha_hash)) {
      return { ok: true, tipo: 'motoboy', motoboyId: row.id, motoboyNome: row.nome };
    }
  }
  return { ok: false };
}

// ---- motoboy parceiro: cadastrar (exige senha de administrador) ----
app.post('/api/motoboys', assincrona(async (req, res) => {
  const { nome, telefone, placa, senha, adminPassword } = req.body || {};
  if (adminPassword !== ADMIN_PASSWORD) {
    return res.status(401).json({ erro: 'Senha de administrador incorreta.' });
  }
  if (!nome || !telefone) {
    return res.status(400).json({ erro: 'Preencha nome e WhatsApp do motoboy.' });
  }
  if (!senha || senha.length < 4) {
    return res.status(400).json({ erro: 'Defina uma senha de pelo menos 4 caracteres pro motoboy (ele vai usar pra ver os valores dele).' });
  }
  const id = gerarIdMotoboy();
  const senhaHash = await bcrypt.hash(senha, 10);
  await pool.query(
    'INSERT INTO motoboys (id, nome, telefone, placa, senha_hash) VALUES ($1,$2,$3,$4,$5)',
    [id, nome, telefone, placa || '', senhaHash]
  );
  res.json({ id, nome, telefone, placa: placa || '' });
}));

// ---- motoboy parceiro: listar (dados públicos, sem senha) ----
app.get('/api/motoboys', assincrona(async (req, res) => {
  const { rows } = await pool.query('SELECT id, nome, telefone, placa, criado_em FROM motoboys ORDER BY nome');
  res.json(rows.map(motoboyRowToJson));
}));

// ---- criar pedido ----
app.post('/api/pedidos', assincrona(async (req, res) => {
  const {
    pedido, nome, telefone, rua, numero, bairro, cidade, complemento, referencia,
    motoboyId, valorEntrega, formaPagamento, obsHorario
  } = req.body || {};
  if (!pedido || !nome || !telefone || !rua || !numero || !bairro) {
    return res.status(400).json({ erro: 'Faltam campos obrigatórios (pedido, nome, telefone, rua, número, bairro).' });
  }
  const code = String(pedido).trim();
  const enderecoTexto = [rua, numero, bairro, cidade].filter(Boolean).join(', ');

  let motoboy = null;
  if (motoboyId) {
    const { rows } = await pool.query('SELECT id, nome FROM motoboys WHERE id = $1', [motoboyId]);
    motoboy = rows[0] || null;
  }

  await pool.query(
    `INSERT INTO pedidos
      (code, nome, telefone, rua, numero, bairro, cidade, complemento, referencia, endereco_texto,
       motoboy_id, motoboy_nome, valor_entrega, forma_pagamento, obs_horario, status, delivered)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'pendente',false)`,
    [
      code, nome, telefone, rua, numero, bairro, cidade || null, complemento || null, referencia || null, enderecoTexto,
      motoboy ? motoboy.id : null, motoboy ? motoboy.nome : null,
      valorEntrega != null && valorEntrega !== '' ? Number(valorEntrega) : null, formaPagamento || null,
      obsHorario ? String(obsHorario).trim().slice(0, 200) : null
    ]
  );

  // geocodifica em segundo plano (não trava a resposta pro motoboy)
  geocodeAddress(enderecoTexto + ', Brasil').then(async coords => {
    if (!coords) return;
    try {
      await pool.query('UPDATE pedidos SET client_lat=$2, client_lng=$3 WHERE code=$1', [code, coords.lat, coords.lng]);
    } catch (e) {
      console.error('Falha ao salvar coordenadas geocodificadas:', e.message);
    }
  });

  res.json({ code, enderecoTexto });
}));

// ---- motoboy aperta o "play": começa a entrega de fato ----
app.post('/api/pedidos/:code/iniciar', assincrona(async (req, res) => {
  const { rows } = await pool.query('SELECT status FROM pedidos WHERE code = $1', [req.params.code]);
  if (!rows[0]) return res.status(404).json({ erro: 'Pedido não encontrado.' });
  if (rows[0].status === 'entregue') return res.status(400).json({ erro: 'Este pedido já foi entregue.' });
  await pool.query(`UPDATE pedidos SET status='em_rota', iniciado_em=now() WHERE code=$1`, [req.params.code]);
  res.json({ ok: true });
}));

// ---- listar pedidos (painel da loja: em rota ou histórico) ----
app.get('/api/pedidos', assincrona(async (req, res) => {
  const { status } = req.query;
  let sql = 'SELECT * FROM pedidos';
  // "em_rota" aqui junta pendente + em_rota: é tudo que ainda não foi entregue,
  // pra aparecer empilhado na mesma aba (com o play pra quem ainda não começou).
  if (status === 'em_rota') sql += ` WHERE status != 'entregue'`;
  else if (status === 'entregue') sql += ` WHERE status = 'entregue'`;
  sql += ' ORDER BY created_at ASC';

  const { rows } = await pool.query(sql);
  const lista = rows.map(pedidoRowToJson).map(p => ({
    code: p.code,
    nome: p.nome,
    telefone: p.telefone,
    enderecoTexto: p.enderecoTexto,
    motoboyNome: p.motoboyNome,
    valorEntrega: p.valorEntrega,
    formaPagamento: p.formaPagamento,
    status: p.status,
    delivered: p.delivered,
    createdAt: p.createdAt,
    iniciadoEm: p.iniciadoEm,
    deliveredAt: p.deliveredAt,
    valorRecebido: p.valorRecebido,
    obs: p.obs,
    obsHorario: p.obsHorario,
    ultimaAtualizacao: p.motoboyPath.length ? p.motoboyPath[p.motoboyPath.length - 1].ts : null
  }));

  res.json(lista);
}));

// ---- relatório de valores (faturamento) ----
// Exige senha (POST em vez de GET pra não deixar a senha exposta na URL/logs).
// Senha de admin -> vê tudo. Senha de um motoboy -> vê só as entregas dele.
// Sem parâmetros de data: totais rápidos de hoje/7 dias/mês + o detalhamento de
// hoje. Com de/ate (YYYY-MM-DD): o mesmo detalhamento, dentro desse período.
function paraDataLocal(d) {
  // formata como YYYY-MM-DD usando o horário LOCAL (toISOString força UTC e
  // pode "pular" pro dia seguinte/anterior dependendo do fuso do servidor).
  const ano = d.getFullYear();
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  return `${ano}-${mes}-${dia}`;
}

app.post('/api/relatorio', assincrona(async (req, res) => {
  const { senha, de, ate } = req.body || {};
  const auth = await verificarSenha(senha);
  if (!auth.ok) return res.status(401).json({ erro: 'Senha incorreta.' });

  let sql = `SELECT * FROM pedidos WHERE status = 'entregue' AND delivered_at IS NOT NULL`;
  const params = [];
  if (auth.tipo === 'motoboy') {
    params.push(auth.motoboyId);
    sql += ` AND motoboy_id = $${params.length}`;
  }
  const { rows } = await pool.query(sql, params);
  const entregues = rows.map(pedidoRowToJson);

  const umDia = 24 * 60 * 60 * 1000;
  const inicioHoje = new Date(); inicioHoje.setHours(0, 0, 0, 0);
  const fimHoje = new Date(); fimHoje.setHours(23, 59, 59, 999);
  const inicioSemana = inicioHoje.getTime() - 6 * umDia;
  const inicioMes = new Date(); inicioMes.setDate(1); inicioMes.setHours(0, 0, 0, 0);

  function somaDesde(desdeMs) {
    return entregues
      .filter(p => p.deliveredAt >= desdeMs)
      .reduce((soma, p) => soma + (p.valorEntrega || 0), 0);
  }

  let inicioPeriodo = inicioHoje;
  let fimPeriodo = fimHoje;
  if (de) {
    const d = new Date(de + 'T00:00:00');
    if (!isNaN(d.getTime())) inicioPeriodo = d;
  }
  if (ate) {
    const d = new Date(ate + 'T23:59:59.999');
    if (!isNaN(d.getTime())) fimPeriodo = d;
  }

  const noPeriodo = entregues.filter(p =>
    p.deliveredAt >= inicioPeriodo.getTime() && p.deliveredAt <= fimPeriodo.getTime()
  );

  const porMotoboy = {};
  const porFormaPagamento = {};
  noPeriodo.forEach(p => {
    const chaveMoto = p.motoboyNome || 'Sem motoboy';
    porMotoboy[chaveMoto] = (porMotoboy[chaveMoto] || 0) + (p.valorEntrega || 0);
    const chavePag = p.formaPagamento || 'Não informado';
    porFormaPagamento[chavePag] = (porFormaPagamento[chavePag] || 0) + (p.valorEntrega || 0);
  });

  res.json({
    tipoAcesso: auth.tipo, // 'admin' (vê tudo) ou 'motoboy' (só o dele) — útil pro front avisar
    motoboyNome: auth.motoboyNome || null,
    hoje: somaDesde(inicioHoje.getTime()),
    semana: somaDesde(inicioSemana),
    mes: somaDesde(inicioMes.getTime()),
    periodo: {
      de: paraDataLocal(inicioPeriodo),
      ate: paraDataLocal(fimPeriodo),
      total: noPeriodo.reduce((s, p) => s + (p.valorEntrega || 0), 0),
      quantidade: noPeriodo.length,
      porMotoboy,
      porFormaPagamento
    }
  });
}));

// ---- motoboy envia localização ----
app.post('/api/pedidos/:code/localizacao', assincrona(async (req, res) => {
  const { lat, lng, accuracy } = req.body || {};
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return res.status(400).json({ erro: 'lat/lng inválidos.' });
  }
  const { rows } = await pool.query('SELECT motoboy_path FROM pedidos WHERE code = $1', [req.params.code]);
  if (!rows[0]) return res.status(404).json({ erro: 'Pedido não encontrado.' });

  let caminho = rows[0].motoboy_path || [];
  caminho.push({ lat, lng, accuracy: accuracy || null, ts: Date.now() });
  if (caminho.length > 300) caminho = caminho.slice(-300); // limita histórico

  await pool.query('UPDATE pedidos SET motoboy_path = $2::jsonb WHERE code = $1', [req.params.code, JSON.stringify(caminho)]);
  res.json({ ok: true });
}));

// ---- cliente consulta status ----
app.get('/api/pedidos/:code', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM pedidos WHERE code = $1', [req.params.code]);
    if (!rows[0]) return res.status(404).json({ erro: 'Pedido não encontrado.' });
    const p = pedidoRowToJson(rows[0]);

    const ultimaPos = p.motoboyPath[p.motoboyPath.length - 1] || null;
    let rota = null;
    if (ultimaPos && p.clientCoords && !p.delivered) {
      rota = await calcularRotaComCache(p.code, ultimaPos, p.clientCoords);
    }

    res.json({
      code: p.code,
      nome: p.nome,
      enderecoTexto: p.enderecoTexto,
      complemento: p.complemento,
      referencia: p.referencia,
      delivered: p.delivered,
      clientCoords: p.clientCoords,
      ultimaPos,
      trilha: p.motoboyPath.slice(-100),
      rota // { distanciaMetros, duracaoSegundos } ou null
    });
  } catch (e) {
    // nunca deixa a consulta da cliente travar sem resposta por causa de um
    // serviço externo de mapa/rota (ou até do banco) lento ou fora do ar
    console.error('Erro ao montar status do pedido:', e.message);
    res.status(200).json({
      code: req.params.code,
      erroParcial: 'Não foi possível calcular a rota agora, tentando novamente.',
      delivered: false,
      clientCoords: null,
      ultimaPos: null,
      trilha: [],
      rota: null
    });
  }
});

// ---- marcar como entregue ----
// Se a forma de pagamento é cobrada na hora (cartão/dinheiro), exige que o
// motoboy tenha confirmado "recebi o valor" (valorRecebido:true) antes de
// aceitar a finalização — evita esquecer de cobrar. obs é uma observação
// livre e opcional (ex: "deixado na portaria com o zelador").
app.post('/api/pedidos/:code/entregar', assincrona(async (req, res) => {
  const { rows } = await pool.query('SELECT forma_pagamento FROM pedidos WHERE code = $1', [req.params.code]);
  if (!rows[0]) return res.status(404).json({ erro: 'Pedido não encontrado.' });

  const { valorRecebido, obs } = req.body || {};
  const exigeConfirmacao = FORMAS_COBRADAS_NA_ENTREGA.includes(rows[0].forma_pagamento);
  if (exigeConfirmacao && valorRecebido !== true) {
    return res.status(400).json({ erro: 'Confirme que recebeu o valor total do pedido antes de finalizar.' });
  }

  await pool.query(
    `UPDATE pedidos SET status='entregue', delivered=true, delivered_at=now(), valor_recebido=$2, obs=$3 WHERE code=$1`,
    [req.params.code, exigeConfirmacao ? true : null, obs ? String(obs).trim().slice(0, 300) : null]
  );
  res.json({ ok: true });
}));

async function iniciar() {
  await initSchema();

  // limpa pedidos com mais de 40 dias assim que o servidor sobe, e depois
  // repete a cada 6 horas (não precisa ser mais frequente que isso).
  limparPedidosAntigos().then(n => {
    if (n) console.log(`🧹 ${n} pedido(s) com mais de ${RETENCAO_PEDIDOS_DIAS} dias removido(s).`);
  }).catch(e => console.error('Falha na limpeza inicial de pedidos antigos:', e.message));
  setInterval(() => {
    limparPedidosAntigos().catch(e => console.error('Falha na limpeza periódica de pedidos antigos:', e.message));
  }, 6 * 60 * 60 * 1000);

  app.listen(PORT, () => {
    console.log('Servidor de rastreio rodando na porta ' + PORT);
  });
}

iniciar().catch(e => {
  // escreve direto no stderr (síncrono) e só derruba o processo depois de um
  // pequeno atraso — sem isso, o log podia se perder porque process.exit()
  // encerra o processo antes do console.error terminar de ser escrito.
  try {
    process.stderr.write('Falha ao iniciar o servidor (verifique DATABASE_URL): ' + (e && e.stack ? e.stack : e) + '\n');
  } catch (_) {}
  setTimeout(() => process.exit(1), 500);
});

process.on('unhandledRejection', (e) => {
  try {
    process.stderr.write('Erro não tratado (unhandledRejection): ' + (e && e.stack ? e.stack : e) + '\n');
  } catch (_) {}
});
