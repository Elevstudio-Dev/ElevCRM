import Link from "next/link";

import { SignupForm } from "@/components/auth/SignupForm";
import { branding } from "@/lib/branding";
import { verifyInviteToken } from "@/lib/auth/invite-token";
import { cadastroPublicoAbertoNaInstalacao } from "@/lib/auth/cadastro-publico";
import { createClient } from "@/lib/supabase/server";
import { normalizarIdioma } from "@/lib/i18n/idiomas";
import { traduzir } from "@/lib/i18n/dicionario";

export const metadata = { title: "Criar conta" };

/**
 * Aceita `?invite=<token>`: é o caminho de quem foi convidado e ainda não tem
 * conta. Sem isso, essa pessoa criava uma conta comum, e o provisionamento —
 * sem encontrar vínculo nenhum — abria uma organização e a tornava admin dela.
 *
 * O token só é lido aqui para MONTAR a tela (esconder o nome da empresa, travar
 * o e-mail). Quem decide o que ele vale é o servidor, duas vezes: ao criar a
 * conta e ao confirmar o e-mail.
 */
export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ invite?: string }>;
}) {
  const { invite } = await searchParams;
  const payload = invite ? verifyInviteToken(invite) : null;
  const convite = invite && payload ? { token: invite, email: payload.email } : undefined;
  const conviteExpirado = Boolean(invite) && !payload;
  // Instalação operada como serviço: o cadastro público fica fechado e a conta só nasce
  // de um convite. Sem convite válido não há formulário — não é só esconder um botão;
  // quem manda é `/auth/confirm`, e a tela apenas deixa de prometer o que o servidor
  // vai recusar.
  const formularioAberto = Boolean(convite) || cadastroPublicoAbertoNaInstalacao();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const idioma = normalizarIdioma(
    (user?.user_metadata?.locale as string | undefined) ?? null,
  );
  const t = (texto: string) => traduzir(texto, idioma);

  return (
    <div className="space-y-6">
      <div className="space-y-1.5 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">{t("Criar conta")}</h1>
        <p className="text-sm text-muted-foreground">
          {convite
            ? t("Crie sua senha para entrar na empresa que te convidou")
            : formularioAberto
              ? `${t("Comece a usar o")} ${branding().name} ${t("em minutos")}`
              : t("Esta instalação só aceita novas contas por convite")}
        </p>
      </div>

      {conviteExpirado && (
        <p
          role="alert"
          className="rounded-md border border-amber-300/60 bg-amber-50 px-4 py-3 text-sm dark:border-amber-500/30 dark:bg-amber-950/20"
        >
          {t(
            "Esse convite expirou ou não é mais válido. Peça um novo a quem te convidou — criar uma conta agora abriria uma empresa nova, e não é isso que você quer.",
          )}
        </p>
      )}

      {formularioAberto ? (
        <SignupForm convite={convite} />
      ) : (
        // Convite vencido já tem o aviso acima, que diz o que fazer; repetir "cadastro
        // fechado" por cima só embaralharia as duas mensagens.
        !conviteExpirado && (
          <p role="status" className="rounded-md border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
            {t(
              "O cadastro está fechado. Para entrar, peça um convite a quem administra o sistema — o link do convite abre esta tela já com o seu e-mail.",
            )}
          </p>
        )
      )}

      <p className="text-center text-sm text-muted-foreground">
        {t("Já tem conta?")}{" "}
        <Link href="/login" className="font-medium text-foreground underline underline-offset-4">
          {t("Entrar")}
        </Link>
      </p>
    </div>
  );
}
