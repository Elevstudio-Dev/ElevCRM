import { ICONE_ELEV } from "./icone";

/**
 * O ícone da Elev Studio desenhado para o gerador de imagens (`next/og`): o ícone em `frente` sobre um
 * ladrilho quadrado da cor `fundo`. É o desenho do ícone da aba (`app/icon.tsx`) e do ícone de atalho
 * do iPhone (`app/apple-icon.tsx`) — um desenho só, para os dois não divergirem.
 *
 * O ladrilho é cheio e quadrado de propósito: o navegador e o iOS já arredondam o ícone no chrome deles,
 * e arredondar aqui também produz canto duplo. O ícone ocupa 60% do lado — o suficiente para sobrar
 * respiro sem virar um selo minúsculo no meio.
 *
 * Só SVG inline (sem rede, sem fonte): o satori desenha `<svg>` e `<path>` direto, e é isso que mantém
 * o `<head>` de toda página sem depender de requisição nenhuma.
 */
export function DesenhoDoIcone({ lado, fundo, frente }: { lado: number; fundo: string; frente: string }) {
  const largura = Math.round(lado * 0.6);
  const altura = Math.round((largura * ICONE_ELEV.altura) / ICONE_ELEV.largura);
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: fundo,
      }}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={largura}
        height={altura}
        viewBox={`0 0 ${ICONE_ELEV.largura} ${ICONE_ELEV.altura}`}
      >
        <g transform={ICONE_ELEV.transformacao} fill={frente}>
          {ICONE_ELEV.caminhos.map((d) => (
            <path key={d.slice(0, 16)} d={d} />
          ))}
        </g>
      </svg>
    </div>
  );
}
