-- 0045 - what a password link was ISSUED FOR: a welcome, or a reset
--
-- The welcome email's set-password link and the forgot-password link are the
-- same kind of token and are consumed by the same route. That was the whole
-- point (one credential-minting path, not two), and it had one unwanted
-- consequence: consuming a WELCOME link sent the security alert "Your
-- password was changed - if this was not you, somebody else has access to
-- your email" to a person who had just chosen their first password. Every new
-- learner, and every new organization admin, was told on day one that their
-- account might be compromised.
--
-- purpose is written at issue time. DEFAULT 'reset' so every token that
-- predates this column keeps its old behaviour, which is the safe direction:
-- an unlabelled token still sends the alert.

ALTER TABLE password_reset_tokens
  ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'reset';
