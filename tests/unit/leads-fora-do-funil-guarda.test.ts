import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * QUEM ESTÁ "FORA DO FUNIL" NÃO PODE VOLTAR POR UMA LEITURA ESQUECIDA.
 *
 * O espelho `crm_leads.fora_do_funil` (migration 0221) esconde os negócios de equipe, prestador e parceiro — mas só
 * de quem o filtra. O sistema lê negócios em dezenas de pontos; um ponto novo (ou um que ninguém lembrou) que liste
 * ou agregue negócios sem o filtro devolve a equipe do cliente ao quadro, ao radar e ao relatório, em silêncio.
 *
 * Esta guarda OBRIGA a decisão: todo arquivo de `lib/`, `app/`, `hooks/` e `components/` que lê ou escreve
 * `crm_leads` tem de estar em UMA de duas listas —
 *   - FILTRAM: lista/agrega negócios e carrega o filtro (a guarda confere que o filtro está lá);
 *   - NAO_FILTRAM: com o MOTIVO escrito (opera num negócio que já se tem na mão, ciclo de vida/LGPD, dependência de
 *     exclusão que precisa ver tudo…).
 * Arquivo novo que leia negócios e não esteja em nenhuma das duas REPROVA. A lista só encolhe: entrada que não lê
 * mais negócios também reprova (senão a lista vira lixo e ninguém mais a lê).
 */
const RAIZES = ["lib", "app", "hooks", "components"];

/** Lê ou escreve `crm_leads` em código (não em comentário de prosa): `.from("crm_leads")`, SQL cru ou embed. */
const LE_NEGOCIOS =
  /\.from\(\s*["']crm_leads["']\s*\)|\b(?:from|join|update|insert\s+into|delete\s+from)\s+(?:public\.)?crm_leads\b|\bcrm_leads\s*[!(]|\bcrm_leads:|table:\s*["']crm_leads["']/;

/** O filtro: `.eq("fora_do_funil", false)`, SQL `not fora_do_funil`/`fora_do_funil = false`, ou guarda do realtime. */
const TEM_O_FILTRO =
  /\.eq\(\s*["']fora_do_funil["']\s*,\s*false\s*\)|\bnot\s+(?:\w+\.)?fora_do_funil\b|\bfora_do_funil\s*=\s*false\b|\.fora_do_funil\s*===\s*true/;

const FILTRAM: Record<string, string> = {
  "app/api/v1/pipelines/[id]/board/route.ts": "o quadro do funil: o card de quem está fora não aparece",
  "app/api/v1/leads/_handler.ts": "a listagem e a busca de negócios (as operações por id do mesmo arquivo não precisam)",
  "app/api/v1/leads/proposals/route.ts": "as propostas de próxima ação só roteiam para negócio que aparece",
  "app/api/v1/cron/risk-watcher/route.ts": "o vigia de risco só varre organizações com negócio que conta",
  "lib/leads/radar-de-risco.ts": "o radar de risco lista negócios que o time precisa agir",
  "lib/leads/risk-seed.ts": "a semente do risco não cria estado para quem está fora",
  "app/api/v1/contacts/[id]/crm-summary/route.ts": "o resumo do CRM na ficha do contato mostra os negócios que contam",
  "lib/followup/retorno-crm.ts": "o retorno do follow-up só escolhe negócio que aparece",
  "lib/escalacao/retomada.ts": "a volta do atendimento só se registra em negócio que aparece",
  "lib/inbox/atividade-de-comando.ts": "a troca de comando só se registra em negócio que aparece",
  "hooks/notifications/useCrmAlerts.ts": "avisos em tempo real: o espelho muda em massa e não pode virar aviso",
};

const NAO_FILTRAM: Record<string, string> = {
  // ── opera num negócio que já se tem na mão (por id) — esconder aqui quebraria abrir/mover/fechar o que o time achou
  "app/api/v1/leads/[id]/move/route.ts": "por id: mover um negócio que já se tem na mão",
  "app/api/v1/leads/[id]/next-action/route.ts": "por id: próxima ação de um negócio específico",
  "app/api/v1/leads/[id]/reactivation/route.ts": "por id: proposta de reativação de um negócio específico",
  "app/api/v1/leads/[id]/timeline/route.ts": "por id: a linha do tempo de um negócio específico",
  "app/api/v1/leads/bulk/route.ts": "por ids escolhidos na tela: ação em lote sobre o que a pessoa selecionou",
  "app/app/leads/[id]/page.tsx": "por id: abrir um negócio pelo endereço (o histórico fica guardado e acessível)",
  "app/api/v1/agenda/agendamentos/_handler.ts": "por id: ligar a consulta a um negócio escolhido",
  "app/api/v1/conversations/[id]/claim/route.ts": "ao assumir a conversa, passa o dono para os negócios do contato; é escrita, não listagem",
  "lib/agenda/consulta.ts": "por id: confirmar que o negócio citado existe",
  "lib/automation/actions/assign-owner.ts": "por id: a regra age no negócio do evento",
  "lib/automation/actions/add-tag.ts": "por id: a regra age no negócio do evento",
  "hooks/kanban/useBoard.ts": "tempo real: só INVALIDA o quadro, que recarrega pela rota já filtrada",
  "lib/automation/engine.ts": "por id: o contexto do evento da regra",
  "lib/followup/gatilho-etapa.ts": "por id: o contato do negócio que mudou de etapa",
  "lib/followup/persistir-resposta.ts": "por id: grava a resposta no negócio do fluxo",
  "lib/followup/turn-bridge.ts": "por id: a ponte do turno de follow-up com o negócio dele",
  "lib/followup/engine.ts": "variáveis do contato para um follow-up que, para quem está fora, nem é matriculado (elegibilidade)",
  "lib/leads/agent-activity.ts": "por id: o que o agente fez neste negócio",
  "lib/leads/agent-stage-sync.ts": "por id: o agente move o negócio que está atendendo",
  "lib/leads/appointment-stage-move.ts": "por id: a consulta marcada move o negócio dela",
  "lib/leads/handoff-stage-move.ts": "por id: o passe para humano move o negócio",
  "lib/leads/encerramento.ts": "por id: fechar (ganho/perdido) um negócio específico",
  "lib/leads/escopo-de-funil.ts": "a regra de quem vê qual funil (permissão), não uma listagem de negócios",
  "lib/leads/score-writer.ts": "por id: grava a pontuação do negócio",
  "lib/leads/stage-operations.ts": "operações de etapa que precisam enxergar TODOS os negócios (mover/excluir etapa, FK restrict)",
  "lib/leads/reactivation.ts": "por id: reativação de um negócio específico",
  "lib/routing/worker.ts": "escreve o dono nos negócios do contato ao rotear a conversa; é escrita, não listagem",
  "lib/notifications/push.handler.ts": "por id: o título do negócio de um evento já gerado",
  "lib/operacao/modelos-de-mensagem.ts": "por id: variáveis do negócio para preencher um modelo de mensagem",
  "lib/mcp/tools/handoff.ts": "por id: ferramenta de passe do agente, que não roda para quem está fora (elegibilidade)",
  "lib/mcp/tools/retencao.ts": "por id: ferramenta de retenção do agente, que não roda para quem está fora (elegibilidade)",
  "lib/ai/handoff/triggers.ts": "por id: a etapa exige humano? (agente, que não roda para quem está fora)",
  "lib/ai/runtime/tools.ts": "por id: ferramentas do agente legado, que não roda para quem está fora (elegibilidade)",
  "lib/agent-engine/agent/inbound-turn.ts": "o turno do agente, que não roda para quem está fora (decidirElegibilidade vem antes)",
  // ── ciclo de vida, dependência de exclusão e administração: precisam ver tudo, escondido ou não
  "app/api/v1/pipelines/_funis.ts": "dependência de EXCLUSÃO do funil: negócio fora do funil continua sendo FK RESTRICT — contá-lo evita apagar um funil que o banco recusaria",
  "app/api/v1/admin/tenants/[id]/route.ts": "administração da plataforma: contagem real da organização",
  "lib/lgpd/cascata.ts": "LGPD: anonimizar alcança TODO negócio do contato, escondido ou não",
  "lib/lgpd/export-collector.ts": "LGPD: a exportação entrega TUDO que se guarda do titular",
  "app/api/v1/contacts/[id]/timeline/route.ts": "a linha do tempo do contato: o histórico guardado, inclusive o do que saiu do funil",
  "app/api/v1/webhooks/in/[token]/route.ts": "idempotência por external_id: precisa ver o negócio existente, escondido ou não, para não duplicá-lo",
  "lib/leads/nascimento-do-lead.ts": "escreve o negócio novo; a recusa para quem está fora é a própria regra deste arquivo",
  "lib/contatos/fora-do-funil.ts": "a prévia e o marcador contam justamente os negócios que o espelho esconde ou devolve",
  "app/api/v1/metrics/attendants/route.ts": "lê pela função fn_attendant_metrics, que ignora o espelho (provado em tests/invariants/contato-fora-do-funil.test.ts)",
};

function arquivos(dir: string, acc: string[] = []): string[] {
  for (const nome of readdirSync(dir)) {
    if (nome === "node_modules" || nome === ".next" || nome.startsWith(".")) continue;
    const p = join(dir, nome);
    if (statSync(p).isDirectory()) arquivos(p, acc);
    else if (/\.(ts|tsx)$/.test(nome) && !/\.test\.|\.d\.ts$|database\.types\.ts$/.test(nome)) acc.push(p);
  }
  return acc;
}

const RAIZ = process.cwd();
const LEEM = RAIZES.flatMap((r) => arquivos(join(RAIZ, r)))
  .map((p) => relative(RAIZ, p).split("\\").join("/"))
  .filter((f) => LE_NEGOCIOS.test(readFileSync(join(RAIZ, f), "utf8")))
  .sort();

describe("leitura de negócios e o espelho 'fora do funil'", () => {
  it("achou arquivos que leem negócios (guarda de vacuidade)", () => {
    expect(LEEM.length).toBeGreaterThan(40);
  });

  it("todo arquivo que lê ou escreve crm_leads foi CLASSIFICADO (filtra, ou não filtra com motivo)", () => {
    const sem = LEEM.filter((f) => !(f in FILTRAM) && !(f in NAO_FILTRAM));
    expect(
      sem,
      "Arquivo novo lê negócios sem estar classificado. Se ele LISTA ou AGREGA negócios, ponha `.eq(\"fora_do_funil\", false)` " +
        "e coloque em FILTRAM; se opera num negócio já em mãos, ponha em NAO_FILTRAM com o MOTIVO.",
    ).toEqual([]);
  });

  it("as duas listas não se contradizem", () => {
    const nasDuas = Object.keys(FILTRAM).filter((f) => f in NAO_FILTRAM);
    expect(nasDuas).toEqual([]);
  });

  it("quem diz FILTRAR filtra de verdade (o texto do filtro está no arquivo)", () => {
    const sem = Object.keys(FILTRAM).filter((f) => !TEM_O_FILTRO.test(readFileSync(join(RAIZ, f), "utf8")));
    expect(sem, "o arquivo está em FILTRAM mas perdeu o filtro de fora_do_funil").toEqual([]);
  });

  it("nenhuma entrada ficou obsoleta: todo arquivo listado ainda existe e ainda lê negócios", () => {
    const lidos = new Set(LEEM);
    const obsoletas = [...Object.keys(FILTRAM), ...Object.keys(NAO_FILTRAM)].filter((f) => !lidos.has(f));
    expect(obsoletas, "tire da lista: o arquivo sumiu ou deixou de ler negócios").toEqual([]);
  });

  it("toda exceção tem um motivo de verdade (não vazio nem placeholder)", () => {
    for (const [arquivo, motivo] of Object.entries({ ...FILTRAM, ...NAO_FILTRAM })) {
      expect(motivo.trim().length, arquivo).toBeGreaterThan(15);
      expect(motivo, arquivo).not.toMatch(/^(todo|tbd|\?+)/i);
    }
  });
});
