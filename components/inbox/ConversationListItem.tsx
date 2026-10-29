"use client";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";

import type { Locale } from "date-fns";
import { formatDistanceToNowStrict } from "date-fns";
import { useT } from "@/hooks/i18n/useT";
import { Check, Checks, Clock, Phone, Robot, Warning } from "@/lib/ui/icons";
import { AvatarDoContato } from "@/components/contacts/AvatarDoContato";
import { Badge } from "@/components/ui/badge";
import { OwnerBadge } from "@/components/kanban/OwnerBadge";
import { ChipDeSetor } from "@/components/setores/ChipDeSetor";
import { SeloForaDoFunil } from "@/components/contacts/SeloForaDoFunil";
import { ICONE_DA_MIDIA } from "@/components/inbox/CitacaoResumo";
import { comandoDaConversa } from "@/lib/inbox/comando-da-conversa";
import { horaDaLinha, previaDaLinha, type Tique, tiqueDaUltima } from "@/lib/inbox/linha-da-conversa";
import { type Faixa, PISO_MINUTOS, tempoSemResposta } from "@/lib/inbox/tempo-sem-resposta";
import { CLASSE_DE_COR } from "@/lib/marcadores/cores";
import { COR_DE_MARCADOR_PADRAO, type CorDeMarcador } from "@/lib/schemas/settings";
import { cn } from "@/lib/utils";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { phoneForDisplay } from "@/lib/channels/phone-variants";

interface Props {
  conversation: ConversationWithContact;
  isSelected: boolean;
  onSelect: (id: string) => void;
  /** Posição 1-based na fila (G5-03). Presente só na visão Fila. */
  queuePosition?: number;
  /**
   * Mostrar POR ONDE a conversa entrou.
   *
   * Só com mais de um número conectado. Com um só, o rótulo seria a mesma
   * palavra em toda linha da lista — ruído que ensina o olho a ignorar a área
   * onde vivem os avisos que importam (bloqueado, tags).
   */
  mostrarCanal?: boolean;
  /**
   * Mostrar QUEM está no comando de cada conversa.
   *
   * Mesma regra do canal, e pelo mesmo motivo: só quando o rótulo DISCRIMINA. Nas
   * abas "Fila" (todas sem dono), "Minhas" (todas do mesmo dono) e "IA" o badge
   * seria a mesma palavra em toda linha — ruído que ensina o olho a ignorar a
   * área onde vivem os avisos que importam. Quem decide é a lista, que é quem
   * sabe quantos donos distintos ela tem.
   */
  mostrarAtendente?: boolean;
  /**
   * A org tem atendimento automático de pé? Vem por PROP e não por hook: um hook
   * por linha faria 50 assinaturas de query na mesma lista para responder a MESMA
   * pergunta org-wide. `undefined` = "não sei", e a função trata isso como "não
   * afirme nada".
   */
  automaticoDaOrg?: boolean;
  /**
   * Em quantos minutos a primeira resposta vira alarme nesta organização. Vem por PROP, pela mesma
   * razão do `automaticoDaOrg`: uma leitura de configuração por linha seria 50 assinaturas para
   * responder a MESMA pergunta org-wide. Ausente = o piso.
   */
  limiteMinutos?: number;
  /**
   * A cor de cada marcador da empresa, pelo NOME. Vem por PROP pela mesma razão do
   * `automaticoDaOrg`: o vocabulário é da organização, e uma leitura por linha seriam 50
   * assinaturas para a mesma pergunta. Marcador fora do mapa (nasceu digitado, ou o vocabulário
   * ainda não chegou) cai no cinza — o mesmo que o editor de tags da conversa faz.
   */
  coresDasTags?: ReadonlyMap<string, CorDeMarcador>;
}

/**
 * Os tiques da nossa última mensagem. O ícone sozinho não diz nada a quem usa leitor de tela, então
 * cada um carrega o nome do estado — e a cor nunca vai sozinha: ✓✓ azul é "lida", ✓✓ cinza é
 * "entregue", e o formato (um ou dois) já separa "enviada" das duas.
 */
const TIQUES: Record<Tique, { icone: typeof Check; rotulo: string; classe: string }> = {
  relogio: { icone: Clock, rotulo: "Na fila para enviar", classe: "text-muted-foreground" },
  enviada: { icone: Check, rotulo: "Enviada", classe: "text-muted-foreground" },
  entregue: { icone: Checks, rotulo: "Entregue", classe: "text-muted-foreground" },
  lida: { icone: Checks, rotulo: "Lida", classe: "text-info" },
  falhou: { icone: Warning, rotulo: "Falhou ao enviar", classe: "text-error-fg" },
};

/**
 * A cor de "há quanto tempo esse cliente espera", pela MESMA regra de faixas do cabeçalho da conversa
 * (`lib/inbox/tempo-sem-resposta`): a lista e o cabeçalho têm de dizer a mesma coisa sobre a mesma
 * conversa. Verde-neutro até um terço do limite, âmbar até o limite, vermelho depois. A cor nunca vai
 * sozinha: o relógio e o texto "Aguardando há …" continuam ao lado.
 */
const CLASSE_DA_ESPERA: Record<Faixa, string> = {
  ok: "text-muted-foreground",
  atencao: "font-medium text-warning-fg",
  estourado: "font-medium text-error-fg",
};

/**
 * A COR SAI DE QUEM MANDA, NÃO DO STATUS.
 *
 * O mapa anterior era por `conversations.status`, e o `bg-purple-500` de
 * `ai_handling` era a mesma mentira das abas em forma de cor: `ai_handling` é
 * escrito por UM caminho só em produção, então a bolinha do automático quase
 * nunca aparecia — enquanto o robô atendia a maior parte da lista — e, quando
 * aparecia, sobrevivia ao silêncio, porque o status não muda quando o atendente
 * cala o automático.
 *
 * As chaves são as de `Comando["quem"]`, ao lado de `ROTULO_DO_COMANDO`, pela
 * mesma razão que ele mora ali: a cor e a palavra dizem a mesma coisa e não
 * podem ser mantidas em arquivos diferentes.
 */
const COR_DO_COMANDO: Record<string, string> = {
  humano: "bg-blue-500",
  automatico: "bg-purple-500",
  aguardando: "bg-amber-500",
  ninguem: "bg-muted-foreground/60",
  encerrada: "bg-muted-foreground/30",
};


/** "Aguardando há 5 min" — desde a última mensagem do cliente (fallback: criação). */
function waitingLabel(
  conversation: ConversationWithContact,
  t: (texto: string) => string = (texto) => texto, locale: Locale,
): string {
  const since = conversation.last_inbound_at ?? conversation.created_at;
  if (!since) return t("Aguardando");
  return `${t("Aguardando")} ${formatDistanceToNowStrict(new Date(since), { addSuffix: true, locale: locale })}`;
}

export function ConversationListItem({
  conversation,
  isSelected,
  onSelect,
  queuePosition,
  mostrarCanal,
  mostrarAtendente,
  automaticoDaOrg,
  limiteMinutos,
  coresDasTags,
}: Props) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  const c = conversation.contacts ?? null;
  const displayName = rotuloDoContato(c);
  const phoneFallback = c?.phone_number ? phoneForDisplay(c.phone_number) : "??";
  const tags = c?.tags ?? [];
  const visibleTags = tags.slice(0, 2);
  const overflow = tags.length - visibleTags.length;
  const unread = conversation.unread_count_for_assignee ?? 0;

  // A linha do WhatsApp: hora no formato dele, quem falou por último, o tipo da mensagem e o
  // tique. As regras moram em `lib/inbox/linha-da-conversa` (testadas sem montar tela).
  const hora = horaDaLinha(conversation.last_message_at, new Date(), localeDaData, t("Ontem"));
  const previa = previaDaLinha({
    type: conversation.last_message_type,
    preview: conversation.last_message_preview,
    direction: conversation.last_message_direction,
  });
  const tique = tiqueDaUltima(conversation.last_message_direction, conversation.last_message_status);
  const IconeDaMidia = previa.icone ? ICONE_DA_MIDIA[previa.icone] : null;
  const TiqueIcone = tique ? TIQUES[tique].icone : null;
  // "Você:" cobre o que o tique não diz: em grupo (onde dizer QUEM falou importa) e quando o
  // status é desconhecido (conversa antiga, sem tique). Com o tique à vista ele já diz "é nossa" —
  // repetir viraria ruído, e o WhatsApp também não repete.
  const mostrarVoce = previa.voce && (conversation.is_group || tique === null);


  /**
   * Quem manda, pela MESMA regra do cabeçalho.
   *
   * `status === 'ai_handling'` era um proxy ruim e foi medido: o único escritor
   * desse status em produção é o botão "Devolver ao automático", então o ícone de
   * robô aparecia só em conversa que já tinha sido escalada E devolvida — nunca
   * na que o automático atendeu do começo ao fim, que é a maioria.
   */
  const { comando } = comandoDaConversa({
    status: conversation.status,
    assigned_to_user_id: conversation.assigned_to_user_id,
    assigned_to_user_name: conversation.assigned_to_user_name ?? null,
    assignee_kind: conversation.assignee_kind ?? null,
    bot_silenced_until: conversation.bot_silenced_until ?? null,
    force_human: c?.force_human ?? null,
    is_blocked: c?.is_blocked ?? null,
    fora_do_funil_em: c?.fora_do_funil_em ?? null,
    automaticoDaOrg,
  });
  const isAi = comando.quem === "automatico";
  // A espera só é contada na visão Fila (é onde "Aguardando há …" aparece), mas a regra é a mesma
  // do cabeçalho: nula quando a conversa está encerrada ou quando o atendente já respondeu.
  const espera =
    queuePosition === undefined
      ? null
      : tempoSemResposta({
          lastInboundAt: conversation.last_inbound_at ?? null,
          lastOutboundAt: conversation.last_outbound_at ?? null,
          status: conversation.status,
          agora: new Date(),
          limiteMinutos: limiteMinutos ?? PISO_MINUTOS,
        });
  const dot = COR_DO_COMANDO[comando.quem] ?? COR_DO_COMANDO.ninguem;

  // O número DA EMPRESA por onde esta conversa chegou — não o do cliente. Com
  // dois canais é o que decide o tom da resposta e qual número a pessoa vê
  // respondendo. Cai no nome do canal quando não há número (canal recém-criado).
  const canal = conversation.channel_sessions ?? null;
  const rotuloCanal = canal?.phone_number ?? canal?.display_name ?? null;

  const atendenteVisivel = Boolean(mostrarAtendente) && comando.quem === "humano";
  const canalVisivel = Boolean(mostrarCanal) && rotuloCanal !== null;
  // A terceira linha é para o que só o CRM sabe (fila, setor, tags, atendente, número). Na maioria
  // das conversas não há nada a dizer ali, e então a linha NÃO existe: o WhatsApp tem duas linhas,
  // e a lista fica densa como a dele em vez de reservar espaço vazio em cada conversa.
  const temDetalhe =
    queuePosition !== undefined ||
    Boolean(conversation.sector_id) ||
    visibleTags.length > 0 ||
    atendenteVisivel ||
    canalVisivel ||
    Boolean(c?.is_blocked) ||
    Boolean(c?.is_anonymized);

  return (
    <button
      type="button"
      data-conversation-id={conversation.id}
      onClick={() => onSelect(conversation.id)}
      className={cn(
        // O DIVISOR SAIU DAQUI e foi para o bloco de texto (abaixo): assim ele
        // começa DEPOIS do avatar, como no WhatsApp. Divisor cortando a linha
        // inteira empilha retângulos; começando no texto, ele lê como uma lista
        // de pessoas.
        "group flex w-full items-start gap-3 px-3 py-2 text-left transition-colors hover:bg-accent/40",
        isSelected && "bg-accent/60",
      )}
      aria-current={isSelected ? "true" : undefined}
    >
      <div className="relative shrink-0">
        {/* 48px: é o tamanho que o WhatsApp usa, e o rosto é o que a pessoa
            procura primeiro numa lista de conversa. */}
        <AvatarDoContato
          contato={c}
          nome={displayName}
          reserva={phoneFallback}
          className="h-12 w-12"
        />
        <span
          className={cn(
            "absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border border-background",
            dot,
          )}
          aria-hidden
        />
      </div>

      <div className="min-w-0 flex-1 border-b border-border pb-2">
        {/*
          A POSIÇÃO NA FILA DESCEU. Ela ocupava a primeira linha, acima do nome,
          e empurrava para baixo justamente o que se procura numa lista de
          conversa — quem é. O dado não some: ele desce para a faixa de
          detalhes, junto das tags e do canal, onde o olho vai quando já achou
          a pessoa certa.
        */}
        <div className="flex items-baseline justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              className={cn(
                "truncate text-[15px] font-medium",
                c?.is_anonymized && "italic text-muted-foreground",
              )}
            >
              {displayName}
            </span>
            <SeloForaDoFunil foraDoFunilEm={c?.fora_do_funil_em} tipoId={c?.fora_do_funil_tipo_id} className="h-4 px-1.5 text-[10px]" />
          </span>
          {/* Verde e em negrito quando há não lida: é como o WhatsApp avisa, de longe, que a
              conversa pede o olho — a hora vira o sinal, sem precisar ler o contador. */}
          <time
            dateTime={conversation.last_message_at ?? undefined}
            data-testid="hora-da-conversa"
            className={cn(
              "shrink-0 text-xs tabular-nums",
              unread > 0 ? "font-medium text-success-fg" : "text-muted-foreground",
            )}
          >
            {hora}
          </time>
        </div>

        <div className="mt-0.5 flex items-center gap-1 text-[13px] leading-5 text-muted-foreground">
          {tique && TiqueIcone ? (
            <span
              role="img"
              aria-label={t(TIQUES[tique].rotulo)}
              data-tique={tique}
              className={cn("inline-flex shrink-0", TIQUES[tique].classe)}
            >
              <TiqueIcone size={16} weight="bold" aria-hidden />
            </span>
          ) : null}
          <span className="flex min-w-0 flex-1 items-center gap-1">
            {mostrarVoce ? <span className="shrink-0">{t("Você:")}</span> : null}
            {IconeDaMidia ? <IconeDaMidia size={14} weight="fill" className="shrink-0" aria-hidden /> : null}
            <span className="truncate" data-testid="previa-da-conversa">
              {previa.trecho ?? t(previa.rotulo ?? "Sem mensagens")}
            </span>
          </span>
          {isAi ? (
            <Robot size={14} weight="duotone" className="shrink-0" aria-label={t("Atendimento automático")} role="img" />
          ) : null}
          {unread > 0 ? (
            <span
              data-testid="nao-lidas"
              aria-label={`${unread} ${t("mensagens não lidas")}`}
              className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-success-fg px-1.5 text-[11px] font-semibold tabular-nums text-background"
            >
              {unread > 99 ? "99+" : unread}
            </span>
          ) : null}
        </div>

        {temDetalhe ? (
          <div
            data-testid="detalhes-da-conversa"
            className="mt-1 flex flex-wrap items-center gap-1"
          >
            {queuePosition !== undefined && (
              <span
                data-faixa={espera?.faixa}
                className={cn(
                  "inline-flex items-center gap-1 text-[10px]",
                  espera ? CLASSE_DA_ESPERA[espera.faixa] : "text-muted-foreground",
                )}
                aria-label={`${t("Posição")} ${queuePosition} ${t("na fila")}`}
              >
                <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary/10 px-1 font-medium tabular-nums text-primary">
                  {queuePosition}º
                </span>
                {espera ? <Clock size={10} weight="bold" aria-hidden /> : null}
                {waitingLabel(conversation, t, localeDaData)}
              </span>
            )}
            {/* O setor vem ANTES das tags: é a fila em que a conversa está, e
                a pergunta "isso é com quem?" vem antes de "isso é sobre o quê?". */}
            <ChipDeSetor sectorId={conversation.sector_id} compacto />
            {/* Etiquetas coloridas, como as do WhatsApp Business: a cor é a do marcador da empresa. */}
            {visibleTags.map((tag) => {
              const cor = CLASSE_DE_COR[coresDasTags?.get(tag) ?? COR_DE_MARCADOR_PADRAO];
              return (
                <Badge
                  key={tag}
                  variant="secondary"
                  className={cn("h-4 border-transparent px-1.5 text-[10px]", cor.fundo, cor.texto)}
                >
                  {tag}
                </Badge>
              );
            })}
            {overflow > 0 && (
              <span className="text-[10px] text-muted-foreground">+{overflow}</span>
            )}
            {atendenteVisivel && (
              <OwnerBadge ownerKind="user" ownerName={comando.nome ?? t("Atendente")} compacto />
            )}
            {canalVisivel && (
              <Badge
                variant="outline"
                className="h-4 gap-1 px-1.5 text-[10px] font-normal text-muted-foreground"
                title={`${t("Entrou por")} ${rotuloCanal}`}
              >
                <Phone size={9} weight="regular" aria-hidden />
                {rotuloCanal}
              </Badge>
            )}
            {c?.is_blocked && (
              <Badge variant="destructive" className="h-4 px-1.5 text-[10px]">
                {t("Bloqueado")}
              </Badge>
            )}
            {c?.is_anonymized && (
              <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                {t("Anonimizado")}
              </Badge>
            )}
          </div>
        ) : null}
      </div>
    </button>
  );
}
