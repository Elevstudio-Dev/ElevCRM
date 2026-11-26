-- ============================================================================
-- 0234 — a cifra do CPF passa a existir.
--
-- `contacts` guarda o CPF em duas colunas que andam juntas (CHECK `contacts_cpf_consistency`): `cpf_hash` (sha256,
-- para achar e deduplicar) e `cpf_encrypted` (a versão recuperável, cifrada). O app pede a cifra à RPC
-- `encrypt_cpf` — que só existia na spec. Sem ela o app gravava o hash sozinho e o banco recusava a linha: em
-- 25/11/2026 a importação por planilha perdeu assim TODAS as 408 linhas com CPF de uma clínica, e o create/PATCH
-- unitário de contato com CPF quebrava do mesmo jeito.
--
-- `encrypt_cpf(p_plaintext)`:
--   * mesma cifra e mesma chave mestra do resto da base (`pgp_sym_encrypt` AES-256, chave em
--     `private.fn_oauth_key()` — a GUC `app.nuvemshop_oauth_key` ou `private.app_secrets`), então nenhuma chave
--     nova precisa ser provisionada: a instalação que já cifra o token do canal oficial e a credencial do Google
--     cifra o CPF;
--   * só aceita o CPF NORMALIZADO (11 dígitos) — quem chama com a sessão do usuário não ganha um oráculo genérico
--     da chave mestra;
--   * sem chave, recusa com motivo legível ("chave de cifra ausente"), e nenhuma das mensagens repete a entrada;
--   * EXECUTE para `authenticated` (as rotas de contato chamam com a sessão do usuário, sob RLS) e `service_role`;
--     nunca `anon`.
--
-- Aditiva e idempotente; nenhum dado tocado. Mesmo bloco no baseline, antes da varredura anon.
-- Vigiada por `tests/invariants/cpf-cifrado-na-gravacao.test.ts`.
-- ============================================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create or replace function public.encrypt_cpf(p_plaintext text) returns bytea
    language plpgsql volatile security definer
    set search_path to 'public', 'private', 'extensions', 'pg_temp'
    as $$
declare
  k text;
begin
  if p_plaintext is null or p_plaintext !~ '^[0-9]{11}$' then
    raise exception 'encrypt_cpf: entrada recusada (esperado o CPF normalizado, 11 dígitos)'
      using errcode = '22023';
  end if;
  k := private.fn_oauth_key();
  if k is null or length(k) < 32 then
    raise exception 'encrypt_cpf: chave de cifra ausente nesta instalação'
      using errcode = '55000';
  end if;
  return pgp_sym_encrypt(p_plaintext, k, 'cipher-algo=aes256');
end$$;

comment on function public.encrypt_cpf(text) is
  'Cifra o CPF normalizado (11 dígitos) com a chave mestra (pgp_sym AES-256). Par obrigatório de contacts.cpf_hash '
  '(CHECK contacts_cpf_consistency). Migration 0234.';

revoke all on function public.encrypt_cpf(text) from public;
revoke all on function public.encrypt_cpf(text) from anon;
grant execute on function public.encrypt_cpf(text) to authenticated, service_role;
