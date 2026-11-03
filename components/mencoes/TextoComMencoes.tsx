import { trechosComMencao } from "@/lib/mencoes/texto";
import type { Mencao } from "@/lib/mencoes/tipos";
import { cn } from "@/lib/utils";

interface Props {
  texto: string;
  mencoes: ReadonlyArray<Mencao> | null | undefined;
  /** Quem está olhando: a marcação que o inclui ganha mais destaque, como no WhatsApp. */
  euId?: string | null;
  className?: string;
  /**
   * `padrao`: o nome em cor de destaque (fundo claro). `heranca`: o nome herda a cor do texto e ganha
   * só um fundo translúcido e negrito — para dentro de uma bolha colorida, onde uma cor própria
   * sumiria no fundo.
   */
  tom?: "padrao" | "heranca";
}

/**
 * A quebra de linha e de palavra do texto. `overflow-wrap: anywhere` e NÃO `break-words`: só o `anywhere`
 * faz o tamanho mínimo do conteúdo encolher, e com `break-words` um link longo (sem espaço nenhum) empurra
 * a coluna e estoura a tela — o defeito que a bolha já teve e foi consertado.
 */
const QUEBRA = "whitespace-pre-wrap [overflow-wrap:anywhere]";

/**
 * O texto de uma mensagem ou nota com o `@Nome` de quem foi marcado em destaque.
 *
 * Sem marcação guardada, devolve o texto puro — que é o caso de toda mensagem
 * antiga. A quebra de linha e de palavra ficam aqui para quem usa não ter de
 * repeti-las (e para o destaque não mudar a medida do texto).
 */
export function TextoComMencoes({ texto, mencoes, euId, className, tom = "padrao" }: Props) {
  const lista = mencoes ?? [];
  if (lista.length === 0) {
    return <span className={cn(QUEBRA, className)}>{texto}</span>;
  }
  return (
    <span className={cn(QUEBRA, className)}>
      {trechosComMencao(texto, lista).map((t, i) => {
        if (!t.mencao) return <span key={i}>{t.texto}</span>;
        const comigo =
          t.mencao.tipo === "todos" || (t.mencao.tipo === "pessoa" && !!euId && t.mencao.user_id === euId);
        return (
          <span
            key={i}
            data-testid="mencao"
            data-comigo={comigo ? "true" : undefined}
            className={cn(
              "rounded-sm px-0.5",
              tom === "heranca"
                ? "bg-white/25 font-semibold"
                : cn("font-medium text-primary", comigo ? "bg-primary/25" : "bg-primary/10"),
            )}
          >
            {t.texto}
          </span>
        );
      })}
    </span>
  );
}
