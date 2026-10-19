# SLI_TECH build (branch `claude/sli-tech-build`)

- `site/` – built customer site (minified; upload/serve this folder). Points at Supabase project `pedjksnjyltbkjhstaqp`.
- `supabase/` – numbered SQL migrations (+ ROLLBACK files) and the 4 Edge Functions. No secrets are stored here.
- Your original `index.html` (design mockup) is untouched on `main`.

Secrets (Paystack key etc.) live only in Supabase Edge Function secrets.
