/**
 * Post-login Action: inject the non-standard claims the backend requires.
 *
 * The RulesLawyer API does NOT read standard OIDC claims — jwt.strategy.ts
 * rejects any token without `user_email` and uses `user_name` when
 * auto-provisioning the local User. Auth0 will not emit these bare
 * (non-namespaced) names unless this Action adds them. They are set on the
 * ACCESS token (the token the API validates); bare names are accepted there for
 * a custom API but would be silently dropped from ID tokens.
 *
 * See ruleslawyer-backend/Documentation/AUTH0_TENANT_SETUP.md §2.
 */
exports.onExecutePostLogin = async (event, api) => {
  api.accessToken.setCustomClaim('user_email', event.user.email);
  api.accessToken.setCustomClaim('user_name', event.user.name);
};
