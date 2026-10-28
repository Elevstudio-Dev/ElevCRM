"use client";
import Link from "next/link";
import type { MouseEvent } from "react";

import { ICONE_DA_MIDIA } from "@/components/inbox/CitacaoResumo";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { horaDaLinha, previaDaLinha } from "@/lib/inbox/linha-da-conversa";
import { ChatCircle } from "@/lib/ui/icons";
import type { Lead } from "@/lib/types/leads";
import { cn } from "@/lib/utils";

/**
 * A última mensagem do negócio, com atalho para o inbox.
 *
 * ─── Por que atalho e não um composer aqui dentro ───────────────────────────
 *
 * Responder de dentro do quadro exigiria trazer o composer inteiro — anexos,
 * templates, notas internas, gravação de áudio — para uma segunda tela. Duas
 * cópias do mesmo campo divergem: a correção entra numa e não na outra, e o
 * atendente aprende que "no Kanban não funciona igual". O inbox já é o lugar
 * onde se conversa; o que faltava era chegar nele sem procurar.
 *
 * ─── O que a prévia resolve ─────────────────────────────────────────────────
 *
 * Sem ela o atalho é uma aposta: clicar para descobrir se vale a pena. Com a
 * última mensagem à vista, o vendedor decide olhando o quadro — que é para o
 * que o quadro serve.
 *
 * ─── Ausência é estado normal, não erro ─────────────────────────────────────
 *
 * Lead criado à mão ou por webhook não tem contato; contato pode não ter
 * conversa. Nesses casos o slot não aparece — e NÃO aparece um "sem mensagens"
 * cinza, que ocuparia a mesma linha em metade dos cards para não dizer nada.
 */
export function ConversaSlot({ conversa }: { conversa: Lead["conversa"] }) {
  const t = useT();
  const localeDaData = useLocaleDeData();
  if (!conversa) return null;

  // O que o card responde sobre a conversa: QUEM falou por último (a bola está com o cliente ou com
  // a gente?), o que foi dito (áudio aparece como "Áudio", não como `[audio]`) e quando. As regras
  // moram em `lib/inbox/linha-da-conversa`, as mesmas da lista do Inbox — o card e a lista não
  // podem contar histórias diferentes sobre a mesma conversa.
  const previa = previaDaLinha({
    type: conversa.type,
    preview: conversa.preview,
    direction: conversa.direction,
  });
  const IconeDaMidia = previa.icone ? ICONE_DA_MIDIA[previa.icone] : null;
  const quemFalou =
    conversa.direction === "outbound"
      ? t("Você:")
      : conversa.direction === "inbound"
        ? t("Cliente:")
        : null;
  const texto = previa.trecho ?? (previa.rotulo && previa.rotulo !== "Sem mensagens" ? t(previa.rotulo) : null);
  const hora = horaDaLinha(conversa.last_message_at, new Date(), localeDaData, t("Ontem"));
  const temNaoLidas = conversa.unread > 0;

  return (
    <Link
      href={`/app/inbox?id=${conversa.id}`}
      // O card inteiro é arrastável e clicável (abre o dossiê). Sem parar a
      // propagação, o clique no atalho também abriria o dossiê por baixo — dois
      // destinos para um gesto.
      onClick={(e: MouseEvent) => e.stopPropagation()}
      onPointerDown={(e: MouseEvent) => e.stopPropagation()}
      className={cn(
        "group/conversa mt-1 flex items-center gap-1.5 rounded-md px-1 py-0.5 text-[11px]",
        "text-text-muted transition-colors hover:bg-muted hover:text-foreground",
      )}
      title={t("Abrir esta conversa no Inbox")}
    >
      <ChatCircle size={12} weight="regular" className="shrink-0" aria-hidden />
      {quemFalou && texto ? (
        // Do CLIENTE em tom forte: é a mensagem que espera resposta. A nossa fica no tom da linha.
        <span
          data-testid="quem-falou"
          data-direcao={conversa.direction}
          className={cn(
            "shrink-0",
            conversa.direction === "inbound" && "font-medium text-text",
          )}
        >
          {quemFalou}
        </span>
      ) : null}
      {IconeDaMidia ? <IconeDaMidia size={12} weight="fill" className="shrink-0" aria-hidden /> : null}
      <span className="truncate">
        {texto || <span className="italic">{t("conversa sem mensagens")}</span>}
      </span>
      {hora ? (
        <time
          dateTime={conversa.last_message_at ?? undefined}
          className="ml-auto shrink-0 tabular-nums"
        >
          {hora}
        </time>
      ) : null}
      {temNaoLidas && (
        // O número, não um ponto: "3 sem ler" e "12 sem ler" pedem urgências
        // diferentes, e um ponto colapsa as duas.
        <span
          className="shrink-0 rounded-full bg-primary px-1.5 text-[10px] font-medium text-primary-foreground tabular-nums"
          aria-label={`${conversa.unread} ${t("sem ler")}`}
        >
          {conversa.unread}
        </span>
      )}
    </Link>
  );
}
