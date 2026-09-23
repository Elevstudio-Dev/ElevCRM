/**
 * Configurações → Canais → Despacho Certo.
 *
 * A tela que LIGA o plugin. Enquanto ninguém a preenche, o Elev CRM não sabe
 * que o Despacho Certo existe e o botão "Cadastrar" do inbox não aparece —
 * é assim que uma integração de nicho não vira ruído numa instalação de loja
 * ou de clínica.
 *
 * A página é uma casca: TODO o texto mora no componente de cliente, porque é
 * lá que `t()` existe. Prosa em português num Server Component chegaria crua a
 * quem escolheu espanhol, e é o que `i18n-espanhol-cobre-a-tela` reprova.
 */
import { TelaDaIntegracao } from "./_client";

export const dynamic = "force-dynamic";

export default function Page() {
  return <TelaDaIntegracao />;
}
