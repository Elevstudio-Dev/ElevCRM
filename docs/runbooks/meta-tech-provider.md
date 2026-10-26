# Roteiro — a Elev como Tech Provider da Meta

Para quem opera o Elev CRM como serviço, com **vários clientes numa instalação só**, e
quer que o cliente use o **mesmo número no app do celular e no CRM/IA** (a "coexistência").

> Tudo aqui foi lido nas páginas oficiais da Meta (links no fim) em 2026-10-26, por
> resumo automático da página. A Meta muda isto com frequência: **confira cada passo no
> painel antes de agir**. O que a página não diz está marcado como "não informado" —
> e não foi preenchido por suposição.

## Por que isto é necessário

| Quero | A Meta exige |
|---|---|
| Número só de API (sem o app do celular) | Uma conta WhatsApp Business (WABA) e um token. **Funciona hoje** com a tela de Conexões. |
| O mesmo número no app **e** no CRM (coexistência) | Ser **Tech Provider ou Solution Partner**, usar o **Embedded Signup v4** com *session logging*, e o app Business do cliente na versão **2.24.17 ou superior**. |

O produto foi desenhado para **um app da Meta por instalação**: `META_APP_SECRET` e
`META_WEBHOOK_VERIFY_TOKEN` são da instalação, e o token no caminho do webhook
(`/api/v1/webhooks/meta/<token>`) é o que amarra cada evento a UMA organização. É
exatamente o modelo de Tech Provider: um app da Elev, N contas de N clientes.

## O que fazer, em ordem (na Meta, por quem é dono da Elev)

1. **Portfólio de negócios da Elev** (Meta Business Suite) e **verificação da empresa**:
   nome, endereço, telefone, e-mail e site, com documentos se a Meta pedir. A página diz
   que a empresa "must be verified" antes do App Review.
2. **Criar o app da Meta** com o caso de uso **WhatsApp**, ligado a esse portfólio.
3. No painel do app: *Use cases → Customize* no WhatsApp → **Tech Provider onboarding**.
   - Passo 1: verificação da empresa (item 1).
   - Passo 2: **App Review**. Exige ícone do app, **política de privacidade** (URL
     pública) e categoria.
   - Dois vídeos de demonstração: (a) uma mensagem criada e enviada pelo app e recebida
     no WhatsApp; (b) a criação de um *template* de mensagem. A página aceita, no lugar,
     a gravação de tela do cURL do *API Setup* ou do WhatsApp Manager.
   - Pedir **acesso avançado** a `whatsapp_business_messaging` e
     `whatsapp_business_management` e clicar em **Begin App Review**.
4. Anotar o **App ID** e o **App Secret** do app. O App Secret vai para o `.env` da
   instalação como `META_APP_SECRET`; o `META_WEBHOOK_VERIFY_TOKEN` é uma frase longa
   que você inventa e cola igual nos dois lugares (`.env` e painel da Meta).
   **Nenhum dos dois é escrito pelo `install.sh`** — sem eles, o canal oficial não
   recebe nada e a tela de Conexões avisa.
5. Depois de aprovado: o Embedded Signup passa a funcionar para clientes. O limite
   inicial é de **10 clientes novos por 7 dias**; sobe para 200 depois de verificação de
   empresa, App Review e *Access Verification*.

**Prazo:** não informado pela Meta. Planeje semanas, não dias, e comece já.

## O que o cliente precisa ter

- Uma conta do WhatsApp Business **com método de pagamento**, a não ser que a Elev seja
  Solution Partner (que pode compartilhar a linha de crédito). Não informado se o Tech
  Provider "puro" tem outra saída.
- Para a coexistência: o número **já em uso no app WhatsApp Business** (não no WhatsApp
  comum), app ≥ 2.24.17, e o celular **aberto de vez em quando** — a Meta desconecta o
  dispositivo principal inativo por cerca de **14 dias**.
- **Modelos de mensagem aprovados** para tudo que o CRM mandar fora da janela de 24 h
  (lembrete de consulta, follow-up). Ver `lembrete-de-consulta.md`.

## Regras da coexistência que afetam o atendimento

- Throughput fixo de **20 mensagens por segundo** no número.
- **Grupos não funcionam** pela Cloud API.
- Mensagens temporárias, visualização única e localização em tempo real ficam desativadas
  nos chats 1:1; listas de transmissão ficam somente leitura.
- Depois do cadastro há **24 horas** para sincronizar contatos e histórico; passou disso,
  o número precisa ser desligado e cadastrado de novo.
- **Brasil: a página não informa se há restrição de país.** Confirme no painel da Meta
  antes de prometer a coexistência a um cliente.
- O QR code não oficial (WAHA) **não convive** com a coexistência: a Meta desativa
  integrações não oficiais no mesmo número.

## O que o produto tem hoje e o que falta

| Peça | Estado |
|---|---|
| Conectar número de API (ID do número, ID da conta, token) | **Pronto** — Configurações → Conexões |
| Receber mensagens do paciente, status de entrega, status de modelo | **Pronto** |
| Webhook por canal, com a organização amarrada pelo token do caminho | **Pronto** |
| Receber o que a recepção escreve **pelo app do celular** (`smb_message_echoes`) | **Falta** |
| Pausar a IA quando um humano responde pelo celular (no canal oficial) | **Falta** (existe no canal por QR code) |
| Cadastro do cliente pelo Embedded Signup v4 (botão, troca do código por token) | **Falta** |
| Sincronizar contatos e histórico em até 24 h (`smb_app_state_sync`, `history`) | **Falta** |
| Assinar os campos `account_update`, `history`, `smb_app_state_sync`, `smb_message_echoes` | **Falta** — hoje só `messages` e `message_template_status_update` |

O formato do `smb_message_echoes` (um `message_echoes[]` com `from`, `to`, `id`,
`timestamp`, `type` entre `text`, `image`, `video`, `document`, `revoke` e `edit`) foi
lido numa documentação de terceiros, não na da Meta. **Não foi provado contra a Meta
real.**

## Fontes

- [Onboarding de usuários do WhatsApp Business app (coexistência)](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users/)
- [Como virar Tech Provider](https://developers.facebook.com/docs/whatsapp/solution-providers/get-started-for-tech-providers)
- [Visão geral do Embedded Signup](https://developers.facebook.com/docs/whatsapp/embedded-signup/overview)
- Formato do eco (terceiro, não oficial): [dualhook — smb_message_echoes](https://dualhook.com/docs/webhook-smb-message-echoes)

> O Embedded Signup **v2 e v3 foram descontinuados em 15/10/2026** — qualquer exemplo
> antigo na internet está errado. Use a v4.
