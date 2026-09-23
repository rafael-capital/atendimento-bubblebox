require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');

// ==========================================
// CONFIGURAÇÃO
// ==========================================

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// OpenRouter (API compatível com OpenAI)
const openai = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
});

const AI_MODEL = process.env.AI_MODEL || 'anthropic/claude-sonnet-4';

// Sonnet 5 pensa antes de responder por padrão: custa mais, demora mais e pode estourar o
// max_tokens (resposta cortada). Atendimento de lavanderia não precisa disso — desligado.
const AI_EXTRA = AI_MODEL.includes('sonnet-5') ? { reasoning: { enabled: false } } : {};
const VERSAO = '2026-09-23-checkin';

// Supabase (memória)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ==========================================
// CARREGAR SKILLS (prompt e base de conhecimento)
// ==========================================

function loadSkill(filename) {
  const filepath = path.join(__dirname, 'skills', filename);
  try {
    return fs.readFileSync(filepath, 'utf-8');
  } catch (err) {
    console.error(`⚠️  Não consegui ler ${filename}:`, err.message);
    return '';
  }
}

// O prompt é relido a cada mensagem — edite, salve, e o efeito aparece na próxima resposta
function getSystemPrompt() {
  return loadSkill('prompt-agente.md');
}

function getConstituicao() {
  return loadSkill('constituicao.md');
}

// ==========================================
// VMLAV — Mapa de unidades
// ==========================================

const VMLAV_API = 'https://apps.vmhub.vmtecnologia.io/vmlav/api/externa/v1';
const VMLAV_KEY = process.env.VMLAV_API_KEY;

// IDs reais das lavanderias no VMLav
const UNIDADES = {
  '1': { id: 448, nome: 'Centro — R. da Penha' },
  '2': { id: 1761, nome: 'Simus — Av. Américo Figueiredo' },
  '3': { id: 2739, nome: 'Vila Olímpia — Av. Itavuvu' },
};

// Aliases para o modelo encontrar a unidade pelo nome
const ALIASES = {
  centro: '1', penha: '1',
  simus: '2', 'jardim simus': '2', americo: '2', 'américo': '2',
  'vila olimpia': '3', 'vila olímpia': '3', itavuvu: '3', olimpia: '3',
};

function resolveUnidade(input) {
  if (!input) return null;
  const clean = input.toString().trim().toLowerCase();
  if (UNIDADES[clean]) return clean;
  if (ALIASES[clean]) return ALIASES[clean];
  // Busca parcial
  for (const [alias, num] of Object.entries(ALIASES)) {
    if (clean.includes(alias) || alias.includes(clean)) return num;
  }
  return null;
}

// Traduz o estado da API para linguagem humana
function traduzirEstado(estado) {
  if (!estado) return 'desconhecido';
  if (estado.includes('operacional')) return 'livre';
  if (estado.includes('ocupado')) return 'ocupada';
  if (estado.includes('manutencao') || estado.includes('manutenção')) return 'em manutenção';
  return estado.replace('situacaoMaquina.', '');
}

// Consulta real à API do VMLav
async function consultarVMLav(unidadeInput) {
  try {
    const res = await fetch(`${VMLAV_API}/maquinas?pagina=0&quantidade=100&estadoCadastro=true`, {
      headers: { 'x-api-key': VMLAV_KEY },
    });
    if (!res.ok) throw new Error(`API VMLav retornou ${res.status}`);
    const data = await res.json();
    const maquinas = Array.isArray(data) ? data : data.value || data;

    // Filtrar por unidade se especificada
    const unidadeNum = resolveUnidade(unidadeInput);
    const unidadesParaFiltrar = unidadeNum
      ? [UNIDADES[unidadeNum]]
      : Object.values(UNIDADES);

    const resultado = unidadesParaFiltrar.map((u) => {
      const maqsUnidade = maquinas.filter((m) => m.idLavanderia === u.id);
      const lavadoras = maqsUnidade.filter((m) => m.tipo === 'LAVAGEM');
      const secadoras = maqsUnidade.filter((m) => m.tipo === 'SECAGEM');

      return {
        unidade: u.nome,
        lavadoras: {
          total: lavadoras.length,
          livres: lavadoras.filter((m) => traduzirEstado(m.estado) === 'livre').length,
          ocupadas: lavadoras.filter((m) => traduzirEstado(m.estado) === 'ocupada').length,
          detalhe: lavadoras.map((m) => ({ nome: m.nome, status: traduzirEstado(m.estado) })),
        },
        secadoras: {
          total: secadoras.length,
          livres: secadoras.filter((m) => traduzirEstado(m.estado) === 'livre').length,
          ocupadas: secadoras.filter((m) => traduzirEstado(m.estado) === 'ocupada').length,
          detalhe: secadoras.map((m) => ({ nome: m.nome, status: traduzirEstado(m.estado) })),
        },
      };
    });

    return JSON.stringify(resultado, null, 2);
  } catch (err) {
    console.error('❌ Erro ao consultar VMLav:', err.message);
    return JSON.stringify({ erro: 'Não consegui consultar o status das máquinas agora. Peça ao cliente para tentar novamente em instantes.' });
  }
}

// ==========================================
// TRANSBORDO — transferir para humano
// ==========================================

const RAFAEL_PHONE = process.env.RAFAEL_PHONE || '5515999999999';

async function gerarResumoConversa(mensagens) {
  try {
    const historicoTexto = mensagens
      .map((m) => `${m.role === 'user' ? 'Cliente' : 'Super Bubble'}: ${m.content}`)
      .join('\n');

    const response = await openai.chat.completions.create({
      model: AI_MODEL,
      ...AI_EXTRA,
      messages: [
        {
          role: 'system',
          content: 'Você é um assistente interno. Gere um resumo executivo de 2-3 linhas da conversa abaixo, focando no que o cliente precisa e qual o motivo da transferência. Seja direto e objetivo. Não use emojis.',
        },
        { role: 'user', content: historicoTexto },
      ],
      max_tokens: 200,
    });

    return response.choices[0]?.message?.content || 'Resumo indisponível.';
  } catch (err) {
    console.error('⚠️  Erro ao gerar resumo:', err.message);
    return 'Não foi possível gerar o resumo da conversa.';
  }
}

async function notificarRafael(clientId, resumo, motivo) {
  const mensagem = `🚨 *Transferência de atendimento*\n\n` +
    `📱 Cliente: ${clientId}\n` +
    `📋 Motivo: ${motivo}\n\n` +
    `💬 *Resumo da conversa:*\n${resumo}`;

  // Se o WAHA estiver configurado, envia pelo WhatsApp
  if (process.env.WAHA_API_URL) {
    try {
      await fetch(`${process.env.WAHA_API_URL}/api/sendText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.WAHA_API_KEY || '' },
        body: JSON.stringify({
          chatId: `${RAFAEL_PHONE}@c.us`,
          text: mensagem,
          session: process.env.WAHA_SESSION || 'default',
        }),
      });
      console.log(`📲 Notificação WhatsApp enviada para ${RAFAEL_PHONE}`);
    } catch (err) {
      console.error('⚠️  Erro ao enviar notificação WhatsApp:', err.message);
    }
  } else {
    // Log local enquanto o WAHA não estiver deployado
    console.log('');
    console.log('📲 ===== NOTIFICAÇÃO PARA O RAFAEL =====');
    console.log(mensagem);
    console.log('=========================================');
    console.log('');
  }
}

async function transferirParaHumano(conversationId, clientId, motivo) {
  try {
    // 1. Mudar status da conversa para 'humano'
    await supabase
      .from('conversas')
      .update({ status: 'humano', updated_at: new Date().toISOString() })
      .eq('id', conversationId);

    // 2. Carregar histórico e gerar resumo
    const mensagens = await loadMessages(conversationId, 20);
    const resumo = await gerarResumoConversa(mensagens);

    // 3. Notificar o Rafael
    await notificarRafael(clientId, resumo, motivo);

    return JSON.stringify({
      sucesso: true,
      mensagem: 'Atendimento transferido. O Rafael foi notificado com o resumo da conversa.',
    });
  } catch (err) {
    console.error('❌ Erro ao transferir:', err.message);
    return JSON.stringify({
      sucesso: false,
      mensagem: 'Houve um erro ao transferir. Peça desculpas e diga que vai tentar novamente em instantes.',
    });
  }
}

// ==========================================
// ORIGEM DO LEAD — de onde o cliente veio
// ==========================================

async function registrarOrigemLead(conversationId, origem, detalhe) {
  try {
    // Não sobrescreve se essa conversa já tiver origem registrada
    const { data: atual } = await supabase
      .from('conversas')
      .select('origem_lead')
      .eq('id', conversationId)
      .single();

    if (atual && atual.origem_lead) {
      return JSON.stringify({ sucesso: true, mensagem: 'Origem já estava registrada, mantendo o valor original.' });
    }

    const { error } = await supabase
      .from('conversas')
      .update({
        origem_lead: origem,
        origem_lead_detalhe: detalhe,
        origem_lead_capturada_em: new Date().toISOString(),
      })
      .eq('id', conversationId);

    if (error) throw error;

    return JSON.stringify({ sucesso: true, mensagem: 'Origem do lead registrada.' });
  } catch (err) {
    console.error('❌ Erro ao registrar origem do lead:', err.message);
    return JSON.stringify({ sucesso: false, mensagem: 'Não consegui registrar agora, mas pode seguir a conversa normalmente.' });
  }
}

// ==========================================
// FERRAMENTAS (function calling)
// ==========================================

const tools = [
  {
    type: 'function',
    function: {
      name: 'constituicao',
      description: 'Consulta a base de conhecimento da Bubble Box Sorocaba: dados da empresa, serviços, preços por unidade, planos de mensalidade, horários, Wi-Fi, formas de pagamento, cupons de desconto, ciclos de lavagem, itens proibidos, endereços das unidades e dúvidas frequentes.',
      parameters: {
        type: 'object',
        properties: {
          consulta: {
            type: 'string',
            description: 'O que o agente quer saber (ex: "preços da unidade 2", "horário de funcionamento", "planos de mensalidade")',
          },
        },
        required: ['consulta'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'vmlav_status',
      description: 'Consulta o status das máquinas de lavar e secar em tempo real em cada unidade da Bubble Box. Retorna quantas máquinas estão livres/ocupadas. SEMPRE use esta ferramenta quando o cliente perguntar sobre disponibilidade de máquinas.',
      parameters: {
        type: 'object',
        properties: {
          unidade: {
            type: 'string',
            description: 'Número ou nome da unidade (ex: "1", "2", "3", "Centro", "Simus", "Vila Olímpia"). Deixe vazio para consultar todas.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'registrar_origem_lead',
      description: 'Registra de onde o cliente conheceu a Bubble Box (Instagram, Google, indicação, passando na rua ou outro). Use assim que o cliente responder essa pergunta pela primeira vez. Não pergunte de novo se ele já respondeu antes na conversa.',
      parameters: {
        type: 'object',
        properties: {
          origem: {
            type: 'string',
            enum: ['instagram', 'google', 'indicacao', 'passando_na_rua', 'outro'],
            description: 'Categoria mais próxima da resposta do cliente.',
          },
          detalhe: {
            type: 'string',
            description: 'A resposta literal do cliente, como ele disse (ex: "vi no Instagram", "minha vizinha indicou").',
          },
        },
        required: ['origem', 'detalhe'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'transferir_humano',
      description: 'Transfere o atendimento para um humano (o Rafael). Use quando: nota fiscal, problema técnico, fechamento de plano, ou qualquer situação fora do seu escopo. A ferramenta pausa o agente, gera um resumo e notifica o Rafael pelo WhatsApp.',
      parameters: {
        type: 'object',
        properties: {
          motivo: {
            type: 'string',
            description: 'Motivo da transferência (ex: "nota fiscal", "problema técnico", "fechamento de plano", "reclamação")',
          },
        },
        required: ['motivo'],
      },
    },
  },
];

// Executar uma ferramenta (conversationId e clientId necessários para transferir_humano)
async function executeTool(name, args, conversationId, clientId) {
  switch (name) {
    case 'constituicao': {
      const conteudo = getConstituicao();
      if (!conteudo) return 'A base de conhecimento está vazia. Não tenho dados da empresa.';
      return conteudo;
    }
    case 'vmlav_status': {
      return await consultarVMLav(args.unidade);
    }
    case 'registrar_origem_lead': {
      return await registrarOrigemLead(conversationId, args.origem, args.detalhe);
    }
    case 'transferir_humano': {
      return await transferirParaHumano(conversationId, clientId, args.motivo || 'não especificado');
    }
    default:
      return `Ferramenta "${name}" não encontrada.`;
  }
}

// ==========================================
// MEMÓRIA (Supabase)
// ==========================================

// Buscar ou criar conversa para um cliente
async function getOrCreateConversation(clientId) {
  // Tentar encontrar conversa existente
  const { data: existing } = await supabase
    .from('conversas')
    .select('*')
    .eq('client_id', clientId)
    .single();

  if (existing) return existing;

  // Criar nova conversa
  const { data: created, error } = await supabase
    .from('conversas')
    .insert({ client_id: clientId })
    .select()
    .single();

  if (error) {
    console.error('Erro ao criar conversa:', error);
    return null;
  }
  return created;
}

// Salvar mensagem no Supabase
async function saveMessage(conversationId, role, content) {
  const { error } = await supabase.from('mensagens').insert({
    conversa_id: conversationId,
    role: role, // 'user', 'assistant' ou 'humano'
    content: content,
  });
  if (error) console.error('Erro ao salvar mensagem:', error);
}

// Carregar as últimas N mensagens de uma conversa
async function loadMessages(conversationId, limit = 20) {
  const { data, error } = await supabase
    .from('mensagens')
    .select('role, content, created_at')
    .eq('conversa_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) {
    console.error('Erro ao carregar mensagens:', error);
    return [];
  }
  return data || [];
}

// Atualizar timestamp da conversa
async function touchConversation(conversationId) {
  await supabase
    .from('conversas')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', conversationId);
}

// ==========================================
// CHAT — o cérebro do agente
// ==========================================

async function chat(clientId, userMessage) {
  // 1. Buscar ou criar conversa
  const conversation = await getOrCreateConversation(clientId);
  if (!conversation) {
    return 'Desculpe, estou com um problema técnico. Tente novamente em instantes.';
  }

  // 1b. Se a conversa está no modo humano, o agente não responde (ou verifica timeout)
  if (conversation.status === 'humano') {
    const lastUpdate = new Date(conversation.updated_at);
    const now = new Date();
    const diffHours = (now - lastUpdate) / (1000 * 60 * 60);

    if (diffHours >= 4) {
      console.log(`[TIMEOUT] Retornando conversa do ${clientId} para o agente após 4 horas.`);
      await supabase
        .from('conversas')
        .update({ status: 'agente', updated_at: now.toISOString() })
        .eq('id', conversation.id);
      conversation.status = 'agente'; // Permite o agente responder agora
    } else {
      await saveMessage(conversation.id, 'user', userMessage);
      await touchConversation(conversation.id); // Renova o timeout se o cliente mandar msg
      return null; // null = não responder (o humano está no controle)
    }
  }

  // 2. Salvar a mensagem do cliente
  await saveMessage(conversation.id, 'user', userMessage);

  // 3. Carregar histórico (últimas 20 mensagens)
  const history = await loadMessages(conversation.id);

  // 4. Montar mensagens para o modelo
  const messages = [
    { role: 'system', content: getSystemPrompt() },
    ...history.map((msg) => ({
      role: msg.role === 'humano' ? 'assistant' : msg.role,
      content: msg.content,
    })),
  ];

  // 5. Loop de ferramentas — o modelo pode chamar ferramentas várias vezes
  let response;
  let maxIterations = 5; // segurança

  while (maxIterations > 0) {
    maxIterations--;

    response = await openai.chat.completions.create({
      model: AI_MODEL,
      ...AI_EXTRA,
      messages: messages,
      tools: tools,
      tool_choice: 'auto',
      max_tokens: 1024,
    });

    const choice = response.choices[0];

    // Se o modelo terminou (não quer usar ferramenta)
    if (choice.finish_reason === 'stop' || !choice.message.tool_calls) {
      const assistantMessage = choice.message.content || '';

      // 6. Salvar resposta do agente
      await saveMessage(conversation.id, 'assistant', assistantMessage);
      await touchConversation(conversation.id);

      return assistantMessage;
    }

    // Se o modelo quer usar ferramenta(s)
    messages.push(choice.message); // adiciona a mensagem com tool_calls

    for (const toolCall of choice.message.tool_calls) {
      const toolName = toolCall.function.name;
      const toolArgs = JSON.parse(toolCall.function.arguments || '{}');

      console.log(`🔧 Ferramenta: ${toolName}`, toolArgs);

      const toolResult = await executeTool(toolName, toolArgs, conversation.id, clientId);

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
      });
    }
    // Volta pro while — o modelo recebe o resultado da ferramenta e pensa de novo
  }

  // Segurança: se saiu do loop sem resposta
  return 'Desculpe, estou com dificuldade para processar. Pode repetir?';
}

// ==========================================
// ROTAS
// ==========================================

// Sandbox: página de teste
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API de chat (sandbox e futuro webhook do WAHA)
app.post('/chat', async (req, res) => {
  try {
    const { clientId, message } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Mensagem vazia' });
    }

    // Se não vier clientId, usa um aleatório (sandbox)
    const id = clientId || `sandbox-${Date.now()}`;

    const reply = await chat(id, message);

    // Se reply é null, o agente está pausado (humano no controle)
    if (reply === null) {
      return res.json({ reply: '⏸️ Este atendimento está sendo feito por um humano. Aguarde.' });
    }

    res.json({ reply });
  } catch (err) {
    console.error('❌ Erro no chat:', err);
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  }
});

// Webhook para conexão com o WhatsApp (WAHA)
app.post('/waha/webhook', async (req, res) => {
  try {
    const payload = req.body;

    // Ignorar eventos que não sejam mensagens
    if (payload.event === 'message' && payload.payload) {
      // 1. Mensagens enviadas PELO HUMANO (Rafael) via próprio celular ou Chatwoot
      if (payload.payload.fromMe) {
        const clientId = payload.payload.to; // O destino da msg é o cliente
        const messageBody = payload.payload.body || '';

        // Se o humano mandar a mensagem de encerramento, religa o agente
        if (messageBody.includes('Bubble Lover, vou encerrar o seu atendimento')) {
          console.log(`[WAHA] Comando de devolução detectado para ${clientId}. Reativando agente...`);

          await supabase
            .from('conversas')
            .update({ status: 'agente', updated_at: new Date().toISOString() })
            .eq('client_id', clientId);

          console.log(`[WAHA] Agente reativado para ${clientId}`);
        } else {
          // Renova o timeout se o humano mandar mensagem
          await supabase
            .from('conversas')
            .update({ updated_at: new Date().toISOString() })
            .eq('client_id', clientId);
        }

        // Retornamos OK e não deixamos o agente responder (pois fomos nós que geramos)
        return res.status(200).send('OK');
      }

      // 2. Mensagens enviadas PELO CLIENTE (fromMe: false)
      const clientId = payload.payload.from;
      const messageBody = (payload.payload.body || '').substring(0, 2000);

      // Status do WhatsApp, grupos e canais não são clientes: o agente não responde
      if (/(@broadcast|@g\.us|@newsletter)$/.test(String(clientId))) {
        return res.status(200).send('OK');
      }

      console.log(`[WAHA] Message from ${clientId}: ${messageBody}`);

      // Resposta ao WAHA imediata para confirmar recebimento (evitar retries)
      res.status(200).send('OK');

      // Detectar se a mensagem e midia (imagem, audio, video, etc.)
      const hasMedia = payload.payload.hasMedia ||
        payload.payload.type === 'image' ||
        payload.payload.type === 'audio' ||
        payload.payload.type === 'ptt' ||
        payload.payload.type === 'video' ||
        payload.payload.type === 'document' ||
        payload.payload.type === 'sticker';

      // Se for midia sem texto, responder com mensagem amigavel e encerrar
      if (hasMedia && !messageBody) {
        const mediaReply = 'Oi, Bubble Lover! No momento eu so consigo ler mensagens em texto. Pode me escrever o que precisa?';
        if (process.env.WAHA_API_URL) {
          await fetch(`${process.env.WAHA_API_URL}/api/sendText`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              'X-Api-Key': process.env.WAHA_API_KEY || ''
            },
            body: JSON.stringify({
              chatId: clientId,
              text: mediaReply,
              session: process.env.WAHA_SESSION || 'default',
            }),
          });
          console.log(`[WAHA] Reply sent to ${clientId} (media fallback)`);
        }
        return;
      }

      // Processar mensagem apenas se tiver texto
      if (messageBody) {
        try {
          const reply = await chat(clientId, messageBody);

          // Se a resposta for null, o transbordo ja assumiu. Senao, enviamos a resposta de volta ao WhatsApp.
          if (reply) {
            if (process.env.WAHA_API_URL) {
              await fetch(`${process.env.WAHA_API_URL}/api/sendText`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Accept: 'application/json',
                  'X-Api-Key': process.env.WAHA_API_KEY || ''
                },
                body: JSON.stringify({
                  chatId: clientId,
                  text: reply,
                  session: process.env.WAHA_SESSION || 'default',
                }),
              });
              console.log(`[WAHA] Reply sent to ${clientId}`);
            } else {
              console.log(`[WAHA Simulado] para ${clientId}: ${reply}`);
            }
          }
        } catch (chatErr) {
          console.error(`Erro no chat para ${clientId}:`, chatErr.message);
          if (process.env.WAHA_API_URL) {
            try {
              await fetch(`${process.env.WAHA_API_URL}/api/sendText`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Accept: 'application/json',
                  'X-Api-Key': process.env.WAHA_API_KEY || ''
                },
                body: JSON.stringify({
                  chatId: clientId,
                  text: 'Desculpe, tive um problema tecnico momentaneo. Pode repetir sua mensagem?',
                  session: process.env.WAHA_SESSION || 'default',
                }),
              });
            } catch (sendErr) {
              console.error('Erro ao enviar fallback:', sendErr.message);
            }
          }
        }
      }
      return;
    }

    // Para outros eventos (typing, status, read) dar OK ignorando
    res.status(200).send('Event ignored');
  } catch (err) {
    console.error('❌ Erro no webhook WAHA:', err);
    if (!res.headersSent) {
      res.status(500).send('Error');
    }
  }
});

// ==========================================
// CHECK-IN DO PRIMEIRO CICLO (chamado pelo n8n)
// ==========================================
// O n8n detecta na VMLav o primeiro ciclo de um cliente e chama esta rota com a
// mensagem já sorteada. O WhatsApp identifica os clientes por um código interno
// (@lid), não pelo telefone — e é com esse código que a resposta do cliente volta.
// Por isso a conversa é gravada no @lid: quando ele responder, o agente enxerga
// a pergunta no histórico e segue (link de avaliação ou transferência).
app.post('/checkin', async (req, res) => {
  if (!process.env.CHECKIN_TOKEN || req.get('x-checkin-token') !== process.env.CHECKIN_TOKEN) {
    return res.status(401).json({ enviado: false, motivo: 'não autorizado' });
  }
  const { telefone, mensagem } = req.body || {};
  const digitos = String(telefone || '').replace(/\D/g, '');
  if (!mensagem || digitos.length < 10) {
    return res.status(400).json({ enviado: false, motivo: 'telefone ou mensagem inválidos' });
  }
  const numero = digitos.startsWith('55') && digitos.length >= 12 ? digitos : `55${digitos}`;
  const sessao = process.env.WAHA_SESSION || 'default';
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Api-Key': process.env.WAHA_API_KEY || '' };

  try {
    const r = await fetch(`${process.env.WAHA_API_URL}/api/contacts/check-exists?phone=${numero}&session=${encodeURIComponent(sessao)}`, { headers });
    const contato = await r.json();
    if (!contato.numberExists || !contato.chatId) return res.json({ enviado: false, motivo: 'telefone sem WhatsApp' });

    const conversa = await getOrCreateConversation(contato.chatId);
    if (!conversa) return res.status(500).json({ enviado: false, motivo: 'não consegui abrir a conversa' });
    if (conversa.status === 'humano') return res.json({ enviado: false, motivo: 'cliente em atendimento humano' });

    const envio = await fetch(`${process.env.WAHA_API_URL}/api/sendText`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ session: sessao, chatId: contato.chatId, text: mensagem }),
    });
    if (!envio.ok) return res.status(502).json({ enviado: false, motivo: `WAHA recusou o envio (${envio.status})` });

    await saveMessage(conversa.id, 'assistant', mensagem);
    console.log(`📨 Check-in de primeiro ciclo enviado para ${contato.chatId}`);
    res.json({ enviado: true });
  } catch (err) {
    console.error('❌ Erro no check-in:', err);
    res.status(500).json({ enviado: false, motivo: err.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', agent: 'Super Bubble', versao: VERSAO, modelo: AI_MODEL, timestamp: new Date().toISOString() });
});

// ==========================================
// INICIAR SERVIDOR
// ==========================================

app.listen(PORT, () => {
  console.log('');
  console.log('🫧 ============================================');
  console.log('🫧  SUPER BUBBLE — Agente de IA');
  console.log('🫧  Bubble Box Sorocaba');
  console.log('🫧 ============================================');
  console.log('');
  console.log(`✅ Servidor rodando em http://localhost:${PORT}`);
  console.log(`🧪 Sandbox de teste: http://localhost:${PORT}`);
  console.log(`🧠 Modelo: ${AI_MODEL}`);
  console.log(`💾 Supabase: ${process.env.SUPABASE_URL ? 'conectado' : '⚠️  não configurado'}`);
  console.log(`🏭 VMLav: ${VMLAV_KEY ? 'conectado' : '⚠️  não configurado'}`);
  console.log(`📲 Notificação: ${process.env.WAHA_API_URL ? 'WAHA conectado' : 'log local (WAHA não configurado)'}`);
  console.log('');
});
