# Abrir um cliente novo numa instalação com vários clientes

Para a instalação que a Elev opera como serviço: **uma VPS, um banco, cada cliente uma
organização** isolada pelas regras de acesso do banco (RLS). Aqui o cadastro público fica
**fechado** — ninguém cria empresa sozinho — e cada cliente entra por um convite que você
emite.

## Antes de tudo: fechar o cadastro público

No `.env` da instalação:

```bash
CADASTRO_PUBLICO=false
```

Recrie o contêiner do app para ele ler o `.env` de novo (`docker compose -f docker-compose.prod.yml up -d app`;
se a instalação usa Traefik, junte `-f docker-compose.traefik.yml`). Não precisa de rebuild.

| Valor | Efeito |
| --- | --- |
| vazio ou `true` | **Aberto** (o padrão): quem confirmar um e-mail ganha uma organização própria. |
| `false` — ou **qualquer outro valor** | **Fechado**: só entra quem traz um convite válido. |

Qualquer valor que não seja vazio ou `true` fecha de propósito: errar a grafia (`falso`)
não pode deixar o cadastro aberto sem ninguém perceber.

Com o cadastro fechado:

- `/signup` só mostra o formulário para quem chega por um link de convite; para os outros
  mostra "O cadastro está fechado";
- o login deixa de oferecer "Criar conta";
- **quem criar conta por fora da tela** (direto no Auth do Supabase) confirma o e-mail e
  **não ganha organização nenhuma** — cai em `/login?error=cadastro_fechado`, e o motivo
  fica no log de auditoria (`auth.signup_provision_recusado`, `motivo: cadastro_fechado`);
- quem **já é membro** de uma organização não é afetado (troca de e-mail, link mágico).

## Abrir o cliente

1. Entre em `/admin` com o seu usuário de plataforma (MFA obrigatório).
2. **Tenants → Novo tenant.** Preencha nome, slug, plano e o **e-mail do responsável**
   (quem vai administrar a organização do cliente).
3. Ao criar, a tela seguinte mostra o **convite do responsável**:
   - se o envio de e-mail está configurado (`RESEND_API_KEY` e domínio verificado), o
     e-mail já saiu e a tela diz para onde;
   - se **não saiu**, a tela avisa e mostra o link. **Copie e entregue pelo canal que o
     cliente usa** (o WhatsApp, por exemplo).
4. O responsável abre o link → **Ainda não tenho conta** → cria a senha (o e-mail vem
   travado no do convite) → confirma o e-mail → **Aceitar convite**. Entra como
   **administrador** da organização dele, sem nunca ter aberto uma própria.

O link **vale 24 horas** e não fica guardado em lugar nenhum — a tela de criação é a única
que o mostra. Se venceu, ou o e-mail se perdeu: **Tenants → (o cliente) → Convidar
responsável** e gere outro. Só funciona para organizações **ativas** (suspensa ou redigida
por LGPD recusa; reative antes).

Se a criação do tenant der certo e o convite falhar, a tela avisa e o tenant continua
criado. Use **Convidar responsável** — não crie de novo (o slug já existe).

## O que o convite NÃO resolve

- **A chave de IA** é da organização (cada cliente paga a sua). Sem ela, o agente não
  responde; o responsável cadastra nas configurações da organização (ver
  `docs/runbooks/ai-credentials-rotation.md`), ou você cadastra ao impersonar o tenant.
- **O canal de WhatsApp** é ligado por organização (Configurações → Canais).

## Risco que sobra (e como vigiar)

O Auth do Supabase **continua aceitando cadastro direto** — é preciso, porque o convite
cria a conta por esse mesmo caminho. O que o fechamento impede é a **organização**: essas
contas ficam sem vínculo, não enxergam nada e só ocupam uma linha em `auth.users`. O custo
possível é o **e-mail de confirmação** que o Supabase manda para cada tentativa.

Mitigação no painel do Supabase: a proteção contra abuso do Auth (CAPTCHA — hoje em
**Authentication → Attack Protection**, confira o nome na versão atual do painel) e os
limites de envio de e-mail. Para ver se há acúmulo:

```sql
select count(*) as contas_sem_organizacao
from auth.users u
where not exists (select 1 from public.user_organizations uo where uo.user_id = u.id)
  and u.created_at < now() - interval '7 days';
```

Contas assim, com mais de uma semana e sem nunca terem aceitado convite, podem ser
removidas pelo painel do Supabase (Authentication → Users).
