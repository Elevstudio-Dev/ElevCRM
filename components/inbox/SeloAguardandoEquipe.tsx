"use client";
import { useT } from "@/hooks/i18n/useT";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { formatDistanceToNowStrict } from "date-fns";
import { cn } from "@/lib/utils";
import { ClockCountdown } from "@/lib/ui/icons";

/**
 * O selo ROXO "Aguardando equipe": a IA passou um pedido (por exemplo, agendar)
 * para a equipe e ninguém respondeu ainda. Some quando uma pessoa da equipe
 * manda mensagem na conversa (ver `lib/inbox/aguardando-equipe.ts`).
 *
 * Roxo de propósito: é a cor que a clínica escolheu para "falta a equipe
 * responder", e não se confunde com o âmbar da fila nem com o vermelho de falha.
 * A cor nunca vai sozinha — o texto diz o que é, e o título diz desde quando.
 */
export function SeloAguardandoEquipe({
  desde,
  compacto = false,
  className,
}: {
  desde: string | null | undefined;
  compacto?: boolean;
  className?: string;
}) {
  const t = useT();
  const locale = useLocaleDeData();
  if (!desde) return null;
  const ha = formatDistanceToNowStrict(new Date(desde), { addSuffix: true, locale });
  return (
    <span
      data-testid="selo-aguardando-equipe"
      title={`${t("A IA passou para a equipe")} ${ha}`}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full bg-purple-100 font-medium text-purple-800 dark:bg-purple-900/50 dark:text-purple-200",
        compacto ? "h-5 px-1.5 text-[11px]" : "h-6 px-2 text-xs",
        className,
      )}
    >
      <ClockCountdown size={compacto ? 12 : 14} weight="bold" aria-hidden />
      {t("Aguardando equipe")}
    </span>
  );
}
