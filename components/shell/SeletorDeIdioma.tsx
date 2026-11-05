"use client";
import { useTransition } from "react";
import { toast } from "sonner";

import { trocarIdioma } from "@/app/actions/settings/trocarIdioma";
import { useT } from "@/hooks/i18n/useT";
import { useAplicarIdioma, useIdioma } from "@/lib/i18n/IdiomaProvider";
import { type Idioma } from "@/lib/i18n/idiomas";

/**
 * A troca de idioma — a lógica e os nomes. O DESENHO mora em `PreferenciasNoMenu`, dentro do
 * menu do usuário.
 *
 * ─── Por que dois cliques, de qualquer tela ────────────────────────────────
 *
 * Quem precisa dela é justamente quem NÃO acha Configurações: alguém que abriu o sistema num
 * idioma que não lê. Enterrar a troca a três telas de distância transforma "está em português"
 * num beco. O menu do usuário (o avatar, no pé da coluna lateral) está em toda tela e a troca fica
 * a dois cliques dele.
 *
 * Havia um botão "PT"/"ES" solto na barra superior (`SeletorDeIdioma`). Saiu junto com a barra: a
 * coluna lateral tem 64px e não comporta botões de texto. Quem o procurar o acha no menu do
 * usuário, com o idioma em vigor marcado e o nome de cada língua na língua dela.
 */
export const NOME_DO_IDIOMA: Record<Idioma, { curto: string; completo: string }> = {
  // Cada língua no nome dela própria: é assim que se reconhece a sua numa
  // lista que você não sabe ler.
  "pt-BR": { curto: "PT", completo: "Português (BR)" },
  es: { curto: "ES", completo: "Español" },
};

/** A troca de idioma, para quem for desenhar o controle (a barra, ou o menu do usuário). */
export function useTrocarDeIdioma() {
  const t = useT();
  const idioma = useIdioma();
  const aplicar = useAplicarIdioma();
  const [salvando, startTransition] = useTransition();

  const escolher = (novo: Idioma) => {
    if (novo === idioma) return;
    const anterior = idioma;
    // Pinta primeiro: quem clica quer ver o efeito no clique, não depois do
    // round-trip. Se o servidor recusar, voltamos ao anterior e dizemos.
    aplicar(novo);
    startTransition(async () => {
      const r = await trocarIdioma(novo);
      if (!r.ok) {
        aplicar(anterior);
        toast.error(t("Não foi possível trocar o idioma. Tente de novo."));
        return;
      }
      // ⚠️ RECARGA INTEIRA, e não `router.refresh()` — os dois foram MEDIDOS.
      //
      // O problema: `revalidatePath` invalida o cache do SERVIDOR. O Router
      // Cache do CLIENTE é outro, e guarda o layout de `/app` já renderizado —
      // que é justamente quem monta o `IdiomaProvider`. Numa sonda Playwright,
      // sem nada disto: logo após o clique a tela mostrava o idioma novo (o
      // estado local pintando), ao NAVEGAR ela voltava ao antigo, e só um
      // reload acertava. A troca parecia funcionar e se desfazia sozinha no
      // primeiro clique seguinte — o pior desfecho possível.
      //
      // `router.refresh()` melhora e não resolve: medido na mesma sonda, a
      // PRIMEIRA navegação depois do clique ainda vinha no idioma antigo e só a
      // SEGUNDA vinha certa. Ele é assíncrono, e quem clica em "ES" e sai
      // navegando ganha a corrida dele. "Funciona porque o humano é lento" não
      // é garantia — é a corrida esperando um dia ruim.
      //
      // A recarga é determinística e é o que qualquer produto faz ao trocar de
      // idioma. O preço é o estado não salvo da tela, e ele é pequeno aqui:
      // trocar o idioma da interface é ação rara, deliberada, e feita antes de
      // trabalhar — não no meio de uma mensagem pela metade.
      window.location.reload();
    });
  };

  return { idioma, escolher, salvando };
}
