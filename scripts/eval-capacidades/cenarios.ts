/**
 * As mensagens do teste de limite de capacidades.
 *
 * Cada cenário é uma mensagem do tipo que chega a uma clínica (ou uma ordem da equipe ao agente), com a ferramenta
 * que um agente certo chamaria PRIMEIRO. `aceitas` são as alternativas igualmente corretas: quando falta um dado
 * (o id do compromisso, a etapa do funil) é certo consultar antes de agir, e punir isso mediria o modelo errado.
 *
 * Os nomes são do catálogo real (`lib/mcp/tools`) e das ferramentas nativas do turno (`AGENT_TOOL_DEFS`). O teste
 * confere no começo que todo nome citado existe — um nome errado aqui valeria como erro do modelo.
 */
export interface Cenario {
  id: string;
  /** O que o cliente (ou a equipe) escreve. */
  mensagem: string;
  /** A ferramenta que o agente deve chamar primeiro. É a que entra SEMPRE no conjunto oferecido. */
  esperada: string;
  /** Outras primeiras chamadas igualmente corretas. */
  aceitas?: string[];
}

export const CENARIOS: Cenario[] = [
  { id: "horarios-livres", mensagem: "Oi! Quais horários vocês têm livres amanhã para uma avaliação?", esperada: "crm_find_free_slots", aceitas: ["crm_list_event_types"] },
  { id: "marcar-limpeza", mensagem: "Quero marcar uma limpeza na quinta às 15h, pode ser?", esperada: "crm_book_appointment", aceitas: ["crm_find_free_slots", "crm_list_event_types"] },
  { id: "remarcar", mensagem: "Preciso remarcar minha consulta de sexta para segunda de manhã.", esperada: "crm_reschedule_appointment", aceitas: ["crm_list_appointments", "crm_find_free_slots"] },
  { id: "cancelar", mensagem: "Não vou conseguir ir na consulta de amanhã, pode cancelar por favor?", esperada: "crm_cancel_appointment", aceitas: ["crm_list_appointments"] },
  { id: "confirmar", mensagem: "Confirmo presença na consulta de amanhã, até lá!", esperada: "crm_confirm_appointment", aceitas: ["crm_list_appointments"] },
  { id: "proxima-consulta", mensagem: "Quando é a minha próxima consulta mesmo? Esqueci o dia.", esperada: "crm_list_appointments" },
  { id: "tipos-de-atendimento", mensagem: "Que tipos de atendimento vocês fazem e quanto tempo dura cada um?", esperada: "crm_list_event_types" },
  { id: "convenio", mensagem: "Vocês aceitam convênio? Quais?", esperada: "search_knowledge", aceitas: ["crm_search_knowledge", "crm_get_org_memory"] },
  { id: "preco-clareamento", mensagem: "Qual o valor do clareamento dental?", esperada: "search_knowledge", aceitas: ["crm_search_knowledge", "crm_search_products", "crm_get_org_memory"] },
  { id: "email-novo", mensagem: "Meu email mudou, agora é maria.souza@exemplo.com", esperada: "crm_propose_contact_field" },
  { id: "me-chama-depois", mensagem: "Vou pensar com calma. Pode me chamar daqui a 3 dias pra eu decidir?", esperada: "crm_schedule_followup", aceitas: ["schedule_followup"] },
  { id: "nao-chama-mais", mensagem: "Já decidi, pode parar de me chamar sobre isso, obrigada.", esperada: "crm_cancel_followup", aceitas: ["crm_list_followups", "send_message"] },
  { id: "falar-com-pessoa", mensagem: "Prefiro falar com uma pessoa de verdade, não com robô.", esperada: "request_human_handoff" },
  { id: "reclamacao", mensagem: "Fui cobrada duas vezes e quero falar com o responsável agora!", esperada: "request_human_handoff" },
  { id: "dados-cadastro", mensagem: "Pode atualizar meu cadastro: meu nome é Carlos Eduardo Silva.", esperada: "crm_propose_contact_field" },
  { id: "atendentes-livres", mensagem: "(equipe) Quais atendentes estão disponíveis agora para assumir?", esperada: "crm_list_available_attendants" },
  { id: "fila", mensagem: "(equipe) Quantas conversas estão na fila de atendimento agora?", esperada: "crm_get_queue_status" },
  { id: "produto-caseiro", mensagem: "Vocês vendem kit de clareamento caseiro? Quanto custa?", esperada: "crm_search_products", aceitas: ["search_knowledge", "crm_search_knowledge"] },
  { id: "meus-pedidos", mensagem: "Pode me mostrar os pedidos que eu já fiz aí?", esperada: "crm_list_contact_orders" },
  { id: "alergia", mensagem: "Anota aí que eu sou alérgica a dipirona, pra não esquecerem.", esperada: "save_lead_note", aceitas: ["crm_save_org_memory"] },
  { id: "o-que-combinamos", mensagem: "O que a gente combinou da última vez sobre o meu orçamento?", esperada: "get_lead_note", aceitas: ["get_lead_context", "crm_get_conversation_history", "crm_list_conversations"] },
  { id: "resposta-pronta", mensagem: "(equipe) Preencha a resposta pronta de boas-vindas com os dados dessa cliente.", esperada: "crm_render_message_template", aceitas: ["crm_list_message_templates"] },
  { id: "bom-dia", mensagem: "Bom dia!", esperada: "send_message", aceitas: ["get_lead_context"] },
  { id: "obrigada", mensagem: "Obrigada, era só isso mesmo!", esperada: "send_message" },
  { id: "endereco", mensagem: "Qual o endereço da clínica e o horário de funcionamento?", esperada: "search_knowledge", aceitas: ["crm_search_knowledge", "crm_get_org_memory"] },
  { id: "regras-desconto", mensagem: "(equipe) Quais as regras de desconto que a empresa registrou para o atendimento?", esperada: "crm_get_org_memory", aceitas: ["crm_search_knowledge", "search_knowledge"] },
  { id: "negocios-esfriando", mensagem: "(equipe) Quais oportunidades abertas estão esfriando e precisam de atenção?", esperada: "crm_list_at_risk_leads" },
  { id: "mover-etapa", mensagem: "(equipe) Mova a oportunidade da Maria para a etapa Agendado.", esperada: "crm_move_lead_stage", aceitas: ["crm_list_stages", "crm_list_pipelines", "crm_list_leads", "crm_get_lead"] },
  { id: "tag-implante", mensagem: "(equipe) Adicione a tag implante nessa conversa.", esperada: "crm_manage_tags", aceitas: ["crm_list_tags"] },
  { id: "listar-tags", mensagem: "(equipe) Quais tags a empresa usa hoje?", esperada: "crm_list_tags" },
  { id: "equipe", mensagem: "(equipe) Quem trabalha na organização e com qual papel?", esperada: "crm_list_team_members" },
  { id: "criar-lead", mensagem: "(equipe) Crie uma oportunidade para a Júlia no funil de vendas.", esperada: "crm_create_lead", aceitas: ["crm_list_pipelines", "crm_list_stages"] },
  { id: "casos-abertos", mensagem: "(equipe) Quais casos humanos estão abertos agora?", esperada: "crm_list_human_cases" },
  { id: "devolver-ia", mensagem: "(equipe) Devolva essa conversa para a IA continuar o atendimento.", esperada: "crm_resume_ai_attendance" },
  { id: "fechar-caso", mensagem: "(equipe) Encerre esse caso, já foi resolvido.", esperada: "crm_close_human_case", aceitas: ["crm_list_human_cases", "crm_get_human_case"] },
  { id: "nota-no-caso", mensagem: "(equipe) Registre no caso aberto que a cliente ligou de volta hoje.", esperada: "crm_add_case_note", aceitas: ["crm_list_human_cases", "crm_get_human_case"] },
  { id: "perdido", mensagem: "(equipe) Marque essa oportunidade como perdida: o cliente desistiu do tratamento.", esperada: "crm_close_demand", aceitas: ["crm_move_lead_stage", "crm_update_lead"] },
  { id: "reativar", mensagem: "(equipe) Proponha reativar o negócio do João, que esfriou.", esperada: "crm_propose_reactivation", aceitas: ["crm_list_at_risk_leads"] },
  { id: "retornos-da-cliente", mensagem: "(equipe) Liste os retornos agendados para essa cliente.", esperada: "crm_list_followups" },
  { id: "regras-automacao", mensagem: "(equipe) Mostre as regras de automação que estão ligadas.", esperada: "crm_list_automation_rules" },
  { id: "acervo", mensagem: "(equipe) Quais materiais existem no acervo de conhecimento?", esperada: "crm_list_knowledge_sources" },
  { id: "pedidos-privacidade", mensagem: "(equipe) Há pedidos de exclusão de dados (LGPD) pendentes?", esperada: "crm_list_privacy_requests" },
  { id: "atendida", mensagem: "(equipe) A paciente Ana foi atendida na consulta de ontem, registre isso.", esperada: "crm_set_appointment_outcome", aceitas: ["crm_list_appointments"] },
];
