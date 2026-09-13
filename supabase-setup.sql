-- =============================================
-- Super Bubble — Tabelas de Memória
-- Execute este SQL no Supabase SQL Editor
-- =============================================

-- Tabela de conversas (uma por cliente)
CREATE TABLE conversas (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id TEXT NOT NULL UNIQUE,
  status TEXT DEFAULT 'agente', -- 'agente' ou 'humano' (quem está respondendo)
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Índice para buscar conversa pelo client_id
CREATE INDEX idx_conversas_client_id ON conversas(client_id);

-- Tabela de mensagens (cada mensagem da conversa)
CREATE TABLE mensagens (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  conversa_id UUID NOT NULL REFERENCES conversas(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'humano')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Índice para carregar mensagens de uma conversa em ordem
CREATE INDEX idx_mensagens_conversa ON mensagens(conversa_id, created_at);

-- Habilitar RLS (Row Level Security) para proteção
ALTER TABLE conversas ENABLE ROW LEVEL SECURITY;
ALTER TABLE mensagens ENABLE ROW LEVEL SECURITY;

-- Política: permitir tudo via service_role (o servidor usa a chave service role)
CREATE POLICY "Acesso total via service role" ON conversas FOR ALL USING (true);
CREATE POLICY "Acesso total via service role" ON mensagens FOR ALL USING (true);
