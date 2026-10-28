"use client";
import { useEffect, useMemo, useState } from "react";

import { CitacaoResumo } from "@/components/inbox/CitacaoResumo";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useT } from "@/hooks/i18n/useT";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";
import {
  useConversasParaEncaminhar,
  useEncaminhar,
  type ResultadoDoEncaminhamento,
} from "@/hooks/inbox/useEncaminhar";
import { MAX_DESTINOS_POR_ENCAMINHAMENTO } from "@/lib/messaging/encaminhar";
import type { Message } from "@/lib/types/messaging";
import { CheckCircle, MagnifyingGlass, ShareFat, Warning } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

interface Props {
  /** As mensagens a encaminhar, na ordem em que foram ditas. */
  mensagens: Message[];
  /** A conversa de onde elas saem. */
  origem: ConversationWithContact;
  onFechar: () => void;
  /** Terminou (ao menos uma saiu): quem abriu sai do modo de seleção. */
  onConcluido: () => void;
}

// O rótulo é o do repositório (o que uma pessoa escolheu, depois o que o canal informou, depois o número):
// remontar a cadeia à mão é como a 7ª cópia nasce e um identificador técnico chega à tela.
const nomeDe = (c: ConversationWithContact): string => rotuloDoContato(c.contacts);

/**
 * ENCAMINHAR: escolher para quem, ver o que vai, confirmar.
 *
 * Num CRM de clínica o que se encaminha é o que UMA pessoa disse chegando ao WhatsApp de OUTRA. Por isso
 * o diálogo não é só um seletor: ele mostra as mensagens que vão (para ninguém mandar a errada), diz de
 * quem elas são e para quem vão — e o botão só liga com pelo menos um destino. O envio acontece uma vez,
 * no servidor, e o resultado volta por destino: o que saiu e o que não saiu, sem fingir que foi tudo.
 */
export function EncaminharDialog({ mensagens, origem, onFechar, onConcluido }: Props) {
  const t = useT();
  const [busca, setBusca] = useState("");
  const [buscaAplicada, setBuscaAplicada] = useState("");
  const [escolhidos, setEscolhidos] = useState<Map<string, ConversationWithContact>>(new Map());
  const [resultado, setResultado] = useState<ResultadoDoEncaminhamento | null>(null);

  // Debounce da busca: uma consulta por letra digitada seria barulho no servidor sem ganho.
  useEffect(() => {
    const id = setTimeout(() => setBuscaAplicada(busca), 250);
    return () => clearTimeout(id);
  }, [busca]);

  const lista = useConversasParaEncaminhar(buscaAplicada, true);
  const encaminhar = useEncaminhar();

  const cheio = escolhidos.size >= MAX_DESTINOS_POR_ENCAMINHAMENTO;

  const alternar = (c: ConversationWithContact) => {
    setEscolhidos((prev) => {
      const next = new Map(prev);
      if (next.has(c.id)) next.delete(c.id);
      else if (next.size < MAX_DESTINOS_POR_ENCAMINHAMENTO) next.set(c.id, c);
      return next;
    });
  };

  // De quem são as mensagens × para quem vão: é a linha que o atendente confere antes de confirmar.
  const outrosContatos = useMemo(
    () => [...escolhidos.values()].filter((c) => c.contact_id !== origem.contact_id),
    [escolhidos, origem.contact_id],
  );

  const enviar = () => {
    encaminhar.mutate(
      {
        message_ids: mensagens.map((m) => m.id),
        destination_conversation_ids: [...escolhidos.keys()],
      },
      {
        onSuccess: (r) => {
          setResultado(r);
          if (r.total_enviadas > 0) onConcluido();
        },
      },
    );
  };

  const nomeDaOrigem = nomeDe(origem);

  return (
    <Dialog open onOpenChange={(v) => !v && onFechar()}>
      <DialogContent className="flex max-h-[85dvh] w-[min(34rem,95vw)] flex-col gap-3 overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShareFat size={18} aria-hidden /> {t("Encaminhar mensagens")}
          </DialogTitle>
          <DialogDescription>
            {t("Escolha para quem enviar. Cada pessoa recebe uma cópia no WhatsApp dela.")}
          </DialogDescription>
        </DialogHeader>

        {resultado ? (
          <ResultadoDoEnvio resultado={resultado} onFechar={onFechar} />
        ) : (
          <>
            {/* O QUE VAI — para ninguém mandar a mensagem errada. */}
            <section aria-label={t("O que vai ser encaminhado")}>
              <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("O que vai")} ({mensagens.length})
              </h3>
              <ul className="max-h-28 space-y-1 overflow-y-auto rounded-md border border-border bg-muted/40 p-2 text-sm">
                {mensagens.map((m) => (
                  <li key={m.id} className="flex items-start gap-2">
                    <span className="shrink-0 text-xs font-medium text-muted-foreground">
                      {m.direction === "outbound" ? t("Você") : nomeDaOrigem}:
                    </span>
                    <CitacaoResumo mensagem={m} />
                  </li>
                ))}
              </ul>
            </section>

            {/* PARA QUEM */}
            <section className="flex min-h-0 flex-1 flex-col gap-2" aria-label={t("Para quem")}>
              <div className="relative">
                <MagnifyingGlass
                  size={14}
                  aria-hidden
                  className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  value={busca}
                  onChange={(e) => setBusca(e.target.value)}
                  placeholder={t("Buscar por nome ou telefone")}
                  aria-label={t("Buscar conversa para encaminhar")}
                  className="pl-8"
                />
              </div>

              <p className="text-xs text-muted-foreground" aria-live="polite">
                {escolhidos.size} {t("de")} {MAX_DESTINOS_POR_ENCAMINHAMENTO} {t("conversas escolhidas")}
              </p>

              <ul
                className="min-h-24 flex-1 space-y-0.5 overflow-y-auto rounded-md border border-border p-1"
                aria-busy={lista.isPending}
              >
                {lista.isPending && (
                  <li className="px-2 py-3 text-sm text-muted-foreground">{t("Carregando…")}</li>
                )}
                {lista.isError && (
                  <li className="px-2 py-3 text-sm text-destructive">
                    {t("Não consegui buscar as conversas.")}
                  </li>
                )}
                {lista.data?.length === 0 && (
                  <li className="px-2 py-3 text-sm text-muted-foreground">
                    {t("Nenhuma conversa encontrada.")}
                  </li>
                )}
                {lista.data?.map((c) => {
                  const marcada = escolhidos.has(c.id);
                  const bloqueada = Boolean(c.contacts?.is_blocked);
                  const semVaga = cheio && !marcada;
                  const desabilitada = bloqueada || semVaga;
                  return (
                    <li key={c.id}>
                      <label
                        className={cn(
                          "flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-muted",
                          marcada && "bg-primary/10",
                          desabilitada && "cursor-not-allowed opacity-50 hover:bg-transparent",
                        )}
                      >
                        <input
                          type="checkbox"
                          className="size-4 accent-[var(--color-primary,currentColor)]"
                          checked={marcada}
                          disabled={desabilitada}
                          onChange={() => alternar(c)}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{nomeDe(c)}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {c.contacts?.phone_number ?? ""}
                            {c.channel_sessions?.display_name
                              ? ` · ${c.channel_sessions.display_name}`
                              : ""}
                          </span>
                        </span>
                        {c.id === origem.id && (
                          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                            {t("Conversa atual")}
                          </span>
                        )}
                        {bloqueada && (
                          <span className="shrink-0 text-[10px] text-destructive">{t("Bloqueado")}</span>
                        )}
                      </label>
                    </li>
                  );
                })}
              </ul>
            </section>

            {/* A CONFERÊNCIA: de quem são, para quem vão. */}
            {outrosContatos.length > 0 && (
              <p
                role="note"
                className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs"
              >
                <Warning size={14} aria-hidden className="mt-0.5 shrink-0" />
                <span>
                  {t("As mensagens são de")} <strong>{nomeDaOrigem}</strong> {t("e vão chegar ao WhatsApp de")}{" "}
                  <strong>{outrosContatos.map(nomeDe).join(", ")}</strong>.{" "}
                  {t("Confira antes de enviar.")}
                </span>
              </p>
            )}

            {encaminhar.isError && (
              <p role="alert" className="text-sm text-destructive">
                {t("Não consegui encaminhar. Nada foi enviado — tente de novo.")}
              </p>
            )}

            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" onClick={onFechar} disabled={encaminhar.isPending}>
                {t("Cancelar")}
              </Button>
              <Button
                type="button"
                onClick={enviar}
                disabled={escolhidos.size === 0 || encaminhar.isPending}
              >
                <ShareFat size={14} aria-hidden className="mr-1.5" />
                {encaminhar.isPending ? t("Enviando…") : t("Encaminhar")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** O que saiu e o que não saiu, por destino — sem fingir que foi tudo. */
function ResultadoDoEnvio({
  resultado,
  onFechar,
}: {
  resultado: ResultadoDoEncaminhamento;
  onFechar: () => void;
}) {
  const t = useT();
  const tudoCerto = resultado.total_falhas === 0;
  return (
    <div className="space-y-3" data-testid="resultado-do-encaminhamento">
      <p
        role="status"
        className={cn("flex items-center gap-2 text-sm font-medium", !tudoCerto && "text-destructive")}
      >
        {tudoCerto ? <CheckCircle size={16} aria-hidden /> : <Warning size={16} aria-hidden />}
        {tudoCerto
          ? t("Encaminhado.")
          : resultado.total_enviadas > 0
            ? t("Encaminhado só em parte.")
            : t("Nada foi encaminhado.")}
      </p>
      <ul className="max-h-48 space-y-1 overflow-y-auto text-sm">
        {resultado.destinos.map((d) => (
          <li key={d.conversation_id} className="rounded-md border border-border px-3 py-2">
            <span className="font-medium">{d.contato ?? d.conversation_id.slice(0, 8)}</span>
            <span className="ml-2 text-xs text-muted-foreground">
              {d.enviadas} {t("enviada(s)")}
              {d.falhas.length > 0 ? ` · ${d.falhas.length} ${t("não saiu")}` : ""}
            </span>
            {d.falhas.length > 0 && (
              <span className="mt-0.5 block text-xs text-destructive">{d.falhas[0]!.erro}</span>
            )}
          </li>
        ))}
      </ul>
      <DialogFooter>
        <Button type="button" onClick={onFechar}>
          {t("Fechar")}
        </Button>
      </DialogFooter>
    </div>
  );
}
