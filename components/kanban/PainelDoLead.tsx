"use client";
import Link from "next/link";
import { useState } from "react";

import { ConversaAberta } from "@/components/inbox/ConversaAberta";
import type { CustomFieldDef } from "@/components/contacts/CustomFieldsEditor";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useT } from "@/hooks/i18n/useT";
import { isNotFound, useConversation } from "@/hooks/inbox/useConversation";
import { OpenConversationProvider } from "@/hooks/notifications/OpenConversationContext";
import type { Lead } from "@/lib/types/leads";
import { ArrowRight, X } from "@/lib/ui/icons";

import { LeadDossier } from "./LeadDossier";

interface Props {
  lead: Lead;
  pipelineId: string;
  fieldDefs?: CustomFieldDef[];
  stageName: string;
  ownerNames?: Map<string, string | null>;
  onClose: () => void;
}

/**
 * A conversa do negócio, ao lado do quadro.
 *
 * Quem trabalha o funil quer responder o cliente SEM largar o funil. Antes, o
 * clique no card abria uma gaveta estreita só com os dados e um link para o
 * inbox: para responder, saía-se do quadro, achava-se a conversa e voltava-se
 * — e o lugar no funil se perdia a cada ida.
 *
 * Duas abas, e a conversa vem primeiro quando existe: é por ela que se abre um
 * lead. Os dados (timeline e campos) continuam a um clique, sem perder o que se
 * digitava, porque as duas abas ficam montadas (ver `forceMount`).
 *
 * ─── Lado a lado, e no celular em tela cheia ────────────────────────────────
 *
 * Do `lg` para cima o painel é METADE da largura da página, em toda a altura, e
 * título + filtros + quadro encolhem para a outra metade (a página divide a
 * linha com ele — ver `PipelinePageClient`): dá para ver e arrastar os cards
 * enquanto se conversa, e clicar em outro lead troca a conversa. Abaixo disso
 * não há largura para duas coisas, e o painel cobre a tela inteira com o botão
 * de fechar. A escolha é CSS (`lg:`), não `useMediaQuery`: a segunda decide
 * depois da hidratação e a primeira pintura mostraria o layout errado.
 *
 * ⚠️ Monte com `key={lead.id}`: trocar de lead tem de trocar a conversa, o
 * rascunho e a citação — nunca levá-los para o cliente seguinte.
 */
export function PainelDoLead({ lead, pipelineId, fieldDefs, stageName, ownerNames, onClose }: Props) {
  const t = useT();
  const conversationId = lead.conversa?.id ?? null;
  const [aba, setAba] = useState<"conversa" | "dados">(conversationId ? "conversa" : "dados");

  return (
    <aside
      data-testid="painel-do-lead"
      aria-label={`${t("Lead")}: ${lead.title}`}
      className="fixed inset-0 z-50 flex min-h-0 flex-col bg-background lg:static lg:z-auto lg:ml-4 lg:w-1/2 lg:shrink-0 lg:overflow-hidden lg:rounded-lg lg:border lg:border-border"
    >
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <h2 className="min-w-0 flex-1 truncate text-base font-semibold leading-6">{lead.title}</h2>
        {conversationId && (
          <Link
            href={`/app/inbox?id=${conversationId}`}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-text-muted hover:bg-muted hover:text-text focus-visible:outline-2 focus-visible:outline-ring"
          >
            {t("Abrir no Inbox")}
            <ArrowRight size={12} aria-hidden />
          </Link>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          aria-label={t("Fechar painel do lead")}
          onClick={onClose}
        >
          <X size={16} aria-hidden />
        </Button>
      </header>

      <Tabs
        value={aba}
        onValueChange={(v) => setAba(v === "dados" ? "dados" : "conversa")}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList className="mx-4 mt-2 self-start">
          <TabsTrigger value="conversa" disabled={!conversationId}>
            {t("Conversa")}
          </TabsTrigger>
          <TabsTrigger value="dados">{t("Dados do lead")}</TabsTrigger>
        </TabsList>

        {/* `forceMount` + `hidden`: trocar de aba não desmonta a outra. Sem isso, olhar os dados
            do lead no meio de uma resposta apagaria o que estava sendo digitado. */}
        <TabsContent
          value="conversa"
          forceMount
          className="mt-2 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
        >
          {conversationId ? (
            <ConversaDoLead conversationId={conversationId} />
          ) : (
            <p className="px-4 py-6 text-sm text-text-muted">
              {t("Este lead ainda não tem uma conversa.")}
            </p>
          )}
        </TabsContent>
        <TabsContent
          value="dados"
          forceMount
          className="mt-2 min-h-0 flex-1 overflow-y-auto data-[state=inactive]:hidden"
        >
          <LeadDossier
            lead={lead}
            pipelineId={pipelineId}
            fieldDefs={fieldDefs}
            stageName={stageName}
            ownerNames={ownerNames}
          />
        </TabsContent>
      </Tabs>
    </aside>
  );
}

/**
 * Busca a conversa e a abre pelo MESMO componente do inbox — a janela de 24h, o
 * contato bloqueado e o envio têm uma régua só (ver `ConversaAberta`).
 */
function ConversaDoLead({ conversationId }: { conversationId: string }) {
  const t = useT();
  const q = useConversation(conversationId, true);

  if (q.isPending) {
    return (
      <div className="space-y-3 px-4 py-4" aria-busy="true">
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="h-16 w-1/2" />
        <Skeleton className="ml-auto h-16 w-1/2" />
      </div>
    );
  }
  if (!q.data) {
    return (
      <p className="px-4 py-6 text-sm text-text-muted">
        {isNotFound(q.error)
          ? t("Conversa não encontrada ou fora do seu acesso.")
          : t("Não consegui abrir a conversa. Feche o painel e tente de novo.")}
      </p>
    );
  }
  return (
    <OpenConversationProvider conversationId={conversationId}>
      <ConversaAberta key={q.data.id} conversation={q.data} />
    </OpenConversationProvider>
  );
}
