"use client";
import { useState, type MouseEvent } from "react";

import { useT } from "@/hooks/i18n/useT";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { bandLabel, type ScoreBand } from "@/lib/kanban/score-band";

interface Fator {
  pontos: number;
  frase: string;
  ancora?: { kind: string; id: string };
}

interface ScoreSlotProps {
  probability: number;
  /** A faixa PERSISTIDA — este componente NÃO a deriva do número. */
  band: ScoreBand;
  reason: string;
  /** Até três, as que existem. */
  factors: Fator[];
}

const RAIO_DO_ANEL = 6;
const CIRCUNFERENCIA = 2 * Math.PI * RAIO_DO_ANEL;

/**
 * O anel: um círculo de 14px cujo arco vai de 0 a 100%. Decorativo (`aria-hidden`) — o número e a
 * faixa estão no rótulo do botão e no texto ao lado. `probability` fora de 0–100 é contido, porque
 * um arco que passa de 100% desenharia um anel "mais que cheio" sem erro nenhum.
 */
export function AnelDeProbabilidade({
  probability,
  band,
}: {
  probability: number;
  band: ScoreBand;
}) {
  const p = Math.max(0, Math.min(100, probability));
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="h-[14px] w-[14px] shrink-0 -rotate-90">
      <circle cx="8" cy="8" r={RAIO_DO_ANEL} fill="none" strokeWidth="2" className="stroke-border" />
      <circle
        cx="8"
        cy="8"
        r={RAIO_DO_ANEL}
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={CIRCUNFERENCIA}
        strokeDashoffset={CIRCUNFERENCIA - (CIRCUNFERENCIA * p) / 100}
        data-anel-arco={p}
        className={cn(
          "transition-[stroke-dashoffset] duration-300",
          band === "quente" && "stroke-accent",
          band === "morno" && "stroke-warning",
          band === "frio" && "stroke-text-muted",
        )}
      />
    </svg>
  );
}

/**
 * A faixa ③ quando há score: medidor, número, e o porquê a um gesto de distância.
 *
 * UM COMPORTAMENTO, DOIS GATILHOS: clique/toque abre, e onde há ponteiro o
 * hover também abre. Hover-only sumiria com as evidências no tablet, e decidir
 * isso depois viraria retrabalho de layout dentro de um card de altura fixa —
 * que é contrato do §5.
 *
 * A faixa vem PRONTA do banco. Derivá-la do número aqui ignoraria a histerese e
 * traria de volta o card piscando na fronteira, no único lugar onde o CHECK de
 * coerência não alcança.
 */
export function ScoreSlot({ probability, band, reason, factors }: ScoreSlotProps) {
  const t = useT();
  const [aberto, setAberto] = useState(false);

  const pare = (e: MouseEvent) => {
    // O card inteiro seleciona ao clique; abrir o porquê não é selecionar.
    e.stopPropagation();
  };

  return (
    <Popover open={aberto} onOpenChange={setAberto}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => {
            pare(e);
            setAberto((v) => !v);
          }}
          onMouseEnter={() => setAberto(true)}
          onMouseLeave={() => setAberto(false)}
          // O rótulo acessível carrega o número E a faixa: "72%" lido sozinho
          // não diz se é bom ou ruim para quem não vê a barra.
          aria-label={`${t("Probabilidade")} ${probability}%, ${bandLabel(band, t)}. ${t("Ver o porquê.")}`}
          className="flex min-w-0 items-center gap-2 rounded-md text-left"
        >
          {/* O ANEL de probabilidade (o "progresso" do quadro novo): a trilha cinza e o arco na cor da
              faixa. A faixa continua vindo PRONTA do banco — o arco só desenha o número. */}
          <AnelDeProbabilidade probability={probability} band={band} />
          <span className="tabular-nums text-text-muted">{probability}%</span>
        </button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        className="w-72 text-xs"
        onClick={pare}
        data-testid="score-evidencias"
      >
        <p className="font-medium text-text">{bandLabel(band, t)} · {probability}%</p>
        {reason !== "" && <p className="mt-1 text-text-muted">{reason}</p>}

        {factors.length > 0 ? (
          <ul className="mt-2 space-y-1">
            {factors.map((f, i) => (
              <li key={`${f.frase}-${i}`} className="flex items-baseline gap-2">
                <span
                  className={cn(
                    "shrink-0 tabular-nums",
                    f.pontos > 0 ? "text-accent" : "text-warning-fg",
                  )}
                >
                  {f.pontos > 0 ? "+" : "−"}
                  {Math.abs(f.pontos)}
                </span>
                <span className="min-w-0 flex-1 text-text">
                  {f.frase}
                  {/* O rótulo diz O QUE a evidência é. Chamar um checkpoint de
                      "momento da conversa" seria prometer um destino que ele não
                      tem — e fabricar âncora de mensagem para cumprir a frase é
                      pior que âncora nenhuma. */}
                  {f.ancora && (
                    <span className="ml-1 text-text-muted">
                      ({f.ancora.kind === "message" ? t("ver a mensagem") : t("registro que sustenta")})
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          // Vazio com DESENHO PRÓPRIO: não há evidência a mostrar, e dizer isso
          // é melhor que deixar um espaço que parece defeito de carregamento.
          <p className="mt-2 text-text-muted">{t("Sem evidências registradas.")}</p>
        )}
      </PopoverContent>
    </Popover>
  );
}
