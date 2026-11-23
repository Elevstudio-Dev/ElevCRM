/**
 * A IDA, EXECUTADA — publica no Google o que foi marcado aqui.
 *
 * ─── Por que um worker, e não o próprio handler de marcar ────────────────
 *
 * Publicar é rede: cinco a quinze segundos de latência que não são nossos, mais
 * `invalid_grant`, `rate_limited` e 5xx do Google. Pendurar isso no POST faria a
 * pessoa esperar o Google para ver "marcado" — e faria a marcação FALHAR quando
 * o Google estiver fora, sendo que a linha no CRM é a que importa. É a mesma
 * razão pela qual esta base proíbe trigger que faz HTTP.
 *
 * ─── O que decide quem vai ───────────────────────────────────────────────
 *
 * `google_synced_at is null` (nunca foi) **ou** `updated_at > google_synced_at`
 * (mudou depois da última ida). Remarcar e cancelar mexem em `updated_at`, então
 * as duas operações entram por este mesmo caminho — não há fila própria para
 * cada verbo.
 *
 * ─── E o filtro de membro ativo entra aqui também ────────────────────────
 *
 * `apenasDeMembrosAtivos` já impede LER a agenda pessoal de quem saiu da
 * organização. Escrever nela é o outro lado da mesma porta: mandar compromisso
 * da clínica para o calendário pessoal de um ex-funcionário é pior que ler, e a
 * mesma função responde às duas perguntas porque a pergunta é uma só — esta
 * pessoa ainda é do time?
 */
import { NextResponse, type NextRequest } from "next/server";

import { apenasDeMembrosAtivos } from "@/lib/agenda/google/membros";
import { apagarNoGoogle, publicarNoGoogle } from "@/lib/agenda/google/escrita";
import type { AgendamentoParaGoogle } from "@/lib/agenda/google/evento";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { PROVEDOR_GOOGLE } from "@/lib/agenda/tipos";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

export const dynamic = "force-dynamic";

/** Teto por rodada: o cron roda a cada 5min, e ida longa demais estoura o job. */
const TETO_POR_RODADA = 50;

interface LinhaParaIda {
  id: string;
  organization_id: string;
  owner_user_id: string | null;
  title: string | null;
  description: string | null;
  starts_at: string;
  ends_at: string;
  time_zone: string;
  status: string;
  location_kind: string;
  location_details: string | null;
  google_event_id: string | null;
  /** Não nulo = espelho de relato da secretária (carrega nome de paciente). Nunca vai ao Google. */
  origem_relato_id: string | null;
}

function autorizado(req: NextRequest): boolean {
  const cabecalho = req.headers.get("authorization") ?? "";
  const aceitos = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  // Fail-closed: sem segredo configurado, ninguém entra.
  return aceitos.length > 0 && aceitos.some((s) => cabecalho === `Bearer ${s}`);
}

async function executar(req: NextRequest): Promise<Response> {
  if (!autorizado(req)) {
    return NextResponse.json(
      { error: { code: "unauthenticated", message: "cron secret inválido" } },
      { status: 401 },
    );
  }

  const admin = createAdminClient();
  const resumo = { candidatos: 0, publicados: 0, apagados: 0, falhas: 0, semConexao: 0, espelhosRecusados: 0 };
  /**
   * POR QUE as falhas falharam — e não só quantas.
   *
   * ⚠️ ESTE É O TERCEIRO DEFEITO DA v1.9.1, e o que fez os outros dois custarem
   * uma sessão de investigação: o audit registrava `{"falhas": 3}` sem motivo, e
   * o log do app não tinha UMA linha sobre isso (conferido com controle: 27
   * linhas no período, nenhuma de push). O erro existia só dentro da coluna
   * `google_sync_error`, que ninguém abre sem já saber que ela existe.
   *
   * O comentário abaixo dizia "erro que só existe em log é estoque morto", e
   * está certo — mas a recíproca também vale, e foi ela que nos custou caro:
   * erro que só existe na COLUNA é invisível para quem opera a VPS. As duas
   * superfícies servem a leitores diferentes: a coluna é para a tela do dono, o
   * log é para quem investiga por que nada chega ao Google.
   */
  const motivos: string[] = [];

  const { data: pendentes, error: erroLeitura } = await admin
    .from("calendar_appointments")
    .select(
      "id, organization_id, owner_user_id, title, description, starts_at, ends_at, time_zone, status, location_kind, location_details, google_event_id, origem_relato_id",
    )
    // ⚠️ NÃO volte a `.or("…,updated_at.gt.google_synced_at")`.
    //
    // O PostgREST trata o lado DIREITO de `gt.` como VALOR LITERAL, nunca como
    // nome de coluna: ele tentava converter a string "google_synced_at" em
    // `timestamptz` e recusava a consulta INTEIRA. Em produção isso era um
    // `warn` a cada 5 minutos desde o deploy da v1.7.0 e ZERO compromissos
    // empurrados — a ida ao Google nunca aconteceu em instalação nenhuma.
    //
    // `needs_google_push` é coluna GERADA (migration 0200) que carrega
    // exatamente a mesma pergunta, num filtro que o PostgREST sabe fazer.
    .eq("needs_google_push", true)
    .not("owner_user_id", "is", null)
    // PRIVACIDADE: o espelho de relato (`origem_relato_id` não nulo) tem como
    // `title` o NOME DE UM PACIENTE e nunca vai ao Google Agenda de ninguém.
    // Ele nasce com `google_synced_at` carimbado, mas qualquer update depois
    // (editar pela tela, ou o cancelamento do próprio aplicador) religa
    // `needs_google_push` — então o filtro tem de estar AQUI, na leitura. E tem
    // de ser na consulta, não no loop: espelho que só fosse pulado depois de lido
    // gastaria o teto por rodada (TETO_POR_RODADA) e deixaria os compromissos reais esperando.
    //
    // ⚠️ RISCO RESIDUAL, e este filtro NÃO o cobre: `origem_relato_id` é
    // `ON DELETE SET NULL` (migration 0228). Apagar um `agenda_relatos` anula o
    // vínculo de TODOS os espelhos dele; esse UPDATE avança `updated_at`, religa
    // `needs_google_push` e o espelho, já sem `origem_relato_id`, passa pelo
    // filtro E pela defesa do loop como se fosse compromisso comum — com o nome
    // do paciente no `title`. Por isso: NUNCA apagar `agenda_relatos` que ainda
    // tenha espelho vivo (nenhum código do produto apaga hoje). Follow-up: uma
    // migration que troque o FK para RESTRICT, ou que cancele os espelhos antes.
    .is("origem_relato_id", null)
    .order("starts_at", { ascending: true })
    .limit(TETO_POR_RODADA);

  if (erroLeitura) {
    logger.warn("[agenda-google-push] leitura falhou", { error: erroLeitura.message });
    return NextResponse.json({ error: { code: "internal_error", message: erroLeitura.message } }, { status: 500 });
  }

  // DEFESA EM PROFUNDIDADE: o `.is("origem_relato_id", null)` acima já os exclui.
  // Se alguém reescrever a consulta sem ele, o espelho chegaria aqui — e este é o
  // último ponto antes de `publicarNoGoogle`/`apagarNoGoogle`. Recusa e conta;
  // nunca publica o nome de um paciente por descuido de consulta.
  const lidas = (pendentes ?? []) as LinhaParaIda[];
  const linhas = lidas.filter((l) => !l.origem_relato_id);
  resumo.espelhosRecusados = lidas.length - linhas.length;
  if (resumo.espelhosRecusados > 0) {
    logger.warn("[agenda-google-push] espelho de relato chegou ao loop e foi recusado", {
      recusados: resumo.espelhosRecusados,
    });
  }
  resumo.candidatos = linhas.length;
  if (linhas.length === 0) {
    // Rodada vazia NÃO audita: o repo já pagou 95% do audit log em batida de
    // cron sem efeito. Auditar é para quando houve efeito.
    return NextResponse.json({ data: resumo });
  }

  // Só de quem ainda é do time — mesma função que impede a leitura.
  const doTime = await apenasDeMembrosAtivos(
    admin,
    linhas.map((l) => ({ ...l, user_id: l.owner_user_id as string })),
  );

  for (const linha of doTime) {
    const { data: conexoes } = await admin
      .from("calendar_connections")
      .select("id, status, oauth_access_token_encrypted, account_email")
      .eq("organization_id", linha.organization_id)
      .eq("user_id", linha.owner_user_id as string)
      // A CONSTANTE. Era `"google"`, que o CHECK proíbe: o worker achava o
      // compromisso pendente, não achava conexão nenhuma, contava `semConexao` e
      // seguia. A ida CRM→Google nunca aconteceu em instalação alguma — e sem
      // rastro, porque rodada sem efeito não audita (o que é doutrina e está
      // certo: o defeito era não haver efeito, não a ausência de log).
      .eq("provider", PROVEDOR_GOOGLE)
      .eq("status", "healthy")
      .limit(1);

    const conexao = conexoes?.[0];
    if (!conexao?.oauth_access_token_encrypted) {
      // Sem agenda conectada não é falha: é o estado normal de quem não conectou.
      // Marcar `google_synced_at` aqui faria a ida "acontecer" sem ter acontecido,
      // e a linha nunca mais seria candidata quando a pessoa conectasse.
      resumo.semConexao += 1;
      continue;
    }

    const accessToken = await decryptWebhookSecret(admin, conexao.oauth_access_token_encrypted);
    const calendario = conexao.account_email;
    if (!accessToken || !calendario) {
      // Esta saída não deixava rastro NENHUM — nem log, nem coluna. Uma
      // instalação com o token indecifrável somava `falhas` para sempre sem uma
      // pista de onde olhar.
      resumo.falhas += 1;
      motivos.push("credencial_ilegivel");
      logger.warn("[agenda-google-push] token ou calendário ausentes", {
        agendamento: linha.id,
        organizacao: linha.organization_id,
        temToken: Boolean(accessToken),
        temCalendario: Boolean(calendario),
      });
      await admin
        .from("calendar_appointments")
        .update({ google_sync_error: "credencial_ilegivel: token ou calendário ausentes" })
        .eq("id", linha.id);
      continue;
    }

    const cancelado = linha.status === "cancelled";
    const efeito = cancelado
      ? await apagarNoGoogle(accessToken, calendario, linha.id)
      : await publicarNoGoogle(accessToken, calendario, {
          id: linha.id,
          organization_id: linha.organization_id,
          title: linha.title ?? "Agendamento",
          description: linha.description,
          starts_at: linha.starts_at,
          ends_at: linha.ends_at,
          time_zone: linha.time_zone,
          status: linha.status,
          location_kind: linha.location_kind,
          location_details: linha.location_details,
        } as AgendamentoParaGoogle,
        // O ID QUE JÁ TEMOS decide o verbo: sem ele, `publicarNoGoogle` cria com
        // POST; com ele, atualiza com PUT. A linha já trazia a coluna no
        // `select` e ela morria aqui — e era essa a informação que faltava para
        // o worker parar de mandar PUT em evento que nunca existiu.
        linha.google_event_id);

    if (!efeito.ok) {
      resumo.falhas += 1;
      motivos.push(efeito.classificacao.desfecho);
      // NAS DUAS SUPERFÍCIES, e cada uma tem o seu leitor: a coluna é o que a
      // tela do dono pode mostrar; o log é o que quem opera a VPS lê quando os
      // compromissos não chegam ao Google. Só a coluna foi o que escondeu um 404
      // que se repetia a cada 5 minutos.
      logger.warn("[agenda-google-push] publicação recusada pelo Google", {
        agendamento: linha.id,
        organizacao: linha.organization_id,
        desfecho: efeito.classificacao.desfecho,
        detalhe: efeito.detalhe,
        operacao: cancelado ? "apagar" : "publicar",
      });
      await admin
        .from("calendar_appointments")
        .update({ google_sync_error: `${efeito.classificacao.desfecho}: ${efeito.detalhe}` })
        .eq("id", linha.id);
      continue;
    }

    const { error: erroGravar } = await admin
      .from("calendar_appointments")
      .update({
        google_connection_id: conexao.id,
        google_calendar_id: calendario,
        google_event_id: cancelado ? null : efeito.eventoId,
        // `google_sequence` é NOT NULL (default 0) e `apagarNoGoogle` devolve
        // `sequence: null`. Gravar esse null violava a constraint e o UPDATE
        // inteiro falhava SEM ninguém olhar o erro: a linha cancelada ficava na
        // fila e o DELETE saía de novo a cada 5 minutos, para sempre (404 conta
        // como sucesso, então nem erro aparecia). Sem sequência nova, não escreve.
        ...(efeito.sequence === null ? {} : { google_sequence: efeito.sequence }),
        google_synced_at: new Date().toISOString(),
        google_sync_error: null,
      })
      .eq("id", linha.id);

    if (erroGravar) {
      // O Google já respondeu OK, mas o CRM não conseguiu anotar: a linha segue
      // na fila e volta na próxima rodada. Era silêncio total — o laço do DELETE
      // a cada 5 minutos viveu escondido exatamente aqui. Só ids e a mensagem do
      // banco no log: nada do compromisso (o `title` pode ser nome de paciente).
      resumo.falhas += 1;
      motivos.push("gravacao_falhou");
      logger.warn("[agenda-google-push] não gravou o resultado da ida", {
        agendamento: linha.id,
        organizacao: linha.organization_id,
        operacao: cancelado ? "apagar" : "publicar",
        codigo: erroGravar.code,
        erro: erroGravar.message,
      });
      continue;
    }

    if (cancelado) resumo.apagados += 1;
    else resumo.publicados += 1;
  }

  // Auditar SÓ quando houve efeito — a rodada que não fez nada não é mutação.
  if (resumo.publicados > 0 || resumo.apagados > 0 || resumo.falhas > 0) {
    await audit({
      action: "agenda.google.sync_executado",
      organizationId: doTime[0]?.organization_id ?? "",
      // Os MOTIVOS junto da contagem: `{"falhas": 3}` sozinho não distingue
      // "o Google recusou" de "a credencial não decifra", e são consertos
      // opostos. `motivosDistintos` e não a lista inteira, para uma rodada com
      // 500 candidatos não escrever 500 strings iguais no audit.
      metadata: {
        direcao: "ida",
        ...resumo,
        motivosDistintos: [...new Set(motivos)],
      },
    });
  }

  return NextResponse.json({ data: resumo });
}

export async function GET(req: NextRequest): Promise<Response> {
  return executar(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return executar(req);
}
