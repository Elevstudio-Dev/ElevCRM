"use client";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";

import type { Locale } from "date-fns";
import { format, formatDistanceToNowStrict } from "date-fns";
import { useT } from "@/hooks/i18n/useT";
import { Clock, Phone, Robot } from "@/lib/ui/icons";
import { AvatarDoContato } from "@/components/contacts/AvatarDoContato";
import { Badge } from "@/components/ui/badge";
import { OwnerBadge } from "@/components/kanban/OwnerBadge";
import { ChipDeSetor } from "@/components/setores/ChipDeSetor";
import { comandoDaConversa } from "@/lib/inbox/comando-da-conversa";
import { type Faixa, PISO_MINUTOS, tempoSemResposta } from "@/lib/inbox/tempo-sem-resposta";
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
}

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


function relativeTime(iso: string | null, locale: Locale): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return format(d, "HH:mm");
  const diff = (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24);
  if (diff < 7) return formatDistanceToNowStrict(d, { addSuffix: false, locale: locale });
  return format(d, "dd/MM");
}

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
}: Props) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  const c = conversation.contacts ?? null;
  const displayName = rotuloDoContato(c);
  const phoneFallback = c?.phone_number ? phoneForDisplay(c.phone_number) : "??";
  const tags = c?.tags ?? [];
  const visibleTags = tags.slice(0, 2);
  const overflow = tags.length - visibleTags.length;
  const preview = conversation.last_message_preview?.trim() || t("Sem mensagens");
  const truncated = preview.length > 60 ? `${preview.slice(0, 60)}…` : preview;
  const time = relativeTime(conversation.last_message_at, localeDaData);
  const unread = conversation.unread_count_for_assignee ?? 0;


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
          <span
            className={cn(
              "truncate text-sm font-medium",
              c?.is_anonymized && "italic text-muted-foreground",
            )}
          >
            {displayName}
          </span>
          <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
            {time}
          </span>
        </div>

        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {isAi ? <Robot size={10} weight="duotone" className="mr-1 inline" aria-hidden /> : null}
          {truncated}
        </p>

        <div className="mt-1 flex flex-wrap items-center gap-1">
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
          {visibleTags.map((t) => (
            <Badge key={t} variant="secondary" className="h-4 px-1.5 text-[10px]">
              {t}
            </Badge>
          ))}
          {overflow > 0 && (
            <span className="text-[10px] text-muted-foreground">+{overflow}</span>
          )}
          {mostrarAtendente && comando.quem === "humano" && (
            <OwnerBadge ownerKind="user" ownerName={comando.nome ?? t("Atendente")} compacto />
          )}
          {mostrarCanal && rotuloCanal && (
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
          {unread > 0 && (
            <Badge className="ml-auto h-4 min-w-4 px-1.5 text-[10px]">{unread}</Badge>
          )}
        </div>
      </div>
    </button>
  );
}
