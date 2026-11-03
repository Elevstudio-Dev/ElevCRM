/**
 * Minimal WAHA REST client used during onboarding (and elsewhere). Returns
 * `null` from `getWahaClient()` when env is not configured so callers can
 * gracefully render a "Docker is not up" banner instead of crashing.
 *
 * WAHA Plus auth: `X-Api-Key` header. The current devlikeapro/waha-plus
 * image expects the SHA512 HEX HASH directly in the header (matches what's
 * stored in container env). Plaintext-then-hash is NOT used in this version.
 * So WAHA_API_KEY in .env.local IS the hex hash.
 */
import { logger } from "@/lib/logger";
import { classificarFalhaDeAlcance, explicarFalhaDeAlcance } from "@/lib/net/alcance";
import { normalizarParticipantes, type ParticipanteCru } from "./participantes";

/**
 * AS CONVERSAS QUE O CRM NÃO ATENDE, E POR ISSO NÃO PRECISA RECEBER.
 *
 * ─── O que isto custava, medido no banco de produção ────────────────────────
 *
 * Todo evento que o WAHA manda é arquivado inteiro em `webhook_events_log`.
 * Separando os eventos de mensagem por origem, em 20/08/2026:
 *
 *   estados / difusão ......... 23.010 eventos ... 271 MB
 *   grupos .................... 17.970 eventos .... 89 MB
 *   canais / newsletter ........ 1.818 eventos .... 16 MB
 *   conversa 1-a-1 ............. 4.739 eventos .... 19 MB   ← o negócio
 *
 * Ou seja: 376 dos 395 MB eram conversa que o CRM RECEBE, GRAVA INTEIRA e
 * DESCARTA. `handleInbound` já ignora tudo que não é 1-a-1 — o dinheiro era
 * gasto antes da decisão, no transporte e no arquivo.
 *
 * ─── Por que no WAHA e não num `if` nosso ───────────────────────────────────
 *
 * A doc dele é explícita: `ignore` impede "event processing AND database
 * storage" — ou seja, ele nem processa nem guarda. Um filtro do nosso lado
 * chegaria tarde: a mensagem já teria atravessado a rede, ocupado CPU do
 * contêiner e entrado no banco DELE. Cortar na fonte é a única versão que
 * economiza as três coisas.
 *
 * ─── Grupos SAÍRAM da lista em 2026-09-05 ───────────────────────────────────
 *
 * Esta linha dizia "quem um dia quiser grupos inverte a chave". O dia chegou:
 * a migration 0210 deu identidade própria ao grupo (índice
 * `uniq_contacts_org_wa_group` + `fn_upsert_wa_group_contact`) e
 * `handleInbound` passou a vinculá-lo, então o WAHA precisa voltar a ENTREGAR
 * o evento — `ignore` impede processamento E armazenamento, então enquanto
 * `groups: true` estivesse aqui nenhum `if` nosso adiantaria.
 *
 * O custo volta junto: grupo movimentado gera evento, e evento custa
 * transporte e banco do contêiner. É o preço de ver o grupo na tela, e foi uma
 * decisão do dono.
 *
 * A IA segue calada em grupo por PADRÃO — `lib/ai/dispatcher/triggers.ts:86`,
 * `ignore_groups` que só é `false` se alguém desmarcar na tela do agente. Isso
 * não mudou aqui e não deve mudar por acidente.
 */
export const CONVERSAS_IGNORADAS = {
  /** Os "estados" que os contatos publicam. Sozinhos eram 69% do arquivo. */
  status: true,
  /** Listas de difusão. */
  broadcast: true,
  /** Canais / newsletters. */
  channels: true,
  /** Ver o parágrafo acima: o CRM passou a vinculá-los (0210). */
  groups: false,
} as const;

/**
 * Teto de relógio das chamadas ao WAHA.
 *
 * 15s não é número escolhido aqui: é o que `docs/specs/03-spec-whatsapp-waha.md`
 * já prescrevia na linha 636 (`timeoutMs: cfg?.timeoutMs ?? 15_000`). Duas
 * réguas para a mesma grandeza divergem na primeira mudança.
 *
 * O WAHA é dependência externa e cai. O modo de falha caro não é a recusa
 * imediata — essa devolve `ECONNREFUSED` na hora — é o socket que ACEITA e não
 * responde: sem teto, a Server Action ou a rota fica presa até o limite do
 * runtime. (issue #470)
 */
export const TETO_PADRAO_MS = 15_000;

/**
 * Mídia tem teto MAIOR, e por um motivo medível: `lib/waha/media-send.ts:28,31`
 * manda `convert: true` em `sendVideo` e `sendVoice`. O WAHA roda ffmpeg e BAIXA
 * a URL do Storage antes de responder.
 *
 * Um teto único calibrado para `sendText` cortaria envio de áudio legítimo — o
 * conserto do timeout viraria um defeito novo, e mais difícil de ver que o
 * original, porque a mensagem simplesmente não sai.
 *
 * 30s é o mesmo teto que a mídia de ENTRADA já usa
 * (`lib/messaging/media/waha-source.ts:18`).
 */
export const TETO_DE_MIDIA_MS = 30_000;

export interface WahaClientOpts {
  /** Sobrescreve o teto padrão. Existe para o teste; produção usa o default. */
  tetoMs?: number;
}

export class WahaClient {
  private readonly tetoMs: number;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    opts: WahaClientOpts = {},
  ) {
    this.tetoMs = opts.tetoMs ?? TETO_PADRAO_MS;
  }

  /**
   * `fetch` com teto, e com erro que DIZ que foi o relógio.
   *
   * Sem a segunda parte, um estouro de teto chega ao log como um erro de rede
   * genérico e o diagnóstico começa procurando defeito de contrato — que é o
   * caminho mais caro possível para "a dependência externa não respondeu".
   */
  private async fetchComTeto(
    url: string | URL,
    init: RequestInit,
    tetoMs?: number,
  ): Promise<Response> {
    const teto = tetoMs ?? this.tetoMs;
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(teto) });
    } catch (e) {
      const nome = e instanceof Error ? e.name : "";
      if (nome === "TimeoutError" || nome === "AbortError") {
        throw new Error(`waha_timeout: o WAHA não respondeu em ${teto}ms (${url})`);
      }
      throw e;
    }
  }

  /**
   * Idempotent: ensures session exists, then starts it.
   * WAHA Plus split the API:
   *   POST /api/sessions               → create (422 if exists)
   *   POST /api/sessions/{name}/start  → start (422 if already starting/working)
   */
  async startSession(name: string): Promise<{ qr?: string; status: string }> {
    // 1) Create session (ignore 422/409 = already exists)
    const createRes = await this.fetchComTeto(`${this.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "X-Api-Key": this.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ name, config: { ignore: CONVERSAS_IGNORADAS } }),
    });
    if (!createRes.ok && createRes.status !== 422 && createRes.status !== 409) {
      const body = await createRes.text().catch(() => "");
      throw new Error(`waha_create_${createRes.status}: ${body.slice(0, 200)}`);
    }

    // Sessão que JÁ existe devolve 422 e não recebe a config da criação — foi
    // assim que a sessão em produção ficou sem o filtro. Convergir aqui faz
    // toda reconexão corrigir o estado, em vez de deixar o ajuste dependendo de
    // alguém lembrar de apagar e recriar a sessão.
    if (createRes.status === 422 || createRes.status === 409) {
      await this.convergirConfigDaSessao(name);
    }

    // 2) Start session
    const startRes = await this.fetchComTeto(
      `${this.baseUrl}/api/sessions/${encodeURIComponent(name)}/start`,
      {
        method: "POST",
        headers: { "X-Api-Key": this.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    if (!startRes.ok && startRes.status !== 422 && startRes.status !== 409) {
      const body = await startRes.text().catch(() => "");
      throw new Error(`waha_start_${startRes.status}: ${body.slice(0, 200)}`);
    }
    if (startRes.status === 422 || startRes.status === 409) {
      // Already started — fetch and return current state
      return this.getSessionQr(name);
    }
    return (await startRes.json()) as { qr?: string; status: string };
  }

  /**
   * Stop a session. Idempotent: 404 (unknown) / 422 / 409 (already stopped)
   * are treated as success so callers can compose reconnect = stop + start.
   */
  async stopSession(name: string): Promise<void> {
    const res = await this.fetchComTeto(
      `${this.baseUrl}/api/sessions/${encodeURIComponent(name)}/stop`,
      {
        method: "POST",
        headers: { "X-Api-Key": this.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    if (!res.ok && ![404, 422, 409].includes(res.status)) {
      const body = await res.text().catch(() => "");
      throw new Error(`waha_stop_${res.status}: ${body.slice(0, 200)}`);
    }
  }

  /**
   * Logout: descarta as CREDENCIAIS pareadas da sessão (o conteúdo de
   * `/app/.sessions`), mantendo a sessão registrada no WAHA.
   *
   * É o passo que falta para reconectar um número desvinculado pelo celular:
   * `stop + start` sozinho reaproveita as credenciais em disco; se o WhatsApp já
   * as revogou, o engine tenta reconectar com credencial morta e cai direto em
   * FAILED — sem NUNCA passar por SCAN_QR_CODE, então a UI fica esperando um QR
   * que nunca vem. Com logout antes do start, o pareamento recomeça do zero.
   *
   * Idempotente: 404 (sessão desconhecida) / 422 / 409 (já deslogada) contam
   * como sucesso — quem chama quer o efeito, não a transição.
   */
  async logoutSession(name: string): Promise<void> {
    const res = await this.fetchComTeto(
      `${this.baseUrl}/api/sessions/${encodeURIComponent(name)}/logout`,
      {
        method: "POST",
        headers: { "X-Api-Key": this.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    if (!res.ok && ![404, 422, 409].includes(res.status)) {
      const body = await res.text().catch(() => "");
      throw new Error(`waha_logout_${res.status}: ${body.slice(0, 200)}`);
    }
  }

  /**
   * Põe a config de uma sessão que já existe no estado que queremos.
   *
   * ─── LÊ ANTES DE ESCREVER, e isto não é preciosismo ────────────────────────
   *
   * A doc do WAHA é literal: o PUT "updates a session with a FULL new
   * configuration". Mandar `{config: {ignore}}` sozinho não acrescenta o filtro
   * — SUBSTITUI a config inteira, e leva junto o bloco `webhooks`. O resultado
   * seria uma sessão de pé, conectada, sem entregar mensagem nenhuma ao CRM:
   * a pior forma de falhar, porque nada fica vermelho.
   *
   * Por isso o GET vem primeiro e o `ignore` é ENXERTADO no que já existe. Se o
   * GET não responder, não há PUT: sem saber o que há lá, escrever é apostar o
   * canal inteiro numa economia de bytes.
   *
   * ─── E ele REINICIA a sessão ───────────────────────────────────────────────
   *
   * "If the session is not in a STOPPED status, it will be stopped and started
   * with the new configuration." Sem QR novo — as credenciais moram em disco —
   * mas é uma janela de segundos sem canal. Aceitável aqui porque este caminho
   * só roda dentro de `startSession`, que já é o momento em que a sessão está
   * sendo (re)iniciada de propósito.
   *
   * NÃO lança: é melhoria de custo, não condição de envio. Uma versão do WAHA
   * que não conheça a rota faria toda reconexão falhar por causa de uma
   * economia — trocar mensagem por byte é o negócio errado.
   */
  async convergirConfigDaSessao(name: string): Promise<void> {
    const url = `${this.baseUrl}/api/sessions/${encodeURIComponent(name)}`;
    try {
      const atual = await this.fetchComTeto(url, { headers: { "X-Api-Key": this.apiKey } });
      if (!atual.ok) {
        logger.warn("[waha] não li a config da sessão; não vou reescrevê-la", {
          status: atual.status,
        });
        return;
      }
      const sessao = (await atual.json().catch(() => null)) as {
        config?: Record<string, unknown>;
      } | null;
      // Sem corpo reconhecível, o mesmo raciocínio: não escrever é o seguro.
      if (!sessao || typeof sessao.config !== "object" || sessao.config === null) {
        logger.warn("[waha] a sessão respondeu sem config; não vou reescrevê-la", {});
        return;
      }

      const config = { ...sessao.config, ignore: CONVERSAS_IGNORADAS };
      // Já está como queremos: não reiniciar a sessão à toa. Este caminho roda
      // em TODA reconexão, e um restart desnecessário por rodada seria pior que
      // o gasto que ele evita.
      // Comparação chave a chave, não `JSON.stringify`: `stringify` é sensível
      // à ORDEM das chaves, então o dia em que o WAHA devolver o mesmo objeto
      // com as chaves noutra sequência, esta guarda passa a dizer "mudou" e a
      // sessão reinicia a cada reconexão — sem que nada tenha mudado.
      const jaConvergida =
        typeof sessao.config.ignore === "object" &&
        sessao.config.ignore !== null &&
        Object.entries(CONVERSAS_IGNORADAS).every(
          ([k, v]) => (sessao.config!.ignore as Record<string, unknown>)[k] === v,
        );
      if (jaConvergida) return;

      const res = await this.fetchComTeto(url, {
        method: "PUT",
        headers: { "X-Api-Key": this.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ name, config }),
      });
      if (!res.ok) {
        logger.warn("[waha] não consegui convergir a config da sessão", { status: res.status });
      }
    } catch (err) {
      // Rede fora aqui não é assunto de quem só quer iniciar a sessão — a
      // convergência é oportunista e a sessão sobe do mesmo jeito. Mas os
      // outros dois caminhos de falha deste mesmo bloco logam, e sem esta
      // linha a única falha INVISÍVEL seria justamente a que faz a economia
      // não acontecer: a config fica velha e ninguém fica sabendo.
      logger.warn("[waha] não consegui falar com o WAHA para convergir a config", {
        erro: err instanceof Error ? err.message : "unknown",
      });
    }
  }

  /**
   * Remove a sessão do WAHA por completo (registro + credenciais em disco).
   * Idempotente pelo mesmo motivo do logout: 404 = já não existe = sucesso.
   */
  async deleteSession(name: string): Promise<void> {
    const res = await this.fetchComTeto(
      `${this.baseUrl}/api/sessions/${encodeURIComponent(name)}`,
      {
        method: "DELETE",
        headers: { "X-Api-Key": this.apiKey, "Content-Type": "application/json" },
      },
    );
    if (!res.ok && ![404, 422, 409].includes(res.status)) {
      const body = await res.text().catch(() => "");
      throw new Error(`waha_delete_${res.status}: ${body.slice(0, 200)}`);
    }
  }

  async getSessionQr(name: string): Promise<{ qr?: string; status: string }> {
    const res = await this.fetchComTeto(`${this.baseUrl}/api/sessions/${encodeURIComponent(name)}`, {
      headers: { "X-Api-Key": this.apiKey },
    });
    if (!res.ok) throw new Error(`waha_${res.status}`);
    return (await res.json()) as { qr?: string; status: string };
  }

  /**
   * URL da foto de perfil do contato, ou null.
   *
   * NÃO lança quando falha: contato sem foto, com privacidade fechada ou
   * simplesmente desconhecido é o caso COMUM, não erro. Quem chama é um cron de
   * varredura — transformar isso em exceção encheria o log de ruído sobre o
   * estado normal da maioria dos contatos.
   *
   * A URL vem assinada pelo CDN do WhatsApp e expira (~9 dias, medido em
   * instalação real). Quem chama baixa e persiste; guardar a URL faz a foto
   * sumir sozinha depois.
   */
  async getProfilePictureUrl(session: string, chatId: string): Promise<string | null> {
    try {
      const res = await this.fetchComTeto(
        `${this.baseUrl}/api/contacts/profile-picture` +
          `?session=${encodeURIComponent(session)}&contactId=${encodeURIComponent(chatId)}`,
        { headers: { "X-Api-Key": this.apiKey } },
      );
      if (!res.ok) return null;
      const body = (await res.json()) as { profilePictureURL?: string | null };
      return body.profilePictureURL ?? null;
    } catch {
      return null;
    }
  }

  /**
   * O telefone por trás de um id opaco (`<lid>@lid`), quando o canal souber.
   *
   * ─── Por que isto não é sempre possível ─────────────────────────────────
   *
   * O WhatsApp passou a identificar quem escreve por um id opaco em vez do
   * número. O canal mantém uma tabela de tradução, mas ela só existe com o
   * STORE habilitado na sessão (`noweb.store.enabled`) — sem isso, todo pedido
   * volta 400 dizendo exatamente isso, medido numa instalação real.
   *
   * E mesmo com o store ligado a tabela é POVOADA POR ATIVIDADE: ela nasce
   * vazia e enche conforme as conversas acontecem. `null` aqui significa "ainda
   * não sei", não "não existe" — quem chama precisa poder tentar de novo depois
   * sem tratar isto como erro.
   */
  async resolvePhoneForLid(session: string, lid: string): Promise<string | null> {
    try {
      const res = await this.fetchComTeto(
        `${this.baseUrl}/api/${encodeURIComponent(session)}/lids/${encodeURIComponent(lid)}`,
        { headers: { "X-Api-Key": this.apiKey } },
      );
      if (!res.ok) return null;
      const body = (await res.json()) as { pn?: string | null };
      // `595981402525@c.us` → `+595981402525`. O sufixo é endereçamento do
      // canal, não parte do número, e guardá-lo faria a tela mostrar lixo.
      const pn = body.pn;
      if (!pn) return null;
      const digitos = String(pn).split("@")[0]?.replace(/\D/g, "") ?? "";
      return digitos.length >= 8 ? `+${digitos}` : null;
    } catch {
      return null;
    }
  }

  /**
   * `replyTo` = citar uma mensagem, como o "responder em cima" do WhatsApp.
   *
   * ─── O defeito que isto conserta ──────────────────────────────────────────
   *
   * A citação já existia de ponta a ponta MENOS aqui: a tela deixava escolher a
   * mensagem, o handler resolvia o `external_id` da citada e gravava
   * `reply_to_message_id`, e a bolha aparecia pendurada — no CRM. No WhatsApp do
   * cliente chegava mensagem solta. Ou seja, a tela prometia uma coisa e o
   * aparelho do outro lado mostrava outra, sem nada ficar vermelho.
   *
   * ─── O formato do id, que é onde isto falha em silêncio ───────────────────
   *
   * O `reply_to` do WAHA quer o id COMPLETO (`{fromMe}_{chatId}_{bareId}`), não
   * o cru. E o WAHA é assimétrico: a resposta de envio devolve o cru (`3EB0…`) e
   * o webhook entrega o completo — ver `bareWaMessageId`.
   *
   * Medido numa instalação real: as 1.734 mensagens de ENTRADA têm o id
   * completo, que é o formato certo. E citar o que o cliente disse é o caso que
   * importa — quem responde "em cima" está respondendo a ele.
   *
   * Por isso o id vai como está, sem reconstrução: inventar o prefixo a partir
   * da direção acertaria o caso que já funciona e chutaria no resto.
   */
  async sendMessage(
    session: string,
    chatId: string,
    text: string,
    replyTo?: string | null,
    mentions?: ReadonlyArray<string> | null,
  ): Promise<unknown> {
    const res = await this.fetchComTeto(`${this.baseUrl}/api/sendText`, {
      method: "POST",
      headers: {
        "X-Api-Key": this.apiKey,
        "Content-Type": "application/json",
      },
      // Só entra quando existe: mandar `reply_to: null` é pedir para citar
      // "nada", e a API não tem por que ser gentil com isso.
      //
      // `mentions` é a marcação num grupo. Pela documentação do WAHA, o texto TEM de trazer o
      // número (`@5511999990001`) E o mesmo número entra aqui como `5511999990001@c.us` — um sem o
      // outro não marca ninguém. `["all"]` marca o grupo inteiro. Quem monta o texto é
      // `prepararMencoesDeGrupo`; este método só repassa.
      body: JSON.stringify({
        session,
        chatId,
        text,
        ...(replyTo ? { reply_to: replyTo } : {}),
        ...(mentions && mentions.length > 0 ? { mentions } : {}),
      }),
    });
    if (!res.ok) throw new Error(`waha_${res.status}`);
    return res.json();
  }

  /**
   * Confere se o número existe no WhatsApp e devolve o chatId canônico.
   * Obrigatório antes de vcard em BR — o nono dígito do CRM nem sempre bate com o wa_id.
   */
  async checkContactExists(
    session: string,
    phoneDigits: string,
  ): Promise<{ numberExists: boolean; chatId?: string | null; pn?: string | null }> {
    const url = new URL(`${this.baseUrl}/api/contacts/check-exists`);
    url.searchParams.set("session", session);
    url.searchParams.set("phone", phoneDigits.replace(/\D/g, ""));
    const res = await this.fetchComTeto(url, {
      headers: { "X-Api-Key": this.apiKey, Accept: "application/json" },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`waha_${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json() as Promise<{ numberExists: boolean; chatId?: string | null; pn?: string | null }>;
  }

  /**
   * Os grupos que a conta JÁ participa — a lista que o aparelho tem.
   *
   * Existe porque a ingestão sozinha só faz aparecer o grupo em que ALGUÉM
   * escreveu depois que ligamos a chave. Um grupo parado há uma semana ficaria
   * invisível, e "cadê os meus grupos?" é a primeira coisa que quem liga isso
   * pergunta.
   *
   * A forma do `id` varia entre as engines do WAHA (NOWEB devolve string,
   * WEBJS devolve `{_serialized}`), e o nome vem ora em `subject`, ora em
   * `name`. Normalizar aqui, e não em cada chamador, é o que impede a diferença
   * de engine de virar bug de tela.
   */
  async listGroups(session: string): Promise<Array<{ chatId: string; subject: string | null }>> {
    // A CONFIG DA SESSAO CONVERGE ANTES DE LISTAR — e não é detalhe.
    //
    // `ignore.groups` foi para `false` no codigo, mas `convergirConfigDaSessao`
    // só roda dentro de `startSession`. Uma sessão que já estava no ar mantém a
    // config ANTIGA para sempre: os grupos aparecem na importação e nenhuma
    // mensagem nova deles chega depois — meia funcionalidade, e a metade que
    // falta é silenciosa. MEDIDO na instalação do dono: sessão WORKING com
    // `ignore.groups=true` depois do deploy.
    //
    // Pedir a lista de grupos É dizer "quero grupos", então este é o momento
    // certo de garantir o transporte. Converge uma vez; nas seguintes a própria
    // função percebe que já está como queremos e não reinicia nada.
    await this.convergirConfigDaSessao(session);

    const url = new URL(`${this.baseUrl}/api/${encodeURIComponent(session)}/groups`);
    const res = await this.fetchComTeto(url, {
      headers: { "X-Api-Key": this.apiKey, Accept: "application/json" },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`waha_${res.status}: ${body.slice(0, 200)}`);
    }
    const cru: unknown = await res.json();

    // ⚠️ MAPA, NÃO ARRAY — e a primeira versão disto estava errada.
    //
    // Eu escrevi `if (!Array.isArray(cru)) return []` a partir da documentação,
    // sem exercitar contra o WAHA real. MEDIDO depois, no engine NOWEB:
    //
    //   { "120363401969475450@g.us": { id, subject, participants, ... }, ... }
    //
    // Um objeto indexado pelo chatId. O `return []` devolvia zero grupo com
    // HTTP 200 — o pior desfecho possível: sem erro, sem log, e a tela dizendo
    // que importou. Aceitar as DUAS formas porque o array é o que a doc mostra
    // e outro engine pode entregar assim; o que não se aceita mais é presumir.
    const itens: unknown[] = Array.isArray(cru)
      ? cru
      : cru && typeof cru === "object"
        ? Object.values(cru as Record<string, unknown>)
        : [];

    const saida: Array<{ chatId: string; subject: string | null }> = [];
    for (const item of itens) {
      if (!item || typeof item !== "object") continue;
      const g = item as { id?: unknown; subject?: unknown; name?: unknown };
      const id =
        typeof g.id === "string"
          ? g.id
          : g.id && typeof g.id === "object" && typeof (g.id as { _serialized?: unknown })._serialized === "string"
            ? (g.id as { _serialized: string })._serialized
            : null;
      // Sem `@g.us` não é grupo — e deixar passar aqui criaria um contato-grupo
      // com identidade de outra coisa, que o índice único não desfaz depois.
      if (!id || !id.endsWith("@g.us")) continue;
      const nome =
        typeof g.subject === "string" && g.subject.trim()
          ? g.subject.trim()
          : typeof g.name === "string" && g.name.trim()
            ? g.name.trim()
            : null;
      saida.push({ chatId: id, subject: nome });
    }
    return saida;
  }

  /**
   * O assunto (o NOME) de UM grupo — para o grupo que chegou por mensagem se batizar sozinho, sem
   * esperar alguém apertar "Importar grupos" (ver `lib/waha/nome-do-grupo.ts`).
   *
   * `null` quando o canal não diz o nome — e é um desfecho NORMAL, não erro: grupo recém-criado, store
   * ainda sem o dado. Quem chama não trata como falha, só tenta de novo mais tarde.
   *
   * Erro de transporte (HTTP ≠ 2xx, timeout) LANÇA, ao contrário do `null` acima, porque "não deu para
   * perguntar" e "perguntei e não há nome" pedem esperas diferentes — e quem chama mede as duas.
   *
   * O nome vem ora em `subject`, ora em `name` (o engine decide; `listGroups` documenta a mesma
   * diferença), e a resposta pode trazer o grupo embrulhado em `{ id: ... }`.
   */
  async getGroupSubject(session: string, chatId: string): Promise<string | null> {
    const url = `${this.baseUrl}/api/${encodeURIComponent(session)}/groups/${encodeURIComponent(chatId)}`;
    const res = await this.fetchComTeto(url, {
      headers: { "X-Api-Key": this.apiKey, Accept: "application/json" },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`waha_${res.status}: ${body.slice(0, 200)}`);
    }
    const cru: unknown = await res.json().catch(() => null);
    if (!cru || typeof cru !== "object") return null;
    const g = cru as { subject?: unknown; name?: unknown };
    for (const candidato of [g.subject, g.name]) {
      if (typeof candidato === "string" && candidato.trim()) return candidato.trim();
    }
    return null;
  }

  /**
   * Quem está num grupo. Tenta a forma que a documentação recomenda (`participants/v2`, igual entre
   * os engines) e, se a versão instalada não a tem, lê os participantes do objeto do grupo — que
   * `listGroups` já mostrou existir. Erro do WAHA propaga: quem chama decide o que fazer sem a lista.
   */
  async getGroupParticipants(session: string, groupId: string): Promise<ParticipanteCru[]> {
    const base = `${this.baseUrl}/api/${encodeURIComponent(session)}/groups/${encodeURIComponent(groupId)}`;
    const cabecalhos = { "X-Api-Key": this.apiKey, Accept: "application/json" };

    const v2 = await this.fetchComTeto(new URL(`${base}/participants/v2`), { headers: cabecalhos });
    if (v2.ok) return normalizarParticipantes(await v2.json());

    const grupo = await this.fetchComTeto(new URL(base), { headers: cabecalhos });
    if (!grupo.ok) {
      const corpo = await grupo.text().catch(() => "");
      throw new Error(`waha_${grupo.status}: ${corpo.slice(0, 200)}`);
    }
    const cru: unknown = await grupo.json();
    const participantes =
      cru && typeof cru === "object" ? (cru as { participants?: unknown }).participants : null;
    return normalizarParticipantes(participantes);
  }

  async sendContactVcard(
    session: string,
    chatId: string,
    contacts: Array<{
      fullName: string;
      phoneNumber: string;
      whatsappId: string;
      vcard: string;
    }>,
  ): Promise<unknown> {
    const res = await this.fetchComTeto(`${this.baseUrl}/api/sendContactVcard`, {
      method: "POST",
      headers: {
        "X-Api-Key": this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ session, chatId, contacts }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`waha_${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json();
  }

  async sendMedia(
    session: string,
    chatId: string,
    plan: { endpoint: string; payload: Record<string, unknown> },
  ): Promise<unknown> {
    // Teto MAIOR aqui: `media-send.ts` manda `convert: true` em vídeo e áudio, e
    // o WAHA roda ffmpeg e baixa a URL do Storage antes de responder. Com o teto
    // de texto, o envio de áudio legítimo seria cortado — o conserto do timeout
    // viraria um defeito novo, e mais silencioso que o original.
    const res = await this.fetchComTeto(`${this.baseUrl}/api/${plan.endpoint}`, {
      method: "POST",
      headers: { "X-Api-Key": this.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ session, chatId, ...plan.payload }),
    }, TETO_DE_MIDIA_MS);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`waha_${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json();
  }
}

/**
 * Traduz erros crus do WAHA numa mensagem que aponta ONDE mexer.
 *
 * A versão anterior mandava TODA falha de rede para a mesma frase — "confirme
 * que o container está no ar" —, inclusive `ENOTFOUND`, que significa o oposto:
 * o endereço configurado não existe, então não há container nenhum a conferir.
 * Em produção isso mandou o dono reiniciar durante semanas um container que
 * nunca havia caído. Reiniciar o que está de pé não conserta um endereço errado,
 * e a frase errada é pior que nenhuma: ela encerra a investigação.
 *
 * Aceita o erro CRU, e não só a mensagem, porque o código real (`ENOTFOUND`,
 * `ECONNREFUSED`) vive na cadeia de `cause` — `err.message` sozinho é sempre
 * "fetch failed". Continua aceitando string para os pontos que já achataram o
 * erro; lá a classificação cai no texto e degrada para "indeterminada", que é a
 * verdade disponível.
 */
export function wahaFriendlyError(erro: unknown): string {
  const falha = classificarFalhaDeAlcance(erro);
  if (falha !== "indeterminada") {
    return explicarFalhaDeAlcance(falha, "o WhatsApp (WAHA)");
  }
  const msg = erro instanceof Error ? erro.message : String(erro ?? "unknown");
  return `Falha na comunicação com o WhatsApp (WAHA): ${msg}`;
}

/**
 * Returns a configured client or null. Null means the WAHA Docker isn't up
 * or the env is using the dev placeholder; the UI must render a banner
 * prompting the user to start it.
 */
export function getWahaClient(): WahaClient | null {
  const url = process.env.WAHA_API_BASE_URL;
  const key = process.env.WAHA_API_KEY;
  if (!url || !key || key === "dev_plaintext_change_me") return null;
  return new WahaClient(url, key);
}
