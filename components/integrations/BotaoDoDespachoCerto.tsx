"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { CadastrarNoDespachoCertoDialog } from "@/components/integrations/CadastrarNoDespachoCertoDialog";
import { useT } from "@/hooks/i18n/useT";
import { useDespachoCerto, useVinculoDoContato } from "@/hooks/integrations/useDespachoCerto";

/**
 * "CADASTRAR" — o botão que só existe para quem tem a integração.
 *
 * Três estados, e cada um diz a verdade sobre onde o cliente está:
 *
 *   - integração desligada → NADA na tela. É o caso da maioria das
 *     instalações, e um botão desabilitado ali ensinaria o olho a ignorar a
 *     faixa onde moram "Assumir" e "Liberar".
 *   - sem vínculo → "Cadastrar", que abre o formulário do outro sistema.
 *   - com vínculo → o nome do cadastro, com link para a ficha de lá. Oferecer
 *     "Cadastrar" a quem já está cadastrado faria o operador preencher um
 *     formulário inteiro para receber "já existe".
 *
 * O componente decide tudo sozinho a partir do `contactId` — o cabeçalho da
 * conversa não precisa saber que integração existe, nem qual.
 */
export function BotaoDoDespachoCerto({
  contactId,
  nomeSugerido,
  telefoneSugerido,
}: {
  contactId: string | null;
  nomeSugerido: string;
  telefoneSugerido: string;
}) {
  const t = useT();
  const [aberto, setAberto] = useState(false);
  const integracao = useDespachoCerto();
  const ligada = integracao.data?.conectado === true;
  const vinculo = useVinculoDoContato(contactId, ligada);

  if (!ligada || !contactId) return null;

  if (vinculo.data?.vinculado) {
    const rotulo = vinculo.data.name ?? t("Cliente no Despacho Certo");
    if (!vinculo.data.url) {
      return (
        <span
          className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground"
          data-testid="vinculo-despachocerto"
        >
          {rotulo}
        </span>
      );
    }
    return (
      <Button size="sm" variant="outline" asChild data-testid="vinculo-despachocerto">
        <a href={vinculo.data.url} target="_blank" rel="noreferrer">
          {rotulo}
        </a>
      </Button>
    );
  }

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        data-testid="cadastrar-despachocerto"
        title={t("Cadastrar este contato como cliente no Despacho Certo.")}
        onClick={() => setAberto(true)}
      >
        {t("Cadastrar")}
      </Button>
      <CadastrarNoDespachoCertoDialog
        contactId={contactId}
        nomeSugerido={nomeSugerido}
        telefoneSugerido={telefoneSugerido}
        open={aberto}
        onOpenChange={setAberto}
      />
    </>
  );
}
