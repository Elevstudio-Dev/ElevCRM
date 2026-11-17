"use client";

import { format } from "date-fns";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { useProximosDaFila } from "@/hooks/followup/useFollowupQueue";

/**
 * Quem vem a seguir na fila de follow-up, ANTES de ser inscrito.
 *
 * Só aparece para fluxo de silêncio com ritmo configurado (intervalo entre
 * pacientes + limite por dia). Sem nenhum, a seção some: um bloco vazio ensinaria
 * que ela "às vezes não funciona". A hora é PREVISÃO — quem responder antes sai
 * da lista e quem vem depois adianta.
 */
export function ProximosDaFila() {
  const t = useT();
  const localeDaData = useLocaleDeData();
  const { data: fluxos } = useProximosDaFila();

  if (!fluxos || fluxos.length === 0) return null;

  return (
    <div className="flex flex-col gap-3" data-testid="proximos-da-fila">
      {fluxos.map((f) => (
        <section key={f.pointer_id} className="rounded-md border border-border">
          <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-3">
            <div className="flex flex-col">
              <h2 className="font-medium">{t("Próximos a entrar na fila")}</h2>
              <span className="text-xs text-text-muted">{f.nome}</span>
            </div>
            <div className="flex flex-col items-end text-xs text-text-muted">
              <span>
                {t("Intervalo entre pacientes")}: {f.ritmo.min_minutos}–{f.ritmo.max_minutos} min
              </span>
              <span data-testid="proximos-usados">
                {t("Entraram nas últimas 24h")}: {f.usados_24h} / {f.ritmo.limite_por_dia}
              </span>
            </div>
          </header>
          {f.itens.length === 0 ? (
            <p className="px-4 py-6 text-sm text-text-muted">
              {t("Ninguém esperando para entrar: todos os pacientes parados já estão na fila.")}
            </p>
          ) : (
            <ol className="divide-y divide-border">
              {f.itens.map((i) => (
                <li
                  key={i.contact.id}
                  className="flex items-center justify-between gap-3 px-4 py-2 text-sm"
                  data-testid="proximo-da-fila"
                >
                  <span className="flex items-center gap-3">
                    <span className="w-6 text-right text-text-muted tabular-nums">{i.posicao}</span>
                    <span className="font-medium">{i.contact.name}</span>
                  </span>
                  <span className="text-text-muted tabular-nums" title={i.entra_em}>
                    {t("entra por volta de")} {format(new Date(i.entra_em), "dd/MM HH:mm", { locale: localeDaData })}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      ))}
    </div>
  );
}
