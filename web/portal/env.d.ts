/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_AWS_REGION?: string;
  readonly VITE_API_BASE?: string;
  readonly VITE_GLOBUS_CLIENT_ID?: string;
  readonly VITE_ROLE_ARN?: string;
  readonly VITE_REDIRECT_URI?: string;
  /** "1" only in the gate build (portal/.env.gate). */
  readonly VITE_PORTAL_TEST_HOOKS?: string;
  /** "1" only in the gate build: client_id/role_arn may come from the URL (#704). */
  readonly VITE_PORTAL_CONFIG_OVERRIDES?: string;
}
