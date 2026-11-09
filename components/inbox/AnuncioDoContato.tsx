"use client";

import { format } from "date-fns";
import type { Locale } from "date-fns";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { useT } from "@/hooks/i18n/useT";
import type { AnuncioDoContato as Anuncio } from "@/lib/leads/anuncio-do-contato";
import { ArrowSquareOut, Megaphone } from "@/lib/ui/icons";

/**
 * "De qual anúncio este cliente veio", no painel da conversa.
 *
 * O dado já existia (o contato nasce carimbado com o anúncio); faltava dizê-lo no lugar onde o atendente está.
 * Todo texto aqui veio do anúncio de um terceiro (título e corpo são do anunciante): entra como TEXTO, nunca
 * como HTML, e o link só chega aqui se for http(s) (ver `anuncioDoContato`).
 */
export function AnuncioDoContato({ anuncio, locale }: { anuncio: Anuncio; locale: Locale }) {
  const t = useT();
  const clique = anuncio.clicadoEm ? new Date(anuncio.clicadoEm) : null;
  const clicadoEm = clique && !Number.isNaN(clique.getTime()) ? format(clique, "dd/MM/yy HH:mm", { locale }) : null;

  return (
    <section data-testid="inbox-anuncio">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("Veio de um anúncio")}</h3>
      <Card className="mt-2 space-y-2 p-3 text-sm">
        <div className="flex flex-wrap items-center gap-1.5">
          <Megaphone size={14} aria-hidden className="shrink-0 text-text-muted" />
          <span className="font-medium">{anuncio.titulo ?? t("Anúncio sem título")}</span>
          {anuncio.app && (
            <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
              {anuncio.app}
            </Badge>
          )}
        </div>
        {anuncio.texto && <p className="line-clamp-4 whitespace-pre-line text-xs text-text-muted">{anuncio.texto}</p>}
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-text-muted">
          {clicadoEm && (
            <span>
              {t("Clicou em")} {clicadoEm}
            </span>
          )}
          {anuncio.url && (
            <a
              href={anuncio.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
            >
              {t("Ver anúncio")}
              <ArrowSquareOut size={12} aria-hidden />
            </a>
          )}
        </div>
      </Card>
    </section>
  );
}
