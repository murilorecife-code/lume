// db.js — conexão com o banco de dados (Postgres / Supabase) e criação das tabelas.
//
// Guardamos:
//   - pedidos: por RETENCAO_PEDIDOS_DIAS dias (uma limpeza automática apaga os mais antigos)
//   - motoboys: para sempre (só somem se alguém apagar manualmente no banco)
//
// Configure a variável de ambiente DATABASE_URL no Render com a connection
// string do seu projeto Supabase (Project Settings -> Database -> Connection string).
// Sem essa variável, o servidor sobe mas nenhuma operação de dados funciona.

const { Pool } = require('pg');

const RETENCAO_PEDIDOS_DIAS = 40;

const connectionString = process.env.DATABASE_URL || '';

if (!connectionString) {
  console.warn(
    '⚠️  DATABASE_URL não configurada. Configure essa variável de ambiente com a ' +
    'connection string do Supabase (veja o README) — sem ela o servidor não consegue salvar nada.'
  );
}

const pool = new Pool({
  connectionString: connectionString || undefined,
  // Supabase (e a maioria dos provedores gerenciados) exige SSL, mas usa um
  // certificado que o driver não valida por padrão nesse tipo de conexão simples.
  ssl: connectionString ? { rejectUnauthorized: false } : undefined,
});

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS motoboys (
      id TEXT PRIMARY KEY,
      nome TEXT NOT NULL,
      telefone TEXT NOT NULL,
      placa TEXT,
      senha_hash TEXT,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pedidos (
      code TEXT PRIMARY KEY,
      nome TEXT NOT NULL,
      telefone TEXT NOT NULL,
      rua TEXT,
      numero TEXT,
      bairro TEXT,
      cidade TEXT,
      complemento TEXT,
      referencia TEXT,
      endereco_texto TEXT,
      motoboy_id TEXT,
      motoboy_nome TEXT,
      valor_entrega NUMERIC,
      forma_pagamento TEXT,
      client_lat DOUBLE PRECISION,
      client_lng DOUBLE PRECISION,
      motoboy_path JSONB NOT NULL DEFAULT '[]'::jsonb,
      status TEXT NOT NULL DEFAULT 'pendente',
      delivered BOOLEAN NOT NULL DEFAULT false,
      valor_recebido BOOLEAN,
      obs TEXT,
      obs_horario TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      iniciado_em TIMESTAMPTZ,
      delivered_at TIMESTAMPTZ
    )
  `);

  // migração pra bancos que já existiam antes desse campo (CREATE TABLE IF NOT
  // EXISTS acima não adiciona coluna em tabela já criada anteriormente).
  await pool.query(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS obs_horario TEXT`);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_pedidos_status ON pedidos(status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_pedidos_created_at ON pedidos(created_at)`);
}

// apaga pedidos mais antigos que RETENCAO_PEDIDOS_DIAS dias (rodada no start e periodicamente)
async function limparPedidosAntigos() {
  const r = await pool.query(
    `DELETE FROM pedidos WHERE created_at < now() - interval '${RETENCAO_PEDIDOS_DIAS} days'`
  );
  return r.rowCount;
}

module.exports = { pool, initSchema, limparPedidosAntigos, RETENCAO_PEDIDOS_DIAS };
